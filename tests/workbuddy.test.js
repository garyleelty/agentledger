import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseWorkBuddy, workbuddyProjects, WORKBUDDY_SESSION_MATCH } from '../src/parsers-workbuddy.js';

/**
 * WorkBuddy (Tencent's AI agent desktop app) reads one JSONL file per
 * session, and the traps are all in the token buckets. What is pinned here:
 *
 *   1. **The fresh input is `prompt_cache_miss_tokens`**, never
 *      `usage.inputTokens` — the latter is the WHOLE prompt (hit + miss
 *      === input on all 487 real records).
 *   2. **The cache read is `prompt_cache_hit_tokens`**, never
 *      `cache_read_input_tokens` or `rawUsage.cached_tokens` — both of
 *      those are 0 on every real record, and the `message.usage` block on
 *      the record is a third copy whose `input_tokens` is the whole prompt.
 *   3. **The reasoning tokens are a SUBSET of the output.** Output 750 with
 *      reasoning 520 is output 750, not 1270.
 *   4. **The model is the machine id** (`providerData.model`), never the
 *      display name — one of the real records calls itself `快速`.
 *   5. **One record per model CALL.** A record with no
 *      `providerData.usage` is not a model call.
 *
 * Every fixture here is synthetic: a fake home directory with fake session
 * files. The machine's real store is not a fixture — a test that changes
 * when the machine does is not a test. The measured totals of the real
 * store (487 records, 40,247,343 prompt, 525,945 completion, 36,825,012
 * cache read) are reproduced here by a fixture built to the same shape.
 */

const projectsRoot = (home) => path.join(home, '.workbuddy', 'projects');

/**
 * Write a fake session file at the real path shape.
 *
 * @param {string} home
 * @param {string} slug the lossy cwd slug of the project directory
 * @param {string} sessionId the session uuid (the file stem)
 * @param {Array<object>} records the records, as objects or raw strings
 * @returns {Promise<string>} the path of the file
 */
async function writeSession(home, slug, sessionId, records) {
  const dir = path.join(projectsRoot(home), slug);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const body = records
    .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
    .join('\n');
  await writeFile(file, `${body}\n`);
  return file;
}

/**
 * A model call, in the shape WorkBuddy really writes it.
 *
 * The `providerData` block carries the usage three times over: normalised
 * (`usage`), raw (`rawUsage`) and once more on `message.usage`. The raw
 * view is the only one with the cache split in it.
 */
function call({
  id = 'call-1',
  type = 'function_call',
  sessionId = 'c7e6a30a-78bc-4911-989d-7a8d043449e2',
  cwd = '/Users/tianyi/WorkBuddy/2026-09-08-22-34-57',
  timestamp = 1788878111396,
  model = 'hy3',
  requestModelId,
  requestModelName,
  hit = 11584,
  miss = 18977,
  out = 137,
  reasoning = 52,
  cacheWrite = 0,
  cacheReadInputTokens = 0,
}) {
  const inputTokens = hit + miss;
  const totalTokens = inputTokens + out;
  return {
    id,
    parentId: 'parent-1',
    timestamp,
    type,
    sessionId,
    cwd,
    callId: 'call_5a6ea4d86faa4531856e2ff2',
    name: 'Bash',
    arguments: '{"command":"ls"}',
    providerData: {
      messageId: id,
      model,
      requestModelId: requestModelId ?? model,
      requestModelName: requestModelName ?? model,
      traceId: 'e8780ad7936349188c6af41ed4779375',
      rawUsage: {
        prompt_tokens: inputTokens,
        completion_tokens: out,
        total_tokens: totalTokens,
        completion_tokens_details: { reasoning_tokens: reasoning, cached_tokens: 0 },
        prompt_tokens_details: { reasoning_tokens: 0, cached_tokens: hit },
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: miss,
        // The decoy: 0 on every real record.
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheWrite,
        prompt_cache_write_tokens: 0,
        completion_thinking_tokens: reasoning,
        credit: 0.27,
        // The other decoy: 0 on every real record.
        cached_tokens: 0,
      },
      usage: {
        requests: 1,
        inputTokens,
        outputTokens: out,
        totalTokens,
        inputTokensDetails: [{ cached_tokens: hit }],
        outputTokensDetails: [{ reasoning_tokens: reasoning }],
      },
    },
    // A third copy of the numbers, with no cache-miss split. Its
    // `input_tokens` is the WHOLE prompt.
    message: {
      usage: {
        input_tokens: inputTokens,
        output_tokens: out,
        total_tokens: totalTokens,
        cache_read_input_tokens: hit,
      },
    },
  };
}

/** Collect the records a parser yields. */
async function collect(file) {
  const records = [];
  for await (const r of parseWorkBuddy(file)) records.push(r);
  return records;
}

const FIELDS = [
  'agent', 'model', 'session', 'timestamp', 'input',
  'cacheRead', 'cacheWrite', 'output', 'project', 'branch',
];

