import { now, sleep, summarizeError, newTag, raceTimeout, timedFrom } from './util.js';

export function buildSql(dialect, tag, sleepMs) {
  const seconds = sleepMs / 1000;
  const marker = `/* abortlab:${tag} */`;
  if (dialect === 'postgres') return `select pg_sleep(${seconds}) ${marker}`;
  if (dialect === 'mysql') return `select sleep(${seconds}) ${marker}`;
  throw new Error(`Unknown dialect: ${dialect}`);
}

// cancelled: the database stopped the query within the threshold.
// abandoned: the call came back quickly, but the database kept running the query.
// ignored:   neither happened. The query ran to completion.
export function classify(result, thresholdMs) {
  if (!result.valid) return 'invalid';
  const stopped = result.dbStoppedAfterMs !== null && result.dbStoppedAfterMs <= thresholdMs;
  if (stopped) return 'cancelled';
  const released = result.settledAfterAbortMs !== null && result.settledAfterAbortMs <= thresholdMs;
  return released ? 'abandoned' : 'ignored';
}

function startOperation(adapter, ctx, mode, sql, signal, control) {
  switch (mode) {
    case 'baseline':
      return adapter.runPlain(ctx, sql);
    case 'signal':
      return adapter.runWithSignal(ctx, sql, signal);
    case 'workaround':
      return adapter.runWithWorkaround(ctx, sql, { signal, control });
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

function invalid(base, reason, outcome = null) {
  return {
    ...base,
    valid: false,
    reason,
    verdict: 'invalid',
    outcome,
    settledAfterAbortMs: null,
    dbStoppedAfterMs: null,
    followUp: null,
    leaked: false,
  };
}

function describeOutcome(outcome) {
  if (!outcome) return 'no outcome';
  if (outcome.status !== 'rejected') return outcome.status;
  const { name, code, message } = outcome.error;
  return `rejected: ${name}${code ? ` ${code}` : ''} ${message}`.trim();
}

export async function runScenario({ adapter, ctx, mode, label, observer, control, cfg }) {
  const tag = newTag();
  const sql = buildSql(adapter.dialect, tag, cfg.sleepMs);
  const base = { driver: adapter.name, dialect: adapter.dialect, mode, label, tag };
  const controller = new AbortController();
  const capMs = cfg.sleepMs + 5000;
  let settledAt = null;

  const operation = (async () => startOperation(adapter, ctx, mode, sql, controller.signal, control))()
    .then(
      () => ({ status: 'resolved', error: null }),
      (err) => ({ status: 'rejected', error: summarizeError(err) }),
    )
    .then((outcome) => {
      settledAt = now();
      return outcome;
    });

  // Wait until the database itself shows the query running. Aborting before
  // that would measure connection setup, not cancellation.
  let running = false;
  const startDeadline = now() + cfg.startTimeoutMs;
  while (settledAt === null && now() < startDeadline) {
    if ((await observer.countActive(tag)) > 0) {
      running = true;
      break;
    }
    await sleep(cfg.pollMs);
  }

  if (!running) {
    controller.abort();
    const outcome = await raceTimeout(operation, capMs, { status: 'hung', error: null });
    const reason =
      settledAt !== null
        ? `call finished before the database showed the query running (${describeOutcome(outcome)})`
        : 'the database never showed the query as running';
    return invalid(base, reason, outcome);
  }

  await sleep(cfg.abortAfterMs);

  if (settledAt !== null) {
    const outcome = await operation;
    return invalid(base, `call finished before the abort was sent (${describeOutcome(outcome)})`, outcome);
  }

  const abortAt = now();
  controller.abort(new Error('abortlab: client left'));
  const followUpPromise = timedFrom(abortAt, () => adapter.followUp(ctx));

  let dbStoppedAfterMs = null;
  const stopDeadline = abortAt + cfg.sleepMs + 3000;
  for (;;) {
    const active = await observer.countActive(tag);
    const t = now();
    if (active === 0) {
      dbStoppedAfterMs = t - abortAt;
      break;
    }
    if (t > stopDeadline) break;
    await sleep(cfg.pollMs);
  }

  const outcome = await raceTimeout(operation, capMs, { status: 'hung', error: null });
  const followUp = await raceTimeout(followUpPromise, capMs, {
    ok: false,
    ms: null,
    error: { name: 'Timeout', code: null, message: 'follow-up query did not finish' },
  });
  const leaked = (await observer.countActive(tag)) > 0;

  const result = {
    ...base,
    valid: true,
    reason: null,
    outcome,
    settledAfterAbortMs: settledAt === null ? null : settledAt - abortAt,
    dbStoppedAfterMs,
    followUp,
    leaked,
  };
  result.verdict = classify(result, cfg.stopThresholdMs);
  return result;
}
