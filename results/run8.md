# node-db-abort-matrix results

Generated: 2026-10-31T08:09:27.990Z
Node.js: v22.22.2
Server (postgres): PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)
Server (mysql): MySQL 8.4.13

Each query sleeps for 3000 ms on the server. The client aborts 500 ms after the database shows the query running. A query counts as stopped if the database is idle within 1000 ms of the abort. Every pool is limited to one connection, so "next query waited" shows whether the connection is still tied up.

| Driver | Version | Scenario | Verdict | DB idle after abort (ms) | Promise settled after abort (ms) | Promise outcome | Next query waited (ms) |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| pg | 8.23.1 | no cancellation (control) | ignored | 2505 | 2500 | resolved | 2503 |
| pg | 8.23.1 | signal: query({ text, signal }) | ignored | 2501 | 2491 | resolved | 2493 |
| pg | 8.23.1 | workaround: pg_cancel_backend() from a second connection | cancelled | 14 | 13 | rejected (error 57014) | 17 |
| postgres.js | 3.4.9 | no cancellation (control) | ignored | 2499 | 2490 | resolved | 2490 |
| postgres.js | 3.4.9 | workaround: query.cancel() | cancelled | 64 | 10 | rejected (PostgresError 57014) | 10 |
| postgres.js 4 | 4.0.0 | no cancellation (control) | ignored | 2532 | 2489 | resolved | 2489 |
| postgres.js 4 | 4.0.0 | signal: query.signal(signal) | cancelled | 88 | 25 | rejected (PostgresError 57014) | 25 |
| postgres.js 4 | 4.0.0 | workaround: query.cancel() | cancelled | 65 | 9 | rejected (PostgresError 57014) | 9 |
| mysql2 | 3.24.6 | no cancellation (control) | ignored | 2420 | 2417 | resolved | 2420 |
| mysql2 | 3.24.6 | signal: query({ sql, signal }) | ignored | 2501 | 2499 | resolved | 2501 |
| mysql2 | 3.24.6 | workaround: KILL QUERY from a second connection | cancelled | 65 | 3 | resolved | 5 |
| mariadb | 3.5.4 | no cancellation (control) | ignored | 2496 | 2494 | resolved | 2495 |
| mariadb | 3.5.4 | signal: query({ sql, signal, abortSignal }) | ignored | 2495 | 2493 | resolved | 2494 |
| mariadb | 3.5.4 | workaround: KILL QUERY from a second connection | cancelled | 66 | 4 | resolved | 6 |

- **cancelled**: the database stopped the query within the threshold.
- **abandoned**: the promise settled quickly, but the database kept running the query.
- **ignored**: neither happened. The query ran to completion.
- **invalid**: the scenario could not be measured. The reason is in the outcome column.