const sum = (records, key) => records.reduce((a, r) => a + (r[key] || 0), 0);

test('one usage record becomes one record, with the expected field set', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', [call({})]);

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), [...FIELDS].sort());
  assert.equal(records[0].agent, 'workbuddy');
  assert.equal(records[0].session, 'c7e6a30a-78bc-4911-989d-7a8d043449e2');
  assert.equal(records[0].timestamp, 1788878111396);
  assert.equal(records[0].project, '/Users/tianyi/WorkBuddy/2026-09-08-22-34-57');
  assert.equal(records[0].branch, null, 'WorkBuddy records no branch');
});

test('the fresh input is the cache miss, never the whole prompt', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2',
    [call({ hit: 11584, miss: 18977, out: 137 })]);

  const [rec] = await collect(file);
  assert.equal(rec.input, 18977, 'the fresh input is prompt_cache_miss_tokens');
  assert.notEqual(rec.input, 30561, 'inputTokens is the WHOLE prompt and is not the fresh input');
  assert.equal(rec.input + rec.cacheRead, 30561, 'the two buckets still add up to the whole prompt');
});

test('the cache read is the cache hit, not the field that looks like it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2',
    [call({ hit: 11584, miss: 18977, cacheReadInputTokens: 0 })]);

  const [rec] = await collect(file);
  assert.equal(rec.cacheRead, 11584, 'the cache read is prompt_cache_hit_tokens');
  assert.notEqual(rec.cacheRead, 0, 'cache_read_input_tokens is 0 on every real record');
});

test('a non-zero cache_read_input_tokens is still not the cache read', async () => {
  // The decoy is 0 everywhere in the real store, so a parser that read it
  // would look right there. This fixture gives it a value of its own: the
  // cache read must still be the cache hit.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2',
    [call({ hit: 11584, miss: 18977, cacheReadInputTokens: 42 })]);

  const [rec] = await collect(file);
  assert.equal(rec.cacheRead, 11584, 'the cache read is prompt_cache_hit_tokens');
  assert.notEqual(rec.cacheRead, 42);
});

test('the reasoning tokens are a subset of the output, not added to it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2',
    [call({ hit: 40000, miss: 1000, out: 750, reasoning: 520 })]);

  const [rec] = await collect(file);
  assert.equal(rec.output, 750, 'the reasoning is already inside the output');
  assert.notEqual(rec.output, 1270, 'the reasoning must not be added');
});

test('the model is the machine id, never the display name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2',
    [call({
      model: 'glm-5.3-flash',
      requestModelId: 'fast-model',
      requestModelName: '快速',
    })]);

  const [rec] = await collect(file);
  assert.equal(rec.model, 'glm-5.3-flash', 'the machine id is the model');
  assert.notEqual(rec.model, '快速', 'the display name is not a model');
  assert.notEqual(rec.model, 'fast-model', 'the route alias is not the model');
});

test('a record with no providerData.usage produces no record', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', [
      // The file also holds titles, snapshots, tool results and credit
      // records; none of them is a model call.
      { id: 'a', timestamp: 1788878098143, type: 'message', role: 'user', providerData: { agent: 'cli' } },
      { id: 'b', timestamp: 1788878100408, type: 'file-history-snapshot', snapshot: {} },
      { id: 'c', timestamp: 1788878109290, type: 'ai-title', aiTitle: '整理我的电脑' },
      { id: 'd', timestamp: 1788878110000, type: 'credit-usage', providerData: { credit: 5.71 } },
      { id: 'e', timestamp: 1788878111000, type: 'function_call_result', toolResult: 'ok' },
      call({ id: 'f' }),
    ]);

  const records = await collect(file);
  assert.equal(records.length, 1, 'only the model call is a record');
  assert.equal(records[0].output, 137);
});

test('the same id on two lines is one record, not two and not zero', async () => {
  // 136 of the 1,754 real ids appear twice: the assistant `message` and
  // the `function_call` that shares its id, one millisecond apart. Only the
  // function_call copy carries the usage. A parser that deduplicated by
  // record id would drop 136 real records.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const shared = 'f10a75b69ae44ee68d847afdbb905f38';
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', [
      {
        id: shared,
        parentId: 'parent-1',
        timestamp: 1788878127747,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '好，我先做一次只读扫描。' }],
        providerData: { messageId: shared, model: 'glm-5.3-flash', agent: 'cli' },
      },
      call({ id: shared, type: 'function_call', timestamp: 1788878127748, hit: 11584, miss: 19332, out: 137 }),
    ]);

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 19332);
  assert.equal(records[0].output, 137);
});

test('a truncated final line is skipped, not fatal', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', [
      call({ id: 'good' }),
      // The app was killed mid-write: the last line stops in the middle.
      '{"id":"torn","timestamp":1788878127748,"type":"function_call","providerData":{"usage":{"inputTokens":',
    ]);

  const records = await collect(file);
  assert.equal(records.length, 1, 'the torn tail is skipped, the good line survives');
  assert.equal(records[0].input, 18977);
});

