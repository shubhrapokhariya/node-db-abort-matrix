# node-db-abort-matrix results

Generated: 2026-10-31T08:08:07.407Z
Node.js: v22.22.2
Server (postgres): PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)
Server (mysql): MySQL 8.4.13

Each query sleeps for 3000 ms on the server. The client aborts 500 ms after the database shows the query running. A query counts as stopped if the database is idle within 1000 ms of the abort. Every pool is limited to one connection, so "next query waited" shows whether the connection is still tied up.

| Driver | Version | Scenario | Verdict | DB idle after abort (ms) | Promise settled after abort (ms) | Promise outcome | Next query waited (ms) |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| pg | 8.23.1 | no cancellation (control) | ignored | 2497 | 2474 | resolved | 2475 |
| pg | 8.23.1 | signal: query({ text, signal }) | ignored | 2495 | 2493 | resolved | 2497 |
| pg | 8.23.1 | workaround: pg_cancel_backend() from a second connection | cancelled | 70 | 5 | rejected (error 57014) | 6 |
| postgres.js | 3.4.9 | no cancellation (control) | ignored | 2496 | 2492 | resolved | 2492 |
| postgres.js | 3.4.9 | workaround: query.cancel() | cancelled | 65 | 13 | rejected (PostgresError 57014) | 13 |
| postgres.js 4 | 4.0.0 | no cancellation (control) | ignored | 2521 | 2499 | resolved | 2499 |
| postgres.js 4 | 4.0.0 | signal: query.signal(signal) | cancelled | 64 | 5 | rejected (PostgresError 57014) | 5 |
| postgres.js 4 | 4.0.0 | workaround: query.cancel() | cancelled | 64 | 6 | rejected (PostgresError 57014) | 6 |
| mysql2 | 3.24.6 | no cancellation (control) | ignored | 2496 | 2437 | resolved | 2442 |
| mysql2 | 3.24.6 | signal: query({ sql, signal }) | ignored | 2487 | 2429 | resolved | 2434 |
| mysql2 | 3.24.6 | workaround: KILL QUERY from a second connection | cancelled | 6 | 8 | resolved | 10 |
| mariadb | 3.5.4 | no cancellation (control) | ignored | 2434 | 2428 | resolved | 2436 |
| mariadb | 3.5.4 | signal: query({ sql, signal, abortSignal }) | ignored | 2488 | 2437 | resolved | 2438 |
| mariadb | 3.5.4 | workaround: KILL QUERY from a second connection | cancelled | 3 | 4 | resolved | 6 |

- **cancelled**: the database stopped the query within the threshold.
- **abandoned**: the promise settled quickly, but the database kept running the query.
- **ignored**: neither happened. The query ran to completion.
- **invalid**: the scenario could not be measured. The reason is in the outcome column.
