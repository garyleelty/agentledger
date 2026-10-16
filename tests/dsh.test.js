import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseDsh, PARSERS } from '../src/parsers.js';
import { SOURCES } from '../src/ledger.js';

/**
 * DSH (DeepSeek Harness) is the sixth source and the only compressed one: it
 * appends one zstd frame per write, so a real session file is dozens of
 * concatenated frames. Node's zstdDecompressSync reads only the FIRST frame —
 * which silently yielded 238 bytes of a 776 kB session and zero records.
 * That failure is invisible (no error, just an empty lane), so it gets a test
 * built from a genuinely multi-frame file.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * zstd landed in Node 23.8. The parser degrades to zero records on the 22.5
 * floor (by design), so the fixture builders cannot run there either — the
 * suite has to skip rather than fail, or the matrix leg fails for the one
 * environment where the lane is legitimately inert. CI caught this: the
 * tests passed on 24/26 and died on 22.5 with 'zstdCompressSync is not a
 * function', which is a test-environment fact, not a product defect.
 */
const zstd = await import('node:zlib');
const hasZstd = typeof zstd.zstdCompressSync === 'function' && typeof zstd.zstdDecompressSync === 'function';
const skip = hasZstd ? false : 'node:zlib has no zstd on this Node (< 23.8); the dsh lane is inert here';

async function multiFrameSession() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-dsh-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const events = [
    { type: 'session', id: 'session-test', cwd: '/work/dsh-proj' },
    { type: 'request/header', data: { header: { config: { model: 'test-model-a' } } } },
    { type: 'assistant/message', time: 1000, data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', time: 2000, data: { usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 40 } } },
    { type: 'request/header', data: { header: { config: { model: 'test-model-b' } } } },
    { type: 'assistant/message', time: 3000, data: { usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  ];
  // one frame per event, exactly how the harness appends
  const frames = events.map((e) => zstd.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')));
  await writeFile(file, Buffer.concat(frames));
  return file;
}

test('parseDsh reads every zstd frame, not just the first', { skip }, async () => {
  const file = await multiFrameSession();
  const records = [];
  for await (const r of parseDsh(file)) records.push(r);
  assert.equal(records.length, 3, 'all three assistant turns must survive multi-frame decompression');
  assert.equal(records[0].input, 100);
  assert.equal(records[0].cacheRead, 500);
  assert.equal(records[1].cacheWrite, 40);
  assert.equal(records[2].input, 300);
});

test('parseDsh attributes each turn to the model in the latest request header', { skip }, async () => {
  const file = await multiFrameSession();
  const records = [];
  for await (const r of parseDsh(file)) records.push(r);
  assert.deepEqual(records.map((r) => r.model), ['test-model-a', 'test-model-a', 'test-model-b'],
    'a model switch mid-session must be picked up, not frozen at the first value');
});

test('parseDsh skips a torn frame instead of failing the file', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-dsh-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const good = zstd.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 1 } } }) + '\n'));
  const torn = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]); // magic + garbage
  await writeFile(file, Buffer.concat([good, torn]));
  const records = [];
  for await (const r of parseDsh(file)) records.push(r);
  assert.equal(records.length, 1, 'the readable frame survives');
});

test('parseDsh tolerates a file that is not zstd at all', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-dsh-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  await writeFile(file, 'not compressed at all\n');
  const records = [];
  for await (const r of parseDsh(file)) records.push(r);
  assert.equal(records.length, 0, 'an unreadable store is skipped, never thrown');
});

test('dsh is advertised as a supported source', () => {
  const src = SOURCES.find((s) => s.agent === 'dsh');
  assert.ok(src, 'dsh must be in SOURCES');
  assert.match(src.root, /\.dsh\/sessions/);
  assert.equal(src.parser, PARSERS.dsh);
});
