import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseCodeBuddy,
  CODEBUDDY_LOG_MATCH,
  clearCodeBuddyCache,
} from '../src/parsers-codebuddy.js';

/**
 * CodeBuddy CN (腾讯云代码助手) reads from FOUR stores at once, and the
 * joins between them are where the mistakes live. What is pinned here:
 *
 *   1. **The buckets.** `usage.inputTokens` is the WHOLE prompt, not the
 *      fresh part — `inputTokens === cacheTokens + cachedMissTokens` holds
 *      on every one of the 362 steps on this machine. So the fresh input is
 *      `cachedMissTokens`, the cache read is `cacheTokens`, the cache write
 *      is `cachedWriteTokens` and the output is `outputTokens`. Using
 *      `inputTokens` as the fresh input charges the cached part twice.
 *   2. **One record per STEP.** A request is a multi-step agent loop and
 *      every step is a separate API call, so a five-step request is five
 *      records, not one. The extension also re-logs the final step's usage
 *      in an `AgentReporter` summary line; reading that line too would
 *      double-count every request.
 *   3. **The model is not in the index.** It is in the message files, whose
 *      `extra` field is a JSON *string* that has to be parsed a second
 *      time. A request whose model cannot be resolved keeps its record and
 *      is reported as `unknown` — real spend is never dropped.
 *   4. **The log clock is LOCAL.** The offset is recovered from the
 *      history index's `startedAt`, as a MEDIAN over the file, so one odd
 *      request cannot move the whole file.
 *   5. **`credit` is a quota, not money.** It is not priced and it is not
 *      carried as `storedCost`.
 *
 * Every fixture here is synthetic: a fake home directory with a fake log,
 * a fake history tree and a fake sessions database. The machine's real
 * stores are not a fixture — a test that changes when the machine does is
 * not a test.
 */

/** The zone the fixtures pretend the machine is in: UTC+8 (Asia/Shanghai). */
const ZONE = 8 * 3_600_000;

/** How long an API call takes to finish its first step (measured: 14.1s). */
const LATENCY = 14_100;

let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

const appDir = (home) => path.join(home, 'Library', 'Application Support');

/** Write a log file at the real path shape, Chinese name and all. */
async function writeLog(home, lines, name = '腾讯云代码助手.log') {
  const dir = path.join(
    appDir(home), 'CodeBuddy CN', 'logs', '20260508T235457',
    '20260508211243--1', 'exthost', 'Tencent-Cloud.coding-copilot',
  );
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, lines.length ? `${lines.join('\n')}\n` : '');
  return file;
}

/** A `notifyStepEnd` line, in the shape the extension really writes. */
function stepLine({ wall, requestId, messageId, usage, agent = 'craft', step = 1 }) {
  return (
    `${wall} [info] [BaseAgent:${agent}] [${requestId}] notifyStepEnd, step: ${step}, ` +
    `requestId: ${requestId}, messageId: ${messageId}, usage: ${JSON.stringify(usage)}, ` +
    'isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool:false, isContentFilter: false'
  );
}

/** The usage object the extension writes, with every field it writes. */
function usage({
  inputTokens, outputTokens, cacheTokens = 0, cachedWriteTokens = 0, credit = 0.36,
}) {
  const cachedMissTokens = inputTokens - cacheTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheTokens,
    cachedWriteTokens,
    cachedMissTokens,
    lastTokens: inputTokens + outputTokens,
    credit,
  };
}

/** The epoch ms a local wall clock would be, read as if it were UTC. */
const wallAsUtc = (wall) => Date.parse(`${wall.replace(' ', 'T')}Z`);

/**
 * Write a conversation's history index and its message files.
 * `requests` is the index's `requests` array, `messages` maps a message id
 * to the `extra` payload (written as a JSON STRING, as the extension does).
 */
async function writeHistory(home, {
  workspaceId = 'ws-1',
  conversationId = 'conv-1',
  requests = [],
  messages = {},
} = {}) {
  const dir = path.join(
    appDir(home), 'CodeBuddyExtension', 'Data', 'profile-1', 'CodeBuddyIDE',
    'user-1', 'history', workspaceId, conversationId,
  );
  await mkdir(path.join(dir, 'messages'), { recursive: true });
  await writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify({ messages: Object.keys(messages), requests }),
  );
  for (const [id, extra] of Object.entries(messages)) {
    await writeFile(
      path.join(dir, 'messages', `${id}.json`),
      JSON.stringify({
        role: 'assistant',
        message: 'a reply',
        id,
        // `extra` is a JSON string, not an object: it has to be parsed twice.
        extra: JSON.stringify(extra),
      }),
    );
  }
  return dir;
}

