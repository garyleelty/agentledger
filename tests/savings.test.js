import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `savings` prices the counterfactual: the same records with cache-read tokens
 * billed at each model's fresh-input rate instead of its cache rate.
 *
 * The number it produces is the tool's whole headline, so the arithmetic has to
 * be checkable rather than asserted. These tests pin:
 *
 *   - actual + savings == withoutCache, exactly;
 *   - the counterfactual really is higher (a bug that zeroed saving would
 *     otherwise make the headline number silently disappear);
 *   - a record with no cache reads contributes nothing, and the command says so
 *     rather than printing a 0% bar.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

// Fixture HOME with committed session logs: a CI runner has none, and every
// assertion below ("the counterfactual must cost more") is meaningless on a
// ledger that silently measured zero records.
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, HOME: fixtureHome, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('savings --json reconciles: actual + savings == withoutCache', () => {
  const { status, stdout } = run(['savings', '--json']);
  assert.equal(status, 0);
  const d = JSON.parse(stdout);
  assert.ok(d.records > 0);
  assert.ok(d.withoutCacheUSD > d.actualUSD, 'the counterfactual must cost more than what was paid');
  assert.ok(d.savingsUSD > 0, 'saving must be positive on a real ledger');
  assert.ok(
    Math.abs(d.actualUSD + d.savingsUSD - d.withoutCacheUSD) < 1e-6,
    `components must sum exactly: ${d.actualUSD} + ${d.savingsUSD} != ${d.withoutCacheUSD}`,
  );
  assert.equal(
    d.totalTokens,
    d.inputTokens + d.cacheReadTokens + d.cacheWriteTokens + d.outputTokens,
    'token buckets must sum to the total',
  );
});

test('savings satisfies the counterfactual when recomputed by hand', async () => {
  const { resolvePricing } = await import('../src/pricing.js');
  const { collect, withCost, totals } = await import('../src/ledger.js');
  const { savingsOf } = await import('../bin/agentledger.js');

  const savedHome = process.env.HOME;
  process.env.HOME = fixtureHome;
  let records;
  try {
    ({ records } = await collect());
  } finally {
    process.env.HOME = savedHome;
  }
  // An empty ledger makes every equality below vacuously true; require data.
  assert.ok(records.length > 0, 'the fixture home must produce records');
  assert.ok(records.some((r) => r.cacheRead > 0), 'the fixture must contain cache reads to counterfactually price');

  const priced = records.map(withCost);
  const reported = savingsOf(priced);

  const t = totals(priced);
  let without = 0;
  for (const r of priced) {
    const p = resolvePricing(r.model);
    // Model the TTL split independently of the shipped helper: 1-hour writes
    // ride at 2x in the counterfactual too, so savings cancels them exactly
    // as the production path does. An inline copy of the *rule*, not of the
    // function — if the two ever disagree, this test has earned its keep.
    const hasSplit = (r.cacheWrite1h || 0) + (r.cacheWrite5m || 0) > 0 && p.cacheWrite1hMultiplier != null;
    const writeCost = hasSplit
      ? ((r.cacheWrite5m || 0) * p.input * p.cacheWriteMultiplier
         + (r.cacheWrite1h || 0) * p.input * p.cacheWrite1hMultiplier) / 1e6
      : ((r.cacheWrite ?? 0) * p.input * p.cacheWriteMultiplier) / 1e6;
    without += (
      ((r.input ?? 0) + (r.cacheRead ?? 0)) * p.input
      + (r.output ?? 0) * p.output
    ) / 1e6 + writeCost;
  }
  assert.ok(Math.abs(reported.withoutCacheUSD - without) < 1e-6,
    `withoutCache mismatch: ${reported.withoutCacheUSD} vs ${without}`);
  assert.ok(Math.abs(reported.actualUSD - t.cost) < 1e-6,
    `actual mismatch: ${reported.actualUSD} vs ${t.cost}`);
});

test('the rendered report names the saving, not just the spend', () => {
  const { stdout } = run(['savings']);
  assert.match(stdout, /What prompt caching saved/);
  assert.match(stdout, /without cache/);
  assert.match(stdout, /\d+\.\d% cheaper/);
  assert.match(stdout, /came from cache/);
});

test('a ledger with no cache reads reports that honestly, not a 0% bar', () => {
  const { stdout } = run(['savings'], { HOME: '/nonexistent-path-for-tests' });
  assert.match(stdout, /No agent sessions found/);
  assert.doesNotMatch(stdout, /0\.0% cheaper/, 'a 0% bar reads as a measurement');
});

test('savings is listed in --help', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /savings\s+What prompt caching saved/);
});
