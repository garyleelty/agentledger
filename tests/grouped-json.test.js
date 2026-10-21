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
 * A grouped report's `--json` must BE the breakdown.
 *
 * Six commands used to answer `--json` with the full record dump: asking for
 * "by-model JSON" got 18,017 rows and no model breakdown, so a consumer had
 * to group them itself — the same work the command had already done, thrown
 * away on the way out. The record dump is still one command away
 * (`agentledger json`), so nothing is lost.
 *
 * These run against a synthetic log directory, so the numbers are the
 * tool's own and the assertions can be exact.
 */

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-json-'));
  // One Claude Code session with two records in two models.
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'assistant', message: { model: 'mimo-v2.5-pro', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 } }, timestamp: '2026-06-01T10:00:00.000Z', sessionId: 's1', cwd: '/work' },
    { type: 'assistant', message: { model: 'gpt-5.5', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } }, timestamp: '2026-06-01T11:00:00.000Z', sessionId: 's1', cwd: '/work' },
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
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

test('a grouped report answers --json with its own breakdown, not the record dump', () => {
  const home = makeHome();
  for (const command of ['by-model', 'by-project', 'by-branch', 'by-day', 'sessions']) {
    const d = runJson([command], home);
    assert.equal(d.command, command, `${command} must name itself in the JSON`);
    assert.ok(Array.isArray(d.rows), `${command} must return a rows array`);
    assert.ok(d.rows.length > 0, `${command} must return at least one row`);
    // The record dump is NOT what came back: that was the old shape, and
    // the whole point of the change.
    assert.equal(d.records, undefined, `${command} must not return the raw record dump`);
    // Every row is a group, so it has a key and a cost.
    for (const row of d.rows) {
      assert.equal(typeof row.key, 'string', `${command} row must have a string key`);
      assert.equal(typeof row.costUSD, 'number', `${command} row must have a numeric cost`);
      assert.equal(typeof row.records, 'number', `${command} row must have a record count`);
      assert.equal(typeof row.tokens.input, 'number', `${command} row must have token counts`);
    }
  }
});

test('by-model breaks the records down per model, with the totals agreeing', () => {
  const home = makeHome();
  const d = runJson(['by-model'], home);
  const models = d.rows.map((r) => r.key).sort();
  assert.deepEqual(models, ['gpt-5.5', 'mimo-v2.5-pro']);
  // The rows must add up to the same total the command reports.
  const summed = d.rows.reduce((a, r) => a + r.costUSD, 0);
  assert.ok(Math.abs(summed - d.totals.costUSD) < 0.01, 'row costs must add up to the total');
  const records = d.rows.reduce((a, r) => a + r.records, 0);
  assert.equal(records, d.totals.records, 'row record counts must add up to the total');
});

test('the record dump is still available, one command away', () => {
  // The change moved the breakdown into the grouped reports; it must not
  // have removed the raw records from the tool.
  const home = makeHome();
  const d = runJson(['json'], home);
  assert.ok(Array.isArray(d.records), 'the json command still returns the record dump');
  assert.equal(d.records.length, 2);
});