/** Write a sessions database with the `session:<conversationId>` rows. */
async function writeSessions(home, rows) {
  const file = path.join(appDir(home), 'CodeBuddy CN', 'codebuddy-sessions.vscdb');
  await mkdir(path.dirname(file), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT, value BLOB)');
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of rows) ins.run(key, JSON.stringify(value));
  db.close();
  return file;
}

/** Collect the records a parser yields. */
async function collect(file, opts) {
  const records = [];
  for await (const r of parseCodeBuddy(file, opts)) records.push(r);
  return records;
}

const FIELDS = [
  'agent', 'model', 'session', 'timestamp', 'input',
  'cacheRead', 'cacheWrite', 'output', 'project', 'branch',
];

test('one step line becomes one record, with the expected field set', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'e5b2ba9602574d578146d06b71b37d23',
      usage: usage({ inputTokens: 80395, outputTokens: 64, cacheTokens: 8192 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, type: 'craft', state: 'complete', startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const records = await collect(file, { home });
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), [...FIELDS].sort());
  assert.equal(records[0].agent, 'codebuddy');
  assert.equal(records[0].branch, null, 'CodeBuddy records no branch');
});

test('the buckets map from the split, never from the whole prompt', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'e5b2ba9602574d578146d06b71b37d23',
      usage: {
        inputTokens: 80395,
        outputTokens: 64,
        totalTokens: 80459,
        cacheTokens: 8192,
        cachedWriteTokens: 4096,
        cachedMissTokens: 72203,
        lastTokens: 80459,
        credit: 0.36,
      },
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const [rec] = await collect(file, { home });
  assert.equal(rec.input, 72203, 'fresh input is cachedMissTokens, not the whole prompt');
  assert.equal(rec.cacheRead, 8192, 'the cache read is cacheTokens');
  assert.equal(rec.cacheWrite, 4096, 'the cache write is cachedWriteTokens');
  assert.equal(rec.output, 64, 'the output is outputTokens');
  assert.notEqual(rec.input, 80395, 'inputTokens is the WHOLE prompt and must not be the fresh input');
});

test('every step of a request is its own record', async () => {
  // The measured shape of a real request: the prompt grows step by step,
  // and each step is a separate API call and a separate bill.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const requestId = '367d58f431b14f108a2e4ee04db146d3';
  const steps = [
    ['2026-05-08 23:22:00.133', 30530, 111],
    ['2026-05-08 23:22:26.102', 43118, 190],
    ['2026-05-08 23:23:01.667', 57756, 3340],
  ];
  const file = await writeLog(home, steps.map(([wall, inputTokens, outputTokens], i) =>
    stepLine({
      wall,
      requestId,
      messageId: `m${i}`,
      step: i + 1,
      usage: usage({ inputTokens, outputTokens, cacheTokens: 1984 }),
    })));
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(steps[0][0]) - ZONE - LATENCY }],
  });

  const records = await collect(file, { home });
  assert.equal(records.length, 3, 'three steps, three records');
  assert.deepEqual(records.map((r) => r.input), [28546, 41134, 55772]);
  assert.deepEqual(records.map((r) => r.output), [111, 190, 3340]);
  assert.ok(
    records.every((r) => r.session === 'conv-1'),
    'every step belongs to the same conversation',
  );
});

