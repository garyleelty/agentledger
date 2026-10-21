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
 * The agent's own cost, next to agentledger's estimate.
 *
 * Claude Code writes its own pre-calculated cost on the JSONL line, as a
 * sibling of `message` rather than inside it. ccusage picks ONE of the two
 * numbers (`auto` prefers the stored cost, `calculate` prefers its own
 * table) and prints the other only in `--debug`.
 *
 * agentledger prints BOTH, and the difference between them, because two
 * independent calculations of the same bill disagreeing is information
 * worth having — and a pricing table that has drifted out of date is
 * exactly the thing a cost tool should show you rather than hide.
 *
 * The stored cost is never used to PRICE anything. It is a second opinion.
 */

function makeHome(withCost) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-stored-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'mimo-v2.5-pro',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-06-01T10:00:00.000Z',
    sessionId: 's1',
    cwd: '/work',
  };
  if (withCost) rec.costUSD = 12.34;
  fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(rec) + '\n');
  return home;
}

function run(args, home) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home },
  });
}

test('the stored cost is read from the top level of the line', () => {
  const home = makeHome(true);
  const d = JSON.parse(run(['json'], home));
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].storedCostUSD, 12.34, 'the agent\'s own cost must be carried through');
});

test('a source that writes no cost reports null, not zero', () => {
  // Zero would be a claim ("this cost nothing"). Null is the truth.
  const home = makeHome(false);
  const d = JSON.parse(run(['json'], home));
  assert.equal(d.records[0].storedCostUSD, null);
});

test('the summary prints both numbers and the difference', () => {
  const home = makeHome(true);
  const out = run([], home);
  assert.match(out, /agent's own total/, 'the stored total must be shown');
  assert.match(out, /agentledger's estimate/, 'the estimate must be shown beside it');
  assert.match(out, /Difference:/, 'the difference between the two must be shown');
});

test('the summary says nothing about a stored cost when there is none', () => {
  const home = makeHome(false);
  const out = run([], home);
  assert.doesNotMatch(out, /agent's own total/, 'no stored cost means no comparison to print');
});

test('the stored cost never prices the report', () => {
  // The report's own total is computed from tokens against the price table.
  // If the stored cost were used, the "TOTAL" line would change when a
  // cost field appeared — and the tool would be quoting a number it cannot
  // reproduce from tokens.
  const withCost = JSON.parse(run(['json'], makeHome(true)));
  const without = JSON.parse(run(['json'], makeHome(false)));
  assert.equal(
    withCost.records[0].costUSD,
    without.records[0].costUSD,
    'the priced total must not depend on the stored cost',
  );
  assert.ok(withCost.records[0].costUSD > 0, 'the priced total is still computed from tokens');
});
