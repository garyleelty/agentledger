import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Flag-validation regressions.
 *
 * Every case here used to produce a *wrong answer with exit code 0* rather than
 * an error, which is the worst possible failure mode for a cost report:
 *
 *   - `--since <junk>`  -> Date.parse -> NaN -> `if (NaN)` is falsy, so the
 *     filter was skipped and the full ledger printed as if requested.
 *   - `-n -5`           -> `slice(0, -5)` silently dropped the last 5 rows.
 *   - `-n abc`          -> NaN -> `slice(0, NaN)` -> zero rows.
 *   - `-a <typo>`       -> "No agent sessions found yet.", identical to having
 *     no logs at all.
 *
 * The CLI must fail loudly and non-zero on all of them.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

/** Run the CLI, returning {status, stdout, stderr} instead of throwing. */
// Fixture HOME so "--since filters real spend" and "a valid invocation prints
// a report" have data to assert on even on a CI runner with no agent logs.
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

function run(args) {
  try {
    // `json` on a busy machine emits many MB of records; the default 1MB
    // maxBuffer would abort the child and look like a CLI failure.
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, HOME: fixtureHome },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--since rejects an unparseable date instead of ignoring the filter', () => {
  const { status, stdout, stderr } = run(['--since', 'not-a-date']);
  assert.notEqual(status, 0, 'must not exit 0');
  assert.match(stderr, /--since could not parse/);
  // The whole point: it must not print a full report.
  assert.doesNotMatch(stdout, /TOTAL/, 'a bad filter must not fall through to an unfiltered report');
});

test('--since accepts a real date and actually filters', () => {
  const all = run(['json']);
  const filtered = run(['json', '--since', '2999-01-01']);
  assert.equal(all.status, 0);
  assert.equal(filtered.status, 0);
  const before = JSON.parse(all.stdout).totals.costUSD;
  const after = JSON.parse(filtered.stdout).totals.costUSD;
  assert.ok(before > 0, 'the machine under test should have some recorded spend');
  assert.equal(after, 0, 'nothing can have happened after the year 2999');
});

test('-n rejects zero, negatives, and non-numbers', () => {
  for (const bad of ['-5', '0', 'abc', '']) {
    const { status, stderr } = run(['sessions', '-n', bad]);
    assert.notEqual(status, 0, `-n ${JSON.stringify(bad)} must fail`);
    assert.match(stderr, /expects a positive integer/);
  }
});

test('-n keeps accepting a valid count', () => {
  const { status, stdout } = run(['sessions', '-n', '3']);
  assert.equal(status, 0);
  // Header + separator + at most 3 rows.
  const rows = stdout.split('\n').filter((l) => /(codex|claude-code|opencode|gemini-cli)\//.test(l));
  assert.ok(rows.length <= 3, `expected at most 3 session rows, got ${rows.length}`);
});

test('an unknown --agent is named rather than reported as "no sessions"', () => {
  const { status, stdout, stderr } = run(['-a', 'nosuchagent']);
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown agent "nosuchagent"/);
  assert.match(stderr, /known agents: .*claude-code/, 'the error should list what is valid');
  assert.doesNotMatch(stdout, /No agent sessions found/, 'must not masquerade as an empty ledger');
});

test('every documented agent name is accepted', () => {
  for (const agent of ['claude-code', 'codex', 'opencode', 'kilo', 'gemini-cli']) {
    // The command comes first (as with git); flags follow it.
    const { status, stderr } = run(['json', '-a', agent]);
    assert.equal(status, 0, `${agent} should be a valid --agent (stderr: ${stderr})`);
  }
});

test('an unknown option is rejected with a pointer to --help', () => {
  const { status, stderr } = run(['--bogus']);
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown option --bogus/);
  assert.match(stderr, /--help/);
});

test('a stray positional argument is rejected', () => {
  const { status, stderr } = run(['summary', 'extra-junk']);
  assert.notEqual(status, 0);
  assert.match(stderr, /unexpected argument/);
});

test('a valid invocation still exits 0 and prints a report', () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  assert.match(stdout, /agentledger — \d+ session files scanned/);
});

/* ------------------------- --prices overrides ---------------------------- */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function priceFile(content) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-prices-'));
  const file = path.join(dir, 'p.json');
  await writeFile(file, content);
  return file;
}

test('--prices overrides a built-in model and the total moves', async () => {
  // Target claude-sonnet-4-5: the model the fixture home actually carries.
  // (A first draft overrode gpt-5.5 and "passed" on an empty ledger — the
  // silent-zero trap again: no records, no delta, and the assertion that
  // checked `a !== b` would have failed on real data but the fixture has
  // no gpt-5.5 rows at all, so it compared 0 to 0.)
  const file = await priceFile(JSON.stringify({ 'claude-sonnet-4-5': { input: 0.5 } }));
  const withOverride = run(['json', '--prices', file]);
  const plain = run(['json']);
  assert.equal(withOverride.status, 0, withOverride.stderr);
  assert.equal(plain.status, 0);
  const a = JSON.parse(withOverride.stdout).totals.costUSD;
  const b = JSON.parse(plain.stdout).totals.costUSD;
  assert.ok(b > 0, 'the fixture ledger must have real spend to override');
  assert.ok(a < b, 'cutting input $3 -> $0.5 must lower the total');
});

test('--prices partial entries keep the untouched fields of the built-in row', async () => {
  const { resolvePricing, loadPricingOverrides, PRICING: P } = await import('../src/pricing.js');
  loadPricingOverrides({ 'gpt-5.5': { input: 4.0 } });
  const p = resolvePricing('gpt-5.5');
  assert.equal(p.input, 4.0);
  assert.equal(p.output, P['gpt-5.5'].output, 'output must survive an input-only override');
  assert.equal(p.cacheReadMultiplier, P['gpt-5.5'].cacheReadMultiplier);
  loadPricingOverrides({}); // restore for later tests in this file
});

test('--prices rejects a bad file loudly, never silently ignoring it', async () => {
  const bad = await priceFile('not json');
  const r = run(['summary', '--prices', bad]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not valid JSON/);

  const neg = await priceFile(JSON.stringify({ 'gpt-5': { input: -1 } }));
  const r2 = run(['summary', '--prices', neg]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /finite number >= 0/);

  const missing = run(['summary', '--prices', '/nonexistent/nope.json']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /could not read/);

  const noArg = run(['summary', '--prices']);
  assert.notEqual(noArg.status, 0);
  assert.match(noArg.stderr, /expects a JSON file path/);
});

test('a free lane can be repriced by an explicit override', async () => {
  // The documented rule: overrides are checked BEFORE the :free tail. Someone
  // paying a proxy for "gpt-5:free" must be able to price it honestly.
  const { resolvePricing, loadPricingOverrides } = await import('../src/pricing.js');
  loadPricingOverrides({ 'gpt-5:free': { input: 0.5, output: 2 } });
  assert.equal(resolvePricing('gpt-5:free').input, 0.5);
  loadPricingOverrides({});
});
