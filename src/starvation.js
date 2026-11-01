import {
  newTag,
  now,
  raceTimeout,
  sleep,
  summarizeError,
  timedFrom,
} from "./util.js";

// A row lock is held by one session. A burst of requests then queues behind it
// and every client gives up shortly afterwards. While that happens, "healthy"
// requests (select 1) are sent through the same pool.
export const STARVATION_DEFAULTS = {
  poolSize: 4,
  abandoned: 12,
  abortAfterMs: 200,
  holdMs: 6000,
  probeStartMs: 300,
  probeEveryMs: 100,
  sampleMs: 100,
  slowMs: 500,
  tailMs: 500,
  capMs: 20000,
};

export const lockSql = (tag) =>
  `select id from abortlab_lock where id = 1 for update /* abortlab:${tag} */`;

export function summarizeProbes(probes, slowMs) {
  const sorted = [...probes].sort((a, b) => a.startedAt - b.startedAt);
  const finished = sorted.filter((p) => p.ms !== null);
  return {
    total: sorted.length,
    failed: sorted.filter((p) => !p.ok).length,
    firstMs: sorted.length > 0 ? sorted[0].ms : null,
    maxMs: finished.length > 0 ? Math.max(...finished.map((p) => p.ms)) : null,
    slowCount: sorted.filter((p) => !p.ok || p.ms > slowMs).length,
  };
}

// samples: [{ t, active }] in ms since the start. Returns connection-seconds
// (how many connections were busy, multiplied by how long) up to untilMs.
export function integrateConnectionSeconds(samples, untilMs) {
  let total = 0;
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a.t >= untilMs) break;
    const end = Math.min(b.t, untilMs);
    total += (a.active * (end - a.t)) / 1000;
  }
  return total;
}

// mode 'naive': the server never notices that clients left.
// mode 'signal': the AbortSignal is passed to the driver and nothing else is done.
// mode 'cancel-aware': a request that has not started is skipped, and one that
// is running is cancelled (the adapter's workaround).
export async function runStarvation({
  adapter,
  ctx,
  mode,
  observer,
  control,
  lock,
  cfg = STARVATION_DEFAULTS,
}) {
  const tag = newTag();
  const sql = lockSql(tag);
  const controllers = [];
  const abandoned = [];
  const samples = [];
  const probes = [];
  let stop = false;
  let abortTimer;
  let sampler;
  let prober;
  let releasedAt = 0;
  let abandonedSettled = 0;
  let probesSettled = 0;
  const outcomeByIndex = new Array(cfg.abandoned).fill(null);

  await lock.hold();
  const t0 = now();
  try {
    for (let i = 0; i < cfg.abandoned; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      abandoned.push(
        (async () => {
          if (mode === "naive") return adapter.runPlain(ctx, sql);
          if (mode === "signal")
            return adapter.runWithSignal(ctx, sql, controller.signal);
          return adapter.runWithWorkaround(ctx, sql, {
            signal: controller.signal,
            control,
          });
        })()
          .then(
            () => ({ status: "resolved", error: null }),
            (err) => ({ status: "rejected", error: summarizeError(err) }),
          )
          .then((outcome) => {
            abandonedSettled += 1;
            outcomeByIndex[i] = outcome;
            return outcome;
          }),
      );
    }

    abortTimer = setTimeout(() => {
      for (const controller of controllers)
        controller.abort(new Error("abortlab: client left"));
    }, cfg.abortAfterMs);

    sampler = (async () => {
      while (!stop) {
        const t = now() - t0;
        try {
          samples.push({ t, active: await observer.countActive(tag) });
        } catch {
          // a missed sample is not worth failing the run
        }
        await sleep(cfg.sampleMs);
      }
    })();

    prober = (async () => {
      await sleep(cfg.probeStartMs);
      while (!stop) {
        const startedAt = now() - t0;
        probes.push(
          timedFrom(now(), () => adapter.followUp(ctx)).then((result) => {
            probesSettled += 1;
            return { startedAt, ...result };
          }),
        );
        await sleep(cfg.probeEveryMs);
      }
    })();

    const untilRelease = cfg.holdMs - (now() - t0);
    if (untilRelease > 0) await sleep(untilRelease);
    await lock.release();
    releasedAt = now() - t0;
    await sleep(cfg.tailMs);
  } finally {
    stop = true;
    clearTimeout(abortTimer);
    await lock.release().catch(() => {});
  }

  await Promise.all([sampler, prober].filter(Boolean));
  // Requests that never settle are a result, not a failure of the test: they
  // are counted and reported. Healthy queries that never settle mean the pool
  // itself is wedged, and that makes the run invalid.
  await raceTimeout(Promise.all(abandoned), cfg.capMs, null);
  const probeResults = await raceTimeout(Promise.all(probes), cfg.capMs, null);

  const base = { driver: adapter.name, dialect: adapter.dialect, mode };
  if (probeResults === null) {
    return {
      ...base,
      valid: false,
      reason:
        `healthy queries did not settle within ${cfg.capMs / 1000} s after the lock was released ` +
        `(${probesSettled} of ${probes.length} settled)`,
    };
  }

  const settledOutcomes = outcomeByIndex.filter((o) => o !== null);

  const leaked = (await observer.countActive(tag)) > 0;
  return {
    ...base,
    valid: true,
    reason: null,
    probes: summarizeProbes(probeResults, cfg.slowMs),
    peakActive: samples.reduce((max, s) => Math.max(max, s.active), 0),
    connectionSeconds: integrateConnectionSeconds(samples, releasedAt),
    rejected: settledOutcomes.filter((o) => o.status === "rejected").length,
    resolved: settledOutcomes.filter((o) => o.status === "resolved").length,
    unsettled: cfg.abandoned - settledOutcomes.length,
    errorCodes: [
      ...new Set(
        settledOutcomes
          .filter((o) => o.status === "rejected")
          .map((o) => String(o.error.code ?? o.error.name)),
      ),
    ].sort(),
    leaked,
  };
}

