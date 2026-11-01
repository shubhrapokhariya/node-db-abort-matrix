# Pool starvation results

Generated: 2026-10-27T05:41:00.687Z
Node.js: v22.22.2
Server (postgres): PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)

One session holds a row lock for 6000 ms. 12 requests that need that row are sent through a pool of 4 connections, and every client gives up 200 ms later. Starting 300 ms in, a healthy query (select 1) is sent every 100 ms through the same pool. "Slow" means longer than 500 ms or failed. Connection-seconds are sampled every 100 ms and are approximate.

| Driver | Version | Mode | First healthy query waited (ms) | Slowest healthy query (ms) | Slow healthy queries | Peak busy connections | Connection-seconds held | Abandoned requests: rejected / resolved |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| postgres.js | 3.4.9 | naive: abandoned requests keep running | 5733 | 5733 | 48 of 57 | 4 | 23.7 | 0 / 12 |
| postgres.js | 3.4.9 | cancel-aware: skip if not started, cancel if running | invalid: requests did not settle within 20 s after the lock was released (abandoned: 8 of 12 settled, healthy queries: 57 of 57 settled) | n/a | n/a | n/a | n/a | n/a |

- **rejected**: the request was cancelled while running and its promise failed.
- **resolved**: the request finished, or in cancel-aware mode was skipped because the client had already gone.
