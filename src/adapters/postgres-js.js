import postgres from "postgres";
import { config } from "../config.js";

// postgres.js 3.4.9 has no AbortSignal option on queries. Its own cancel is
// query.cancel(), so only the baseline and the workaround scenarios apply.
// postgres.js 4 adds query.signal(); see postgres-js-4.js.
export default {
  name: "postgres.js",
  packageName: "postgres",
  dialect: "postgres",
  workaroundLabel: "workaround: query.cancel()",

  async setup({ poolSize = 1 } = {}) {
    const sql = postgres(config.pgUrl, {
      max: poolSize,
      onnotice: () => {},
      connection: { application_name: "abortlab-postgresjs" },
    });
    await sql`select 1`;
    return { sql };
  },

  async runPlain({ sql }, text) {
    await sql.unsafe(text);
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
