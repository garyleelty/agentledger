import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseLingma, lingmaPaths, LINGMA_DB_MATCH } from '../src/parsers-lingma.js';

/**
 * Lingma (阿里通义灵码) reads from TWO stores at once — a SQLite cache
 * database that holds the usage and a CLI log that holds the cache split —
 * and the mistakes live in the seams between them. What is pinned here:
 *
 *   1. **One record per CALL.** A request in Lingma is an agent turn, and a
 *      turn is many model calls; every call is a separate API call and a
 *      separate bill, and every one of them writes its own `chat_message`
 *      row with its own `token_info`. The rows are NOT all `role =
 *      'assistant'` — on the real machine 5 of the 43 usage-bearing rows
 *      are assistant, 5 are user and 33 are tool — so the record set is
 *      "every row that carries a token_info", not "every assistant row".
 *   2. **The buckets.** `prompt_tokens` is the WHOLE prompt, not the fresh
 *      part. When the split is known the fresh input is
 *      `prompt_tokens - cache_read`; when it is not known the whole prompt
 *      is fresh (the Cherry Studio precedent), which makes the lane's
 *      dollars an upper bound.
 *   3. **The model is not recorded.** `model_info` is an empty string on
 *      every row, so the model is `'unknown'` — never null, never invented.
 *   4. **The join.** The log's `request_set_id` is tried first and the token
 *      pair within the session is the fallback; both name exactly one row.
 *
 * Every fixture here is synthetic: a fake home directory with a fake
 * database and a fake log. The machine's real stores are not a fixture — a
 * test that changes when the machine does is not a test. The measured
 * totals of the real store (43 records, 2,752,050 prompt, 11,724
 * completion) are reproduced here by a fixture built to the same shape.
 */

let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

const appDir = (home) => path.join(home, 'Library', 'Application Support');
const cacheRoot = (home) => path.join(appDir(home), 'Lingma', 'SharedClientCache');

/**
 * Write a fake `local.db` with the two tables the parser reads.
 *
 * @param {string} home
 * @param {{rows?: Array<object>, sessions?: Array<object>}} [data]
 * @returns {Promise<string>} the path of the database
 */
