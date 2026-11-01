import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { config, validateConfig } from "./config.js";
import { runScenario } from "./harness.js";
import { renderMatrix } from "./report.js";
import { createObserver, createControl } from "./observers.js";
import { firstLine, raceTimeout, redactUrl, sleep } from "./util.js";

const ADAPTER_FILES = [
  "pg",
  "postgres-js",
  "postgres-js-4",
  "mysql2",
  "mariadb",
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Usage: node src/run.js [--only=pg,mysql2]

Runs every driver adapter against the databases from docker-compose.yml
(or the URLs in ABORTLAB_PG_URL and ABORTLAB_MYSQL_URL) and writes
results/matrix.md and results/latest.json.

Adapters: pg, postgres.js, postgres.js 4, mysql2, mariadb`;

function installedVersion(packageName) {
  try {
    const file = path.join(root, "node_modules", packageName, "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch {
    return null;
  }
}

function modesFor(adapter) {
  const modes = [["baseline", "no cancellation (control)"]];
  if (typeof adapter.runWithSignal === "function")
    modes.push(["signal", adapter.signalLabel]);
  if (typeof adapter.runWithWorkaround === "function")
    modes.push(["workaround", adapter.workaroundLabel]);
  return modes;
}

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  validateConfig(config);

  const only = values.only
    ? values.only
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    : null;

  const skipped = [];
  const loaded = [];
  for (const file of ADAPTER_FILES) {
    try {
      const mod = await import(`./adapters/${file}.js`);
      loaded.push(mod.default);
    } catch (err) {
      skipped.push({
        driver: file,
        reason: `could not load the adapter: ${firstLine(err)}`,
      });
    }
  }

  const selected = only
    ? loaded.filter((a) => only.includes(a.name.toLowerCase()))
    : loaded;
  if (only && selected.length === 0) {
    console.error(
      `No adapter matches --only=${values.only}. Available: ${loaded.map((a) => a.name).join(", ")}`,
    );
    return 1;
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    servers: {},
    settings: {
      sleepMs: config.sleepMs,
      abortAfterMs: config.abortAfterMs,
      stopThresholdMs: config.stopThresholdMs,
      pollMs: config.pollMs,
    },
  };

  const resources = {};
  const urls = { postgres: config.pgUrl, mysql: config.mysqlUrl };
  for (const dialect of new Set(selected.map((a) => a.dialect))) {
    try {
      const observer = await createObserver(dialect);
      const control = await createControl(dialect);
      meta.servers[dialect] = await observer.serverVersion();
      resources[dialect] = { observer, control };
    } catch (err) {
      const reason = `cannot reach ${dialect} at ${redactUrl(urls[dialect])} (${firstLine(err)}). Is docker compose up?`;
      for (const adapter of selected.filter((a) => a.dialect === dialect)) {
        skipped.push({ driver: adapter.name, reason });
      }
    }
  }

  console.log(`Node ${process.version}`);
  for (const [dialect, version] of Object.entries(meta.servers))
    console.log(`${dialect}: ${version}`);
  console.log("");

  const results = [];
  for (const adapter of selected) {
    const res = resources[adapter.dialect];
    if (!res) continue;

    const version = installedVersion(adapter.packageName);
    let ctx;
    try {
      ctx = await adapter.setup();
    } catch (err) {
      skipped.push({
        driver: adapter.name,
        reason: `setup failed: ${firstLine(err)}`,
      });
      continue;
    }

    try {
      for (const [mode, label] of modesFor(adapter)) {
        let result;
        try {
          result = await runScenario({
            adapter,
            ctx,
            mode,
            label,
            observer: res.observer,
            control: res.control,
            cfg: config,
          });
        } catch (err) {
          result = {
            driver: adapter.name,
            dialect: adapter.dialect,
            mode,
            label,
            valid: false,
            reason: `scenario threw: ${firstLine(err)}`,
            verdict: "invalid",
            outcome: null,
            settledAfterAbortMs: null,
            dbStoppedAfterMs: null,
            followUp: null,
            leaked: false,
          };
        }
        result.version = version;
        results.push(result);

        const detail = result.valid
          ? `${result.verdict}, database idle ${Math.round(result.dbStoppedAfterMs ?? -1)} ms after abort`
          : `invalid: ${result.reason}`;
        console.log(`${adapter.name.padEnd(12)} ${mode.padEnd(10)} ${detail}`);
        await sleep(300);
      }
    } finally {
      await raceTimeout(
        Promise.resolve(adapter.teardown(ctx)).catch(() => {}),
        5000,
        undefined,
      );
    }
  }

  await Promise.allSettled(
    Object.values(resources).flatMap(({ observer, control }) => [
      raceTimeout(
        Promise.resolve(observer.close()).catch(() => {}),
        5000,
        undefined,
      ),
      raceTimeout(
        Promise.resolve(control.close()).catch(() => {}),
        5000,
        undefined,
      ),
    ]),
  );

  const markdown = renderMatrix({ meta, results, skipped });
  const outDir = path.join(root, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "matrix.md"), markdown);
  fs.writeFileSync(
    path.join(outDir, "latest.json"),
    JSON.stringify({ meta, results, skipped }, null, 2) + "\n",
  );

  console.log("");
  console.log(markdown);
  console.log("Wrote results/matrix.md and results/latest.json");

  const anyInvalid = results.some((r) => !r.valid);
  return anyInvalid || skipped.length > 0 || results.length === 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
