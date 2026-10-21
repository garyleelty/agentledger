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
 * The `--experimental-sqlite` restart.
 *
 * `node:sqlite` landed in Node 22.5 behind a flag and was unflagged in
 * 23.8, with a backport into the 22.x line partway through. Where it is
 * still flagged, importing it THROWS, and every parser that opens a
 * database catches that and returns zero records — so on Node 22.5.0
 * exactly, five of the eleven lanes read nothing and the report looks
 * complete.
 *
 * So the tool restarts itself with the flag. These tests pin both halves:
 * it restarts when the module is unavailable, and it does NOT restart
 * when it is available (a needless second process on every invocation
 * would be a real cost).
 *
 * The mechanism is tested with a loader hook that makes `node:sqlite`
 * unresolvable, and a preload that counts how many processes started.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-reexec-'));

const HOOKS = path.join(dir, 'block-hooks.mjs');
fs.writeFileSync(HOOKS, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:sqlite') throw new Error('blocked for test');
  return nextResolve(specifier, context);
}
`);

const PRELOAD = path.join(dir, 'preload.cjs');
fs.writeFileSync(PRELOAD, `const { register } = require('node:module');
const fs = require('node:fs');
register(${JSON.stringify('file://' + HOOKS)});
if (process.env.ALEDGER_MARKER) fs.appendFileSync(process.env.ALEDGER_MARKER, 'x\\n');
`);

const MARKER_ONLY = path.join(dir, 'marker-only.cjs');
fs.writeFileSync(MARKER_ONLY, `const fs = require('node:fs');
if (process.env.ALEDGER_MARKER) fs.appendFileSync(process.env.ALEDGER_MARKER, 'x\\n');
`);

function runWith(preload, marker) {
  const env = { ...process.env, ALEDGER_MARKER: marker };
  if (preload) env.NODE_OPTIONS = `--require ${preload}`;
  else delete env.NODE_OPTIONS;
  return execFileSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('the tool restarts itself when node:sqlite is unavailable', () => {
  const marker = path.join(dir, 'blocked.txt');
  fs.writeFileSync(marker, '');
  const out = runWith(PRELOAD, marker);
  assert.match(out, /\d+\.\d+\.\d+/, 'the restarted tool must still answer');
  const starts = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(starts, 2, 'the tool must restart exactly once when node:sqlite is unavailable');
});

test('the tool does not restart when node:sqlite is available', () => {
  const marker = path.join(dir, 'available.txt');
  fs.writeFileSync(marker, '');
  const out = runWith(MARKER_ONLY, marker);
  assert.match(out, /\d+\.\d+\.\d+/);
  const starts = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(starts, 1, 'a second process on every invocation would be a real cost');
});

test('the restart happens at most once, so it cannot loop', () => {
  // The guard is an env var the restarted process inherits. With the
  // module still blocked, the second process must NOT start a third.
  const marker = path.join(dir, 'once.txt');
  fs.writeFileSync(marker, '');
  runWith(PRELOAD, marker);
  const starts = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.ok(starts <= 2, `expected at most two processes, got ${starts}`);
});
