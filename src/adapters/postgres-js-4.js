import postgres from "postgres4";
import { config } from "../config.js";

// postgres.js 4.x, installed next to 3.x under the alias `postgres4`:
//   npm install postgres4@npm:postgres@4.0.0
// The v4.0.0 release notes add `.signal(abortSignal)` on a query: aborting
// rejects it if it is still waiting, or cancels it if it is running. An abort does not reject a query already sent behind a running one: see src/repro-postgresjs4-signal.js.
// `query.cancel()` is kept as the workaround scenario so both routes are measured.
export default {
  name: "postgres.js 4",
  packageName: "postgres4",
  dialect: "postgres",
  signalLabel: "signal: query.signal(signal)",
  workaroundLabel: "workaround: query.cancel()",

  async setup({ poolSize = 1 } = {}) {
    const sql = postgres(config.pgUrl, {
      max: poolSize,
      onnotice: () => {},
      connection: { application_name: "abortlab-postgresjs4" },
    });
    await sql`select 1`;
    return { sql };
  },

  async runPlain({ sql }, text) {
    await sql.unsafe(text);
  },

  async runWithSignal({ sql }, text, signal) {
    await sql.unsafe(text).signal(signal);
  },

  async runWithWorkaround({ sql }, text, { signal }) {
    if (signal.aborted) return;
    const query = sql.unsafe(text);
    let cancelError = null;
    const onAbort = () => {
      try {
        query.cancel();
      } catch (err) {
        cancelError = err;
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await query;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (cancelError) throw cancelError;
  },

  async followUp({ sql }) {
    await sql`select 1`;
  },

  async teardown({ sql }) {
    await sql.end({ timeout: 5 });
  },
};
