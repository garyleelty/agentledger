#!/usr/bin/env node
/**
 * Regenerate the token figures in README.md and docs/index.html from the
 * committed digest sample.
 *
 * Why this exists: the published numbers are real output from a ledger that
 * grows whenever the maintainer works — and this tool counts its own
 * authoring session (DSH logs), so the docs went stale within the hour, every
 * hour, and hand-editing them raced the ledger and lost. The sample is the
 * single source; this rewrites every published figure from it.
 *
 * Usage:
 *   agentledger aggregate > digests/samples/latest.json
 *   node tools/sync-docs.mjs
 *   node --test tests/docs-numbers.test.js   # proves they agree
 *
 * It rewrites token figures and the per-agent cost column. It does not
 * invent prose or touch the hand-written explanation of what the numbers
 * mean.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = JSON.parse(readFileSync(path.join(root, 'digests', 'samples', 'latest.json'), 'utf8'));

const fmtTok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

const t = sample.totals.tokens;
const total = t.input + t.cacheRead + t.cacheWrite + t.output;
const cost = sample.totals.costUSD;
const unpricedCost = sample.unpricedCostUSD ?? 0;

const replaceAll = (text, pairs) => {
  let out = text;
  for (const [re, rep] of pairs) out = out.replace(re, rep);
  return out;
};

/* ------------------------------- README -------------------------------- */

const readmePath = path.join(root, 'README.md');
let readme = readFileSync(readmePath, 'utf8');
const before = readme;

// Token rows in the summary block. The test asserts these exact substrings.
readme = replaceAll(readme, [
  [/( {2}Input tokens {3})\S+/, `$1${fmtTok(t.input)}`],
  [/( {2}Cache read {5})\S+/, `$1${fmtTok(t.cacheRead)}`],
  [/( {2}Cache write {4})\S+/, `$1${fmtTok(t.cacheWrite)}`],
  [/( {2}Output tokens {2})\S+/, `$1${fmtTok(t.output)}`],
  [/( {2}TOTAL {10})\S+/, `$1${fmtTok(total)}`],
]);

// Per-agent rows: name, tokens, cost, records.
// NOTE: the replacement is a function, not a string. `money()` returns a
// literal `$`, and in a string replacement `$1`/`$2` are backreferences —
// passing `$755` through one of those mangled the row into `  00` the first
// time this ran. A function replacement treats the value literally.
for (const [agent, s] of Object.entries(sample.byAgent)) {
  const tok = fmtTok(s.input + s.cacheRead + s.cacheWrite + s.output);
  const re = new RegExp(`( {2}${escapeRe(agent)}\\s+)\\S+(\\s+)\\$[\\d.]+(\\s+\\d+)`);
  readme = readme.replace(re, (_m, p1, p2, p3) => `${p1}${tok}${p2}${money(s.costUSD)}${p3}`);
}

// The unpriced disclosure, quoted from real output.
if ((sample.unpricedModels ?? []).length) {
  const list = sample.unpricedModels.slice(0, 2)
    .map((m) => `      ${m.model}  (${m.records} records)`).join('\n');
  readme = readme.replace(
    / {2}! \d+ model\(s\) have no built-in price and used the\n {4}\$3\/\$15 per-Mtok default \(\$[\d.]+ of the total\):\n[\s\S]*?\n {6}\.\.\./,
    `  ! ${sample.unpricedModels.length} model(s) have no built-in price and used the\n` +
    `    $3/$15 per-Mtok default (${money(unpricedCost)} of the total):\n${list}\n      ...`,
  );
}

if (readme !== before) writeFileSync(readmePath, readme);

/* ---------------------------- landing page ----------------------------- */

const pagePath = path.join(root, 'docs', 'index.html');
let page = readFileSync(pagePath, 'utf8');
const pageBefore = page;

page = replaceAll(page, [
  [/(Input tokens\s+)\S+/, `$1${fmtTok(t.input)}`],
  [/(Cache read\s+)\S+/, `$1${fmtTok(t.cacheRead)}`],
  [/(Output tokens\s+)\S+/, `$1${fmtTok(t.output)}`],
  [/(<span class="ok">TOTAL\s+)\S+/, `$1${fmtTok(total)}`],
  [/(cache reads\s+<span class="hi">)\S+(<\/span> of )\S+( total tokens)/, `$1${fmtTok(t.cacheRead)}$2${fmtTok(total)}$3`],
  [/(pre>paid\s+<span class="hi">)\$[\d.]+(<\/span>)/, `$1${money(cost)}$2`],
  [/1\.\d+B of my 1\.\d+B tokens are cache reads/, `${fmtTok(t.cacheRead)} of my ${fmtTok(total)} tokens are cache reads`],
]);

if (page !== pageBefore) writeFileSync(pagePath, page);

console.log(
  `synced docs from the sample: ${fmtTok(total)} tokens / ${money(cost)}` +
  ` (${Object.keys(sample.byAgent).length} agents, ${(sample.unpricedModels ?? []).length} unpriced)`,
);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
