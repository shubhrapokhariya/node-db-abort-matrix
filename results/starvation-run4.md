# Pool starvation results

Generated: 2026-10-31T08:19:19.838Z
Node.js: v22.22.2
Server (postgres): PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)
Server (mysql): MySQL 8.4.13

One session holds a row lock for 6000 ms. 12 requests that need that row are sent through a pool of 4 connections, and every client gives up 200 ms later. Starting 300 ms in, a healthy query (select 1) is sent every 100 ms through the same pool. "Slow" means longer than 500 ms or failed. Connection-seconds are sampled every 100 ms and are approximate.

| Driver | Version | Mode | First healthy query waited (ms) | Slowest healthy query (ms) | Slow healthy queries | Peak busy connections | Connection-seconds held | Abandoned requests: rejected / resolved / never settled |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| pg | 8.23.1 | naive: abandoned requests keep running | 5709 | 5709 | 49 of 58 | 4 | 23.7 | 0 / 12 / 0 |
| pg | 8.23.1 | signal: passed to the driver, nothing else | 5731 | 5731 | 50 of 58 | 4 | 24.0 | 0 / 12 / 0 |
| pg | 8.23.1 | cancel-aware: skip if not started, cancel if running | 3 | 7 | 0 of 57 | 4 | 0.8 | 4 / 8 / 0 (57014) |
| postgres.js | 3.4.9 | naive: abandoned requests keep running | 5732 | 5732 | 48 of 57 | 4 | 23.7 | 0 / 12 / 0 |
| postgres.js | 3.4.9 | cancel-aware: skip if not started, cancel if running | 5712 | 5712 | 2 of 57 | 4 | 12.7 | 8 / 0 / 4 (57014) |
| postgres.js 4 | 4.0.0 | naive: abandoned requests keep running | 5752 | 5752 | 48 of 57 | 4 | 23.7 | 0 / 12 / 0 |
| postgres.js 4 | 4.0.0 | signal: passed to the driver, nothing else | 2 | 6 | 0 of 58 | 4 | 1.4 | 12 / 0 / 0 (57014) |
| postgres.js 4 | 4.0.0 | cancel-aware: skip if not started, cancel if running | 2 | 6 | 0 of 58 | 4 | 1.3 | 12 / 0 / 0 (57014) |
| mysql2 | 3.24.6 | naive: abandoned requests keep running | 5714 | 5714 | 48 of 57 | 4 | 23.7 | 0 / 12 / 0 |
| mysql2 | 3.24.6 | signal: passed to the driver, nothing else | 5717 | 5717 | 48 of 57 | 4 | 24.0 | 0 / 12 / 0 |
| mysql2 | 3.24.6 | cancel-aware: skip if not started, cancel if running | 2 | 21 | 0 of 57 | 4 | 0.8 | 4 / 8 / 0 (ER_QUERY_INTERRUPTED) |
| mariadb | 3.5.4 | naive: abandoned requests keep running | 5709 | 5709 | 48 of 57 | 4 | 23.8 | 0 / 12 / 0 |
| mariadb | 3.5.4 | signal: passed to the driver, nothing else | 5696 | 5696 | 48 of 57 | 4 | 23.5 | 0 / 12 / 0 |
| mariadb | 3.5.4 | cancel-aware: skip if not started, cancel if running | 1 | 7 | 0 of 57 | 4 | 0.9 | 4 / 8 / 0 (ER_QUERY_INTERRUPTED) |

- **rejected**: the request was cancelled while running and its promise failed.
- **resolved**: the request finished, or in cancel-aware mode was skipped because the client had already gone.
- **never settled**: the promise was still pending when the test ended, long after the lock was released.
