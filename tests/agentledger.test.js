import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseClaudeCode, parseCodex, parseGemini } from '../src/parsers.js';
import { costOf, resolvePricing, PRICING } from '../src/pricing.js';
import { collect, totals, groupBy, withCost, SOURCES } from '../src/ledger.js';

/* ------------------------------- parsers ------------------------------- */

test('parseClaudeCode reads usage from assistant messages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-'));
  const file = path.join(dir, 'abc.jsonl');
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-02T03:04:05.000Z',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 50 },
        },
      }),
      '{ this is not json', // truncated tail, must be skipped
    ].join('\n') + '\n',
  );

  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, 'claude-code');
  assert.equal(records[0].model, 'claude-sonnet-4-5');
  assert.equal(records[0].input, 100);
  assert.equal(records[0].cacheRead, 5000);
  assert.equal(records[0].cacheWrite, 200);
  assert.equal(records[0].output, 50);
  assert.equal(records[0].timestamp, Date.parse('2026-01-02T03:04:05.000Z'));
});

test('parseCodex converts cumulative counters into deltas', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-'));
  const file = path.join(dir, 'rollout-x.jsonl');
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-1' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({
        timestamp: '2026-01-02T03:04:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              // total == input + output: output_tokens already includes
              // reasoning_output_tokens (verified against 1,633 real events)
              input_tokens: 1000,
              cached_input_tokens: 800,
              output_tokens: 100,
              reasoning_output_tokens: 20,
              total_tokens: 1100,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-01-02T03:04:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 3000,
              cached_input_tokens: 2000,
              output_tokens: 300,
              reasoning_output_tokens: 60,
              total_tokens: 3300,
            },
          },
        },
      }),
    ].join('\n') + '\n',
  );

  const records = [];
  for await (const r of parseCodex(file)) records.push(r);
  assert.equal(records.length, 1, 'first event only sets the baseline');
  assert.equal(records[0].agent, 'codex');
  assert.equal(records[0].model, 'gpt-5.5');
  // fresh input = (3000-2000) - (1000-800) = 800
  assert.equal(records[0].input, 800);
  assert.equal(records[0].cacheRead, 1200);
  // output delta is 300-100 = 200; reasoning (60-20=40) is already
  // inside those numbers and must NOT be added again.
  assert.equal(records[0].output, 200);
});

test('parseGemini reads usageMetadata events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-'));
  const file = path.join(dir, 'logs.json');
  await writeFile(
    file,
    JSON.stringify([
      { timestamp: '2026-01-02T03:04:05.000Z', model: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 4 } },
      { timestamp: '2026-01-02T03:04:06.000Z', noUsage: true },
    ]),
  );
  const records = [];
  for await (const r of parseGemini(file)) records.push(r);
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, 'gemini-cli');
  assert.equal(records[0].input, 10);
  assert.equal(records[0].output, 7);
  assert.equal(records[0].cacheRead, 4);
});

/* ------------------------------- pricing ------------------------------- */

test('costOf applies cache-read and output multipliers', () => {
  const cost = costOf({
    model: 'claude-sonnet-4-5',
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
  });
  assert.ok(Math.abs(cost.input - 3.0) < 1e-9);
  assert.ok(Math.abs(cost.cacheRead - 0.3) < 1e-9); // 10% of input price
  assert.ok(Math.abs(cost.output - 15.0) < 1e-9);
  assert.ok(Math.abs(cost.total - 18.3) < 1e-9);
});

test('costOf handles dated model snapshots and unknown models', () => {
  assert.equal(costOf({ model: 'claude-sonnet-4-5-20250929', input: 1_000_000, output: 0 }).input, 3.0);
  const unknown = costOf({ model: 'mystery-model-9000', input: 1_000_000, output: 0 });
  assert.ok(unknown.total > 0);
});

test('resolvePricing prefers exact matches', () => {
  assert.equal(resolvePricing('gpt-5.5').input, 5.0);
  assert.equal(resolvePricing('GPT-5.5').input, 5.0);
  assert.equal(resolvePricing(undefined).input, PRICING['claude-sonnet-4-5'].input);
});

/* -------------------------------- ledger ------------------------------- */

test('collect aggregates records across sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aledger-home-'));
  const projects = path.join(root, '.claude', 'projects');
  await mkdir(projects, { recursive: true });
  await writeFile(
    path.join(projects, 's1.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-02T03:04:05.000Z',
      message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 3 } },
    }) + '\n',
  );

  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    const { records, filesScanned } = await collect();
    assert.ok(filesScanned >= 1);
    assert.ok(records.length >= 1);
    const t = totals(records.map(withCost));
    assert.equal(t.input, 1);
    assert.equal(t.cacheRead, 2);
    assert.equal(t.output, 3);
    assert.ok(t.cost > 0);
  } finally {
    process.env.HOME = home;
  }
});

