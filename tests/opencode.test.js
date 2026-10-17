import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseOpenCode } from '../src/parsers.js';
import { costOf, resolvePricing, PRICING } from '../src/pricing.js';
import { collect, SOURCES } from '../src/ledger.js';

/**
 * Build a real SQLite file in the shape OpenCode writes it, so the parser is
 * exercised against the thing it will actually open rather than a mock.
 */
async function makeDb(dir, rows, opts = {}) {
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
  // The real store joins message -> session for the working directory, so the
  // fixture needs a session table too or the LEFT JOIN yields no attribution.
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)');
  const dirs = opts.directories ?? { 'ses-1': '/tmp/fixture-project' };
  for (const [id, directory] of Object.entries(dirs)) {
    db.exec(`INSERT INTO session (id, directory) VALUES ('${id}', '${directory}')`);
  }
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  for (const [i, row] of rows.entries()) {
    insert.run(`msg_${i}`, row.session ?? 'ses-1', row.created ?? 1776004330476, JSON.stringify(row));
  }
  db.close();
  return file;
}

const assistant = (tokens, extra = {}) => ({
  role: 'assistant',
  providerID: 'opencode',
  modelID: 'deepseek-v4-flash-free',
  time: { created: 1776004330476 },
  tokens,
  ...extra,
});

