import mysql from "mysql2/promise";
import { mysqlConfig } from "../config.js";

export default {
  name: "mysql2",
  packageName: "mysql2",
  dialect: "mysql",
  signalLabel: "signal: query({ sql, signal })",
  workaroundLabel: "workaround: KILL QUERY from a second connection",

  async setup({ poolSize = 1 } = {}) {
    const pool = mysql.createPool({
      ...mysqlConfig(),
      connectionLimit: poolSize,
    });
    await pool.query("select 1");
    return { pool };
  },

  async runPlain({ pool }, sql) {
    await pool.query(sql);
  },

  async runWithSignal({ pool }, sql, signal) {
    await pool.query({ sql, signal });
  },

  async runWithWorkaround({ pool }, sql, { signal, control }) {
    const conn = await pool.getConnection();
    let cancelling = Promise.resolve();
    let threadId;
    const onAbort = () => {
      cancelling = control.cancel(threadId).catch(() => {});
    };
    try {
      const [rows] = await conn.query("select connection_id() as id");
      threadId = Number(rows[0].id);
      // The client may have left while this request waited for a connection.
      if (signal.aborted) return;
      signal.addEventListener("abort", onAbort, { once: true });
      await conn.query(sql);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await cancelling;
      conn.release();
    }
  },

  async followUp({ pool }) {
    await pool.query("select 1");
  },

  async teardown({ pool }) {
    await pool.end();
  },
};
