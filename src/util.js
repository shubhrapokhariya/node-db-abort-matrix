import { randomBytes } from 'node:crypto';

export const now = () => performance.now();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const newTag = () => randomBytes(5).toString('hex');

export function firstLine(value) {
  return String(value?.message ?? value ?? '').split('\n')[0].slice(0, 160);
}

export function summarizeError(err) {
  return {
    name: err?.name ?? 'Error',
    code: err?.code ?? err?.errno ?? null,
    message: firstLine(err),
  };
}

// Resolves with `fallback` if `promise` has not settled after `ms`.
export function raceTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs fn and reports how long it took, measured from t0. Never rejects.
export async function timedFrom(t0, fn) {
  try {
    await fn();
    return { ok: true, ms: now() - t0, error: null };
  } catch (err) {
    return { ok: false, ms: now() - t0, error: summarizeError(err) };
  }
}

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid url>';
  }
}
