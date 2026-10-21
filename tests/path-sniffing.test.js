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
 * `--path` on the two stores that are neither JSONL nor a known database.
 *
 * The rule this project keeps running into: a path that reads **nothing**
 * looks exactly like a path with no usage in it. `--path` pointing at a
 * CodeBuddy log used to be skipped outright (it is a `.log` file, and the
 * loop only accepted `.jsonl`/`.json`), and pointing at a Lingma store
 * used to be opened as a database and then find no parser it recognised.
 * Both read zero records and said nothing.
 */

function run(args, home) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: home },
  });
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-path-'));
  return home;
}

test('--path on a CodeBuddy log reads it instead of skipping it', () => {
  const home = makeHome();
  const dir = path.join(home, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '腾讯云代码助手.log');
  fs.writeFileSync(file, [
    '2026-05-08 23:55:34.627 [info] [BaseAgent:craft] [c28add256aa64c3180c52094a5ab59fe] notifyStepEnd, step: 1, requestId: c28add256aa64c3180c52094a5ab59fe, messageId: e5b2ba9602574d578146d06b71b37d23, usage: {"inputTokens":80395,"outputTokens":64,"totalTokens":80459,"cacheTokens":8192,"cachedWriteTokens":0,"cachedMissTokens":72203,"lastTokens":80459,"credit":0.36}, isMaxTokenLimit: false',
    '',
  ].join('\n'));
  const d = JSON.parse(run(['json', '--path', file], home));
  const cb = d.records.filter((r) => r.agent === 'codebuddy');
  assert.equal(cb.length, 1, 'the log must produce a record, not silence');
  // The whole prompt is NOT the fresh input: the fresh part is what is
  // left after the cache read.
  assert.equal(cb[0].tokens.input, 72203, 'fresh input is cachedMissTokens');
  assert.equal(cb[0].tokens.cacheRead, 8192, 'cache read is cacheTokens');
  assert.equal(cb[0].tokens.output, 64);
});

test('--path on a Lingma store reads it instead of finding no parser', () => {
  const home = makeHome();
  const dir = path.join(home, 'db');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'local.db');
  // Build the store the way the real one is shaped: a chat_message table
  // whose token_info column holds a JSON string.
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE chat_message (id TEXT, session_id TEXT, request_id TEXT, role TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER)");
    db.exec("CREATE TABLE chat_session (session_id TEXT, project_uri TEXT)");
    db.prepare("INSERT INTO chat_session VALUES (?, ?)").run("s1", "/work");
    db.prepare("INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "m1", "s1", "r1", "assistant",
      JSON.stringify({ prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 0, max_input_tokens: 0 }),
      "", 1776699045449);
    db.close();
  `;
  execFileSync(process.execPath, ['-e', script, file], { encoding: 'utf8' });
  const d = JSON.parse(run(['json', '--path', file], home));
  const lg = d.records.filter((r) => r.agent === 'lingma');
  assert.equal(lg.length, 1, 'the store must produce a record, not silence');
  assert.equal(lg[0].tokens.input, 1000, 'the whole prompt is the fresh input when the split is unknown');
  assert.equal(lg[0].tokens.output, 50);
  assert.equal(lg[0].model, 'unknown', 'the model is not recorded, and must not be invented');
});
