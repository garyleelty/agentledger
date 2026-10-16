import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseClaudeCode } from '../src/parsers.js';

/**
 * Claude Code re-emits the same assistant message: a resumed session, a
 * sidechain replay, and a retried request all write another row with the same
 * `message.id`. Summing every row double-counted this machine 2.2x — it
 * reported $15.67 for a lane that costs ~$2.21 — and the token totals did not
 * match ccusage's on the same files.
 *
 * Found by running ccusage's own binary against the same logs and comparing
 * per-model token counts, not by reading either tool's docs. ccusage
 * deduplicates on message id (DedupeIndex, rust/adapters/claude/src/lib.rs);
 * these tests pin that the same rule holds here.
 */

async function log(rows) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-dedup-'));
  const file = path.join(dir, 's.jsonl');
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const assistant = (id, tokens, extra = {}) => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  isSidechain: false,
  message: { id, model: 'claude-sonnet-4-5', usage: tokens },
  ...extra,
});

test('a message id written twice is counted once', async () => {
  const file = await log([
    assistant('msg_1', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 }),
    assistant('msg_1', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 }),
    assistant('msg_2', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2000 }),
  ]);
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 2, 'two distinct messages, not three rows');
  assert.equal(records.reduce((a, r) => a + r.input, 0), 300);
  assert.equal(records.reduce((a, r) => a + r.cacheRead, 0), 3000);
});

test('the non-sidechain copy wins when both exist', async () => {
  const file = await log([
    assistant('m', { input_tokens: 5, output_tokens: 1 }, { isSidechain: true }),
    assistant('m', { input_tokens: 5, output_tokens: 1 }, { isSidechain: false }),
  ]);
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 1);
  // the internal marker must not leak into the record shape
  assert.equal(records[0].isSidechain, undefined);
  assert.equal(records[0].messageId, undefined);
});

test('with two sidechain copies the larger token total wins', async () => {
  // ccusage's rule: sidechain-vs-sidechain is broken by total tokens.
  const file = await log([
    assistant('m', { input_tokens: 10, output_tokens: 1 }, { isSidechain: true }),
    assistant('m', { input_tokens: 999, output_tokens: 1 }, { isSidechain: true }),
  ]);
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 999, 'the fuller record is kept');
});

test('a record with no message id is kept, not dropped', async () => {
  // Dropping usage because it lacks an id would under-report; keeping it may
  // double-count in a pathological log, but losing real spend is worse.
  const file = await log([
    { type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 7, output_tokens: 1 } } },
  ]);
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 7);
});
