function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

export const config = {
  pgUrl: process.env.ABORTLAB_PG_URL || 'postgres://abortlab:abortlab@127.0.0.1:55432/abortlab',
  mysqlUrl: process.env.ABORTLAB_MYSQL_URL || 'mysql://abortlab:abortlab@127.0.0.1:53306/abortlab',
  sleepMs: num('ABORTLAB_SLEEP_MS', 3000),
  abortAfterMs: num('ABORTLAB_ABORT_AFTER_MS', 500),
  stopThresholdMs: num('ABORTLAB_STOP_THRESHOLD_MS', 1000),
  pollMs: num('ABORTLAB_POLL_MS', 50),
  startTimeoutMs: num('ABORTLAB_START_TIMEOUT_MS', 3000),
};

// The server-side sleep has to outlast the abort delay by more than twice the
// stop threshold, otherwise "stopped early" and "finished on its own" overlap.
export function validateConfig(cfg) {
  const remaining = cfg.sleepMs - cfg.abortAfterMs;
  if (remaining < cfg.stopThresholdMs * 2) {
    throw new Error(
      `Invalid timing: sleep (${cfg.sleepMs} ms) minus abort delay (${cfg.abortAfterMs} ms) ` +
        `must be at least twice the stop threshold (${cfg.stopThresholdMs} ms).`,
    );
  }
}

export function mysqlConfig() {
  const url = new URL(config.mysqlUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}
