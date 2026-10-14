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

/**
 * Decide whether a rendered digest is fit to publish.
 *
 * An all-zero or empty digest is worse than no digest: it looks like an
 * authoritative reading and it is not one. The original workflow published
 * exactly that every week.
 *
 * Exported (rather than living in the workflow's `run:` block) so the same
 * check runs locally and in tests — a guard only CI executes is a guard nobody
 * notices is broken.
 *
 * @param {object} ledger a parsed `agentledger aggregate` dump
 * @param {string} page the rendered Markdown
 * @returns {{ok: boolean, reason: string}}
 */
export function checkDigest(ledger, page) {
  const records = ledger?.totals?.records
    ?? (Array.isArray(ledger?.records) ? ledger.records.length : 0);
  if (!(records > 0)) return { ok: false, reason: 'no usage records in the source dump' };
  const cost = ledger?.totals?.costUSD;
  if (!(Number(cost) > 0)) {
    return { ok: false, reason: `estimated total is ${Number(cost || 0).toFixed(2)} USD` };
  }
  if (page.includes('no records in this dump')) {
    return { ok: false, reason: 'the page rendered its empty-state row' };
  }
  return { ok: true, reason: `publishing ${records} records` };
}

/** Only invoked when run directly, not when imported by the tests. */
if (process.argv[1] && process.argv[1].endsWith('digest.js')) {
  const args = process.argv.slice(2);
  // `--check <source.json> <page.md>` validates instead of rendering.
  if (args[0] === '--check') {
    const [source, page] = args.slice(1);
    if (!source || !page) {
      console.error('usage: node bin/digest.js --check <source.json> <page.md>');
      process.exit(1);
    }
    const ledger = JSON.parse(readFileSync(source, 'utf8'));
    const verdict = checkDigest(ledger, readFileSync(page, 'utf8'));
    if (!verdict.ok) {
      console.error(`digest refusal: ${verdict.reason}`);
      process.exit(1);
    }
    console.log(`digest ${verdict.reason}`);
    process.exit(0);
  }

  const [input, output] = args;
  if (!input) {
    console.error('usage: node bin/digest.js <ledger.json> [out.md]');
    console.error('       node bin/digest.js --check <source.json> <page.md>');
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
