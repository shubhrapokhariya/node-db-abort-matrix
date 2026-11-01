import test from "node:test";
import assert from "node:assert/strict";
import {
  runStarvation,
  summarizeProbes,
  integrateConnectionSeconds,
  renderStarvation,
  lockSql,
} from "../src/starvation.js";
import { sleep } from "../src/util.js";

// An in-memory stand-in for a database with a row lock and a small pool.
// It tests the measurement logic only, not any real driver.

const cfg = {
  poolSize: 2,
  abandoned: 6,
  abortAfterMs: 50,
  holdMs: 700,
  probeStartMs: 80,
  probeEveryMs: 25,
  sampleMs: 20,
  slowMs: 200,
  tailMs: 100,
  capMs: 5000,
};

function makeWorld() {
  let free = cfg.poolSize;
  const waiters = [];
  const acquire = () =>
    new Promise((resolve) => {
      if (free > 0) {
        free -= 1;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else free += 1;
  };

  let running = 0;
  let gate = Promise.resolve();
  let open = () => {};

  const lock = {
    async hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    async release() {
      open();
    },
  };

  const observer = {
    async countActive() {
      await sleep(1);
      return running;
    },
  };

  const adapter = {
    name: "fake",
    dialect: "postgres",
    async runPlain() {
      await acquire();
      running += 1;
      try {
        await gate;
      } finally {
        running -= 1;
        release();
      }
    },
    runWithSignal(_ctx, _sql, signal) {
      return this.runWithWorkaround(_ctx, _sql, { signal });
    },
    async runWithWorkaround(_ctx, _sql, { signal }) {
      await acquire();
      try {
        if (signal.aborted) return;
        running += 1;
        try {
          await new Promise((resolve, reject) => {
            gate.then(resolve);
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("canceling statement"), {
                    code: "57014",
                  }),
                ),
              { once: true },
            );
          });
        } finally {
          running -= 1;
        }
      } finally {
        release();
      }
    },
    async followUp() {
      await acquire();
      release();
    },
  };

  return { adapter, observer, lock, control: {} };
}

test("naive mode: healthy queries are stuck behind abandoned requests", async () => {
  const w = makeWorld();
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "naive",
    ...w,
    cfg,
  });
  assert.equal(r.valid, true);
  assert.ok(r.probes.firstMs > 400, `first probe waited ${r.probes.firstMs}`);
  assert.ok(r.probes.slowCount >= 5);
  assert.equal(r.peakActive, cfg.poolSize);
  assert.ok(
    r.connectionSeconds > 0.8,
    `connection-seconds ${r.connectionSeconds}`,
  );
  assert.equal(r.rejected, 0);
  assert.equal(r.resolved, cfg.abandoned);
  assert.equal(r.leaked, false);
});

test("cancel-aware mode: running requests are cancelled and queued ones skipped", async () => {
  const w = makeWorld();
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "cancel-aware",
    ...w,
    cfg,
  });
  assert.equal(r.valid, true);
  assert.ok(r.probes.firstMs < 150, `first probe waited ${r.probes.firstMs}`);
  assert.equal(r.probes.slowCount, 0);
  assert.equal(r.rejected, cfg.poolSize);
  assert.equal(r.resolved, cfg.abandoned - cfg.poolSize);
  assert.deepEqual(r.errorCodes, ["57014"]);
  assert.ok(
    r.connectionSeconds < 0.3,
    `connection-seconds ${r.connectionSeconds}`,
  );
  assert.equal(r.leaked, false);
});

test("signal mode: a driver that honours the signal behaves like cancel-aware", async () => {
  const w = makeWorld();
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "signal",
    ...w,
    cfg,
  });
  assert.equal(r.valid, true);
  assert.ok(r.probes.firstMs < 150, `first probe waited ${r.probes.firstMs}`);
  assert.equal(r.rejected, cfg.poolSize);
  assert.equal(r.resolved, cfg.abandoned - cfg.poolSize);
  assert.equal(r.unsettled, 0);
});

