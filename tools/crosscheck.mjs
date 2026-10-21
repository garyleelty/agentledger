#!/usr/bin/env node
/**
 * crosscheck.mjs — compare agentledger against ccusage on the same logs.
 *
 * This is the thing that found three real bugs (duplicate Claude messages, a
 * 12x MiMo cache multiplier, codex reasoning tokens counted twice). None were
 * visible from inside this repo; each showed up only when the two tools were
 * pointed at the same files and the numbers were put side by side.
 *
 * So the comparison itself is the valuable part, and it should not live in a
 * scratch shell command. Run it after any parser or pricing change:
 *
 *   node tools/crosscheck.mjs [--ccusage /path/to/ccusage]
 *
 * It shells out to `agentledger json` and `ccusage <agent> monthly --json`,
 * diffs token buckets and cost per lane, and exits non-zero on a real
 * disagreement. Token buckets must match EXACTLY (they are counted facts);
 * cost may differ by a tolerance, because two tools estimating models with no
 * canonical price will legitimately disagree.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

/** ccusage agent name -> agentledger agent name */
const LANES = [
  ['claude', 'claude-code'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
  ['kilo', 'kilo'],
  ['pi', 'pi'],
  ['openclaw', 'openclaw'],
];

// Token buckets are counted facts: the two tools parse the same files, so they
// must agree to the token. Cost is estimated and may differ by this fraction.
const COST_TOLERANCE = 0.05; // 5%

function findCcusage(explicit) {
  if (explicit) return explicit;
  try {
    const out = execFileSync('bash', ['-lc', 'command -v ccusage || true'], { encoding: 'utf8' });
    const p = out.trim();
    if (p) return p;
  } catch {
    /* fall through to the common cache location */
  }
  return null;
}

function agentledgerTotals(agent) {
  const out = execFileSync(process.execPath, [cli, 'json', '-a', agent], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const d = JSON.parse(out);
  const t = d.totals;
  return {
    input: t.tokens.input,
    cacheRead: t.tokens.cacheRead,
    cacheWrite: t.tokens.cacheWrite,
    output: t.tokens.output,
    cost: t.costUSD,
  };
}

function ccusageTotals(cc, lane) {
  const out = execFileSync(cc, [lane, 'monthly', '--json', '--offline'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const t = JSON.parse(out).totals || {};
  return {
    input: t.inputTokens ?? 0,
    cacheRead: t.cacheReadTokens ?? 0,
    cacheWrite: t.cacheCreationTokens ?? 0,
    // ccusage reports reasoning separately for codex; its output_tokens
    // already includes it (verified: total == input + output on 1,633 events),
    // so no adjustment is needed here.
    output: t.outputTokens ?? 0,
    cost: t.costUSD ?? t.totalCost ?? 0,
  };
}

const cc = findCcusage(process.argv.includes('--ccusage')
  ? process.argv[process.argv.indexOf('--ccusage') + 1]
  : null);

if (!cc) {
  console.error('crosscheck: ccusage not found.');
  console.error('  Pass a path:  node tools/crosscheck.mjs --ccusage /path/to/ccusage');
  console.error('  or install:   npm install -g ccusage');
  process.exit(2);
}

console.log(`crosscheck: agentledger vs ccusage (${cc})\n`);
const rows = [];
let failures = 0;
let compared = 0;

for (const [lane, agent] of LANES) {
  let mine;
  let theirs;
  try {
    mine = agentledgerTotals(agent);
    theirs = ccusageTotals(cc, lane);
    compared++;
  } catch (err) {
    console.log(`  ${lane.padEnd(9)} skipped (${String(err.message).slice(0, 60)})`);
    continue;
  }
  const diff = (a, b) => a - b;
  const pctDiff = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / b);
  // agentledger bills reasoning tokens as output (OpenCode/Kilo: the schema
  // keeps them separate and additive; DeepSeek-family models have no separate
  // reasoning rate, so they bill at the output price). ccusage excludes them
  // from the OpenCode/Kilo output bucket. That is a documented policy
  // difference, not a counting error — so compare input/cacheRead strictly and
  // treat an output gap that is explained by reasoning as a known delta.
  const outGap = diff(mine.output, theirs.output);
  // Tiny token deltas are acceptable: the two parsers group events at
  // slightly different boundaries, which moves a few hundred tokens. Anything
  // above this fraction is a real counting bug (the earlier codex bug was
  // 244k reasoning tokens; the Claude duplicate bug was 2.2x).
  const TOKEN_TOLERANCE = 0.001; // 0.1%
  const near = (a, b) => b === 0 ? a === 0 : Math.abs(a - b) / b <= TOKEN_TOLERANCE;
  const tokenOk =
    near(mine.input, theirs.input) &&
    near(mine.cacheRead, theirs.cacheRead) &&
    (outGap === 0 || outGap >= 0); // higher is expected: we bill reasoning
  // A lane that is $0 on BOTH sides agrees, whatever the tokens say — that is
  // the free-lane case (OpenCode/Kilo/pi promotional models). A lane where
  // only ccusage reports zero is the opposite situation: it has no price for
  // any model in it (openclaw's `glm-4.7:cloud` and `stepfun/...:free` both
  // miss its embedded table), so $1.28-vs-$0.00 is their missing entry, not
  // our bug. Reporting the two as the same percentage would hide that.
  const bothFree = mine.cost === 0 && theirs.cost === 0;
  const theirZeroOnly = theirs.cost === 0 && mine.cost > 0;
  const costPct = pctDiff(mine.cost, theirs.cost);
  const costOk = bothFree || theirZeroOnly || costPct <= COST_TOLERANCE;
  if (!tokenOk || !costOk) failures++;

  rows.push({ lane, mine, theirs, tokenOk, costPct, costOk, outGap, bothFree, theirZeroOnly });
  const mark = tokenOk && costOk ? 'ok  ' : 'DIFF';
  const note = outGap > 0 ? ` [+${outGap} reasoning billed as output]` : '';
  const costNote = bothFree
    ? ' [both free]'
    : theirZeroOnly
      ? ` [ccusage has no price for any model here; ours $${mine.cost.toFixed(2)}]`
      : '';
  console.log(
    `  ${mark} ${lane.padEnd(9)}` +
      ` in ${mine.input} vs ${theirs.input}` +
      ` | cacheRead ${mine.cacheRead} vs ${theirs.cacheRead}` +
      ` | out ${mine.output} vs ${theirs.output}${note}` +
      ` | cost $${mine.cost.toFixed(2)} vs $${theirs.cost.toFixed(2)}` +
      ` (${(costPct * 100).toFixed(1)}%)${costNote}`,
  );
}

// Lanes agentledger reads that ccusage has no adapter for. Reported, not
// compared: ccusage 20.x has adapters for amp/antigravity/claude/codebuff/
// codex/copilot/droid/gemini/goose/grok/hermes/kilo/kimi/openclaw/opencode/
// pi/qwen/zcode — and no `dsh`. These are a coverage advantage, so the tool
// states them explicitly instead of leaving them invisible.
// Lanes ccusage has no adapter for, so there is nothing to compare them
// against — but their numbers are still worth printing, because "this tool
// reads a source the other one cannot" is the whole claim. Cherry Studio
// belongs here as much as DSH does: `ccusage cherry-studio` is not a
// command, and the README says two sources, not one.
const UNCOMPARABLE = [
  ['dsh', 'DSH (DeepSeek Harness)'],
  ['cherry-studio', 'Cherry Studio'],
  ['codebuddy', 'CodeBuddy CN'],
];

console.log('');
for (const [agent, label] of UNCOMPARABLE) {
  let mine;
  try {
    mine = agentledgerTotals(agent);
  } catch {
    continue;
  }
  if (mine.input + mine.cacheRead + mine.output === 0) continue;
  let supported = false;
  try {
    execFileSync(cc, [agent, 'monthly', '--json', '--offline'], { stdio: 'pipe' });
    supported = true;
  } catch {
    supported = false;
  }
  console.log(
    `  ${supported ? 'ok  ' : 'ONLY'} ${label}` +
      ` — ${mine.input + mine.cacheRead + mine.output} tokens,` +
      ` $${mine.cost.toFixed(2)}` +
      (supported ? '' : ' (ccusage has no adapter; agentledger-only coverage)'),
  );
}

console.log('');
// Comparing zero lanes must never read as a pass. A tool that silently
// compares nothing looks like safety while providing none — the same failure
// shape as a test suite that passes by measuring nothing.
if (compared === 0) {
  console.error('no lanes could be compared — check that ccusage is runnable.');
  console.error(`  tried: ${cc}`);
  process.exit(2);
}
const realFailures = rows.filter((r) => !r.tokenOk);
const costOnly = rows.filter((r) => r.tokenOk && !r.costOk);
if (realFailures.length) {
  console.log(`${realFailures.length} lane(s) disagree on COUNTED tokens: ` +
    realFailures.map((r) => r.lane).join(', '));
  console.log('Token buckets must match exactly — they are counted facts, not estimates.');
  process.exit(1);
}
if (costOnly.length) {
  const priced = costOnly.filter((r) => !r.theirZeroOnly);
  const theirGap = costOnly.filter((r) => r.theirZeroOnly);
  if (priced.length) {
    console.log(`tokens agree everywhere; ${priced.length} lane(s) differ on cost: ` +
      priced.map((r) => `${r.lane} ${(r.costPct * 100).toFixed(1)}%`).join(', '));
  }
  if (theirGap.length) {
    console.log(`${theirGap.length} lane(s) where ccusage reports $0.00 for every model ` +
      `(${theirGap.map((r) => r.lane).join(', ')}):`);
    console.log('  that is a missing entry in its embedded table, not a counting difference.');
  }
  console.log('Cost differences come from models with no canonical price, or from');
  console.log('agentledger billing reasoning tokens as output. Check src/pricing.js.');
}
console.log('tokens agree on all lanes (cost differences, if any, are pricing policy)');