test('parseOpenCode reads nested token buckets from the message table', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-oc-'));
  try {
    const file = await makeDb(dir, [
      { role: 'user', time: { created: 1 } },
      assistant({ input: 273, output: 588, reasoning: 41, cache: { read: 116992, write: 0 } }),
      assistant({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }), // an aborted turn
    ]);
    const records = [];
    for await (const r of parseOpenCode(file)) records.push(r);
    assert.equal(records.length, 1, 'a turn with no tokens at all carries no usage');
    const r = records[0];
    assert.equal(r.agent, 'opencode');
    assert.equal(r.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(r.session, 'ses-1');
    assert.equal(r.timestamp, 1776004330476);
    assert.equal(r.input, 273);
    assert.equal(r.cacheRead, 116992);
    assert.equal(r.cacheWrite, 0);
    // reasoning bills at the output price on every provider that splits it
    assert.equal(r.output, 629);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseOpenCode tolerates a file that is not a database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-oc-'));
  try {
    const file = path.join(dir, 'opencode.db');
    await writeFile(file, 'this is not sqlite at all\n');
    const records = [];
    for await (const r of parseOpenCode(file)) records.push(r);
    assert.equal(records.length, 0, 'an unreadable store is skipped, not thrown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseOpenCode tolerates a table that is not the message table', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-oc-'));
  try {
    const file = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE something_else (x TEXT)');
    db.close();
    const records = [];
    for await (const r of parseOpenCode(file)) records.push(r);
    assert.equal(records.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collect finds the OpenCode store and prices its free lane at zero', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aledger-oc-home-'));
  const share = path.join(root, '.local', 'share', 'opencode');
  await mkdir(share, { recursive: true });
  await makeDb(share, [assistant({ input: 1000, output: 500, reasoning: 0, cache: { read: 20000, write: 0 } })]);

  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    const { records } = await collect({ agents: ['opencode'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].agent, 'opencode');
    // The whole lane is a free promotion: it must read $0.00, not the
    // DEFAULT_PRICING fallback that used to turn it into hundreds of dollars.
    assert.equal(costOf(records[0]).total, 0);
  } finally {
    process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});

test('opencode is advertised as a supported source', () => {
  const source = SOURCES.find((s) => s.agent === 'opencode');
  assert.ok(source, 'opencode missing from SOURCES');
  assert.match(source.root, /^~\//);
  assert.equal(typeof source.parser, 'function');
  assert.ok(source.docs.startsWith('https://'));
});

/* ------------------------- pricing regressions ------------------------- */

test('a free model never inherits a paid model price by prefix', () => {
  // deepseek-v4-flash is paid; deepseek-v4-flash-free is $0. The old resolver
  // matched in both directions, so the free lane was billed at the paid rate.
  // The paid side is asserted *relationally* — it must resolve to the paid
  // entry and stay above zero — because the exact rate is the audit script's
  // business (tools/audit_pricing.py), and hardcoding it here made every
  // legitimate repricing look like a resolver regression.
  assert.equal(resolvePricing('deepseek-v4-flash'), PRICING['deepseek-v4-flash']);
  assert.ok(PRICING['deepseek-v4-flash'].input > 0, 'the paid lane must price above zero');
  assert.equal(resolvePricing('deepseek-v4-flash-free').input, 0);
  assert.equal(resolvePricing('opencode/deepseek-v4-flash-free').input, 0);
  assert.equal(resolvePricing('hy3-free').input, 0);
  assert.equal(costOf({ model: 'deepseek-v4-flash-free', input: 1e6, output: 1e6, cacheRead: 1e6 }).total, 0);
});

test('provider-qualified ids resolve to the bare model name', () => {
  assert.equal(resolvePricing('Cherry-New-API/gpt-5.5').input, PRICING['gpt-5.5'].input);
  assert.equal(resolvePricing('moonshotai/kimi-k2.7-code').input, PRICING['kimi-k2.7-code'].input);
  // Two providers of the same model must not become two different prices.
  assert.equal(resolvePricing('Cherry-Xiaomi-MiMo/mimo-v2.5-pro').input, PRICING['mimo-v2.5-pro'].input);
});

test('an unknown model still prices at the documented default', () => {
  const p = resolvePricing('some-model-nobody-has-seen');
  assert.equal(p.input, 3.0);
  assert.equal(p.output, 15.0);
});

/* ------------------------- Kilo (OpenCode fork) -------------------------- */

test('kilo is advertised as a supported source and shares the store reader', async () => {
  const { PARSERS } = await import('../src/parsers.js');
  const src = SOURCES.find((s) => s.agent === 'kilo');
  assert.ok(src, 'kilo must be in SOURCES');
  assert.match(src.root, /kilo/);
  assert.equal(src.parser, PARSERS.kilo);
  // Kilo is an OpenCode fork: same schema, so one factory backs both lanes.
  assert.equal(typeof PARSERS.kilo, 'function');
});

test('parseKilo reads a kilo.db and labels records agent=kilo', async () => {
  const { PARSERS } = await import('../src/parsers.js');
  // Build a kilo-shaped store: message rows with nested tokens, session rows
  // with a directory — the exact shape verified against a live kilo.db.
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-kilo-'));
  const file = path.join(dir, 'kilo.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
  db.exec("INSERT INTO session (id, directory) VALUES ('ses-k1', '/work/kilo-proj')");
  const data = JSON.stringify({
    role: 'assistant',
    providerID: 'minimax-cn', modelID: 'MiniMax-M2.7',
    time: { created: 1775654466351 },
    tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 40000, write: 0 } },
  });
  db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run('msg1', 'ses-k1', data);
  db.close();

  const records = [];
  for await (const r of PARSERS.kilo(file)) records.push(r);
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, 'kilo');
  assert.equal(records[0].model, 'minimax-cn/MiniMax-M2.7');
  assert.equal(records[0].project, '/work/kilo-proj');
  assert.equal(records[0].output, 250, 'reasoning folds into output');
  assert.equal(records[0].cacheRead, 40000);
});

test('a :free model lane bills zero regardless of the paid model it names', async () => {
  // Kilo's store carries `bytedance-seed/dola-seed-2.0-pro:free`. The free
  // check must fire before prefix matching, or the row would price at the
  // paid model's rate (or the $3/$15 default) while the provider bills $0.
  const { resolvePricing, costOf } = await import('../src/pricing.js');
  for (const m of ['bytedance-seed/dola-seed-2.0-pro:free', 'kilo/dola:FREE', 'gpt-5:free', 'some-model-free']) {
    assert.equal(resolvePricing(m).input, 0, `${m} must resolve free`);
  }
  const c = costOf({ model: 'x:free', input: 1e9, output: 1e9, cacheRead: 1e9 });
  assert.equal(c.total, 0);
  // and the paid spelling of the same base model still costs money
  assert.ok(resolvePricing('bytedance-seed/dola-seed-2.0-pro').input > 0);
});

test('a provider-qualified id with a dated suffix resolves like the bare name', async () => {
  // Regression: `deepseek/deepseek-v4.1-flash-1017` fell through to the $3/$15
  // default while the bare `deepseek-v4.1-flash-1017` resolved correctly. The
  // slash-tail lookup did an exact table hit only, skipping the prefix pass
  // that the full id gets. Gateways append dated build suffixes to prefixed
  // ids constantly, so this silently mispriced real records.
  const { resolvePricing } = await import('../src/pricing.js');
  const withPrefix = resolvePricing('deepseek/deepseek-v4.1-flash-1017');
  const bare = resolvePricing('deepseek-v4.1-flash-1017');
  assert.equal(withPrefix.input, 0.3, 'the prefixed dated variant must not fall back to the default');
  assert.deepEqual(withPrefix, bare, 'the prefix must not change the resolved rate');
  assert.notEqual(withPrefix, undefined);
});
