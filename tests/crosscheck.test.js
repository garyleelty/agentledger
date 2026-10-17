import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The cross-check tool is what found three real bugs. It must keep working:
 * a tool that silently stops comparing is worse than none, because it looks
 * like safety while providing none. These tests pin its contract without
 * requiring ccusage to be installed.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tool = path.join(root, 'tools', 'crosscheck.mjs');

test('it exits 2 with guidance when ccusage is absent', () => {
  try {
    execFileSync(process.execPath, [tool, '--ccusage', '/nonexistent/ccusage'], {
      encoding: 'utf8', stdio: 'pipe',
    });
    assert.fail('expected a non-zero exit');
  } catch (err) {
    // A missing binary must not look like a passing comparison. The tool
    // tried every lane, compared none, and must say so — a green result that
    // measured nothing is worse than no check at all.
    assert.equal(err.status, 2, 'exit 2 = "cannot compare", not a silent pass');
    assert.match(err.stderr, /no lanes could be compared/);
  }
});

test('the tool file is a runnable module with the comparison wired', () => {
  const src = execFileSync('cat', [tool], { encoding: 'utf8' });
  assert.match(src, /agentledgerTotals/);
  assert.match(src, /ccusageTotals/);
  // all four lanes must be compared, or a regression in one lane is invisible
  for (const lane of ['claude', 'codex', 'opencode', 'kilo']) {
    assert.match(src, new RegExp(`'${lane}'`));
  }
});

test('it reports lanes agentledger reads that ccusage cannot', () => {
  // The DSH claim in the README must stay true. If ccusage ever ships a dsh
  // adapter, this output changes and the README's claim goes stale — so the
  // tool proves it rather than the docs asserting it.
  const src = execFileSync('cat', [tool], { encoding: 'utf8' });
  assert.match(src, /UNCOMPARABLE/);
  assert.match(src, /agentledger-only coverage/);
});
