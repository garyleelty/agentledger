import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `sources` answers "why is this lane empty?" — a missing directory, an empty
 * one, and a directory of unparseable files used to look identical from the
 * outside. That is the silent-zero failure mode this project keeps meeting.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

function run(args, home) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HOME: home },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('sources reports per-source state, not just paths', () => {
  const { status, stdout } = run(['sources'], fixtureHome);
  assert.equal(status, 0);
  // the fixture home has claude-code sessions, and nothing else
  assert.match(stdout, /claude-code\s+~\S+\s+\d+ file\(s\)/);
  assert.match(stdout, /not found/, 'sources with no data must say so');
  assert.match(stdout, /\d+ of \d+ sources have data on this machine\./);
});

test('sources --json is machine-readable and carries the same facts', async () => {
  const { stdout } = run(['sources', '--json'], fixtureHome);
  const d = JSON.parse(stdout);
  assert.ok(Array.isArray(d.sources));
  // Derived from SOURCES rather than a hardcoded number: this assertion was
  // pinned to 6 while a seventh source shipped, which is the same class of
  // staleness the docs guard exists for — the count is a fact about the code,
  // so read it from the code. A dynamic import, not createRequire: requiring
  // an ES module is only allowed from Node 24, and 22.5 is the floor this
  // project supports (CI caught the require() form failing there).
  const { SOURCES } = await import('../src/ledger.js');
  assert.equal(d.sources.length, SOURCES.length, 'one row per supported source');
  for (const s of d.sources) {
    assert.ok(typeof s.agent === 'string');
    assert.ok(typeof s.state === 'string');
    assert.ok(typeof s.files === 'number');
  }
  const cc = d.sources.find((s) => s.agent === 'claude-code');
  assert.ok(cc.files > 0, 'the fixture home has claude-code logs');
  assert.equal(d.withData, d.sources.filter((s) => s.files > 0).length);
});

test('an empty home reports zero sources and says what to do', () => {
  const { stdout } = run(['sources'], '/nonexistent-home-for-tests');
  assert.match(stdout, /0 of \d+ sources have data/);
  assert.match(stdout, /point at it with -p/);
});

test('an empty ledger points at sources and -p, not just at paths', () => {
  // A fresh user seeing only a list of paths cannot tell a bad install from
  // "no logs yet" from "logs live elsewhere". The message must give the two
  // ways forward.
  const { stdout } = run(['summary'], '/nonexistent-home-for-tests');
  assert.match(stdout, /No agent sessions found yet/);
  assert.match(stdout, /agentledger sources/, 'must point at the diagnostic command');
  assert.match(stdout, /agentledger -p \/path\/to\/logs/, 'must show how to scan elsewhere');
});
