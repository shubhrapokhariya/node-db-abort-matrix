import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { createLockHolder } from "./observers.js";
import { sleep } from "./util.js";

// Minimal reproduction, independent of the harness. A burst of queries that
// wait on a row lock goes through a postgres.js pool of 4. All of them are
// cancelled with query.cancel() 200 ms later, and the script reports what
// happened to every promise. Earlier runs showed that this leaves some
// promises pending when the pool is already warm. Each scenario below changes
// one condition to narrow down why.
//
//   B: cold pool, 12 queries            (no connection is open before the burst)
//   C: warm pool, 12 queries            (the case that left promises pending)
//   E: warm pool, 8 queries             (one waiting query per connection)
//   F: warm pool, 12 queries, max_pipeline: 1   (whether that option matters)
//   G: warm pool, 12 requests, each one reserves its own connection

// Pass the package name to run the same scenarios against postgres.js 4.0.0:
//   node src/repro-postgresjs-cancel.js postgres4
// Setting ABORTLAB_POSTGRES_PACKAGE=postgres4 does the same. The default is the
// `postgres` package (3.x).
const pkg =
  process.argv[2] || process.env.ABORTLAB_POSTGRES_PACKAGE || "postgres";
if (!["postgres", "postgres4"].includes(pkg)) {
  console.error(
    `Unknown package "${pkg}". Use "postgres" (3.x) or "postgres4" (4.x).`,
  );
  process.exit(2);
}
const { default: postgres } = await import(pkg);
const version = JSON.parse(
  readFileSync(
    new URL(`../node_modules/${pkg}/package.json`, import.meta.url),
    "utf8",
  ),
).version;

const MAX = 4;
const LOCK_HOLD_MS = 3000;
const WAIT_MS = 10000;

const SCENARIOS = [
  { name: "B: cold pool, 12 queries", count: 12, warm: false },
  { name: "C: warm pool, 12 queries", count: 12 },
  { name: "E: warm pool, 8 queries", count: 8 },
  {
    name: "F: warm pool, 12 queries, max_pipeline: 1",
    count: 12,
    options: { max_pipeline: 1 },
  },
  {
    name: "G: warm pool, 12 requests, one reserved connection each",
    count: 12,
    reserve: true,
  },
];

const lockQuery = (i) =>
  `select id from abortlab_lock where id = 1 for update /* abortlab-repro:${i} */`;

function describe(query) {
  if (!query) return "waiting for a connection";
  if (!query.state) return "queued inside the pool";
  return query.active ? "running" : "sent, waiting behind another query";
}

async function scenario({
  name,
  count,
  warm = true,
  options = {},
  reserve = false,
}) {
  const sql = postgres(config.pgUrl, {
    max: MAX,
    onnotice: () => {},
    ...options,
  });
  const lock = await createLockHolder("postgres");
  try {
    if (warm) {
      await Promise.all(
        Array.from({ length: MAX }, () => sql.unsafe("select pg_sleep(0.3)")),
      );
    }

    await lock.hold();
    const t0 = performance.now();
    const rows = [];
    const queries = [];
    let clientGone = false;
    const releaseTimer = setTimeout(
      () => lock.release().catch(() => {}),
      LOCK_HOLD_MS,
    );

    for (let i = 0; i < count; i += 1) {
      const row = { i, before: "n/a", outcome: "pending" };
      rows.push(row);
      const finish = (outcome) => {
        row.outcome = outcome;
      };
      const fail = (err) => finish(`rejected ${err.code ?? err.name}`);

      if (!reserve) {
        const query = sql.unsafe(lockQuery(i));
        queries[i] = query;
        query.then(() => finish("resolved"), fail);
      } else {
        (async () => {
          const reserved = await sql.reserve();
          try {
            if (clientGone) {
              finish("skipped (client already gone)");
              return;
            }
            const query = reserved.unsafe(lockQuery(i));
            queries[i] = query;
            await query.then(() => finish("resolved"), fail);
          } finally {
            await reserved.release();
          }
        })().catch((err) => finish(`error ${err.message}`));
      }
    }

    await sleep(150);
    rows.forEach((row, i) => {
      row.before = describe(queries[i]);
    });

    await sleep(50);
    clientGone = true;
    for (const query of queries) {
      if (!query) continue;
      try {
        const result = query.cancel();
        if (result && typeof result.catch === "function")
          result.catch(() => {});
      } catch (err) {
        console.log(`cancel() threw: ${err.message}`);
      }
    }

    const deadline = performance.now() + WAIT_MS;
    while (
      performance.now() < deadline &&
      rows.some((r) => r.outcome === "pending")
    ) {
      await sleep(100);
    }
    clearTimeout(releaseTimer);
    await lock.release().catch(() => {});

    const tally = (values) => {
      const counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      return [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
    };
    const stuck = rows.filter((r) => r.outcome === "pending").map((r) => r.i);

    console.log(
      `\n${name}  (postgres.js ${version}, pool max ${MAX}, lock held ${LOCK_HOLD_MS} ms, cancel at 200 ms)`,
    );
    console.log(`  before cancel: ${tally(rows.map((r) => r.before))}`);
    console.log(`  outcome:       ${tally(rows.map((r) => r.outcome))}`);
    console.log(
      `  never settled within ${WAIT_MS / 1000} s: ${stuck.length} of ${count}${stuck.length ? ` (queries ${stuck.join(", ")})` : ""}`,
    );
  } finally {
    await lock.release().catch(() => {});
    await lock.close().catch(() => {});
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

// A scenario that leaves promises unsettled is a finding and is reported above.
// A scenario that could not run at all (for example the database is down) is a
// failure and makes the script exit with a non-zero code.
let failed = false;
for (const s of SCENARIOS) {
  try {
    await scenario(s);
  } catch (err) {
    failed = true;
    console.log(`\n${s.name}: scenario failed: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
