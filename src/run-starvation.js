import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  createControl,
  createLockHolder,
  createObserver,
} from "./observers.js";
import {
  renderStarvation,
  runStarvation,
  STARVATION_DEFAULTS,
} from "./starvation.js";
import { firstLine, raceTimeout, redactUrl, sleep } from "./util.js";

// Keep this list in sync with run.js.
const ADAPTER_FILES = [
  "pg",
  "postgres-js",
  "postgres-js-4",
  "mysql2",
  "mariadb",
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = STARVATION_DEFAULTS;

function installedVersion(packageName) {
  try {
    const file = path.join(root, "node_modules", packageName, "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch {
    return null;
  }
}

async function main() {
  const { values } = parseArgs({ options: { only: { type: "string" } } });
  const only = values.only
    ? values.only
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    : null;

  const skipped = [];
  const adapters = [];
  for (const file of ADAPTER_FILES) {
    try {
      const mod = await import(`./adapters/${file}.js`);
      adapters.push(mod.default);
    } catch (err) {
      skipped.push({
        driver: file,
        reason: `could not load the adapter: ${firstLine(err)}`,
      });
    }
  }

  if (only) {
    const keep = adapters.filter((a) => only.includes(a.name.toLowerCase()));
    if (keep.length === 0) {
      console.error(
        `No adapter matches --only=${values.only}. Available: ${adapters.map((a) => a.name).join(", ")}`,
      );
      return 1;
    }
    adapters.splice(0, adapters.length, ...keep);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    servers: {},
    settings: cfg,
  };

  const resources = {};
  const urls = { postgres: config.pgUrl, mysql: config.mysqlUrl };
  for (const dialect of new Set(adapters.map((a) => a.dialect))) {
    try {
      const observer = await createObserver(dialect);
      const control = await createControl(dialect);
      const lock = await createLockHolder(dialect);
      meta.servers[dialect] = await observer.serverVersion();
      resources[dialect] = { observer, control, lock };
    } catch (err) {
      const reason = `cannot reach ${dialect} at ${redactUrl(urls[dialect])} (${firstLine(err)}). Is docker compose up?`;
      for (const adapter of adapters.filter((a) => a.dialect === dialect)) {
        skipped.push({ driver: adapter.name, reason });
      }
    }
  }

  console.log(`Node ${process.version}`);
  for (const [dialect, version] of Object.entries(meta.servers))
    console.log(`${dialect}: ${version}`);
  console.log(
    `Each driver runs up to three modes of about ${Math.round((cfg.holdMs + cfg.tailMs) / 1000)} s each.`,
  );
  console.log("");

  const results = [];
  for (const adapter of adapters) {
    const res = resources[adapter.dialect];
    if (!res) continue;

    const version = installedVersion(adapter.packageName);
    let ctx;
    try {
      ctx = await adapter.setup({ poolSize: cfg.poolSize });
    } catch (err) {
      skipped.push({
        driver: adapter.name,
        reason: `setup failed: ${firstLine(err)}`,
      });
      continue;
    }

    try {
      const modes = ["naive"];
      if (typeof adapter.runWithSignal === "function") modes.push("signal");
      if (typeof adapter.runWithWorkaround === "function")
        modes.push("cancel-aware");
      for (const mode of modes) {
        let result;
        try {
          result = await runStarvation({ adapter, ctx, mode, ...res, cfg });
        } catch (err) {
          result = {
            driver: adapter.name,
            dialect: adapter.dialect,
            mode,
            valid: false,
            reason: `scenario threw: ${firstLine(err)}`,
          };
        }
        result.version = version;
        results.push(result);

        const detail = result.valid
          ? `first healthy query waited ${Math.round(result.probes.firstMs ?? -1)} ms, ` +
            `${result.probes.slowCount} of ${result.probes.total} slow, ` +
            `${result.connectionSeconds.toFixed(1)} connection-seconds, ` +
            `${result.unsettled} never settled`
          : `invalid: ${result.reason}`;
        console.log(`${adapter.name.padEnd(12)} ${mode.padEnd(13)} ${detail}`);
        await sleep(500);
      }
    } finally {
      await raceTimeout(
        Promise.resolve(adapter.teardown(ctx)).catch(() => {}),
        10000,
        undefined,
      );
    }
  }

  await Promise.allSettled(
    Object.values(resources).flatMap(({ observer, control, lock }) =>
      [observer, control, lock].map((r) =>
        raceTimeout(
          Promise.resolve(r.close()).catch(() => {}),
          5000,
          undefined,
        ),
      ),
    ),
  );

  const markdown = renderStarvation({ meta, results, skipped });
  const outDir = path.join(root, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const suffix = only ? "-partial" : "";
  fs.writeFileSync(path.join(outDir, `starvation${suffix}.md`), markdown);
  fs.writeFileSync(
    path.join(outDir, `starvation${suffix}.json`),
    JSON.stringify({ meta, results, skipped }, null, 2) + "\n",
  );

  console.log("");
  console.log(markdown);
  console.log(
    `Wrote results/starvation${suffix}.md and results/starvation${suffix}.json`,
  );

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
