import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Recomputes every range quoted in the article from the saved result files, so
// a reviewer can check the numbers with one command: node scripts/summarize-results.js

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "results",
);
const ROW = /^\| (pg|postgres\.js(?: 4)?|mysql2|mariadb) \|/;

function readTableRows(file) {
  const text = fs
    .readFileSync(path.join(dir, file), "utf8")
    .replace(/^\uFEFF/, "");
  return text
    .split(/\r?\n/)
    .filter((line) => ROW.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
}

function files(pattern) {
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

const range = (values, digits = 0) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fmt = (v) => v.toFixed(digits);
  return min === max ? fmt(min) : `${fmt(min)} to ${fmt(max)}`;
};

const ORDER = ["pg", "postgres.js", "postgres.js 4", "mysql2", "mariadb"];
const present = (rows) => ORDER.filter((d) => rows.some((r) => r.driver === d));

// ---- single-query test ----
const singleFiles = files(/^run\d+\.md$/);
const kindOf = (scenario) =>
  scenario.includes("workaround")
    ? "cancel route"
    : scenario.startsWith("signal")
      ? "signal passed"
      : "no cancellation";
const singleRows = singleFiles.flatMap((file) =>
  readTableRows(file).map((c) => ({
    file,
    driver: c[0],
    version: c[1],
    kind: kindOf(c[2]),
    verdict: c[3],
    idleMs: Number(c[4]),
    waitedMs: Number(c[7]),
  })),
);

console.log(
  `SINGLE-QUERY TEST (${singleFiles.length} files: ${singleFiles.join(", ")})`,
);
console.log(
  `  rows per file: ${singleFiles.map((f) => singleRows.filter((r) => r.file === f).length).join(", ")}`,
);
const verdictsByScenario = new Map();
for (const r of singleRows) {
  const key = `${r.driver}|${r.kind}`;
  if (!verdictsByScenario.has(key)) verdictsByScenario.set(key, new Set());
  verdictsByScenario.get(key).add(r.verdict);
}
console.log(
  `  one verdict per driver and scenario across all files: ${[...verdictsByScenario.values()].every((s) => s.size === 1)}`,
);

for (const kind of ["no cancellation", "signal passed", "cancel route"]) {
  for (const driver of present(singleRows)) {
    const rows = singleRows.filter(
      (r) => r.driver === driver && r.kind === kind,
    );
    if (rows.length === 0) continue;
    console.log(
      `  ${kind.padEnd(16)} ${driver.padEnd(14)} n=${rows.length}  version ${[...new Set(rows.map((r) => r.version))].join("/")}` +
        `  DB idle after abort ${range(rows.map((r) => r.idleMs))} ms` +
        `  | next query waited ${range(rows.map((r) => r.waitedMs))} ms  | verdict ${[...new Set(rows.map((r) => r.verdict))].join("/")}`,
    );
  }
}
const THRESHOLD = 136;
const cancelIdle = singleRows
  .filter((r) => r.kind === "cancel route")
  .map((r) => r.idleMs);
console.log(
  `  cancel runs: ${cancelIdle.length}, within ${THRESHOLD} ms: ${cancelIdle.filter((v) => v <= THRESHOLD).length}, ` +
    `slower: ${cancelIdle.filter((v) => v > THRESHOLD).join(", ") || "none"}`,
);

// ---- starvation test ----
const starveFiles = files(/^starvation-run\d+\.md$/);
const modeOf = (label) =>
  label.startsWith("naive")
    ? "naive"
    : label.startsWith("signal")
      ? "signal"
      : "cancel-aware";
const starveRows = starveFiles.flatMap((file) =>
  readTableRows(file).map((c) => {
    const slow = c[5].match(/(\d+) of (\d+)/);
    return {
      file,
      driver: c[0],
      version: c[1],
      mode: modeOf(c[2]),
      firstMs: Number(c[3]),
      slow: Number(slow[1]),
      total: Number(slow[2]),
      peak: Number(c[6]),
      connSeconds: Number(c[7]),
      abandoned: c[8],
    };
  }),
);

console.log(
  `\nSTARVATION TEST (${starveFiles.length} files: ${starveFiles.join(", ")})`,
);
console.log(
  `  rows per file: ${starveFiles.map((f) => starveRows.filter((r) => r.file === f).length).join(", ")}`,
);
for (const driver of present(starveRows)) {
  for (const mode of ["naive", "signal", "cancel-aware"]) {
    const rows = starveRows.filter(
      (r) => r.driver === driver && r.mode === mode,
    );
    if (rows.length === 0) continue;
    console.log(
      `  ${driver.padEnd(14)} ${mode.padEnd(13)} n=${rows.length}  version ${[...new Set(rows.map((r) => r.version))].join("/")}` +
        `  first healthy query ${range(rows.map((r) => r.firstMs))} ms` +
        `  | slow ${range(rows.map((r) => r.slow))} of ${range(rows.map((r) => r.total))}` +
        `  | connection-seconds ${range(
          rows.map((r) => r.connSeconds),
          1,
        )}` +
        `  | peak ${range(rows.map((r) => r.peak))}` +
        `  | abandoned ${[...new Set(rows.map((r) => r.abandoned))].join(" ; ")}`,
    );
  }
}
