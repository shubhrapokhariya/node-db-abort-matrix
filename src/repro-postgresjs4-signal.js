// When does postgres.js 4.0.0 reject a query whose .signal() is aborted?
// Pool of one connection. A slow query runs, a second query is behind it, and
// the second query's signal is aborted 200 ms in. Four cases: the second query
// is either sent behind the running one (default pipelining) or queued inside
// the pool (max_pipeline: 1), and it is either fast or slow.
//
// Run it with: node src/repro-postgresjs4-signal.js
// It needs the databases from `npm run up`.
import postgres from "postgres4";
import { config } from "./config.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reports a promise that does not settle in time instead of waiting forever.
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(`no result within ${ms / 1000} s`), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const outcome = (ok) => [() => ok, (e) => `rejected ${e.code || e.name}`];

async function scenario(label, options, secondText) {
  const sql = postgres(config.pgUrl, {
    max: 1,
    onnotice: () => {},
    ...options,
  });
  try {
    await sql`select 1`;
    const controller = new AbortController();
    const start = performance.now();
    const running = sql
      .unsafe("select pg_sleep(1.5)")
      .then(...outcome("finished"));
    await wait(100);
    const second = sql
      .unsafe(secondText)
      .signal(controller.signal)
      .then(...outcome("resolved"));
    await wait(100);
    controller.abort();
    const secondOutcome = await settleWithin(second, 10000);
    const secondMs = Math.round(performance.now() - start);
    const runningOutcome = await settleWithin(running, 10000);
    console.log(
      `${label}\n  second query: ${secondOutcome} after ${secondMs} ms, first query: ${runningOutcome}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// If something keeps the process alive after the scenarios, stop it and fail.
setTimeout(() => {
  console.error("Timed out: the script did not finish within 90 s.");
  process.exit(1);
}, 90000).unref();

console.log(
  "postgres.js 4.0.0, pool max 1, abort 200 ms in, first query sleeps 1500 ms\n",
);

const SCENARIOS = [
  ["A: sent behind the running query, fast second query", {}, "select 'fast'"],
  [
    "B: sent behind the running query, slow second query",
    {},
    "select pg_sleep(5)",
  ],
  [
    "C: queued in the pool (max_pipeline: 1), fast second query",
    { max_pipeline: 1 },
    "select 'fast'",
  ],
  [
    "D: queued in the pool (max_pipeline: 1), slow second query",
    { max_pipeline: 1 },
    "select pg_sleep(5)",
  ],
];

for (const [label, options, text] of SCENARIOS) {
  try {
    await scenario(label, options, text);
  } catch (err) {
    process.exitCode = 1;
    console.log(`${label}\n  scenario failed: ${err.message}\n`);
  }
}
