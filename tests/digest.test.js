import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `aggregate` is the shareable view of the ledger; `json` is the debugging one.
 *
 * The difference is not cosmetic: `json` emits one row per usage record with the
 * session id, and on Claude Code and Codex that id is a UUID embedded in a file
 * name under the agent's own log directory. A digest built from `json` therefore
 * publishes a map of the author's projects and timestamps. These tests pin the
 * two things that keep that from happening again:
 *
 *   1. `aggregate` carries totals + groupings only, and is small enough to commit.
 *   2. The rendered digest contains no session identifier or file path.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

const agentledger = (args) =>
  execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

test('aggregate reports totals and groupings without per-record rows', () => {
  const dump = JSON.parse(agentledger(['aggregate']));
  assert.ok(dump.totals.costUSD > 0, 'the machine under test should have some spend');
  assert.ok(dump.totals.records > 0);
  assert.ok(dump.byAgent && Object.keys(dump.byAgent).length >= 1);
  assert.ok(dump.byModel && Object.keys(dump.byModel).length >= 1);
  // The shareable shape must not carry the debugging shape's payload.
  assert.equal(dump.records, undefined, 'per-record rows must not be present');
  for (const group of [dump.byAgent, dump.byModel]) {
    for (const entry of Object.values(group)) {
      assert.equal(entry.session, undefined, 'grouped rows must not carry a session id');
    }
  }
});

test('aggregate is small enough to commit, json is not', () => {
  const aggregate = agentledger(['aggregate']);
  assert.ok(aggregate.length < 64 * 1024, `aggregate should stay tiny, got ${aggregate.length} bytes`);
  const json = agentledger(['json']);
  // Guards the reason `aggregate` exists: if these ever converge, one of the
  // two has lost its point.
  assert.ok(json.length > aggregate.length * 10, 'json should still be the verbose shape');
});

test('the rendered digest contains no session ids or file paths', async () => {
  const { renderDigest } = await import('../bin/digest.js');
  const md = renderDigest(JSON.parse(agentledger(['aggregate'])));

  assert.match(md, /# agentledger digest/);
  assert.match(md, /\*\*Estimated total\*\*/);

  // A Claude Code session id is a UUID in a file name; a Codex session id is a
  // ULID-like id in a rollout file name. Neither has any business on a public page.
  assert.doesNotMatch(md, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'no UUIDs');
  assert.doesNotMatch(md, /\/Users\/|\/home\/|\.jsonl|\.db\b/, 'no absolute paths or log file names');
  assert.doesNotMatch(md, /session|rollout-/, 'no session/file naming');
});

test('the digest renders zero-record input without crashing', async () => {
  const { renderDigest } = await import('../bin/digest.js');
  const md = renderDigest({ totals: { tokens: {}, costUSD: 0, records: 0 } });
  assert.match(md, /no records in this dump/);
  assert.match(md, /\$0\.00/);
});

test('the committed sample is aggregate-shaped, not per-record', async () => {
  const fs = await import('node:fs/promises');
  const sample = JSON.parse(
    await fs.readFile(path.join(root, 'digests', 'samples', 'latest.json'), 'utf8'),
  );
  assert.equal(sample.records, undefined, 'the committed sample must not carry per-record rows');
  assert.ok(sample.totals, 'the committed sample must carry totals');
  assert.ok(sample.byAgent, 'the committed sample must carry per-agent groupings');
});
