# node-db-abort-matrix

When a client aborts a request, does your database driver stop the query, or does the query keep running?

This repo answers that with a measurement instead of an assumption. For each driver it starts a slow query, aborts it, and then asks the database itself, over a separate connection, whether the query is still running.

## Run it

You need Node.js 22 or newer and Docker.

```bash
npm ci
npm run up
npm start
```

`npm ci` installs the exact versions from `package-lock.json`: pg 8.23.1, postgres 3.4.9, mysql2 3.24.6, mariadb 3.5.4, and postgres 4.0.0 under the alias `postgres4`.

`npm run up` starts PostgreSQL 18.6 on port 55432 and MySQL 8.4.13 on port 53306. Both ports are bound to 127.0.0.1, so nothing else on your network can reach the databases. `npm start` writes `results/matrix.md` and `results/latest.json`. `npm run down` removes the containers and their data.

To use your own databases, set `ABORTLAB_PG_URL` and `ABORTLAB_MYSQL_URL`. The other settings are in `.env.example`.

**Do not point the test at a production database.** It creates a table named `abortlab_lock`, holds a row lock on it for a few seconds, and sends cancel commands only for queries it started itself. Use a throwaway database.

`node scripts/summarize-results.js` recomputes every range in the article from the saved files in `results/`.

`npm test` runs the measurement logic against an in-memory fake. It needs no database and finishes in about ten seconds.

`npm run starvation` runs the second test, described below. It takes about two minutes.

## What it does

Each driver runs up to three scenarios. Every pool is limited to one connection.

1. **No cancellation (control).** The query runs and nobody cancels it.
2. **Signal.** The `AbortSignal` is passed through the option the driver offers. This runs only for drivers that have one.
3. **Workaround.** The query is cancelled with the driver's own mechanism or from a second connection: `pg_cancel_backend()` on PostgreSQL, `query.cancel()` in postgres.js, `KILL QUERY` on MySQL.

For every scenario the harness does the same thing:

1. Starts `select pg_sleep(3)` or `select sleep(3)`, tagged with a unique comment.
2. Polls `pg_stat_activity` or `SHOW FULL PROCESSLIST` until the database shows that tagged query running.
3. Waits 500 ms, then aborts.
4. Immediately sends `select 1` through the same one-connection pool.
5. Keeps polling the database until the tagged query is gone.

Three numbers come out of that: how long the database kept running the query after the abort, how long the promise took to settle, and how long the follow-up query had to wait for the connection.

## Pool starvation test

The first test asks whether one query stops. The second asks what a burst of abandoned requests does to everyone else.

One session holds a row lock for 6 seconds. Twelve requests that need that row go through a pool of four connections, and every client gives up 200 ms later. Starting 300 ms in, a healthy `select 1` is sent every 100 ms through the same pool. The test runs up to three modes per driver:

- **naive**: nothing notices that the clients left.
- **signal**: the `AbortSignal` is passed to the driver and nothing else is done. This runs only for drivers that have a signal scenario.
- **cancel-aware**: a request that has not started is skipped, and one that is running is cancelled with the driver's workaround. The postgres.js adapters send all requests to the pool at once and cancel all of them, so nothing is skipped there.

It reports how long the first healthy query waited, the slowest one, how many were slower than 500 ms, and how many connection-seconds the abandoned requests held. Connection-seconds are the number of tagged queries the database shows as active, summed over time and sampled every 100 ms. They are not a measure of how long the client library considers a connection checked out. The output goes to `results/starvation.md` and `results/starvation.json`.

To look at the postgres.js behaviour on its own, without the harness:

```bash
node src/repro-postgresjs-cancel.js            # postgres.js 3.4.9
node src/repro-postgresjs-cancel.js postgres4  # postgres.js 4.0.0
```

A lock wait is used instead of a sleep because it is what a stuck transaction looks like in production, and because it shows whether a cancel also works on a query that is blocked and not running.

## Verdicts

- **cancelled**: the database stopped the query within one second of the abort.
- **abandoned**: the promise settled quickly, but the database kept running the query.
- **ignored**: neither happened. The query ran to completion.
- **invalid**: the scenario could not be measured, for example because the call failed before the query started.

Results depend on the exact driver and server versions. The matrix lists the installed driver versions, and the Actions run publishes the matrix for Node 22 and 24 on every push and once a week.

## Drivers

| Driver            | Package             | Signal scenario                       | Workaround scenario   |
| ----------------- | ------------------- | ------------------------------------- | --------------------- |
| pg                | `pg`                | `query({ text, signal })`             | `pg_cancel_backend()` |
| postgres.js 3.4.9 | `postgres`          | none, the library has no such option  | `query.cancel()`      |
| postgres.js 4.0.0 | `postgres4` (alias) | `query.signal(signal)`                | `query.cancel()`      |
| mysql2            | `mysql2`            | `query({ sql, signal })`              | `KILL QUERY`          |
| mariadb           | `mariadb`           | `query({ sql, signal, abortSignal })` | `KILL QUERY`          |

pg, mysql2, mariadb and postgres.js 3.4.9 do not handle an AbortSignal on queries (see Source check below), so for them the signal scenario shows what happens when you pass one anyway. postgres.js 4.0.0 was published on 29 October 2026, after the first recorded runs, and adds `query.signal()`. Its signal scenario measures that. For mariadb both `signal` and `abortSignal` are passed, so the result does not depend on a guess about the option name.

## Source check

I searched each installed package for `signal` and `abort` (case-insensitive, in `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, `.mts` and `.md` files). The only hits were error-code tables, comments and pool messages. Nothing in `pg` 8.23.1, `postgres` 3.4.9, `mysql2` 3.24.6 or `mariadb` 3.5.4 reads an AbortSignal. The postgres.js 3.x README documents `query.cancel()` under "Canceling Queries in Progress". postgres.js 4.0.0 adds `query.signal()`, so this finding applies to the versions above only. Versions change, so rerun the matrix before quoting any of this for a newer release.

## Things to know before you quote a number

- **Direct connections only.** There is no PgBouncer, no proxy and no serverless driver in the path. Poolers change what cancellation means.
- **MySQL and `SLEEP()`.** When `KILL QUERY` interrupts `SELECT SLEEP(n)`, MySQL returns 1 and does not raise an error. The promise therefore resolves early instead of rejecting. The database-side measurement is the one to trust there.
- **A real slow query behaves differently from a sleep.** `pg_sleep` and `SLEEP` are easy to cancel. A query stuck in a lock wait, a long sort or a network read can react differently.
- **Query builders and ORMs are not tested.** Tools such as Kysely, Drizzle and Prisma sit on top of drivers, but they can add their own cancellation and connection handling, so these results do not tell you what they do.
- **The mariadb connector is tested against MySQL.** The server in the test is MySQL 8.4.13, not MariaDB Server.
- **Some numbers are client-side timers.** Verdicts, "DB idle after abort" and connection-seconds come from the database. How long a healthy query waited, and whether a promise settled, are measured by the harness.
- **postgres.js 3.4.9.** In every recorded starvation run, 4 of the 12 cancelled promises never settled. How much that delayed healthy queries varied between runs, so read the unsettled count as the stable result.
- **Timing granularity.** In the single-query test the observer polls every 50 ms, so the "DB idle after abort" column is accurate to about that much plus one round trip. In the starvation test it is sampled every 100 ms, so connection-seconds are approximate.

## Add a driver

See [CONTRIBUTING.md](CONTRIBUTING.md). An adapter is one file of about 50 lines.

## License

MIT
