import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseQwen, qwenProjects, QWEN_SESSION_MATCH } from '../src/parsers-qwen.js';

/**
 * Qwen Code (Alibaba's Gemini CLI fork) reads one JSONL file per session.
 *
 * The traps are all in the token buckets, and one of them is a double count.
 * What is pinned here:
 *
 *   1. **The fresh input is `promptTokenCount - cachedContentTokenCount`**,
 *      never `promptTokenCount`. The prompt count is the WHOLE prompt, cached
 *      part included — the cache read is a SUBSET of it, not an addition to
 *      it. The fixture gives the two different values, so a parser that
 *      priced the whole prompt as fresh would fail here.
 *   2. **The reasoning is ADDITIVE**, a sibling of the visible output and
 *      not a component of it, so the two are added. This is the opposite of
 *      the Cherry Studio and WorkBuddy lanes, where the reasoning is already
 *      inside the output — the lanes disagree, and this one follows the
 *      record shape, not an analogy.
 *   3. **The cache-write bucket is 0**, because the Gemini family exposes no
 *      cache-write field at all. It must never be invented.
 *   4. **The model is the top-level `model`**, and defaults to `'unknown'`.
 *   5. **Only an assistant turn is a model call.** The bundle attaches the
 *      usage to assistant turns and to nothing else, so a usage block on
 *      any other kind of record is skipped.
 *   6. **The `logs.json` array under `~/.qwen/tmp/` is NOT read.** It has
 *      the Gemini CLI's shape and the `gemini-cli` lane already reads that
 *      file; reading it here would count the same requests twice.
 *
 * Every fixture here is synthetic: a fake home directory with fake chat
 * files. The machine's real store is not a fixture — a test that changes
 * when the machine does is not a test. The real store is measured in the
 * parser's docstring: two sessions, 17 records, and ZERO of them an
 * assistant turn, because all four API calls in them failed with a 401.
 */

const chatsRoot = (home) => path.join(qwenProjects(home), '-Users-tianyi', 'chats');

/**
 * Write a fake Qwen chat file at the real path shape.
 *
 * @param {string} home
 * @param {string} sessionId the session uuid (the file stem)
 * @param {Array<object|string>} records the records, as objects or raw lines
 * @param {string} [slug] the cwd slug of the project directory
 * @returns {Promise<string>} the path of the file
 */
async function writeChat(home, sessionId, records, slug = '-Users-tianyi') {
  const dir = path.join(qwenProjects(home), slug, 'chats');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const body = records
    .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
    .join('\n');
  await writeFile(file, `${body}\n`);
  return file;
}

/**
 * An assistant turn, in the shape Qwen Code really writes it.
 *
 * The envelope is qwen-code's `createBaseRecord`; the `model` and the
 * `usageMetadata` are added to an assistant turn by `recordAssistantTurn`.
 * The bundle attaches the usage at the TOP LEVEL of the line, not inside
 * `message`.
 */
function turn({
  sessionId = 'fa14eacd-9757-4666-afb5-8cc7e3902b5a',
  timestamp = '2026-04-20T14:18:00.899Z',
  cwd = '/Users/tianyi',
  version = '0.14.5',
  gitBranch,
  model = 'qwen3.5-plus',
  prompt = 1000,
  cached = 400,
  visible = 100,
  reasoning = 50,
  total = prompt + visible + reasoning,
  type = 'assistant',
  withUsage = true,
} = {}) {
  const rec = {
    uuid: '2d15688b-40f5-4ca1-8359-d9efb98f1a0e',
    parentUuid: '2096b99a-5cec-42b0-a99b-f4f47d664c35',
    sessionId,
    timestamp,
    type,
    cwd,
    version,
    message: { role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
  };
  if (gitBranch !== undefined) rec.gitBranch = gitBranch;
  if (model !== null) rec.model = model;
  if (withUsage) {
    rec.usageMetadata = {
      promptTokenCount: prompt,
      cachedContentTokenCount: cached,
      candidatesTokenCount: visible,
      thoughtsTokenCount: reasoning,
      totalTokenCount: total,
    };
  }
  return rec;
}

/** A user turn, as qwen-code writes it. */
function userTurn({ sessionId = 'fa14eacd-9757-4666-afb5-8cc7e3902b5a' } = {}) {
  return {
    uuid: 'bfce9dac-e322-47f1-8c05-59d9d8d9e37c',
    parentUuid: null,
    sessionId,
    timestamp: '2026-04-20T14:15:08.358Z',
    type: 'user',
    cwd: '/Users/tianyi',
    version: '0.14.5',
    message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  };
}

/** A system turn, as qwen-code writes it. */
function systemTurn({ subtype = 'ui_telemetry' } = {}) {
  return {
    uuid: 'e02b3d96-b9cd-4d62-8bb3-2791fe971fb4',
    parentUuid: 'bfce9dac-e322-47f1-8c05-59d9d8d9e37c',
    sessionId: 'fa14eacd-9757-4666-afb5-8cc7e3902b5a',
    timestamp: '2026-04-20T14:15:08.940Z',
    type: 'system',
    cwd: '/Users/tianyi',
    version: '0.14.5',
    subtype,
    systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_error', status_code: 401 } },
  };
}

/** Collect the records a parser yields. */
async function collect(file) {
  const records = [];
  for await (const r of parseQwen(file)) records.push(r);
  return records;
}

const FIELDS = [
  'agent', 'model', 'session', 'timestamp', 'input',
  'cacheRead', 'cacheWrite', 'output', 'project', 'branch',
];

test('one assistant turn becomes one record, with the expected field set', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [turn({})]);

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), [...FIELDS].sort());
  assert.equal(records[0].agent, 'qwen');
  assert.equal(records[0].session, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a');
  assert.equal(records[0].timestamp, Date.parse('2026-04-20T14:18:00.899Z'));
  assert.equal(records[0].project, '/Users/tianyi');
});

