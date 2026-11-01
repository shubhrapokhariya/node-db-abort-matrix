import pg from "pg";
import { config } from "../config.js";

export default {
  name: "pg",
  packageName: "pg",
  dialect: "postgres",
  signalLabel: "signal: query({ text, signal })",
  workaroundLabel: "workaround: pg_cancel_backend() from a second connection",

  async setup({ poolSize = 1 } = {}) {
    const pool = new pg.Pool({
      connectionString: config.pgUrl,
      max: poolSize,
      application_name: "abortlab-pg",
    });
    pool.on("error", () => {});
    await pool.query("select 1");
    return { pool };
  },

  async runPlain({ pool }, sql) {
    await pool.query(sql);
  },

  async runWithSignal({ pool }, sql, signal) {
    await pool.query({ text: sql, signal });
  },

  async runWithWorkaround({ pool }, sql, { signal, control }) {
    const client = await pool.connect();
    let cancelling = Promise.resolve();
    let pid;
    const onAbort = () => {
      cancelling = control.cancel(pid).catch(() => {});
    };
    try {
      const { rows } = await client.query("select pg_backend_pid() as pid");
      pid = rows[0].pid;
      // The client may have left while this request waited for a connection.
      if (signal.aborted) return;
      signal.addEventListener("abort", onAbort, { once: true });
      await client.query(sql);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await cancelling;
      client.release();
    }
  },

  async followUp({ pool }) {
    await pool.query("select 1");
  },

  async teardown({ pool }) {
    await pool.end();
  },
};
