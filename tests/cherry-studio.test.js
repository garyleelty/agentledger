import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCherryStudio } from '../src/parsers-cherry.js';
import { collect, SOURCES } from '../src/ledger.js';

/**
 * Cherry Studio is the one source that can DOUBLE-COUNT, because it is a GUI
 * hosting other agents and records usage for requests the hosted agent also
 * logs. Two things are therefore pinned here, and neither is optional:
 *
 *   1. The parser's bucketing. `input_tokens` is the WHOLE prompt
 *      (no_cache + cache_read), not the fresh part; `reasoning_tokens` is a
 *      SUBSET of output, not additive. Getting either wrong mis-prices every
 *      row in the lane. Both were verified against the real store on this
 *      machine (no_cache + cache_read == input on all invocation rows that
 *      carry the split; total == input + output on all 41).
 *   2. The dedup. 3 of the 32 real rows are the same request as a pi-agent
 *      row. They must be dropped exactly once, and rows that merely look
 *      similar must NOT be.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Build a cherrystudio.sqlite with the ai_usage_record schema we read. */
async function makeDb(rows) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-cherry-'));
  const file = path.join(dir, 'cherrystudio.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE ai_usage_record (
      id text PRIMARY KEY NOT NULL,
      request_id text NOT NULL,
      record_kind text NOT NULL,
      request_count integer NOT NULL,
      message_kind text,
      message_id text,
      provider_id text,
      provider_name text,
      model_id text,
      source_type text,
      source_id text,
      modality text NOT NULL,
      input_tokens integer,
      output_tokens integer,
      total_tokens integer,
      reasoning_tokens integer,
      no_cache_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      cost real,
      created_at integer NOT NULL
    )`);
  const ins = db.prepare(
    `INSERT INTO ai_usage_record (id, request_id, record_kind, request_count, modality,
       model_id, source_type, source_id, input_tokens, output_tokens, total_tokens,
       reasoning_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, created_at)
     VALUES (?, ?, ?, ?, 'language', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((r, i) => ins.run(
    `id-${i}`, `req-${i}`, r.kind ?? 'invocation', r.requestCount ?? 1,
    r.model ?? null, r.sourceType ?? null, r.sourceId ?? null,
    r.input ?? 0, r.output ?? 0, (r.input ?? 0) + (r.output ?? 0),
    r.reasoning ?? null, r.noCache ?? null, r.cacheRead ?? null, r.cacheWrite ?? null,
    r.createdAt ?? 1700000000000,
  ));
  db.close();
  return file;
}

test('input_tokens is the whole prompt: fresh = no_cache, not input', async () => {
  const file = await makeDb([
    { input: 6364, output: 713, noCache: 92, cacheRead: 6272, reasoning: 221, model: 'm' },
  ]);
  const recs = [];
  for await (const r of parseCherryStudio(file)) recs.push(r);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].input, 92, 'fresh input is no_cache_tokens, not the whole prompt');
  assert.equal(recs[0].cacheRead, 6272);
  assert.equal(recs[0].output, 713, 'reasoning is a SUBSET of output here, not added');
});

test('legacy-aggregate rows keep their whole input as fresh (no split)', async () => {
  const file = await makeDb([
    { kind: 'legacy-aggregate', requestCount: 37, input: 336932, output: 9528, model: 'mimo-v2.5-pro' },
  ]);
  const recs = [];
  for await (const r of parseCherryStudio(file)) recs.push(r);
  assert.equal(recs[0].input, 336932);
  assert.equal(recs[0].cacheRead, 0, 'a session that predates cache accounting has none');
});

test('a NULL model is kept, not dropped', async () => {
  // 4 of the 41 real rows have no model — 115,787 input tokens. Dropping real
  // spend to keep the table pretty is the failure this pins against.
  const file = await makeDb([
    { input: 11371, output: 8471, model: null },
    { input: 5, output: 5, model: 'known' },
  ]);
  const recs = [];
  for await (const r of parseCherryStudio(file)) recs.push(r);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].model, 'unknown');
  assert.equal(recs[0].input, 11371);
});

test('all-zero rows are events, not spend', async () => {
  const file = await makeDb([
    { input: 0, output: 0, model: 'radeon-cloud::DeepSeek-V4-Flash' },
    { input: 7, output: 1, model: 'qwen' },
  ]);
  const recs = [];
  for await (const r of parseCherryStudio(file)) recs.push(r);
  assert.equal(recs.length, 1);
});

test('the SOURCES matcher takes cherrystudio.sqlite and nothing else', () => {
  const src = SOURCES.find((s) => s.agent === 'cherry-studio');
  assert.ok(src, 'cherry-studio must be registered');
  assert.ok(src.match('cherrystudio.sqlite'));
  // the -wal and -shm sidecars would be the same data twice
  assert.ok(!src.match('cherrystudio.sqlite-wal'));
  assert.ok(!src.match('agents.db'), 'the agents store has no token counts');
});