test("signal mode: a driver that ignores the signal looks like naive", async () => {
  const w = makeWorld();
  w.adapter.runWithSignal = (ctx, sql) => w.adapter.runPlain(ctx, sql);
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "signal",
    ...w,
    cfg,
  });
  assert.equal(r.valid, true);
  assert.ok(r.probes.firstMs > 400, `first probe waited ${r.probes.firstMs}`);
  assert.equal(r.rejected, 0);
  assert.equal(r.resolved, cfg.abandoned);
});

test("abandoned requests that never settle are counted, not hidden", async () => {
  const w = makeWorld();
  w.adapter.runPlain = () => new Promise(() => {});
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "naive",
    ...w,
    cfg: { ...cfg, capMs: 200 },
  });
  assert.equal(r.valid, true);
  assert.equal(r.unsettled, cfg.abandoned);
  assert.equal(r.rejected, 0);
  assert.equal(r.resolved, 0);
});

test("some abandoned requests settling and some not is reported per request", async () => {
  const w = makeWorld();
  const original = w.adapter.runWithWorkaround;
  let calls = 0;
  w.adapter.runWithWorkaround = (...args) => {
    calls += 1;
    return calls % 3 === 0 ? new Promise(() => {}) : original(...args);
  };
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "cancel-aware",
    ...w,
    cfg: { ...cfg, capMs: 300 },
  });
  assert.equal(r.valid, true);
  assert.equal(r.unsettled, 2);
  assert.equal(r.rejected + r.resolved, cfg.abandoned - 2);
});

test("healthy queries that never settle make the run invalid", async () => {
  const w = makeWorld();
  w.adapter.followUp = () => new Promise(() => {});
  const r = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "naive",
    ...w,
    cfg: { ...cfg, capMs: 200 },
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /healthy queries did not settle/);
});

test("summarizeProbes orders by start time and counts failures as slow", () => {
  const s = summarizeProbes(
    [
      { startedAt: 200, ok: true, ms: 10 },
      { startedAt: 100, ok: true, ms: 900 },
      { startedAt: 300, ok: false, ms: 5, error: { name: "Error" } },
    ],
    500,
  );
  assert.equal(s.total, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.firstMs, 900);
  assert.equal(s.maxMs, 900);
  assert.equal(s.slowCount, 2);
  assert.deepEqual(summarizeProbes([], 500), {
    total: 0,
    failed: 0,
    firstMs: null,
    maxMs: null,
    slowCount: 0,
  });
});

test("integrateConnectionSeconds sums active connections over time and stops at the limit", () => {
  const samples = [
    { t: 0, active: 4 },
    { t: 1000, active: 4 },
    { t: 2000, active: 0 },
    { t: 3000, active: 0 },
  ];
  assert.equal(integrateConnectionSeconds(samples, 3000), 8);
  assert.equal(integrateConnectionSeconds(samples, 1500), 6);
  assert.equal(integrateConnectionSeconds([], 1000), 0);
});

test("lockSql carries the tag the observer looks for", () => {
  assert.match(lockSql("ab12"), /for update \/\* abortlab:ab12 \*\/$/);
});

test("renderStarvation writes one row per result with matching columns", async () => {
  const w = makeWorld();
  const result = await runStarvation({
    adapter: w.adapter,
    ctx: {},
    mode: "cancel-aware",
    ...w,
    cfg,
  });
  result.version = "1.0.0";
  const markdown = renderStarvation({
    meta: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      node: "v22.0.0",
      servers: { postgres: "PostgreSQL 18.0" },
      settings: cfg,
    },
    results: [
      result,
      { driver: "x", mode: "naive", valid: false, reason: "a | b" },
    ],
    skipped: [{ driver: "mariadb", reason: "setup failed" }],
  });
  const rows = markdown
    .split("\n")
    .filter((l) => l.startsWith("| fake") || l.startsWith("| x"));
  assert.equal(rows.length, 2);
  const columns = (line) => line.split(/(?<!\\)\|/).length - 2;
  const header = markdown.split("\n").find((l) => l.startsWith("| Driver"));
  assert.equal(columns(rows[0]), columns(header));
  assert.equal(columns(rows[1]), columns(header));
  assert.match(markdown, /\| 2 \/ 4 \/ 0 \(57014\) \|/);
  assert.match(markdown, /- mariadb: setup failed/);
});
