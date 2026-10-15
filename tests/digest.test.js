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

// Fixture HOME with committed session logs, so aggregate/json assertions do
// not depend on the machine running them (a CI runner has no agent logs).
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

const agentledger = (args) =>
  execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, HOME: fixtureHome },
  });

/** Run bin/digest.js, capturing the exit status instead of throwing. */
function runDigest(args) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(root, 'bin', 'digest.js'), ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

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

test('aggregate never groups by project, even though by-project exists', () => {
  // `by-project` is a real command and legitimately prints local paths. This
  // guards the boundary: that feature must not reach the shareable shape.
  const dump = JSON.parse(agentledger(['aggregate']));
  const asText = JSON.stringify(dump);
  assert.doesNotMatch(asText, /\/Users\/|\/home\//, 'aggregate must not carry working-directory paths');
  for (const forbidden of ['byProject', 'by-project', 'projects']) {
    assert.equal(dump[forbidden], undefined, `aggregate must not expose ${forbidden}`);
  }
});

test('checkDigest refuses an all-zero page and accepts a real one', async () => {
  const { checkDigest } = await import('../bin/digest.js');

  const good = checkDigest(
    { totals: { records: 10356, costUSD: 87.21, tokens: { input: 1 } } },
    '# agentledger digest\n| stuff |\n',
  );
  assert.equal(good.ok, true, good.reason);
  assert.match(good.reason, /10356 records/);

  const zeroRecords = { totals: { records: 0, costUSD: 0, tokens: {} } };
  const zeroCost = { totals: { records: 10, costUSD: 0, tokens: {} } };
  const emptyStateRow = '| _(no records in this dump)_ | — | — | — |';
  const realCostButEmptyPage = { totals: { records: 10, costUSD: 5, tokens: {} } };

  const refusals = [
    [zeroRecords, 'page'],
    [zeroCost, 'page'],
    [realCostButEmptyPage, emptyStateRow],
    [{}, 'page'],
  ];
  for (const [dump, page] of refusals) {
    const verdict = checkDigest(dump, page);
    assert.equal(verdict.ok, false, `should have refused ${JSON.stringify(dump)}`);
    assert.ok(verdict.reason.length > 0, 'a refusal must say why');
  }
});

test('the CLI --check flag exits non-zero on an empty digest', async () => {
  const fs = await import('node:fs/promises');
  const source = path.join(root, 'tests', 'fixtures', 'empty-aggregate.json');
  const page = path.join(root, 'tests', 'fixtures', 'empty-page.md');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, JSON.stringify({ totals: { records: 0, costUSD: 0, tokens: {} } }));
  await fs.writeFile(page, '# agentledger digest\n| _(no records in this dump)_ | — | — | — |\n');

  const bad = runDigest(['--check', source, page]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /digest refusal/);

  // And the real committed sample passes the same gate.
  const good = runDigest([
    '--check',
    path.join(root, 'digests', 'samples', 'latest.json'),
    path.join(root, 'digests', 'samples', 'latest.json'),
  ]);
  assert.equal(good.status, 0, `committed sample must pass: ${good.stderr}`);
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
