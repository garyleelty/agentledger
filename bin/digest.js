#!/usr/bin/env node
/**
 * Build the public cost digest (Markdown) from a ledger JSON dump.
 *
 *   node bin/digest.js <ledger.json> [out.md]
 *   node bin/agentledger.js json > ledger.json && node bin/digest.js ledger.json
 *
 * The published page is aggregates only. Session ids, file paths and
 * per-record rows never reach the output: the point is to show what agent
 * spend looks like, not to publish one machine's coding history.
 *
 * Kept as a real file with a real argument list, rather than inlined into the
 * workflow's `run:` block, for two reasons: a shell-quoted `node -e` body is
 * unreadable and easy to break on a backtick or `$(...)`, and this way the
 * same code is what the tests run.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const comma = (n) => Number(n || 0).toLocaleString('en-US');

/** Grouped rows, most expensive first. Tolerates a missing or empty group. */
function sortedRows(group) {
  if (!group || typeof group !== 'object') return [];
  return Object.entries(group)
    .map(([name, s]) => [name, {
      input: s?.input ?? 0,
      cacheRead: s?.cacheRead ?? 0,
      cacheWrite: s?.cacheWrite ?? 0,
      output: s?.output ?? 0,
      records: s?.records ?? 0,
      costUSD: s?.costUSD ?? 0,
    }])
    .sort((a, b) => b[1].costUSD - a[1].costUSD);
}

export function renderDigest(ledger) {
  const t = ledger?.totals?.tokens ?? {};
  const records = ledger?.totals?.records ?? (Array.isArray(ledger?.records) ? ledger.records.length : 0);

  // `agentledger aggregate` already sorts these by cost; keep that order, but
  // re-sort anyway so a hand-edited or older dump renders the same way.
  const agentRows = sortedRows(ledger?.byAgent, ['input', 'cacheRead', 'cacheWrite', 'output']);
  const agentLines = agentRows.length
    ? agentRows.map(([name, s]) =>
        `| ${name} | ${comma((s.input ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0) + (s.output ?? 0))} | ${comma(s.records)} | ${money(s.costUSD)} |`)
    : ['| _(no records in this dump)_ | — | — | — |'];

  const modelRows = sortedRows(ledger?.byModel);
  const modelLines = modelRows.length
    ? modelRows.map(([name, s]) => `| ${name} | ${comma(s.records)} | ${money(s.costUSD)} |`)
    : ['| _(no records in this dump)_ | — | — |'];

  const totalTokens = (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.output ?? 0);

  return [
    '# agentledger digest',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} from ${comma(records)} usage records.`,
    '',
    '## Tokens and cost',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Input tokens | ${comma(t.input)} |`,
    `| Cache read | ${comma(t.cacheRead)} |`,
    `| Cache write | ${comma(t.cacheWrite)} |`,
    `| Output tokens | ${comma(t.output)} |`,
    `| **All tokens** | **${comma(totalTokens)}** |`,
    `| **Estimated total** | **${money(ledger?.totals?.costUSD)}** |`,
    '',
    '## By agent',
    '',
    '| Agent | Tokens | Records | Est. cost |',
    '| --- | --- | --- | --- |',
    ...agentLines,
    '',
    '## By model',
    '',
    '| Model | Records | Est. cost |',
    '| --- | --- | --- |',
    ...modelLines,
    '',
    'Produced by [agentledger](https://github.com/garyleelty/agentledger) —',
    'a local-first ledger for AI coding agents. Costs are estimates from',
    'public per-million-token prices.',
    '',
  ].join('\n');
}

/** Only invoked when run directly, not when imported by the tests. */
if (process.argv[1] && process.argv[1].endsWith('digest.js')) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: node bin/digest.js <ledger.json> [out.md]');
    process.exit(1);
  }
  const md = renderDigest(JSON.parse(readFileSync(input, 'utf8')));
  if (output) {
    writeFileSync(output, md);
    console.log(`wrote ${output}`);
  } else {
    process.stdout.write(md);
  }
}
