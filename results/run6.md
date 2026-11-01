# node-db-abort-matrix results

Generated: 2026-10-28T01:49:56.261Z
Node.js: v22.22.2
Server (postgres): PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)
Server (mysql): MySQL 8.4.13

Each query sleeps for 3000 ms on the server. The client aborts 500 ms after the database shows the query running. A query counts as stopped if the database is idle within 1000 ms of the abort. Every pool is limited to one connection, so "next query waited" shows whether the connection is still tied up.

| Driver | Version | Scenario | Verdict | DB idle after abort (ms) | Promise settled after abort (ms) | Promise outcome | Next query waited (ms) |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| pg | 8.23.1 | no cancellation (control) | ignored | 2509 | 2461 | resolved | 2466 |
| pg | 8.23.1 | signal: query({ text, signal }) | ignored | 2497 | 2494 | resolved | 2496 |
| pg | 8.23.1 | workaround: pg_cancel_backend() from a second connection | cancelled | 72 | 6 | rejected (error 57014) | 8 |
| postgres.js | 3.4.9 | no cancellation (control) | ignored | 2516 | 2507 | resolved | 2507 |
| postgres.js | 3.4.9 | workaround: query.cancel() | cancelled | 68 | 22 | rejected (PostgresError 57014) | 22 |
| mysql2 | 3.24.6 | no cancellation (control) | ignored | 2504 | 2500 | resolved | 2504 |
| mysql2 | 3.24.6 | signal: query({ sql, signal }) | ignored | 2537 | 2500 | resolved | 2504 |
| mysql2 | 3.24.6 | workaround: KILL QUERY from a second connection | cancelled | 3 | 3 | resolved | 5 |
| mariadb | 3.5.4 | no cancellation (control) | ignored | 2453 | 2421 | resolved | 2424 |
| mariadb | 3.5.4 | signal: query({ sql, signal, abortSignal }) | ignored | 2463 | 2431 | resolved | 2436 |
| mariadb | 3.5.4 | workaround: KILL QUERY from a second connection | cancelled | 3 | 4 | resolved | 6 |

- **cancelled**: the database stopped the query within the threshold.
- **abandoned**: the promise settled quickly, but the database kept running the query.
- **ignored**: neither happened. The query ran to completion.
- **invalid**: the scenario could not be measured. The reason is in the outcome column.
