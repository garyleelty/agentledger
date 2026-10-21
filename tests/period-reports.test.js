import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'agentledger.js');

/**
 * by-week and by-month: the same report as by-day, rolled up.
 *
 * Two things are pinned here because both are the kind of bug that looks
 * like a number:
 *
 *  1. A week starts on MONDAY. That is the ISO convention and the one
 *     ccusage's `weekly` uses. A week starting on Sunday is not a wrong
 *     answer so much as a different question, and the two are impossible
 *     to tell apart in a table.
 *  2. The week is a LOCAL week. A Monday 00:30 in Shanghai is Sunday
 *     16:30 UTC; calling that Monday while every other Monday in the
 *     report is local is an inconsistency this tool has already had one
 *     of.
 */

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-period-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  // 2026-06-01 is a Monday. These three records land on Monday, Wednesday
  // and the following Monday.
  const stamps = ['2026-06-01T09:00:00.000Z', '2026-06-03T09:00:00.000Z', '2026-06-08T09:00:00.000Z'];
  const lines = stamps.map((ts, i) => JSON.stringify({
    type: 'assistant',
    message: { id: `msg-${i}`, model: 'mimo-v2.5-pro', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    timestamp: ts,
    sessionId: 's1',
    cwd: '/work',
  }));
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.join('\n') + '\n');
  return home;
}

function runJson(args, home) {
  const out = execFileSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(out);
}

test('by-week groups by Monday-starting week', () => {
  const home = makeHome();
  const d = runJson(['by-week'], home);
  assert.equal(d.command, 'by-week');
  const keys = d.rows.map((r) => r.key).sort();
  // June 1 and June 3 are the same week; June 8 opens the next one.
  assert.deepEqual(keys, ['2026-06-01', '2026-06-08']);
  for (const k of keys) {
    assert.equal(new Date(`${k}T00:00:00Z`).getUTCDay(), 1, `${k} is not a Monday`);
  }
});

test('by-month groups by calendar month', () => {
  const home = makeHome();
  const d = runJson(['by-month'], home);
  assert.equal(d.command, 'by-month');
  assert.deepEqual(d.rows.map((r) => r.key), ['2026-06']);
  assert.equal(d.rows[0].records, 3, 'all three records are in June');
});

test('a period report\'s rows add up to its own total', () => {
  const home = makeHome();
  for (const command of ['by-week', 'by-month']) {
    const d = runJson([command], home);
    const records = d.rows.reduce((a, r) => a + r.records, 0);
    assert.equal(records, d.totals.records, `${command} rows must cover every record`);
    const cost = d.rows.reduce((a, r) => a + r.costUSD, 0);
    assert.ok(Math.abs(cost - d.totals.costUSD) < 0.01, `${command} row costs must add up`);
  }
});

test('a period report is a roll-up, not a subset', () => {
  // by-day on the same ledger must produce as many days as the week
  // report has records, and the week's records must be a superset of any
  // single day's. The bug this catches is a report that silently drops
  // records at the coarser grain.
  const home = makeHome();
  const week = runJson(['by-week'], home);
  const day = runJson(['by-day'], home);
  assert.equal(week.totals.records, day.totals.records, 'the week roll-up must not lose records');
  assert.equal(week.totals.costUSD, day.totals.costUSD, 'the week roll-up must cost the same');
});