test('the AgentReporter summary line is not a second record', async () => {
  // The extension re-logs the final step's usage for the whole request.
  // Reading it would double-count every request.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const u = usage({ inputTokens: 80395, outputTokens: 64, cacheTokens: 8192 });
  const file = await writeLog(home, [
    stepLine({ wall, requestId, messageId: 'm1', usage: u }),
    `${wall} [info] [AgentReporter] [${requestId}] Agent execution successful with usage: ${JSON.stringify(u)}`,
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const records = await collect(file, { home });
  assert.equal(records.length, 1, 'the summary line is not a step');
});

test('the model comes from the message file’s extra string', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'e5b2ba9602574d578146d06b71b37d23',
      usage: usage({ inputTokens: 80395, outputTokens: 64, cacheTokens: 8192 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
    messages: {
      'e5b2ba9602574d578146d06b71b37d23': {
        requestId,
        modelId: 'glm-5.1',
        modelName: 'Hy3 preview',
        traceId: 'trace-1',
        responseId: 'resp-1',
      },
    },
  });

  const [rec] = await collect(file, { home });
  assert.equal(rec.model, 'glm-5.1');
  assert.equal(rec.session, 'conv-1', 'the session is the conversation id');
});

test('a request with no model keeps its record and is reported as unknown', async () => {
  // 24 of the 362 real steps are like this: the history index no longer
  // knows the request. Dropping them would drop real spend.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const known = 'known-request';
  const orphan = 'orphan-request';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId: known,
      messageId: 'm1',
      usage: usage({ inputTokens: 1000, outputTokens: 10 }),
    }),
    stepLine({
      wall,
      requestId: orphan,
      messageId: 'm2',
      usage: usage({ inputTokens: 2000, outputTokens: 20 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: known, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const records = await collect(file, { home });
  assert.equal(records.length, 2, 'the orphan step is kept');
  const orphanRec = records.find((r) => r.session === orphan);
  assert.ok(orphanRec, 'the orphan step is emitted');
  assert.equal(orphanRec.model, 'unknown', 'an unresolved model is never invented');
  assert.equal(orphanRec.input, 2000);
  assert.equal(orphanRec.output, 20);
  assert.equal(orphanRec.project, null);
});

test('the local offset is recovered from startedAt', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const startedAt = wallAsUtc(wall) - ZONE - LATENCY;
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'm1',
      usage: usage({ inputTokens: 80395, outputTokens: 64, cacheTokens: 8192 }),
    }),
  ]);
  await writeHistory(home, { requests: [{ id: requestId, startedAt }] });

  const [rec] = await collect(file, { home });
  // The log clock is local: read as if it were UTC it sits 8h ahead of the
  // truth, and the recovered offset puts it back.
  assert.equal(rec.timestamp, wallAsUtc(wall) - ZONE);
  assert.equal(rec.timestamp - startedAt, LATENCY, 'the residual is the API latency');
  assert.equal(new Date(rec.timestamp).toISOString(), '2026-05-08T15:55:34.627Z');
});

test('the offset is a median: one odd request cannot move the file', async () => {
  // Measured on this machine: one request's step is 4.5 hours away from
  // its `startedAt`. A mean would drag the whole file with it.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requests = [];
  const lines = [];
  for (const [i, id] of ['r-a', 'r-b', 'r-c'].entries()) {
    lines.push(stepLine({
      wall,
      requestId: id,
      messageId: `m${i}`,
      usage: usage({ inputTokens: 1000 + i, outputTokens: 10 }),
    }));
    requests.push({ id, startedAt: wallAsUtc(wall) - ZONE - LATENCY });
  }
  // The odd one: 13h away, which rounds to a -13h candidate.
  lines.push(stepLine({
    wall,
    requestId: 'r-odd',
    messageId: 'm9',
    usage: usage({ inputTokens: 5000, outputTokens: 50 }),
  }));
  requests.push({ id: 'r-odd', startedAt: wallAsUtc(wall) - 13 * 3_600_000 });

  const file = await writeLog(home, lines);
  await writeHistory(home, { requests });

  const records = await collect(file, { home });
  assert.equal(records.length, 4);
  for (const rec of records) {
    assert.equal(rec.timestamp, wallAsUtc(wall) - ZONE, 'the median held the file at -8h');
  }
});

test('a log file with nothing to join falls back to the system zone', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId: 'lonely',
      messageId: 'm1',
      usage: usage({ inputTokens: 1000, outputTokens: 10 }),
    }),
  ]);
  // No history store at all.

  const [rec] = await collect(file, { home });
  assert.ok(Number.isFinite(rec.timestamp), 'a timestamp is still produced');
  // Read back in the machine's own zone, it is the same wall clock.
  const local = new Date(rec.timestamp);
  assert.equal(local.getFullYear(), 2026);
  assert.equal(local.getMonth(), 4);
  assert.equal(local.getDate(), 8);
  assert.equal(local.getHours(), 23);
  assert.equal(local.getMinutes(), 55);
  assert.equal(local.getSeconds(), 34);
});

