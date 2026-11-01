const VERDICT_TEXT = {
  cancelled: 'cancelled',
  abandoned: 'abandoned',
  ignored: 'ignored',
  invalid: 'invalid',
};

function ms(value) {
  return value === null || value === undefined ? 'n/a' : String(Math.round(value));
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function outcomeText(outcome) {
  if (!outcome) return 'n/a';
  if (outcome.status !== 'rejected') return outcome.status;
  const { name, code } = outcome.error;
  return `rejected (${name}${code ? ` ${code}` : ''})`;
}

function followUpText(followUp) {
  if (!followUp) return 'n/a';
  return followUp.ok ? ms(followUp.ms) : `${ms(followUp.ms)} (failed: ${followUp.error.name})`;
}

export function renderMatrix({ meta, results, skipped }) {
  const lines = [];
  lines.push('# node-db-abort-matrix results', '');
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push(`Node.js: ${meta.node}`);
  for (const [dialect, version] of Object.entries(meta.servers)) {
    lines.push(`Server (${dialect}): ${version}`);
  }
  const s = meta.settings;
  lines.push(
    '',
    `Each query sleeps for ${s.sleepMs} ms on the server. The client aborts ${s.abortAfterMs} ms after the database shows the query running. ` +
      `A query counts as stopped if the database is idle within ${s.stopThresholdMs} ms of the abort. ` +
      'Every pool is limited to one connection, so "next query waited" shows whether the connection is still tied up.',
    '',
  );

  lines.push(
    '| Driver | Version | Scenario | Verdict | DB idle after abort (ms) | Promise settled after abort (ms) | Promise outcome | Next query waited (ms) |',
    '| --- | --- | --- | --- | ---: | ---: | --- | ---: |',
  );
  for (const r of results) {
    if (!r.valid) {
      lines.push(
        `| ${cell(r.driver)} | ${cell(r.version ?? 'n/a')} | ${cell(r.label)} | invalid | n/a | n/a | ${cell(r.reason)} | n/a |`,
      );
      continue;
    }
    const verdict = VERDICT_TEXT[r.verdict] + (r.leaked ? ' (query still running at end)' : '');
    lines.push(
      `| ${cell(r.driver)} | ${cell(r.version ?? 'n/a')} | ${cell(r.label)} | ${verdict} | ${ms(r.dbStoppedAfterMs)} | ${ms(r.settledAfterAbortMs)} | ${cell(outcomeText(r.outcome))} | ${followUpText(r.followUp)} |`,
    );
  }

  lines.push(
    '',
    '- **cancelled**: the database stopped the query within the threshold.',
    '- **abandoned**: the promise settled quickly, but the database kept running the query.',
    '- **ignored**: neither happened. The query ran to completion.',
    '- **invalid**: the scenario could not be measured. The reason is in the outcome column.',
  );

  if (skipped.length > 0) {
    lines.push('', '## Skipped', '');
    for (const item of skipped) lines.push(`- ${item.driver}: ${item.reason}`);
  }

  lines.push('');
  return lines.join('\n');
}
