# node-db-abort-matrix results

Generated: 2026-10-26T16:28:44.439Z
Node.js: v22.22.2
Server (postgres): PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)
Server (mysql): MySQL 8.4.13

Each query sleeps for 3000 ms on the server. The client aborts 500 ms after the database shows the query running. A query counts as stopped if the database is idle within 1000 ms of the abort. Every pool is limited to one connection, so "next query waited" shows whether the connection is still tied up.

| Driver | Version | Scenario | Verdict | DB idle after abort (ms) | Promise settled after abort (ms) | Promise outcome | Next query waited (ms) |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| pg | 8.23.1 | no cancellation (control) | ignored | 2531 | 2498 | resolved | 2502 |
| pg | 8.23.1 | signal: query({ text, signal }) | ignored | 2499 | 2496 | resolved | 2499 |
| pg | 8.23.1 | workaround: pg_cancel_backend() from a second connection | cancelled | 4 | 4 | rejected (error 57014) | 6 |
| postgres.js | 3.4.9 | no cancellation (control) | ignored | 2553 | 2500 | resolved | 2500 |
| postgres.js | 3.4.9 | workaround: query.cancel() | cancelled | 69 | 11 | rejected (PostgresError 57014) | 12 |
| mysql2 | 3.24.6 | no cancellation (control) | ignored | 2496 | 2489 | resolved | 2495 |
| mysql2 | 3.24.6 | signal: query({ sql, signal }) | ignored | 2485 | 2437 | resolved | 2442 |
| mysql2 | 3.24.6 | workaround: KILL QUERY from a second connection | cancelled | 70 | 10 | resolved | 15 |
| mariadb | 3.5.4 | no cancellation (control) | ignored | 2471 | 2423 | resolved | 2424 |
| mariadb | 3.5.4 | signal: query({ sql, abortSignal }) | ignored | 2561 | 2501 | resolved | 2507 |
| mariadb | 3.5.4 | workaround: KILL QUERY from a second connection | cancelled | 71 | 6 | resolved | 8 |

- **cancelled**: the database stopped the query within the threshold.
- **abandoned**: the promise settled quickly, but the database kept running the query.
- **ignored**: neither happened. The query ran to completion.
- **invalid**: the scenario could not be measured. The reason is in the outcome column.