async function writeDb(home, { rows = [], sessions = [] } = {}) {
  const dir = path.join(cacheRoot(home), 'cache', 'db');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'local.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE chat_message (
      id varchar(64),
      session_id varchar(64),
      request_id varchar(64),
      role varchar(64),
      content TEXT,
      summary TEXT,
      summary_modified INTEGER,
      summary_trigger INTEGER,
      tool_result TEXT,
      token_info TEXT,
      model_info TEXT,
      extra TEXT,
      gmt_create INTEGER
    );
    CREATE TABLE chat_session (
      session_id varchar(64),
      user_id varchar(64),
      user_name varchar(64),
      session_title varchar(256),
      project_id varchar(64),
      project_uri varchar(512),
      project_name varchar(64),
      gmt_create INTEGER,
      gmt_modified INTEGER,
      session_type varchar(64),
      mode varchar(64),
      preferred_model_info TEXT,
      extra TEXT
    );
  `);
  const msg = db.prepare(
    `INSERT INTO chat_message
       (id, session_id, request_id, role, content, summary, summary_modified,
        summary_trigger, tool_result, token_info, model_info, extra, gmt_create)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    msg.run(
      r.id ?? 'm-1',
      r.sessionId ?? 'sess-1',
      r.requestId ?? 'req-1',
      r.role ?? 'assistant',
      r.content ?? '',
      r.summary ?? '',
      0,
      0,
      r.toolResult ?? '',
      r.tokenInfo ?? '',
      // `model_info` is an empty string on every real row.
      r.modelInfo ?? '',
      r.extra ?? '',
      r.gmtCreate ?? 1776699045449,
    );
  }
  const sess = db.prepare(
    `INSERT INTO chat_session
       (session_id, user_id, user_name, session_title, project_id, project_uri,
        project_name, gmt_create, gmt_modified, session_type, mode,
        preferred_model_info, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of sessions) {
    sess.run(
      s.sessionId ?? 'sess-1',
      '1581213896348172',
      '15807112233',
      '当前代码不好用',
      s.projectUri ?? '',
      s.projectUri ?? '',
      s.projectName ?? 'opencode-ui',
      1776699041741,
      1776699041741,
      'quest',
      'long_running',
      // `preferred_model_info` is empty on the real row too.
      '',
      '',
    );
  }
  db.close();
  return file;
}

/**
 * Write a fake `lingmacli.log`.
 *
 * @param {string} home
 * @param {string[]} lines
 * @returns {Promise<string>} the path of the log
 */
async function writeLog(home, lines) {
  const dir = path.join(cacheRoot(home), 'cli', 'logs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'lingmacli.log');
  await writeFile(file, lines.length ? `${lines.join('\n')}\n` : '');
  return file;
}

/**
 * A log line in the shape the CLI really writes: a tab-separated header
 * (timestamp, level, source, label) and then the JSON payload.
 */
function usageLine({
  requestSetId,
  messageId,
  sessionId = 'sess-1',
  input,
  output,
  cacheRead = 0,
  cacheWrite = 0,
  createdAt = 1776699041761,
  updatedAt = 1776699045449,
  text = '您好!',
}) {
  const payload = {
    reason: '',
    continueFlag: false,
    agentMessage: {
      id: messageId,
      role: 'assistant',
      session_id: sessionId,
      request_set_id: requestSetId,
      content: [
        { type: 'text', text },
        { type: 'finish', reason: 'end_turn', time: updatedAt },
      ],
      created_at: createdAt,
      updated_at: updatedAt,
      parent_id: 'fcaec159-2eba-40df-9e50-84f41c35f5d2',
      provider: 'lingma',
      status: 'finished',
      is_meta: false,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_tokens: cacheWrite,
        cache_read_tokens: cacheRead,
      },
      agent_id: 'a322ae3d',
      delta: null,
    },
    lastToolMessage: { id: '', role: '' },
    todoStatus: { total: 0, completed: 0, pending: 0, in_progress: 0, next_task: 'null' },
    err: null,
  };
  return [
    '2026-04-20T23:30:45.462+0800',
    'INFO',
    'agent_stop/task_completion_checker.go:231',
    'HookDesignBlock',
    JSON.stringify(payload),
  ].join('\t');
}

/** The five usage records the real log carries, verbatim. */
const REAL_LOG = [
  { requestSetId: 'req-1', messageId: 'm-1', input: 24275, output: 104, cacheRead: 0 },
  { requestSetId: 'req-2', messageId: 'm-2', input: 49343, output: 162, cacheRead: 32862 },
  { requestSetId: 'req-3', messageId: 'm-3', input: 63928, output: 470, cacheRead: 63432 },
  { requestSetId: 'req-4', messageId: 'm-4', input: 71345, output: 483, cacheRead: 71001 },
  { requestSetId: 'req-5', messageId: 'm-5', input: 77534, output: 252, cacheRead: 77223 },
];

/** Collect the records a parser yields. */
async function collect(file, opts) {
  const records = [];
  for await (const r of parseLingma(file, opts)) records.push(r);
  return records;
}

const FIELDS = [
  'agent', 'model', 'session', 'timestamp', 'input',
  'cacheRead', 'cacheWrite', 'output', 'project', 'branch',
];

const sum = (records, key) => records.reduce((a, r) => a + (r[key] || 0), 0);

test('one token_info row becomes one record, with the expected field set', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 24275, completion_tokens: 104, cached_tokens: 0, max_input_tokens: 0,
      }),
      gmtCreate: 1776699045449,
    }],
    sessions: [{ sessionId: 'sess-1', projectUri: '/Users/tianyi/code/opencode-ui' }],
  });

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), [...FIELDS].sort());
  assert.equal(records[0].agent, 'lingma');
  assert.equal(records[0].session, 'sess-1');
  assert.equal(records[0].timestamp, 1776699045449);
  assert.equal(records[0].output, 104);
  assert.equal(records[0].branch, null, 'Lingma records no branch');
});

test('the fresh input is the prompt minus the cache read, never the whole prompt', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-3',
      sessionId: 'sess-1',
      requestId: 'req-3',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 63928, completion_tokens: 470, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });
  await writeLog(home, [usageLine({
    requestSetId: 'req-3', messageId: 'm-3', input: 63928, output: 470, cacheRead: 63432,
  })]);

  const [rec] = await collect(file);
  assert.equal(rec.input, 496, 'the fresh input is prompt - cache_read');
  assert.equal(rec.cacheRead, 63432, 'the cache read is cache_read_tokens');
  assert.equal(rec.cacheWrite, 0, 'the cache write is cache_creation_tokens');
  assert.equal(rec.output, 470);
  assert.notEqual(rec.input, 63928, 'the whole prompt is not the fresh input');
  assert.equal(rec.input + rec.cacheRead, 63928, 'the two buckets still add up to the whole prompt');
});

test('a row with no log entry keeps the whole prompt as fresh input', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  // The documented fallback, the Cherry Studio precedent: when the store
  // reports an aggregate without a split, the whole prompt is fresh. The
  // lane's dollars are therefore an upper bound.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-9',
      sessionId: 'sess-1',
      requestId: 'req-9',
      role: 'tool',
      tokenInfo: JSON.stringify({
        prompt_tokens: 49524, completion_tokens: 112, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });

  const [rec] = await collect(file);
  assert.equal(rec.input, 49524, 'the whole prompt is fresh when the split is unknown');
  assert.equal(rec.cacheRead, 0, 'an unknown split is not invented');
  assert.equal(rec.cacheWrite, 0);
  assert.equal(rec.output, 112);
});

test('the model is unknown, never null and never invented', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  // Lingma records no model at all: `model_info` is an empty string on every
  // one of the 94 rows and `preferred_model_info` is empty too. Real spend
  // priced at the table's documented fallback beats real spend that was
  // dropped, and a made-up model name beats neither.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-1',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });

  const [rec] = await collect(file);
  assert.equal(rec.model, 'unknown');
  assert.notEqual(rec.model, null);
  assert.notEqual(rec.model, 'lingma', 'the provider is not the model');
});

test('the project comes from chat_session, and is null for an unknown session', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [
      {
        id: 'm-1',
        sessionId: 'sess-known',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
      {
        id: 'm-2',
        sessionId: 'sess-unknown',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 2000, completion_tokens: 20, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
    ],
    sessions: [{ sessionId: 'sess-known', projectUri: '/Users/tianyi/code/opencode-ui' }],
  });

  const records = await collect(file);
  assert.equal(records.length, 2);
  const known = records.find((r) => r.session === 'sess-known');
  const unknown = records.find((r) => r.session === 'sess-unknown');
  assert.equal(known.project, '/Users/tianyi/code/opencode-ui');
  assert.equal(unknown.project, null, 'an unknown session has no project, and that is not a crash');
});

test('a row with invalid token_info JSON is skipped without failing', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [
      {
        id: 'm-1',
        role: 'assistant',
        tokenInfo: '{"prompt_tokens":1000,"completion_tokens":10,',
      },
      {
        id: 'm-2',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 2000, completion_tokens: 20, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
    ],
  });

  const records = await collect(file);
  assert.equal(records.length, 1, 'the torn row is skipped, the good one survives');
  assert.equal(records[0].input, 2000);
});

test('a missing database yields no records and does not throw', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const missing = path.join(cacheRoot(home), 'cache', 'db', 'local.db');
  const records = await collect(missing);
  assert.deepEqual(records, []);
});

test('a missing log yields the records without a split, and does not throw', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-1',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 63928, completion_tokens: 470, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });

  const records = await collect(file);
  assert.equal(records.length, 1, 'the usage survives the missing log');
  assert.equal(records[0].input, 63928, 'without a split the whole prompt is fresh');
  assert.equal(records[0].cacheRead, 0);
});

test('a malformed log line is skipped, not fatal', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });
  await writeLog(home, [
    'this is not a log line at all',
    '2026-04-20T23:30:45.462+0800\tINFO\tagent_stop/x.go:1\tHook\t{"agentMessage": {"usage": not-json}}',
    // The IDE was killed mid-write: the payload stops in the middle.
    '2026-04-20T23:30:45.462+0800\tINFO\tagent_stop/x.go:1\tHook\t{"agentMessage": {"usage": {"input_tokens": 9',
    usageLine({ requestSetId: 'req-1', messageId: 'm-1', input: 1000, output: 10 }),
  ]);

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 1000);
  assert.equal(records[0].output, 10);
});

test('a user row with no token_info produces no record', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [
      // A `user` row with an EMPTY token_info: 51 of the 94 real rows look
      // like this, and none of them is a model call.
      { id: 'u-1', role: 'user', tokenInfo: '' },
      {
        id: 'm-1',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
    ],
  });

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, undefined, 'no internal field leaks into the record');
});

test('a user row that DOES carry usage is a model call, and is kept', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  // The measured shape of the real store: the role records the message the
  // call produced, not who called it. 5 of the 43 usage-bearing rows are
  // `user` and 33 are `tool`; filtering on the role would drop 38 of the 43
  // calls, and with them 88% of the session's tokens.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [
      {
        id: 'u-1',
        role: 'user',
        tokenInfo: JSON.stringify({
          prompt_tokens: 24392, completion_tokens: 105, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
      {
        id: 't-1',
        role: 'tool',
        tokenInfo: JSON.stringify({
          prompt_tokens: 28190, completion_tokens: 70, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
    ],
  });

  const records = await collect(file);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.input), [24392, 28190]);
});

test('the split is joined on the request id, and the token pair is the fallback', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [
      {
        id: 'm-1',
        sessionId: 'sess-1',
        requestId: 'req-1',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 63928, completion_tokens: 470, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
      {
        id: 'm-2',
        sessionId: 'sess-1',
        requestId: 'req-2',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 71345, completion_tokens: 483, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
    ],
  });
  await writeLog(home, [
    // The request id matches: this is the primary join.
    usageLine({ requestSetId: 'req-1', messageId: 'm-1', input: 63928, output: 470, cacheRead: 63432 }),
    // The request id does NOT match; the token pair inside the session does.
    usageLine({
      requestSetId: 'req-unknown',
      messageId: 'm-2',
      input: 71345,
      output: 483,
      cacheRead: 71001,
    }),
  ]);

  const stats = {};
  const records = await collect(file, { stats });
  assert.equal(records.length, 2);
  const first = records.find((r) => r.input === 496);
  const second = records.find((r) => r.input === 344);
  assert.ok(first, 'the request-id join gave the fresh input');
  assert.ok(second, 'the token-pair fallback gave the fresh input');
  assert.equal(first.cacheRead, 63432);
  assert.equal(second.cacheRead, 71001);
  assert.equal(stats.joins.request, 1);
  assert.equal(stats.joins['token-pair'], 1);
  assert.equal(stats.joins.none, 0);
});

test('the log is found next to the database, and the payload may sit in field 3', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 24275, completion_tokens: 104, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });
  const line = usageLine({ requestSetId: 'req-1', messageId: 'm-1', input: 24275, output: 104 });
  const fields = line.split('\t');
  // A layout with one header field fewer: the payload is the fourth field.
  await writeLog(home, [fields.slice(0, 3).concat(fields[4]).join('\t')]);

  const [rec] = await collect(file);
  assert.equal(rec.input, 24275);
  assert.equal(rec.cacheRead, 0);
});

test('a payload with braces inside a string does not truncate the usage', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [{
      id: 'm-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: 24275, completion_tokens: 104, cached_tokens: 0, max_input_tokens: 0,
      }),
    }],
  });
  await writeLog(home, [usageLine({
    requestSetId: 'req-1',
    messageId: 'm-1',
    input: 24275,
    output: 104,
    // The model's answer, which is what the payload carries: braces inside
    // a string must not end the scan.
    text: 'function f() { return {a: 1}; }',
  })]);

  const [rec] = await collect(file);
  assert.equal(rec.output, 104, 'the usage was found behind the braces in the answer');
});

test('a row whose buckets are all zero is an event, not spend', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const file = await writeDb(home, {
    rows: [
      {
        id: 'm-1',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
      {
        id: 'm-2',
        role: 'assistant',
        tokenInfo: JSON.stringify({
          prompt_tokens: 7, completion_tokens: 1, cached_tokens: 0, max_input_tokens: 0,
        }),
      },
    ],
  });

  const records = await collect(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 7);
});

test('a database that is not a Lingma store yields no records and does not throw', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const dir = path.join(cacheRoot(home), 'cache', 'db');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'local.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE something_else (a TEXT)');
  db.close();

  const records = await collect(file);
  assert.deepEqual(records, []);
});

test('the totals reproduce: 43 records, 2,752,050 prompt, 11,724 completion', async (t) => {
  if (!sqliteAvailable) {
    t.skip('node:sqlite is unavailable on this runtime');
    return;
  }
  // The measured shape of the real store, rebuilt as a fixture: 43 calls
  // over 6 turns, the five of them that the log describes carrying the
  // measured cache split, and the other 38 carrying none.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-lingma-'));
  const rows = [];
  REAL_LOG.forEach((r, i) => {
    rows.push({
      id: r.messageId,
      sessionId: 'sess-1',
      requestId: r.requestSetId,
      role: 'assistant',
      tokenInfo: JSON.stringify({
        prompt_tokens: r.input,
        completion_tokens: r.output,
        cached_tokens: 0,
        max_input_tokens: 0,
      }),
      gmtCreate: 1776699045449 + i * 1000,
    });
  });
  // 37 calls of 64,863 prompt / 270 completion and one of 65,694 / 263:
  // 2,465,625 and 10,253, which with the five above are 2,752,050 and
  // 11,724.
  for (let i = 0; i < 37; i++) {
    rows.push({
      id: `t-${i}`,
      sessionId: 'sess-1',
      requestId: `req-${6 + (i % 6)}`,
      role: i % 2 ? 'tool' : 'user',
      tokenInfo: JSON.stringify({
        prompt_tokens: 64863, completion_tokens: 270, cached_tokens: 0, max_input_tokens: 0,
      }),
      gmtCreate: 1776699055449 + i * 1000,
    });
  }
  rows.push({
    id: 't-37',
    sessionId: 'sess-1',
    requestId: 'req-12',
    role: 'tool',
    tokenInfo: JSON.stringify({
      prompt_tokens: 65694, completion_tokens: 263, cached_tokens: 0, max_input_tokens: 0,
    }),
    gmtCreate: 1776699095449,
  });

  const file = await writeDb(home, {
    rows,
    sessions: [{ sessionId: 'sess-1', projectUri: '/Users/tianyi/code/opencode-ui' }],
  });
  await writeLog(home, REAL_LOG.map((r) => usageLine({
    requestSetId: r.requestSetId,
    messageId: r.messageId,
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
  })));

  const records = await collect(file);
  assert.equal(records.length, 43, '43 usage-bearing rows are 43 records');
  assert.equal(
    sum(records, 'input') + sum(records, 'cacheRead'),
    2752050,
    'the whole prompt totals 2,752,050',
  );
  assert.equal(sum(records, 'output'), 11724, 'the completion totals 11,724');
  // The five known splits: the fresh part of the last three is a plausible
  // per-step count (496, 344, 311), and the 38 unknown splits are priced as
  // fresh — which is what makes the lane an upper bound.
  assert.equal(sum(records, 'cacheRead'), 244518);
  assert.equal(sum(records, 'input'), 2507532);
  assert.ok(records.every((r) => r.model === 'unknown'));
  assert.ok(records.every((r) => r.project === '/Users/tianyi/code/opencode-ui'));
});

test('the matcher takes the database and not its sidecars', () => {
  assert.ok(LINGMA_DB_MATCH('local.db'));
  assert.ok(!LINGMA_DB_MATCH('local.db-wal'), 'the -wal sidecar is the same data');
  assert.ok(!LINGMA_DB_MATCH('local.db-shm'));
  assert.ok(!LINGMA_DB_MATCH('lingmacli.log'), 'the log is a join sidecar, not a record source');
});

test('the store paths follow the real layout', () => {
  const paths = lingmaPaths('/home/tester');
  assert.equal(
    paths.db,
    '/home/tester/Library/Application Support/Lingma/SharedClientCache/cache/db/local.db',
  );
  assert.equal(
    paths.log,
    '/home/tester/Library/Application Support/Lingma/SharedClientCache/cli/logs/lingmacli.log',
  );
});
