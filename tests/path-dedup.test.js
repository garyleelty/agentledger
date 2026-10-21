import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'agentledger.js');

/**
 * `--path` on a file a built-in lane already read.
 *
 * The same request, twice, in the same total, with nothing to say so.
 * Measured before the fix: `--path` on a Claude Code file took that lane
 * from 1,462 records to 1,574 — 112 extra records for 112 requests that
 * were already in the number.
 *
 * The rule now is file-level: a file a built-in lane already read is not
 * read again. A path that is genuinely new still contributes.
 */

const childArgs = process.execArgv.some((a) => a.includes('experimental-sqlite'))
  ? process.execArgv.filter((a) => a.includes('experimental-sqlite'))
  : [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-dedup-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [0, 1].map((i) => JSON.stringify({
    type: 'assistant',
    message: { id: `msg-${i}`, model: 'mimo-v2.5-pro', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    timestamp: new Date(Date.UTC(2026, 5, 1, 10 + i)).toISOString(),
    sessionId: 's1',
    cwd: '/work',
  }));
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.join('\n') + '\n');
  return { home, file: path.join(dir, 's1.jsonl') };
}

function count(args, home) {
  const out = execFileSync(process.execPath, [...childArgs, cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(out).records.length;
}

test('--path on a file a lane already read does not double count', () => {
  const { home, file } = makeHome();
  const before = count(['json', '-a', 'claude-code'], home);
  const after = count(['json', '-a', 'claude-code', '--path', file], home);
  assert.equal(before, 2);
  assert.equal(after, 2, 'the same requests must not be counted twice');
});

test('--path on a genuinely new file still contributes', () => {
  const { home, file } = makeHome();
  const copy = path.join(os.tmpdir(), `aledger-copy-${Date.now()}.jsonl`);
  fs.copyFileSync(file, copy);
  try {
    const before = count(['json', '-a', 'claude-code'], home);
    const after = count(['json', '-a', 'claude-code', '--path', copy], home);
    assert.equal(after, before + 2, 'a new path must add its records');
  } finally {
    fs.unlinkSync(copy);
  }
});
