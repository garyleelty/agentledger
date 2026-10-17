import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseClaudeCode, parseCodex } from '../src/parsers.js';
import { collect, totals, groupBy } from '../src/ledger.js';

test('claude-code records carry the project and branch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-attr-'));
  const file = path.join(dir, 's.jsonl');
  await writeFile(
    file,
    [
      JSON.stringify({ cwd: '/work/alpha', gitBranch: 'feature/x', type: 'user' }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:01:00Z',
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } },
      }),
    ].join('\n') + '\n',
  );
  const records = [];
  for await (const r of parseClaudeCode(file)) records.push(r);
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.project, '/work/alpha', 'attribution survives later turns that omit it');
    assert.equal(r.branch, 'feature/x');
  }
});

test('codex records carry the project and branch from session_meta', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-attr-'));
  const file = path.join(dir, 'rollout-x.jsonl');
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/work/beta', git: { branch: 'main', commit_hash: 'abc' } } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } } } }),
      JSON.stringify({ timestamp: '2026-01-01T00:01:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0 } } } }),
    ].join('\n') + '\n',
  );
  const records = [];
  for await (const r of parseCodex(file)) records.push(r);
  // First token_count is now yielded absolutely (Codex resumes with counters
  // already advanced), so two events produce two records.
  assert.equal(records.length, 2);
  assert.equal(records[0].project, '/work/beta');
  assert.equal(records[0].branch, 'main');
  assert.equal(records[1].project, '/work/beta');
  assert.equal(records[1].branch, 'main');
});

test('per-project costs sum back to the overall total', async () => {
  const records = [
    { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, project: '/a', model: 'claude-sonnet-4-5' },
    { input: 20, cacheRead: 0, cacheWrite: 0, output: 5, project: '/b', model: 'claude-sonnet-4-5' },
    { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, project: null, model: 'claude-sonnet-4-5' },
  ];
  const grand = totals(records).cost;
  let perProject = 0;
  for (const g of groupBy(records, (r) => r.project || '(unknown)').values()) perProject += totals(g).cost;
  assert.ok(Math.abs(grand - perProject) < 1e-9, 'grouping must not lose or double-count cost');
});

// A committed HOME tree with claude-code sessions, so the ledger-level tests
// never depend on whatever logs happen to exist on the machine running them.
// CI runners have no ~/.claude at all, and a test that silently measures zero
// records proves nothing.
const fixtureHome = path.join(import.meta.dirname, 'fixtures', 'home');

test('collect attributes every record to a project', async () => {
  const savedHome = process.env.HOME;
  process.env.HOME = fixtureHome;
  try {
    const { records } = await collect();
    assert.ok(records.length > 0, 'the fixture home must produce records');
    const unattributed = records.filter((r) => !r.project);
    assert.equal(unattributed.length, 0, 'every parser should carry attribution');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test('waste report ranks sessions by cache read and states the share', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = path.resolve(import.meta.dirname, '..');
  const out = execFileSync('node', [path.join(root, 'bin', 'agentledger.js'), 'waste'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, HOME: fixtureHome },
  });
  assert.match(out, /cache reads are the story/);
  assert.match(out, /of all cache reads/);
  // the concentration claim must be a real percentage, not a placeholder
  const m = out.match(/hold (\d+\.\d)% of all cache reads/);
  assert.ok(m, 'expected a concrete concentration figure');
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 100);
});