test('a truncated final line is skipped, not fatal', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const good = stepLine({
    wall,
    requestId,
    messageId: 'm1',
    usage: usage({ inputTokens: 1000, outputTokens: 10 }),
  });
  const file = await writeLog(home, [
    good,
    // The IDE was killed mid-write: the last line stops in the middle.
    `${wall} [info] [BaseAgent:craft] [${requestId}] notifyStepEnd, step: 2, requestId: ${requestId}, messageId: m2, usage: {"inputTokens":2000,"outputTo`,
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const records = await collect(file, { home });
  assert.equal(records.length, 1, 'the torn tail is skipped, the good line survives');
  assert.equal(records[0].input, 1000);
});

test('a malformed line anywhere is skipped, not fatal', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    'this is not a log line at all',
    `${wall} [info] [BaseAgent:craft] [${requestId}] notifyStepEnd, step: 1, requestId: ${requestId}, messageId: m1, usage: not-json`,
    stepLine({
      wall,
      requestId,
      messageId: 'm2',
      usage: usage({ inputTokens: 1000, outputTokens: 10 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const records = await collect(file, { home });
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 1000);
});

test('credit is a quota, not a cost: no storedCost is emitted', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'm1',
      usage: usage({ inputTokens: 80395, outputTokens: 64, cacheTokens: 8192, credit: 0.36 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });

  const [rec] = await collect(file, { home });
  assert.equal('storedCost' in rec, false, 'credit is not dollars and is never carried as a cost');
  assert.equal('credit' in rec, false, 'credit is not carried as a field either');
  assert.equal(rec.input, 72203);
});

test('the project is the working directory of the conversation', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'm1',
      usage: usage({ inputTokens: 1000, outputTokens: 10 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
  });
  await writeSessions(home, [
    ['session:conv-1', {
      conversationId: 'conv-1',
      cwd: '/Users/tianyi/CodeBuddy/20260508211243',
      userId: 'user-1',
      title: '帮我配置git',
      status: 'Completed',
      createdAt: 1778245981338,
      updatedAt: 1778246250457,
    }],
  ]);

  const [rec] = await collect(file, { home });
  assert.equal(rec.project, '/Users/tianyi/CodeBuddy/20260508211243');
});

test('missing stores degrade: no history, no sessions db', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'm1',
      usage: usage({ inputTokens: 1000, outputTokens: 10 }),
    }),
  ]);

  const records = await collect(file, { home });
  assert.equal(records.length, 1, 'the usage survives the missing stores');
  assert.equal(records[0].model, 'unknown');
  assert.equal(records[0].project, null, 'no sessions db means no project, not a crash');
  assert.ok(Number.isFinite(records[0].timestamp));
});

test('a missing log file yields no records and does not throw', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const missing = path.join(appDir(home), 'CodeBuddy CN', 'logs', 'nope.log');
  const records = await collect(missing, { home });
  assert.deepEqual(records, []);
});

test('a log with no usage lines yields no records', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const file = await writeLog(home, [
    '2026-05-08 23:55:00.789 [info] [ConnectorService] PostConstruct',
    '2026-05-08 23:55:00.789 [info] [Connector-Debug] ConnectorService userDataPath=/x',
  ]);
  const records = await collect(file, { home });
  assert.deepEqual(records, []);
});

test('the default home is used when no home is passed', async () => {
  // The SOURCES wiring calls the parser with the file path only, so the
  // home has to come from the environment.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-codebuddy-'));
  const wall = '2026-05-08 23:55:34.627';
  const requestId = 'c28add256aa64c3180c52094a5ab59fe';
  const file = await writeLog(home, [
    stepLine({
      wall,
      requestId,
      messageId: 'm1',
      usage: usage({ inputTokens: 1000, outputTokens: 10 }),
    }),
  ]);
  await writeHistory(home, {
    requests: [{ id: requestId, startedAt: wallAsUtc(wall) - ZONE - LATENCY }],
    messages: { m1: { requestId, modelId: 'kimi-k2.6' } },
  });

  const before = process.env.HOME;
  process.env.HOME = home;
  clearCodeBuddyCache();
  try {
    const records = await collect(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'kimi-k2.6');
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    clearCodeBuddyCache();
  }
});

test('the matcher takes the extension log and its rotations', () => {
  assert.ok(CODEBUDDY_LOG_MATCH('20260508T235457/20260508211243--1/exthost/Tencent-Cloud.coding-copilot/腾讯云代码助手.log'));
  assert.ok(CODEBUDDY_LOG_MATCH('20260508T235457/20260508211243--1/exthost/Tencent-Cloud.coding-copilot/腾讯云代码助手.3.log'));
  // The ASCII branch: the Chinese file name is never parsed as text.
  assert.ok(CODEBUDDY_LOG_MATCH('20260508T235457/x--1/exthost/Tencent-Cloud.coding-copilot/whatever.log'));
  assert.equal(CODEBUDDY_LOG_MATCH('20260508T235457/exthost/exthost.log'), false);
  assert.equal(CODEBUDDY_LOG_MATCH('20260508T235457/renderer.log'), false);
});
