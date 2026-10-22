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

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
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
  // A pair's replacement may be a string — in which case `$1`/`$2` are
  // backreferences, as in every String.replace — or a FUNCTION, in which
  // case it is called with the match and the whole thing is literal.
  //
  // The function form is required whenever the replacement carries a
  // dollar amount: `money()` returns a literal `$`, and in a string
  // replacement "$1.28" has its "$1" replaced by the captured group. (A
  // row that used to be mangled into `00` says so below.) The function
  // form is also required wherever the replacement contains `$1` as
  // literal text, which is why the landing-page pairs below all use it.
  for (const [re, rep] of pairs) {
    out = out.replace(re, typeof rep === 'function' ? rep : rep);
  }
  return out;
};

/* ------------------------------- README -------------------------------- */

const readmePath = path.join(root, 'README.md');
let readme = readFileSync(readmePath, 'utf8');
const before = readme;

// The metric rows in the summary block: tokens AND cost.
//
// The whole row is rebuilt, not just the token column. The old tool
// replaced only the tokens, so the costs were whatever someone had pasted
// in by hand — and the README's total read $1169 while the tool said
// $1227, with the gate green because the gate only checked the tokens.
// The spacing between the two columns is kept; the values are not.
const bucketCost = sample.totals.costByBucket ?? {};
// The whole metric BLOCK is rebuilt, not row by row.
//
// Matching row by row needs the padding to be exactly right, and the
// padding is a function of the values — which change. A row that stopped
// matching simply kept its old numbers, silently, and the gate only
// checked the token column, so the README's total read $1169 while the
// tool said $1227. Building the block from the sample means the columns
// are always aligned to the values that are actually there.
const metricBlock = [
  ['Input tokens', fmtTok(t.input), bucketCost.input ?? 0],
  ['Cache read', fmtTok(t.cacheRead), bucketCost.cacheRead ?? 0],
  ['Cache write', fmtTok(t.cacheWrite), bucketCost.cacheWrite ?? 0],
  ['Output tokens', fmtTok(t.output), bucketCost.output ?? 0],
  ['TOTAL', fmtTok(total), cost],
];
const labelW = Math.max(...metricBlock.map((r) => r[0].length));
const tokenW = Math.max(...metricBlock.map((r) => r[1].length));
const metricText = metricBlock
  .map(([label, tokens, c]) => `  ${label.padEnd(labelW)}  ${tokens.padStart(tokenW)}  ${money(c)}`)
  .join('\n');
readme = readme.replace(
  /( {2}Input tokens[\s\S]*?\n {2}TOTAL[^\n]*\n)/,
  () => `${metricText}\n`,
);

// The line count. It is a claim about the size of the tool, and it was
// hand-written in four places — the README twice and the landing page
// twice — so it went stale without anyone noticing: the project grew from
// ~3,100 lines to ~5,600 and the number did not move. It is computed from
// the source here, so it cannot drift.
const lineCount = (() => {
  const dir = path.join(root, 'src');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f))
    .concat([
      path.join(root, 'bin', 'agentledger.js'),
      path.join(root, 'bin', 'digest.js'),
    ]);
  let n = 0;
  for (const f of files) {
    try { n += readFileSync(f, 'utf8').split('\n').length; } catch { /* missing */ }
  }
  return n;
})();
const lineText = `~${Math.round(lineCount / 100) * 100} lines`;
readme = readme.replace(/~[\d,]+ lines/g, lineText);

// "231 session files scanned" — the number of files the tool opened. It
// was hand-pasted, and it went stale silently, so it is carried in the
// sample and refreshed from there.
if (sample.totals.filesScanned) {
  readme = readme.replace(
    /(agentledger — )\d+( session files scanned)/,
    (_m, p1, p2) => `${p1}${sample.totals.filesScanned}${p2}`,
  );
}

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

// The metric BLOCK is rebuilt, for the same reason the README's is: the
// page's cost column was stale in exactly the way the README's was, and
// the gate did not look at it. The `hi` span is kept on the three rows
// that had one, so the page's styling does not change under the numbers.
const pageRows = [
  ['Input tokens', fmtTok(t.input), bucketCost.input ?? 0, true],
  ['Cache read', fmtTok(t.cacheRead), bucketCost.cacheRead ?? 0, true],
  ['Cache write', fmtTok(t.cacheWrite), bucketCost.cacheWrite ?? 0, false],
  ['Output tokens', fmtTok(t.output), bucketCost.output ?? 0, true],
];
const pLabelW = Math.max(...pageRows.map((r) => r[0].length));
const pTokenW = Math.max(...pageRows.map((r) => r[1].length));
const pageMetric = pageRows
  .map(([label, tokens, c, hi]) => {
    const amount = hi ? `<span class="hi">${money(c)}</span>` : money(c);
    return `  ${label.padEnd(pLabelW)}  ${tokens.padStart(pTokenW)}  ${amount}`;
  })
  .join('\n');
const pageTotal = `  <span class="ok">TOTAL          ${fmtTok(total).padStart(pTokenW)}    ${money(cost)}</span>`;
page = page.replace(
  /( {2}Input tokens[\s\S]*?<\/span>\n)( {2}<span class="ok">TOTAL[^\n]*\n)/,
  () => `${pageMetric}\n${pageTotal}\n`,
);

// Every pair is a FUNCTION, so a dollar amount in the replacement is
// literal rather than a backreference.
// The same line count on the landing page, which states it twice.
page = page.replace(/~[\d,]+ lines/g, lineText);

page = replaceAll(page, [
  [/(cache reads\s+<span class="hi">)\S+(<\/span> of )\S+( total tokens)/, (_m, p1, p2, p3) => `${p1}${fmtTok(t.cacheRead)}${p2}${fmtTok(total)}${p3}`],
  [/(pre>paid\s+<span class="hi">)\$[\d.]+(<\/span>)/, (_m, p1, p2) => `${p1}${money(cost)}${p2}`],
  [/1\.\d+B of my 1\.\d+B tokens are cache reads/, () => `${fmtTok(t.cacheRead)} of my ${fmtTok(total)} tokens are cache reads`],
]);

if (page !== pageBefore) writeFileSync(pagePath, page);

console.log(
  `synced docs from the sample: ${fmtTok(total)} tokens / ${money(cost)}` +
  ` (${Object.keys(sample.byAgent).length} agents, ${(sample.unpricedModels ?? []).length} unpriced)`,
);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