test('the fresh input is the prompt minus the cache read, never the whole prompt', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ prompt: 1000, cached: 400 }),
  ]);

  const [rec] = await collect(file);
  assert.equal(rec.input, 600, 'the fresh input is promptTokenCount - cachedContentTokenCount');
  assert.notEqual(rec.input, 1000, 'promptTokenCount is the WHOLE prompt and is not the fresh input');
  assert.equal(rec.cacheRead, 400, 'the cache read is cachedContentTokenCount');
  assert.equal(rec.input + rec.cacheRead, 1000, 'the two buckets still add up to the whole prompt');
});

test('a prompt with no cached part is entirely fresh', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ prompt: 1234, cached: 0 }),
  ]);

  const [rec] = await collect(file);
  assert.equal(rec.input, 1234);
  assert.equal(rec.cacheRead, 0);
});

test('the reasoning is a separate bucket, added to the visible output', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ visible: 100, reasoning: 50 }),
  ]);

  const [rec] = await collect(file);
  assert.equal(rec.output, 150, 'the reasoning is a sibling of the output, so the two are added');
  assert.notEqual(rec.output, 100, 'the reasoning must not be dropped');
});

test('the buckets add up to the total the record reports', async () => {
  // The consistency check that pins all three semantic decisions at once:
  // fresh input + cache read + output === totalTokenCount.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ prompt: 1000, cached: 400, visible: 100, reasoning: 50, total: 1150 }),
  ]);

  const [rec] = await collect(file);
  assert.equal(rec.input + rec.cacheRead + rec.output, 1150);
  assert.equal(rec.input + rec.cacheRead + rec.output, rec.output + 600 + 400);
});

test('the total is not used to inflate the output', async () => {
  // Gemini's total can include tool-use prompt tokens, which have no bucket
  // of their own. Folding the remainder into the output would invent spend
  // in the wrong bucket, so the buckets are taken from the bucket fields and
  // the total is only ever a check.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ prompt: 1000, cached: 400, visible: 100, reasoning: 50, total: 9000 }),
  ]);

  const [rec] = await collect(file);
  assert.equal(rec.output, 150, 'the total must not be added to the output');
  assert.equal(rec.input, 600);
});

test('the cache-write bucket is 0, because the product reports no cache write', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [turn({})]);

  const [rec] = await collect(file);
  assert.equal(rec.cacheWrite, 0);
});

test('a usage block with a cache-write field is still not a cache write', async () => {
  // The Gemini family has no cache-write field. If a future version invents
  // one, this lane must still not report it: there is no way to know the
  // field means what it looks like.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const rec = turn({});
  rec.usageMetadata.cacheCreationTokenCount = 999;
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [rec]);

  const [out] = await collect(file);
  assert.equal(out.cacheWrite, 0, 'no cache-write field is ever read');
});

test('the model is the top-level model, and defaults to unknown', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ model: 'qwen3.6-plus' }),
  ]);

  const [rec] = await collect(file);
  assert.equal(rec.model, 'qwen3.6-plus');
});

test('a record with no model reports unknown rather than being dropped', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ model: null }),
  ]);

  const records = await collect(file);
  assert.equal(records.length, 1, 'real spend is kept even when the model is unknown');
  assert.equal(records[0].model, 'unknown');
});

test('a record with no usageMetadata produces no record', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    userTurn(),
    systemTurn(),
    turn({ withUsage: false }),
  ]);

  const records = await collect(file);
  assert.equal(records.length, 0);
});

test('a non-assistant record with a usage block is skipped, not read', async () => {
  // The bundle attaches the usage to assistant turns and to nothing else, so
  // a usage block on any other kind of record is not this lane's to count.
  // ccusage's qwen parser makes the same choice.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ type: 'user' }),
    turn({ type: 'system' }),
  ]);

  const records = await collect(file);
  assert.equal(records.length, 0, 'only an assistant turn is a model call');
});

test('a record whose buckets are all zero is an event, not spend', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ prompt: 0, cached: 0, visible: 0, reasoning: 0, total: 0 }),
  ]);

  const records = await collect(file);
  assert.equal(records.length, 0);
});

