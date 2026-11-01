# Adding a driver

An adapter is a single file in `src/adapters/` that exports a default object. Add the file name (without `.js`) to `ADAPTER_FILES` in **both** `src/run.js` and `src/run-starvation.js`, and add the package to `dependencies` in `package.json`.

```js
export default {
  name: "my-driver", // shown in the tables
  packageName: "my-driver", // used to read the installed version
  dialect: "postgres", // 'postgres' or 'mysql'
  signalLabel: "signal: query({ sql, signal })", // only if runWithSignal exists
  workaroundLabel: "workaround: ...", // only if runWithWorkaround exists

  async setup({ poolSize = 1 } = {}) {}, // return a context; the pool must hold exactly poolSize connections
  async runPlain(ctx, sql) {}, // run sql, no cancellation
  async runWithSignal(ctx, sql, signal) {}, // optional
  async runWithWorkaround(ctx, sql, { signal, control }) {}, // optional
  async followUp(ctx) {}, // run `select 1` through the same pool
  async teardown(ctx) {},
};
```

Rules:

- The pool size must equal `poolSize`. The single-query test uses 1 and the starvation test uses 4. The follow-up query and the starvation numbers depend on it.
- Pass the signal exactly as the driver documents it. Do not add your own abort handling in `runWithSignal`, because that would measure your code and not the driver.
- In `runWithWorkaround`, take a connection, read its id (backend pid on PostgreSQL, connection id on MySQL) on that same connection, then check `if (signal.aborted) return;` before sending the query. The starvation test aborts requests that are still waiting for a connection, and a cancel that arrives before the statement starts does nothing.
- Call `control.cancel(id)` from the abort listener. `control` is a separate connection.
- Never swallow errors in `runPlain`, `runWithSignal` or `runWithWorkaround`. The harness records them.
- Remove event listeners in a `finally` block.

Check your adapter with:

```bash
npm test
node src/run.js --only=my-driver
node src/run-starvation.js --only=my-driver
```

The second starvation command writes `results/starvation-partial.md`, so it does not overwrite a full run. Include both outputs in your pull request.