const MODE_LABEL = {
  naive: "naive: abandoned requests keep running",
  signal: "signal: passed to the driver, nothing else",
  "cancel-aware": "cancel-aware: skip if not started, cancel if running",
};

function ms(value) {
  return value === null || value === undefined
    ? "n/a"
    : String(Math.round(value));
}

export function renderStarvation({ meta, results, skipped }) {
  const s = meta.settings;
  const lines = [];
  lines.push("# Pool starvation results", "");
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push(`Node.js: ${meta.node}`);
  for (const [dialect, version] of Object.entries(meta.servers)) {
    lines.push(`Server (${dialect}): ${version}`);
  }
  lines.push(
    "",
    `One session holds a row lock for ${s.holdMs} ms. ${s.abandoned} requests that need that row are sent through a pool of ${s.poolSize} connections, ` +
      `and every client gives up ${s.abortAfterMs} ms later. Starting ${s.probeStartMs} ms in, a healthy query (select 1) is sent every ${s.probeEveryMs} ms through the same pool. ` +
      `"Slow" means longer than ${s.slowMs} ms or failed. Connection-seconds are sampled every ${s.sampleMs} ms and are approximate.`,
    "",
  );
  lines.push(
    "| Driver | Version | Mode | First healthy query waited (ms) | Slowest healthy query (ms) | Slow healthy queries | Peak busy connections | Connection-seconds held | Abandoned requests: rejected / resolved / never settled |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const r of results) {
    const label = MODE_LABEL[r.mode] ?? r.mode;
    if (!r.valid) {
      lines.push(
        `| ${r.driver} | ${r.version ?? "n/a"} | ${label} | invalid: ${String(r.reason).replace(/\|/g, "\\|")} | n/a | n/a | n/a | n/a | n/a |`,
      );
      continue;
    }
    lines.push(
      `| ${r.driver} | ${r.version ?? "n/a"} | ${label}${r.leaked ? " (query still running at end)" : ""} | ${ms(r.probes.firstMs)} | ${ms(r.probes.maxMs)} | ${r.probes.slowCount} of ${r.probes.total} | ${r.peakActive} | ${r.connectionSeconds.toFixed(1)} | ${r.rejected} / ${r.resolved} / ${r.unsettled ?? 0}${r.errorCodes && r.errorCodes.length > 0 ? ` (${r.errorCodes.join(", ")})` : ""} |`,
    );
  }
  lines.push(
    "",
    "- **rejected**: the request was cancelled while running and its promise failed.",
    "- **resolved**: the request finished, or in cancel-aware mode was skipped because the client had already gone.",
    "- **never settled**: the promise was still pending when the test ended, long after the lock was released.",
  );
  if (skipped.length > 0) {
    lines.push("", "## Skipped", "");
    for (const item of skipped) lines.push(`- ${item.driver}: ${item.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}
