import mariadb from "mariadb";
import { mysqlConfig } from "../config.js";

export default {
  name: "mariadb",
  packageName: "mariadb",
  dialect: "mysql",
  signalLabel: "signal: query({ sql, signal, abortSignal })",
  workaroundLabel: "workaround: KILL QUERY from a second connection",

  async setup({ poolSize = 1 } = {}) {
    const pool = mariadb.createPool({
      ...mysqlConfig(),
      connectionLimit: poolSize,
      acquireTimeout: 30000,
      // MySQL 8 authenticates with caching_sha2_password. Without TLS the
      // connector needs this flag to fetch the server's public key.
      allowPublicKeyRetrieval: true,
    });
    await pool.query("select 1");
    return { pool };
  },

  async runPlain({ pool }, sql) {
    await pool.query(sql);
  },

  async runWithSignal({ pool }, sql, signal) {
    // As of 3.5.4 the connector has no abort option under either name (a search
    // of the package finds none). Both likely names are passed so the result
    // does not depend on a guess about the spelling.
    await pool.query({ sql, abortSignal: signal, signal });
  },

  async runWithWorkaround({ pool }, sql, { signal, control }) {
    const conn = await pool.getConnection();
    let cancelling = Promise.resolve();
    let threadId;
    const onAbort = () => {
      cancelling = control.cancel(threadId).catch(() => {});
    };
    try {
      const rows = await conn.query("select connection_id() as id");
      // BIGINT columns come back as BigInt from this connector.
      threadId = Number(rows[0].id);
      // The client may have left while this request waited for a connection.
      if (signal.aborted) return;
      signal.addEventListener("abort", onAbort, { once: true });
      await conn.query(sql);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await cancelling;
      await conn.release();
    }
  },

  async followUp({ pool }) {
    await pool.query("select 1");
  },

  async teardown({ pool }) {
    await pool.end();
  },
};