test('a missing file yields no records and does not throw', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const missing = path.join(projectsRoot(home), 'Users-tianyi-nope', 'nope.jsonl');
  const records = await collect(missing);
  assert.deepEqual(records, []);
});

test('an empty file yields no records', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', []);
  const records = await collect(file);
  assert.deepEqual(records, []);
});

test('a record with no cwd yields a null project', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const rec = call({ id: 'no-cwd' });
  delete rec.cwd;
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', [rec]);

  const [record] = await collect(file);
  assert.equal(record.project, null, 'no cwd means no project, and that is not a crash');
  assert.equal(record.input, 18977);
});

test('the cache write is mapped from cache_creation_input_tokens', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2',
    [call({ hit: 1000, miss: 100, out: 10, cacheWrite: 2048 })]);

  const [rec] = await collect(file);
  assert.equal(rec.cacheWrite, 2048, 'the cache write is cache_creation_input_tokens');
});

test('the totals reproduce: 487 records, 40,247,343 prompt, 525,945 completion', async () => {
  // The measured shape of the real store, rebuilt as a fixture: 487 model
  // calls over 10 sessions, with the measured model mix and the measured
  // totals.
  const EXPECTED = {
    records: 487,
    prompt: 40247343,
    output: 525945,
    total: 40773288,
    cacheRead: 36825012,
    fresh: 3422331,
  };
  const MODELS = [
    ['hy3', 223],
    ['hy4-preview', 176],
    ['step-5-preview', 52],
    ['deepseek-v4.1-flash', 32],
    ['glm-5.3-flash', 4],
  ];
  const FILL = { hit: 75616, miss: 7026, out: 1079 };
  const fillRows = EXPECTED.records - 1;
  const last = {
    hit: EXPECTED.cacheRead - fillRows * FILL.hit,
    miss: EXPECTED.fresh - fillRows * FILL.miss,
    out: EXPECTED.output - fillRows * FILL.out,
  };
  assert.ok(last.hit > 0 && last.miss > 0 && last.out > 0, 'the fixture is a real shape');

  const models = [];
  for (const [name, n] of MODELS) for (let i = 0; i < n; i++) models.push(name);
  assert.equal(models.length, EXPECTED.records);

  const home = await mkdtemp(path.join(tmpdir(), 'aledger-workbuddy-'));
  const records = [];
  for (let i = 0; i < EXPECTED.records; i++) {
    const isLast = i === EXPECTED.records - 1;
    records.push(call({
      id: `call-${i}`,
      model: models[i],
      requestModelName: models[i] === 'glm-5.3-flash' ? '快速' : models[i],
      hit: isLast ? last.hit : FILL.hit,
      miss: isLast ? last.miss : FILL.miss,
      out: isLast ? last.out : FILL.out,
      reasoning: 0,
      timestamp: 1788878111396 + i * 60_000,
    }));
  }
  const file = await writeSession(home, 'Users-tianyi-WorkBuddy-2026-09-08-22-34-57',
    'c7e6a30a-78bc-4911-989d-7a8d043449e2', records);

  const parsed = await collect(file);
  assert.equal(parsed.length, EXPECTED.records, '487 usage-bearing records');
  assert.equal(
    sum(parsed, 'input') + sum(parsed, 'cacheRead'),
    EXPECTED.prompt,
    'the whole prompt totals 40,247,343',
  );
  assert.equal(sum(parsed, 'output'), EXPECTED.output, 'the completion totals 525,945');
  assert.equal(sum(parsed, 'cacheRead'), EXPECTED.cacheRead, 'the cache read totals 36,825,012');
  assert.equal(sum(parsed, 'input'), EXPECTED.fresh, 'the fresh input totals 3,422,331');
  assert.equal(
    sum(parsed, 'input') + sum(parsed, 'cacheRead') + sum(parsed, 'output'),
    EXPECTED.total,
    'the whole prompt plus the completion totals 40,773,288',
  );
  const counts = {};
  for (const r of parsed) counts[r.model] = (counts[r.model] || 0) + 1;
  assert.deepEqual(counts, Object.fromEntries(MODELS), 'the model mix is the measured one');
  assert.equal(
    Math.max(...parsed.map((r) => r.timestamp)) - Math.min(...parsed.map((r) => r.timestamp)),
    (EXPECTED.records - 1) * 60_000,
  );
});

test('the matcher takes the session files, and the store path is the projects root', () => {
  assert.ok(WORKBUDDY_SESSION_MATCH('Users-tianyi-WorkBuddy-2026-09-08-22-34-57/c7e6a30a-78bc-4911-989d-7a8d043449e2.jsonl'));
  assert.ok(!WORKBUDDY_SESSION_MATCH('Users-tianyi-WorkBuddy-2026-09-08-22-34-57/notes.txt'));
  assert.equal(
    workbuddyProjects('/home/tester'),
    '/home/tester/.workbuddy/projects',
  );
});
