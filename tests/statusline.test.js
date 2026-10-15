import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `statusline` is the only command built to be called by another program on
 * every render, so its contract is different from every other command here:
 * exit 0 whatever happens, print exactly one line, never leak a stack trace
 * into a status bar. These tests pin that contract, not the wording.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

function run(args, stdin = '') {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input: stdin,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: path.join(root, 'tests', 'fixtures', 'home') },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function fixtureTranscript() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-sl-'));
  const file = path.join(dir, 'sess-abc.jsonl');
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'user', cwd: '/x', message: { role: 'user' } }),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-01T10:00:00.000Z',
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 5000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, output_tokens: 700 } },
      }),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-01T10:01:00.000Z',
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 91000, cache_creation_input_tokens: 0, output_tokens: 60 } },
      }),
    ].join('\n') + '\n',
  );
  return file;
}

test('statusline prices exactly the transcript it is handed', async () => {
  const file = await fixtureTranscript();
  const { status, stdout } = run(['statusline', '--json'], JSON.stringify({ session_id: 'sess-abc', transcript_path: file }));
  assert.equal(status, 0);
  const d = JSON.parse(stdout);
  assert.equal(d.session, 'sess-abc');
  assert.equal(d.records, 2, 'only the two assistant rows of THIS transcript');
  assert.ok(d.tokens > 0);
  // one line, no headers, no ANSI
  const line = run(['statusline'], JSON.stringify({ session_id: 'sess-abc', transcript_path: file })).stdout;
  assert.equal(line.trim().split('\n').length, 1);
  assert.doesNotMatch(line, /\x1b\[/, 'no escape codes in a status bar');
  assert.match(line, /agentledger · \$\S+ · \S+ tok · 2 calls/);
});

test('statusline exits 0 on garbage, missing files, and empty stdin', () => {
  for (const stdin of ['not json', '{"transcript_path":"/nonexistent/x.jsonl"}', '', '{"model":{}}']) {
    const { status, stdout } = run(['statusline'], stdin);
    assert.equal(status, 0, `must survive ${JSON.stringify(stdin.slice(0, 30))}`);
    assert.match(stdout, /^agentledger · .+\n$/, 'exactly one agentledger line');
  }
});

test('a fresh session prints a starting marker, not a fake zero measurement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-sl-'));
  const file = path.join(dir, 'empty-sess.jsonl');
  await writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user' } }) + '\n');
  const { stdout } = run(['statusline'], JSON.stringify({ session_id: 'e', transcript_path: file }));
  assert.match(stdout, /session starting/, 'no records yet must read as "starting", not "$0.00 spent"');
});

test('the model from the hook payload is echoed when present', async () => {
  const file = await fixtureTranscript();
  const { stdout } = run(['statusline'], JSON.stringify({ transcript_path: file, model: { id: 'claude-opus-4-8' } }));
  assert.match(stdout, /claude-opus-4-8$/m);
});

test('a modern payload with cost fields is echoed without touching files', async () => {
  // Claude Code already knows what the session cost; re-deriving an estimate
  // from the transcript when the host hands you the number is worse, not
  // more rigorous. The payload path must win when present.
  const payload = {
    session_id: 'fast',
    transcript_path: '/nonexistent/so-a-scan-would-fail.jsonl',
    model: { id: 'claude-sonnet-4-20250514', display_name: 'Sonnet 4' },
    cost: { total_cost_usd: 0.05626615 },
    context_window: { total_input_tokens: 42500, total_output_tokens: 3200 },
  };
  const { status, stdout } = run(['statusline'], JSON.stringify(payload));
  assert.equal(status, 0);
  assert.match(stdout, /\$0\.0563/);
  assert.match(stdout, /45\.7k tok/);
  assert.match(stdout, /Sonnet 4/);
  const j = JSON.parse(run(['statusline', '--json'], JSON.stringify(payload)).stdout);
  assert.equal(j.source, 'hook-payload');
  assert.equal(j.costUSD, 0.05626615);
});

test('statusline is listed in --help', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /statusline\s+One line for Claude Code/);
});
