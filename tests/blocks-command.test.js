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
 * The `blocks` command, end to end through the CLI.
 *
 * The block algorithm itself is pinned in tests/blocks.test.js. This file
 * pins the two things the command does that the module does not:
 *
 *  1. `<synthetic>` records are excluded. Claude Code writes placeholder
 *     turns under that model name with every bucket zero. They are not
 *     usage, and keeping them opens blocks that contain nothing — which
 *     is how a "where did my quota go" report starts showing empty
 *     windows.
 *  2. `--until` filters the ledger. A bare date is INCLUSIVE of that day,
 *     because "--until 2026-06-18" means "through the end of the 18th",
 *     and a date that does not exist on the calendar is an error rather
 *     than a rollover.
 */

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-blocks-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  // Two records inside one 5-hour window, and a third that opens a second
  // window seven hours later.
  const lines = [
    { type: 'assistant', message: { model: 'mimo-v2.5-pro', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 } }, timestamp: '2026-06-01T10:05:00.000Z', sessionId: 's1', cwd: '/work' },
    { type: 'assistant', message: { model: 'mimo-v2.5-pro', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }, timestamp: '2026-06-01T10:30:00.000Z', sessionId: 's1', cwd: '/work' },
    { type: 'assistant', message: { model: 'mimo-v2.5-pro', usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } }, timestamp: '2026-06-01T17:10:00.000Z', sessionId: 's1', cwd: '/work' },
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return home;
}

function run(args, home) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home },
  });
}

function runJson(args, home) {
  return JSON.parse(run([...args, '--json'], home));
}

test('blocks groups the ledger into windows and names them', () => {
  const home = makeHome();
  const d = runJson(['blocks'], home);
  assert.equal(d.command, 'blocks');
  assert.equal(d.blockHours, 5);
  const real = d.blocks.filter((b) => !b.isGap);
  assert.equal(real.length, 2, 'two windows of activity, not one');
  // The first window starts at the top of the hour of its first record.
  assert.equal(real[0].id, '2026-06-01T10:00:00.000Z');
  assert.equal(real[0].endTime, '2026-06-01T15:00:00.000Z');
  assert.equal(real[0].entries, 2);
  // The third record is more than five hours past the window start, so it
  // opens a new one.
  assert.equal(real[1].id, '2026-06-01T17:00:00.000Z');
  assert.equal(real[1].entries, 1);
});

test('a <synthetic> record does not open a block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-synth-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'assistant', message: { model: 'mimo-v2.5-pro', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, timestamp: '2026-06-01T10:05:00.000Z', sessionId: 's1', cwd: '/work' },
    // A placeholder turn three days later, with no tokens at all.
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, timestamp: '2026-06-04T10:05:00.000Z', sessionId: 's1', cwd: '/work' },
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const d = runJson(['blocks'], home);
  const real = d.blocks.filter((b) => !b.isGap);
  assert.equal(real.length, 1, 'a placeholder turn must not open a second window');
  assert.equal(real[0].entries, 1, 'and it must not be counted as usage');
});

test('--until is inclusive of the day it names', () => {
  const home = makeHome();
  const all = runJson(['by-day'], home);
  const until = runJson(['by-day', '--until', '2026-06-01'], home);
  assert.ok(all.rows.length >= until.rows.length, '--until must not widen the report');
  // Every surviving row is on or before the named day.
  for (const row of until.rows) assert.ok(row.key <= '2026-06-01', `row ${row.key} is after the bound`);
});

test('--until rejects a date that does not exist', () => {
  const home = makeHome();
  // Date.parse('2026-02-30') rolls over to March 2 rather than failing, so
  // a typo would become a real date and a wrong range.
  assert.throws(
    () => run(['by-day', '--until', '2026-02-30'], home),
    /not a real date/,
  );
});

test('the blocks table renders without a single dash of NaN', () => {
  const home = makeHome();
  const out = run(['blocks'], home);
  assert.doesNotMatch(out, /NaN|undefined|\[object/, 'the table must not print invalid values');
  assert.match(out, /Block start/, 'the table must have its header');
});