test('collect() drops host duplicates exactly once, and only those', async () => {
  // A pi session log and a host row for the SAME request, written 40ms apart,
  // with the buckets each store actually uses. The fixture is laid out at the
  // real path (`$HOME/.pi/agent/sessions/<slug>/<file>.jsonl`) so the shipped
  // source matcher, not a test-only shortcut, is what finds it.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-home-'));
  const sessDir = path.join(home, '.pi', 'agent', 'sessions', '--work--');
  await mkdir(sessDir, { recursive: true });
  const t0 = 1792257747314;
  await writeFile(
    path.join(sessDir, '2026-10-17T17-22-27.314Z_uuid.jsonl'),
    [
      JSON.stringify({ type: 'session', id: 's1', timestamp: new Date(t0).toISOString(), cwd: '/work' }),
      // the duplicate: whole prompt 5851, out 13
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: new Date(t0).toISOString(),
        message: { role: 'assistant', model: 'new-api:deepseek-v4.1-flash-free', usage: { input: 5851, output: 13, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      }),
      // a DIFFERENT request: whole prompt 12,599 — must survive
      JSON.stringify({
        type: 'message', id: 'a2', timestamp: new Date(t0 + 26000).toISOString(),
        message: { role: 'assistant', model: 'new-api:deepseek-v4.1-flash-free', usage: { input: 567, output: 818, cacheRead: 12032, cacheWrite: 0, reasoning: 271 } },
      }),
    ].join('\n') + '\n',
  );

  const cherry = await makeDb([
    // same request as pi a1: whole prompt 5851, out 13, written 40ms later
    { input: 5851, output: 13, noCache: 5851, cacheRead: 0, model: 'deepseek-v4.1-flash-free', createdAt: t0 + 40 },
    // the same request the host buckets differently: whole prompt 6364 — NOT a duplicate
    { input: 6364, output: 713, noCache: 92, cacheRead: 6272, model: 'deepseek-v4.1-flash-free', createdAt: t0 + 26400 },
  ]);

  // Run the real CLI with both lanes so the dedup path is the shipped one.
  // The child needs the SAME `--experimental-sqlite` the suite runs under:
  // `node:sqlite` is unflagged from Node 23.8, but 22.5 — this project's floor
  // — only exposes it with the flag, so spawning a bare node silently yields an
  // empty cherry lane on exactly the version CI's matrix leg exercises. Pass
  // the parent's exec argv through rather than hardcoding either way.
  const childArgs = process.execArgv.some((a) => a.includes('experimental-sqlite'))
    ? process.execArgv.filter((a) => a.includes('experimental-sqlite'))
    : [];
  const out = execFileSync(process.execPath, [
    ...childArgs,
    path.join(root, 'bin', 'agentledger.js'), 'json',
    '-a', 'pi', '-a', 'cherry-studio', '--path', cherry,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, HOME: home } });
  const d = JSON.parse(out);
  const pi = d.records.filter((r) => r.agent === 'pi');
  const cherryRecs = d.records.filter((r) => r.agent === 'cherry-studio');
  assert.equal(pi.length, 2, 'the pi lane is untouched');
  assert.equal(cherryRecs.length, 1, 'only the true duplicate is dropped');
  assert.equal(cherryRecs[0].tokens.input, 92, 'the surviving host row is the different request');
});

test('a host row of a DIFFERENT model with the same prompt size survives', async () => {
  // The dedup key is the whole-prompt total PLUS the model family, and the
  // second half is load-bearing: whole-prompt totals collide (402 of 14,959
  // distinct values on this machine are shared by two or more records), so
  // a host row that happened to send the same-sized prompt as an unrelated
  // request nearby would be silently deleted by a prompt-size-only key.
  //
  // This is the false positive, constructed: same token counts, 30ms apart,
  // different models. It must be KEPT.
  const home = await mkdtemp(path.join(tmpdir(), 'aledger-home-'));
  const sessDir = path.join(home, '.pi', 'agent', 'sessions', '--work--');
  await mkdir(sessDir, { recursive: true });
  const t0 = 1792257747314;
  await writeFile(
    path.join(sessDir, '2026-10-17T17-22-27.314Z_uuid.jsonl'),
    [
      JSON.stringify({ type: 'session', id: 's1', timestamp: new Date(t0).toISOString(), cwd: '/work' }),
      // whole prompt 5851, but this is a DIFFERENT model than the host row
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: new Date(t0).toISOString(),
        message: { role: 'assistant', model: 'new-api:some-other-model-free', usage: { input: 5851, output: 13, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      }),
    ].join('\n') + '\n',
  );

  const cherry = await makeDb([
    { input: 5851, output: 13, noCache: 5851, cacheRead: 0, model: 'deepseek-v4.1-flash-free', createdAt: t0 + 30 },
  ]);

  const childArgs = process.execArgv.some((a) => a.includes('experimental-sqlite'))
    ? process.execArgv.filter((a) => a.includes('experimental-sqlite'))
    : [];
  const out = execFileSync(process.execPath, [
    ...childArgs,
    path.join(root, 'bin', 'agentledger.js'), 'json',
    '-a', 'pi', '-a', 'cherry-studio', '--path', cherry,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, HOME: home } });
  const d = JSON.parse(out);
  const cherryRecs = d.records.filter((r) => r.agent === 'cherry-studio');
  assert.equal(cherryRecs.length, 1, 'a different model is not a duplicate, however similar the size');
});

test('a host row with no counterpart is kept', async () => {
  // The June/July Cherry Studio sessions no other source covers must survive.
  const cherry = await makeDb([
    { input: 336932, output: 9528, model: 'mimo-v2.5-pro', createdAt: Date.parse('2026-06-27T14:54:36Z') },
  ]);
  const { records } = await collect({ paths: [cherry] });
  const cherryRecs = records.filter((r) => r.agent === 'cherry-studio');
  assert.equal(cherryRecs.length, 1);
  assert.equal(cherryRecs[0].input, 336932);
});
