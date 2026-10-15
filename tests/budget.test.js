import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `budget` is the only command that answers a question about the future rather
 * than the past: am I about to go over. It is the shape a statusline or a CI
 * gate wants, which is why --json is honoured here.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

// Fixture HOME with committed session logs: CI has no ~/.claude, and budget
// assertions against a silent zero-record ledger would prove nothing.
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, HOME: fixtureHome },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('budget reports spend, remaining, and a run rate', () => {
  const { status, stdout } = run(['budget', '-b', '1']);
  assert.equal(status, 0);
  assert.match(stdout, /budget\s+\$1/);
  assert.match(stdout, /spent/);
  assert.match(stdout, /remaining/);
  assert.match(stdout, /run rate/);
});

test('budget marks an overrun instead of clamping at zero', () => {
  // The fixture ledger has spent ~$0.19; a $0.10 budget must show the overrun.
  const { stdout } = run(['budget', '-b', '0.1']);
  assert.match(stdout, /OVER by/, 'an overrun must be named, not shown as $0 remaining');
});

test('budget under the limit reports days left, not an overrun', () => {
  const { stdout } = run(['budget', '-b', '1']);
  assert.doesNotMatch(stdout, /OVER by/);
  assert.match(stdout, /days left at this rate/);
});

test('budget --json is machine-readable and flags the overrun', () => {
  const { status, stdout } = run(['budget', '-b', '0.1', '--json']);
  assert.equal(status, 0);
  const d = JSON.parse(stdout);
  assert.equal(d.budgetUSD, 0.1);
  assert.ok(d.spentUSD > 0);
  assert.equal(d.over, d.remainingUSD < 0);
  assert.ok(Number.isFinite(d.runRateUSDPerDay));
  assert.ok(d.window && d.window.from && d.window.to, 'the window must be reported');
  assert.ok(d.window.days > 0);
});

test('budget --json omits daysUntilRunOut once the budget is blown', () => {
  const d = JSON.parse(run(['budget', '-b', '0.1', '--json']).stdout);
  assert.equal(d.over, true);
  // "days left" is meaningless when already over; null is the honest answer.
  assert.equal(d.daysUntilRunOut, null);
});

test('budget refuses a missing, zero, negative, or non-numeric limit', () => {
  const missing = run(['budget']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /budget needs a limit/);

  for (const bad of ['0', '-5', 'abc', '']) {
    const r = run(['budget', '-b', bad]);
    assert.notEqual(r.status, 0, `-b ${JSON.stringify(bad)} must fail`);
    assert.match(r.stderr, /expects a positive number of dollars/);
  }
});

test('budget honours --since, so a window can be measured on purpose', () => {
  const all = JSON.parse(run(['budget', '-b', '1', '--json']).stdout);
  const recent = JSON.parse(run(['budget', '-b', '1', '--since', '2026-08-01', '--json']).stdout);
  assert.ok(recent.spentUSD <= all.spentUSD, 'a narrower window cannot cost more');
  assert.ok(recent.records <= all.records);
});

test('budget is listed in --help', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /budget/);
});
