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
 * The statusline's active billing block.
 *
 * This is the part of ccusage's statusline that agentledger used to
 * concede outright ("its statusline shows 5-hour billing blocks and burn
 * rate"). Two things make it better here: the block is computed across
 * every lane rather than Claude Code alone, so a subscription that is not
 * Claude's still gets a window; and the window has a real end, not an
 * estimate.
 */

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-sline-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  // Two records inside the block that is running now, an hour and two
  // minutes ago. TWO, not one: the burn rate is tokens per minute over
  // the block's first-to-last record span, so a single-record block has
  // no rate to report — the same divide-by-zero guard ccusage has, and the
  // reason a one-record block shows `burnRate: null` there too.
  const lines = [-62 * 60_000, -60 * 60_000].map((offset, i) => JSON.stringify({
    type: 'assistant',
    message: { id: `msg-${i}`, model: 'mimo-v2.5-pro', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    timestamp: new Date(Date.now() + offset).toISOString(),
    sessionId: 's1',
    cwd: '/work',
  }));
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.join('\n') + '\n');
  return home;
}

function run(args, home) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home },
    input: '',
  });
}

test('the statusline reports the active block, its end, and the burn rate', () => {
  const home = makeHome();
  const d = JSON.parse(run(['statusline', '--json'], home));
  assert.ok(d.block, 'the statusline must carry the active block');
  assert.equal(typeof d.block.id, 'string');
  assert.ok(d.block.remainingMinutes > 0, 'a running block has time left in it');
  assert.ok(d.block.remainingMinutes <= 5 * 60, 'a block is five hours long at most');
  assert.ok(d.block.tokens > 0, 'the block carries the tokens spent inside it');
  assert.ok(d.block.burnRateTokensPerMinute > 0, 'the burn rate is computed from the block');
  // The block's scope is the window, not the calendar day. The statusline's
  // other figure is "today", and a test that runs at 00:01 local would
  // legitimately see an empty today while the block still holds the
  // records — so the two are NOT asserted equal. They are equal except in
  // the hour after midnight, and asserting equality there is asserting
  // something false twice a day.
  assert.ok(d.block.tokens > 0, 'the block holds the tokens spent inside it');
});

test('the text statusline shows the block and the time left', () => {
  const home = makeHome();
  const out = run(['statusline'], home);
  assert.match(out, /block \$/, 'the block cost must be on the line');
  assert.match(out, /\d+h \d+m left/, 'the time left in the window must be on the line');
});

test('a statusline with no usage still runs', () => {
  // An empty ledger must not produce a block, and must not crash.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-sline-empty-'));
  const out = run(['statusline'], home);
  assert.doesNotMatch(out, /NaN|undefined/, 'the empty case must still print something sane');
  const d = JSON.parse(run(['statusline', '--json'], home));
  assert.equal(d.block, null, 'there is no block when nothing has been used');
});