test('a truncated final line is skipped and the rest of the file is kept', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const good = JSON.stringify(turn({}));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    good,
    '{"uuid":"2d15688b","type":"assistant","usageMetadata":{"promptTokenCount":1000,',
  ]);

  const records = await collect(file);
  assert.equal(records.length, 1, 'the torn tail is dropped, the good line survives');
  assert.equal(records[0].input, 600);
});

test('a missing file yields no records and does not throw', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const missing = path.join(home, '.qwen', 'projects', 'nope', 'chats', 'gone.jsonl');

  const records = await collect(missing);
  assert.deepEqual(records, []);
});

test('a missing directory yields no records and does not throw', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  assert.deepEqual(await collect(path.join(home, 'no-such-dir', 'x.jsonl')), []);
});

test('a record with no cwd yields a null project', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const rec = turn({});
  delete rec.cwd;
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [rec]);

  const [out] = await collect(file);
  assert.equal(out.project, null);
  assert.equal(out.input, 600, 'the usage is still real even without a project');
});

test('a record with no sessionId falls back to the file stem', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const rec = turn({});
  delete rec.sessionId;
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [rec]);

  const [out] = await collect(file);
  assert.equal(out.session, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a');
});

test('a record with no timestamp yields a null timestamp', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const rec = turn({});
  delete rec.timestamp;
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [rec]);

  const [out] = await collect(file);
  assert.equal(out.timestamp, null);
});

test('an unparseable timestamp yields a null timestamp, not a NaN', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ timestamp: 'not-a-date' }),
  ]);

  const [out] = await collect(file);
  assert.equal(out.timestamp, null);
});

test('the branch is read when the project is a git repository', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    turn({ gitBranch: 'main' }),
  ]);

  const [out] = await collect(file);
  assert.equal(out.branch, 'main');
});

test('a record with no branch reports null', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [turn({})]);

  const [out] = await collect(file);
  assert.equal(out.branch, null);
});

test('the matcher accepts a chat file and nothing else', async () => {
  assert.equal(QWEN_SESSION_MATCH('-Users-tianyi/chats/fa14eacd.jsonl'), true);
  // Still accepted if the source root is ever widened to ~/.qwen.
  assert.equal(QWEN_SESSION_MATCH('projects/-Users-tianyi/chats/fa14eacd.jsonl'), true);
  assert.equal(QWEN_SESSION_MATCH('-Users-tianyi/chats/fa14eacd.json'), false);
  assert.equal(QWEN_SESSION_MATCH('-Users-tianyi/debug/fa14eacd.txt'), false);
  assert.equal(QWEN_SESSION_MATCH('-Users-tianyi/chats/notes.md'), false);
});

test('the matcher rejects the tmp store, which is the double-count guard', async () => {
  // `~/.qwen/tmp/<sha>/logs.json` is a JSON array with the Gemini CLI's
  // shape, and the gemini-cli lane already reads that file under
  // ~/.gemini/tmp. Accepting it here would count the same requests twice.
  assert.equal(QWEN_SESSION_MATCH('tmp/4ea9ba9e86e9eee818a76c102174f23d9a62557b62d844952f7202257f5ae2d0/logs.json'), false);
  assert.equal(QWEN_SESSION_MATCH('../tmp/abc/logs.json'), false);
  assert.equal(QWEN_SESSION_MATCH('tmp/abc/logs.json'), false);
  assert.equal(QWEN_SESSION_MATCH('tmp/abc/anything.jsonl'), false);
});

test('a logs.json array under ~/.qwen/tmp is not read by this lane', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  // The array is shaped so that a parser which read it WOULD produce a
  // record. It must produce none.
  const dir = path.join(home, '.qwen', 'tmp', '4ea9ba9e86e9eee818a76c102174f23d9');
  await mkdir(dir, { recursive: true });
  const logs = path.join(dir, 'logs.json');
  await writeFile(logs, JSON.stringify([
    {
      sessionId: 'fa14eacd-9757-4666-afb5-8cc7e3902b5a',
      messageId: 0,
      type: 'assistant',
      model: 'qwen3.5-plus',
      timestamp: '2026-04-20T14:18:00.899Z',
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        totalTokenCount: 1100,
      },
    },
  ]));

  assert.deepEqual(await collect(logs), [], 'the tmp store is not this lane\'s to read');
  assert.equal(QWEN_SESSION_MATCH('tmp/4ea9ba9e86e9eee818a76c102174f23d9/logs.json'), false);
});

test('a JSON array line in a chat file is not a record', async () => {
  // The `logs.json` shape, in a chat file. An array is not a record, and a
  // parser that indexed into it would report a usage that is not there.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-qwen-'));
  const file = await writeChat(home, 'fa14eacd-9757-4666-afb5-8cc7e3902b5a', [
    JSON.stringify([
      { type: 'assistant', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } },
    ]),
  ]);

  assert.deepEqual(await collect(file), []);
});
