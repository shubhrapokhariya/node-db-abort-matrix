import { config, mysqlConfig } from "./config.js";

// The observer asks the database, over its own connection, whether a tagged
// query is still running. It never trusts what the driver under test reports.
export async function createObserver(dialect) {
  if (dialect === "postgres") {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: config.pgUrl,
      application_name: "abortlab-observer",
    });
    client.on("error", () => {});
    await client.connect();
    return {
      async countActive(tag) {
        const { rows } = await client.query(
          `select count(*)::int as n
             from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and pid <> pg_backend_pid()
              and query like $1`,
          [`%abortlab:${tag}%`],
        );
        return rows[0].n;
      },
      async serverVersion() {
        const { rows } = await client.query("show server_version");
        return `PostgreSQL ${rows[0].server_version}`;
      },
      close: () => client.end(),
    };
  }

  if (dialect === "mysql") {
    const { default: mysql } = await import("mysql2/promise");
    const conn = await mysql.createConnection(mysqlConfig());
    conn.on("error", () => {});
    const [[self]] = await conn.query("select connection_id() as id");
    const ownId = Number(self.id);
    return {
      async countActive(tag) {
        const [rows] = await conn.query("show full processlist");
        const needle = `abortlab:${tag}`;
        return rows.filter(
          (row) =>
            Number(row.Id) !== ownId &&
            row.Command === "Query" &&
            typeof row.Info === "string" &&
            row.Info.includes(needle),
        ).length;
      },
      async serverVersion() {
        const [[row]] = await conn.query("select version() as v");
        return `MySQL ${row.v}`;
      },
      close: () => conn.end(),
    };
  }

  throw new Error(`Unknown dialect: ${dialect}`);
}

// The control connection sends the "cancel that query" command. It is a
// separate connection because the one running the query is busy.
export async function createControl(dialect) {
  if (dialect === "postgres") {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: config.pgUrl,
      application_name: "abortlab-control",
    });
    client.on("error", () => {});
    await client.connect();
    // Several requests can be cancelled in the same tick. pg deprecates
    // calling client.query() while another query is running, so cancels are
    // sent one after another.
    let chain = Promise.resolve();
    return {
      cancel(pid) {
        const run = chain.then(() =>
          client.query("select pg_cancel_backend($1)", [pid]),
        );
        chain = run.catch(() => {});
        return run.then(() => undefined);
      },
      close: () => client.end(),
    };
  }

  if (dialect === "mysql") {
    const { default: mysql } = await import("mysql2/promise");
    const conn = await mysql.createConnection(mysqlConfig());
    conn.on("error", () => {});
    let chain = Promise.resolve();
    return {
      cancel(id) {
        const threadId = Number(id);
        if (!Number.isInteger(threadId) || threadId <= 0) {
          return Promise.reject(
            new Error(`Invalid MySQL connection id: ${id}`),
          );
        }
        const run = chain.then(() => conn.query(`KILL QUERY ${threadId}`));
        chain = run.catch(() => {});
        return run.then(() => undefined);
      },
      close: () => conn.end(),
    };
  }

  throw new Error(`Unknown dialect: ${dialect}`);
}

// Holds a row lock so that other sessions block on it. This is how a long
// transaction or a stuck job looks to the rest of an application.
export async function createLockHolder(dialect) {
  let held = false;

  if (dialect === "postgres") {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: config.pgUrl,
      application_name: "abortlab-lock",
    });
    client.on("error", () => {});
    await client.connect();
    await client.query(
      "create table if not exists abortlab_lock (id int primary key)",
    );
    await client.query(
      "insert into abortlab_lock (id) values (1) on conflict do nothing",
    );
    return {
      async hold() {
        await client.query("begin");
        held = true;
        await client.query(
          "select id from abortlab_lock where id = 1 for update",
        );
      },
      async release() {
        if (!held) return;
        held = false;
        await client.query("rollback");
      },
      close: () => client.end(),
    };
  }

  if (dialect === "mysql") {
    const { default: mysql } = await import("mysql2/promise");
    const conn = await mysql.createConnection(mysqlConfig());
    conn.on("error", () => {});
    await conn.query(
      "create table if not exists abortlab_lock (id int primary key) engine=InnoDB",
    );
    await conn.query("insert ignore into abortlab_lock (id) values (1)");
    return {
      async hold() {
        await conn.query("start transaction");
        held = true;
        await conn.query(
          "select id from abortlab_lock where id = 1 for update",
        );
      },
      async release() {
        if (!held) return;
        held = false;
        await conn.query("rollback");
      },
      close: () => conn.end(),
    };
  }

  throw new Error(`Unknown dialect: ${dialect}`);
}
