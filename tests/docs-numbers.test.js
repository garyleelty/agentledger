import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The published figures — README, landing page, promotion kit — are quoted
 * from this machine's real ledger. That made them drift three times in three
 * rounds (every pricing fix or new source moves the totals), and each time it
 * was found by hand. This test is the machine version of that check.
 *
 * It pins the README's summary block and the landing page's findings panel
 * against the committed digest sample (digests/samples/latest.json), which is
 * itself refreshed with `agentledger aggregate > digests/samples/latest.json`.
 * If the docs and the sample disagree, this fails.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = JSON.parse(fs.readFileSync(path.join(root, 'digests', 'samples', 'latest.json'), 'utf8'));

const fmtTok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

test('README summary block matches the committed digest sample', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const t = sample.totals;
  const total = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output;
  // the headline rows, formatted exactly as the CLI prints them
  assert.ok(readme.includes(`Input tokens   ${fmtTok(t.tokens.input)}`), 'README input row stale');
  assert.ok(readme.includes(`Cache read     ${fmtTok(t.tokens.cacheRead)}`), 'README cache-read row stale');
  assert.ok(readme.includes(`TOTAL          ${fmtTok(total)}`), 'README total row stale');
  // every agent in the sample appears in the README block with its cost
  for (const [agent, s] of Object.entries(sample.byAgent)) {
    const row = new RegExp(`${agent}\\s+\\S+\\s+\\$\\d`);
    assert.ok(row.test(readme), `README missing/agent row for ${agent}`);
  }
});

test('landing page figures match the committed digest sample', () => {
  const page = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const t = sample.totals;
  const total = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output;
  assert.ok(page.includes(fmtTok(t.tokens.cacheRead)), 'landing page cache-read figure stale');
  assert.ok(page.includes(fmtTok(total)), 'landing page total figure stale');
});

test('the digest sample is the aggregate shape and passes the publish gate', () => {
  assert.equal(sample.records, undefined, 'sample must not carry per-record rows');
  assert.ok(sample.totals.records > 0, 'sample must carry real records');
});

test('every agent in SOURCES appears in the README sources table', async () => {
  const { SOURCES } = await import('../src/ledger.js');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const cap = (x) => x.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  for (const src of SOURCES) {
    // README lists them human-styled: "Claude Code", "Gemini CLI", "Kilo"...
    const label = cap(src.agent).replace('Claude Code', 'Claude Code');
    // cell may carry a suffix ("Codex CLI"); match the cell start
    assert.ok(
      readme.toLowerCase().includes(`| ${label.toLowerCase()}`) ||
      readme.toLowerCase().includes(`| ${src.agent} |`),
      `README sources table missing ${src.agent}`,
    );
  }
});

test('the README line-count claim matches the source', async () => {
  // The claim "auditable in one sitting" is the tool's central pitch, and it
  // went stale by 40% (claimed ~1,500 when the source reached 2,117) because
  // nothing checked it. Same failure shape as the figures, same fix.
  const { execFileSync } = await import('node:child_process');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const claimed = readme.match(/~([\d,]+) lines/);
  assert.ok(claimed, 'README must state a line count');
  const claimedN = Number(claimed[1].replace(/,/g, ''));

  const out = execFileSync('wc', ['-l', 'src/ledger.js', 'src/parsers.js', 'src/pricing.js',
    'bin/agentledger.js', 'bin/digest.js'], { encoding: 'utf8', cwd: root });
  const actual = Number(out.trim().split('\n').pop().trim().split(/\s+/)[0]);

  // ~ prefix allows a rounded claim, but not a 40% error
  const drift = Math.abs(claimedN - actual) / actual;
  assert.ok(drift < 0.1, `README claims ~${claimedN} lines, source is ${actual} (${(drift * 100).toFixed(0)}% drift)`);
});

test('the README command list covers every implemented command', async () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'bin', 'agentledger.js'), 'utf8');
  const implemented = new Set([...cli.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  for (const cmd of implemented) {
    // every command must appear in the README usage block, by name
    assert.ok(
      new RegExp(`agentledger-cli\\s+${cmd}\\b`).test(readme),
      `README command list is missing: ${cmd}`,
    );
  }
});

test("the README's 'our N sources' claim matches the built-in SOURCES", async () => {
  // The comparison section quoted "17 sources against our 5" — both numbers
  // wrong (ccusage has 18 adapters, agentledger 6). It is the one place the
  // tool describes itself against the incumbent, so it should be checked.
  //
  // The phrasing changed when the comparison was made honest about overlap:
  // "against our N" flattered nobody and hid the fact that 7 of ccusage's 18
  // adapters overlap with ours. It now reads "agentledger has N sources", and
  // the test looks for that.
  const { SOURCES } = await import('../src/ledger.js');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const m = readme.match(/agentledger has \*\*(\d+)\*\* sources/);
  assert.ok(m, 'README must state its own source count against ccusage');
  assert.equal(
    Number(m[1]), SOURCES.length,
    `README claims ${m[1]} sources, SOURCES has ${SOURCES.length}`,
  );
});

test("the README's ccusage adapter count matches the real repo", async () => {
  // ccusage's adapter list is the other half of the same sentence. Counted
  // from the repository listing rather than remembered.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const m = readme.match(/ccusage has (\d+) adapters/);
  assert.ok(m, 'README must state ccusage adapter count');
  const claimed = Number(m[1]);
  // EXACT, not a range. The range (18..25) let a wrong "19" through for
  // several rounds: ccusage has 18 agent adapters, and the 19th directory
  // under rust/adapters is `common`, a shared helper rather than an agent.
  // Recount by listing rust/adapters and excluding `common`, or by counting
  // the agent namespaces in `ccusage --help` — both give 18.
  assert.equal(
    claimed, 18,
    `README claims ${claimed} ccusage adapters; recount rust/adapters (excluding ` +
    "`common`) and update this constant if it really changed",
  );
});

test('the README does not claim ccusage bills reasoning tokens', () => {
  // This claim was false and I verified it two ways: ccusage's kilo
  // outputTokens (39,597) equals sum(output) with reasoning excluded, and its
  // codex cost excludes reasoning. A comparison section headed "honest" is
  // exactly where a flattering error must not survive.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /prices reasoning tokens per model/);
  assert.doesNotMatch(readme, /prices reasoning tokens\./);
  // the corrected claim must actually be present
  assert.match(readme, /does not bill them in the OpenCode or Kilo lanes/);
});
