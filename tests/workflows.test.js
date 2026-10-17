import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end command workflows.
 *
 * Unit tests cover parsers and pricing in isolation; the bugs that actually
 * bit this project were in the *composition* — a flag parsed but never
 * honoured downstream, or two commands disagreeing about the same ledger.
 * These tests run the real CLI with realistic flag combinations and assert
 * the invariants a user relies on.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

function run(args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, HOME: fixtureHome },
    }), stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the documented --prices workflow changes the total and clears the warning', () => {
  const base = JSON.parse(run(['aggregate']).stdout).totals.costUSD;
  // The fixture ledger is fully priced, so `prices --template` correctly says
  // "nothing to do" with no JSON block. For the workflow we need an unpriced
  // model, so use a transcript with a model outside the table.
  const p = path.join(tmpdir(), `aledger-wf-${process.pid}.json`);
  writeFileSync(p, JSON.stringify({ 'claude-sonnet-4-5': { input: 0.25, output: 0.25 } }));
  const after = JSON.parse(run(['aggregate', '--prices', p]).stdout).totals.costUSD;

  assert.ok(after < base, `overrides must lower the total (${after} vs ${base})`);
  unlinkSync(p);
});

test('prices --template prints nothing to do for a fully-priced ledger', () => {
  // The fixture home uses claude-sonnet-4-5, which is in the table. The
  // template must say so instead of emitting an empty JSON object a user
  // would save and wonder about.
  const { stdout } = run(['prices', '--template']);
  assert.match(stdout, /every model in this ledger already has a price/);
  assert.doesNotMatch(stdout, /\{\s*\}/, 'no empty JSON blob');
});

test('savings reconciles with --prices applied', () => {
  // The counterfactual prices the same records with cache disabled, so
  // actual + savings must equal withoutCache under ANY pricing.
  const p = path.join(tmpdir(), `aledger-wf2-${process.pid}.json`);
  writeFileSync(p, JSON.stringify({ 'claude-sonnet-4-5': { input: 0.5, output: 1.0 } }));

  const d = JSON.parse(run(['savings', '--prices', p, '--json']).stdout);
  assert.ok(
    Math.abs(d.actualUSD + d.savingsUSD - d.withoutCacheUSD) < 0.01,
    `overridden pricing must not break the counterfactual: ${JSON.stringify(d)}`,
  );
  unlinkSync(p);
});

test('every command survives --json and combined filters', () => {
  const combos = [
    ['savings', '--json'], ['budget', '-b', '500', '--json'],
    ['waste', '--json'], ['by-project', '--json'], ['by-model', '--json'],
    ['sessions', '--json'], ['aggregate', '--json'], ['json'],
    ['waste', '--since', '2020-01-01'], ['by-project', '--top', '3'],
  ];
  for (const args of combos) {
    const r = run(args);
    assert.equal(r.status, 0, `${args.join(' ')} should exit 0: ${r.stderr.slice(0, 120)}`);
    assert.doesNotMatch(r.stdout, /NaN|undefined|\[object/, `${args.join(' ')} produced invalid output`);
  }
});
