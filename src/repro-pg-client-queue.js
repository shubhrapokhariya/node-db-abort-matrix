import pg from "pg";
import { config } from "./config.js";

// Shows what node-postgres does when several queries are queued on ONE Client.
// The cancel connection in the test harness used to receive several cancels in
// the same tick, which is how this warning first appeared.

const warnings = [];
process.on("warning", (w) => warnings.push(`${w.name}: ${w.message}`));

const client = new pg.Client({ connectionString: config.pgUrl });
await client.connect();
const version = JSON.parse(
  (await import("node:fs")).readFileSync(
    new URL("../node_modules/pg/package.json", import.meta.url),
    "utf8",
  ),
).version;

await Promise.all(
  [1, 2, 3, 4].map((n) => client.query("select $1::int as n", [n])),
);
await client.end();
await new Promise((resolve) => setTimeout(resolve, 200));

console.log(`pg ${version}: 4 queries queued on one Client`);
console.log(
  warnings.length === 0
    ? "  no warning was emitted"
    : warnings.map((w) => `  ${w}`).join("\n"),
);
