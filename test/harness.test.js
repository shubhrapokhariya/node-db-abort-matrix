import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, classify, buildSql } from '../src/harness.js';
import { renderMatrix } from '../src/report.js';
import { validateConfig } from '../src/config.js';
import { sleep } from '../src/util.js';

// These tests exercise the measurement logic against an in-memory fake
// "database". They do not touch a real driver or server.

const cfg = {
  sleepMs: 600,
  abortAfterMs: 100,
  stopThresholdMs: 200,
  pollMs: 10,
  startTimeoutMs: 500,
};

function makeFakeDb() {
  const running = new Set();
  const tagOf = (sql) => /abortlab:([0-9a-f]+)/.exec(sql)[1];
  return {
    observer: {
      async countActive(tag) {
        await sleep(1);
        return running.has(tag) ? 1 : 0;
      },
    },
    control: { async cancel() {} },
    // behaviour: 'honor' | 'ignore' | 'abandon'
    adapter(behaviour) {
      const finishOnItsOwn = async (sql) => {
        const tag = tagOf(sql);
        running.add(tag);
        await sleep(cfg.sleepMs);
        running.delete(tag);
      };
      return {
        name: `fake-${behaviour}`,
        dialect: 'postgres',
        async runPlain(_ctx, sql) {
          await finishOnItsOwn(sql);
        },
        async runWithSignal(_ctx, sql, signal) {
          const tag = tagOf(sql);
          running.add(tag);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              running.delete(tag);
              resolve();
            }, cfg.sleepMs);
            if (behaviour === 'ignore') return;
            signal.addEventListener(
              'abort',
              () => {
                if (behaviour === 'honor') {
                  clearTimeout(timer);
                  running.delete(tag);
                }
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              },
              { once: true },
            );
          });
        },
        async followUp() {
          await sleep(1);
        },
      };
    },
  };
}

async function scenario(behaviour, mode) {
  const db = makeFakeDb();
  const adapter = db.adapter(behaviour);
  return runScenario({
    adapter,
    ctx: {},
    mode,
    label: mode,
    observer: db.observer,
    control: db.control,
    cfg,
  });
}

test('baseline without cancellation is ignored', async () => {
  const result = await scenario('ignore', 'baseline');
  assert.equal(result.valid, true);
  assert.equal(result.verdict, 'ignored');
  assert.ok(result.dbStoppedAfterMs > cfg.stopThresholdMs);
  assert.equal(result.outcome.status, 'resolved');
  assert.equal(result.leaked, false);
});

test('a driver that cancels server-side is reported as cancelled', async () => {
  const result = await scenario('honor', 'signal');
  assert.equal(result.verdict, 'cancelled');
  assert.equal(result.outcome.status, 'rejected');
  assert.equal(result.outcome.error.name, 'AbortError');
  assert.ok(result.dbStoppedAfterMs <= cfg.stopThresholdMs);
});

test('a driver that rejects but leaves the query running is abandoned', async () => {
  const result = await scenario('abandon', 'signal');
  assert.equal(result.verdict, 'abandoned');
  assert.equal(result.outcome.status, 'rejected');
  assert.ok(result.settledAfterAbortMs <= cfg.stopThresholdMs);
  assert.ok(result.dbStoppedAfterMs > cfg.stopThresholdMs);
});

test('a driver that accepts the option and ignores it is ignored', async () => {
  const result = await scenario('ignore', 'signal');
  assert.equal(result.verdict, 'ignored');
  assert.equal(result.outcome.status, 'resolved');
});

test('a call that fails before the query starts is invalid, not a verdict', async () => {
  const db = makeFakeDb();
  const adapter = {
    name: 'broken',
    dialect: 'postgres',
    async runPlain() {
      throw new Error('password authentication failed');
    },
    async followUp() {},
  };
  const result = await runScenario({
    adapter,
    ctx: {},
    mode: 'baseline',
    label: 'baseline',
    observer: db.observer,
    control: db.control,
    cfg,
  });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, 'invalid');
  assert.match(result.reason, /password authentication failed/);
});

test('classify uses the threshold on both measurements', () => {
  const base = { valid: true };
  assert.equal(classify({ ...base, dbStoppedAfterMs: 50, settledAfterAbortMs: 50 }, 100), 'cancelled');
  assert.equal(classify({ ...base, dbStoppedAfterMs: 2500, settledAfterAbortMs: 50 }, 100), 'abandoned');
  assert.equal(classify({ ...base, dbStoppedAfterMs: 2500, settledAfterAbortMs: 2500 }, 100), 'ignored');
  assert.equal(classify({ ...base, dbStoppedAfterMs: null, settledAfterAbortMs: null }, 100), 'ignored');
  assert.equal(classify({ valid: false }, 100), 'invalid');
});

test('buildSql tags the query and uses seconds', () => {
  assert.equal(buildSql('postgres', 'ab12', 2500), 'select pg_sleep(2.5) /* abortlab:ab12 */');
  assert.equal(buildSql('mysql', 'ab12', 3000), 'select sleep(3) /* abortlab:ab12 */');
  assert.throws(() => buildSql('oracle', 'ab12', 3000), /Unknown dialect/);
});

test('validateConfig rejects timings that cannot separate the outcomes', () => {
  assert.doesNotThrow(() => validateConfig({ sleepMs: 3000, abortAfterMs: 500, stopThresholdMs: 1000 }));
  assert.throws(() => validateConfig({ sleepMs: 1500, abortAfterMs: 500, stopThresholdMs: 1000 }), /Invalid timing/);
});

test('renderMatrix produces a table row per result and lists skipped drivers', async () => {
  const valid = await scenario('honor', 'signal');
  valid.version = '1.2.3';
  const invalidResult = {
    driver: 'x',
    version: null,
    label: 'a | b',
    valid: false,
    reason: 'boom',
    verdict: 'invalid',
  };
  const markdown = renderMatrix({
    meta: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      node: 'v22.0.0',
      servers: { postgres: 'PostgreSQL 18.0' },
      settings: { sleepMs: 3000, abortAfterMs: 500, stopThresholdMs: 1000, pollMs: 50 },
    },
    results: [valid, invalidResult],
    skipped: [{ driver: 'mariadb', reason: 'setup failed: nope' }],
  });
  assert.match(markdown, /\| fake-honor \| 1\.2\.3 \| signal \| cancelled \|/);
  assert.match(markdown, /a \\\| b/);
  assert.match(markdown, /## Skipped/);
  assert.match(markdown, /- mariadb: setup failed: nope/);
});