test('collect tolerates a missing home directory', async () => {
  const home = process.env.HOME;
  process.env.HOME = '/nonexistent-path-for-tests';
  try {
    const { records } = await collect();
    assert.equal(records.length, 0);
  } finally {
    process.env.HOME = home;
  }
});

test('groupBy buckets records by an arbitrary key', () => {
  const groups = groupBy(
    [{ agent: 'a' }, { agent: 'a' }, { agent: 'b' }],
    (r) => r.agent,
  );
  assert.equal(groups.get('a').length, 2);
  assert.equal(groups.get('b').length, 1);
});

test('every configured source points at a documented log location', () => {
  assert.ok(SOURCES.length >= 3);
  for (const s of SOURCES) {
    assert.match(s.root, /^~\//);
    assert.equal(typeof s.parser, 'function');
  }
});

/* --------------------- 1h vs 5m cache-write TTL split --------------------- */

test('parseClaudeCode carries the cache TTL split when present', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-ttl-'));
  const file = path.join(dir, 'ttl.jsonl');
  await writeFile(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 90, // lumped: 10m at 5m + 80 at 1h
          output_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 80 },
        },
      },
    }) + '\n',
  );
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 1);
  assert.equal(records[0].cacheWrite, 90, 'the lumped field stays for grouping');
  assert.equal(records[0].cacheWrite5m, 10);
  assert.equal(records[0].cacheWrite1h, 80);
});

test('parseClaudeCode omits the split fields when logs lack the nested block', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-ttl-'));
  const file = path.join(dir, 'old.jsonl');
  await writeFile(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, cache_creation_input_tokens: 90, output_tokens: 5 },
      },
    }) + '\n',
  );
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records[0].cacheWrite1h, undefined, 'no invented split');
  assert.equal(records[0].cacheWrite5m, undefined);
});

test('costOf bills 1-hour cache writes at 2x and 5-minute at 1.25x', () => {
  // Anthropic's published TTL rates (and LiteLLM's above_1hr field): on a
  // $3/M model, 5m writes are $3.75/M and 1h writes are $6/M. Billing the
  // lump at 1.25x undercharges every 1-hour write by 37.5%.
  const p = resolvePricing('claude-sonnet-4-5');
  assert.equal(p.cacheWrite1hMultiplier, 2.0);
  const split = costOf({
    model: 'claude-sonnet-4-5',
    input: 0, cacheRead: 0, cacheWrite: 90, cacheWrite5m: 10, cacheWrite1h: 80, output: 0,
  });
  // 10 * 3 * 1.25 / 1e6 + 80 * 3 * 2 / 1e6
  const expected = (10 * 3 * 1.25 + 80 * 3 * 2.0) / 1e6;
  assert.ok(Math.abs(split.cacheWrite - expected) < 1e-12, `${split.cacheWrite} != ${expected}`);
  // Without a split, the lump prices at the base write rate exactly as before.
  const lump = costOf({ model: 'claude-sonnet-4-5', input: 0, cacheRead: 0, cacheWrite: 90, output: 0 });
  assert.ok(Math.abs(lump.cacheWrite - (90 * 3 * 1.25) / 1e6) < 1e-12);
});

test('non-Anthropic models have no TTL tier and are priced at their own rate', () => {
  // gpt-5 has no separate cache-write billing at all (billed as input).
  const g = resolvePricing('gpt-5');
  assert.equal(g.cacheWrite1hMultiplier, undefined);
  const c = costOf({ model: 'gpt-5', input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 });
  assert.ok(Math.abs(c.cacheWrite - 1.25) < 1e-9, `1M gpt-5 cache-write tokens should cost $1.25, got ${c.cacheWrite}`);
});

test('parseCodex does not add reasoning tokens to output', async () => {
  // Regression: `total_token_usage.output_tokens` already includes
  // `reasoning_output_tokens`. Real logs prove it — 1,633 token_count events
  // satisfy total == input + output, none satisfy total == in + out + reas.
  // Adding them (as the parser did) double-counted every reasoning token and
  // put the codex lane at $200 against ccusage's $192.71.
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-codex-'));
  const file = path.join(dir, 'rollout-r.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 's1' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
        reasoning_output_tokens: 0, total_tokens: 0 } } } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: {
        // total = input + output exactly, so output must be taken as-is
        input_tokens: 12851, cached_input_tokens: 2432, output_tokens: 348,
        reasoning_output_tokens: 315, total_tokens: 13199 } } } }),
  ].join('\n') + '\n');

  const records = [];
  for await (const r of parseCodex(file)) records.push(r);
  assert.equal(records.length, 1);
  // fresh input = (12851-2432) - 0
  assert.equal(records[0].input, 10419);
  assert.equal(records[0].cacheRead, 2432);
  // output is the delta of output_tokens alone (348), NOT 348+315=663
  assert.equal(records[0].output, 348, 'reasoning must not be added again');
});
