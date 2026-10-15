#!/usr/bin/env node
/**
 * agentledger — local-first cost ledger for AI coding agents.
 *
 *   agentledger                # summary table
 *   agentledger by-model       # breakdown per model
 *   agentledger by-day         # daily spend, last 30 days
 *   agentledger sessions       # most expensive sessions
 *   agentledger json           # machine-readable dump
 *   agentledger watch          # live tail (Ctrl-C to stop)
 *   agentledger prices         # show the pricing table in use
 */

import { readFileSync } from 'node:fs';
import { collect, withCost, totals, groupBy, SOURCES } from '../src/ledger.js';
import { PRICING, DEFAULT_PRICING, resolvePricing, cacheWriteCost } from '../src/pricing.js';

const argv = process.argv.slice(2);

// Parsing runs before `main()`, so a bad flag has to be caught here too —
// otherwise a typo escapes as an unhandled exception with a stack trace
// instead of the one-line message every other failure gets.
let command;
let flags;
try {
  command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'summary';
  flags = parseFlags(argv);
} catch (err) {
  console.error(`agentledger: ${err.message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`agentledger: ${err.message}`);
  process.exitCode = 1;
});

/**
 * Flags whose value must be a positive integer. `-n abc` and `-n -5` used to
 * flow straight into `Array.slice`, where NaN silently became 0 (no rows) and a
 * negative count silently dropped rows off the *end* of a ranked list — both
 * wrong answers with no error. A cost report that quietly lies is worse than
 * one that refuses to run, so bad input now stops the run.
 */
function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} expects a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** A budget in USD, or a bare `--budget` meaning "print usage and exit". */
function money0(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} expects a positive number of dollars, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseFlags(args) {
  const out = { agent: [], path: [], json: false, top: 10, days: 30, since: null, budget: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' || a === '-a') out.agent.push(args[++i]);
    else if (a === '--path' || a === '-p') out.path.push(args[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--budget' || a === '-b') out.budget = money0(args[++i], a);
    else if (a === '--top' || a === '-n') out.top = positiveInt(args[++i], a);
    else if (a === '--days' || a === '-d') out.days = positiveInt(args[++i], a);
    else if (a === '--since') {
      const raw = args[++i];
      const parsed = Date.parse(raw);
      // Date.parse returns NaN for junk. `if (NaN)` is falsy, so the old code
      // skipped filtering entirely and printed the full ledger as if the user
      // had asked for it — the single most misleading failure this tool had.
      if (Number.isNaN(parsed)) {
        throw new Error(`--since could not parse ${JSON.stringify(raw)} as a date (try 2026-06-01)`);
      }
      out.since = parsed;
    }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else if (a === '--version' || a === '-v') { out.version = true; }
    else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a} (try --help)`);
    }
    else {
      throw new Error(`unexpected argument ${JSON.stringify(a)} (try --help)`);
    }
  }
  return out;
}

async function main() {
  if (flags.help) return printHelp();
  if (flags.version) return console.log(version());

  // A mistyped agent name used to fall through to "No agent sessions found
  // yet." — indistinguishable from having no logs, and it hid the typo.
  if (flags.agent.length) {
    const known = SOURCES.map((s) => s.agent);
    const unknown = flags.agent.filter((a) => !known.includes(a));
    if (unknown.length) {
      throw new Error(
        `unknown agent ${unknown.map((a) => JSON.stringify(a)).join(', ')}; known agents: ${known.join(', ')}`,
      );
    }
  }

  const { records, filesScanned, skipped } = await collect({
    agents: flags.agent.length ? flags.agent : null,
    paths: flags.path,
  });
  const priced = records.map(withCost);

  if (flags.since) {
    const from = flags.since;
    var filtered = priced.filter((r) => (r.timestamp ?? 0) >= from);
  } else {
    var filtered = priced;
  }

  switch (command) {
    case 'waste': return reportWaste(filtered, flags);
    case 'savings': return reportSavings(filtered, flags);
    case 'by-project': return reportByProject(filtered, flags);
    case 'by-branch': return reportByBranch(filtered, flags);
    case 'by-model': return reportByModel(filtered, flags);
    case 'by-day': return reportByDay(filtered, flags);
    case 'sessions': return reportSessions(filtered, flags);
    case 'budget':
      if (flags.budget === null) {
        throw new Error('budget needs a limit, e.g. `agentledger budget --budget 100` (or -b 100)');
      }
      return reportBudget(filtered, flags);
    case 'sources': return reportSources();
    case 'prices': return reportPrices();
    case 'aggregate': return reportAggregate(filtered);
    case 'json': return reportJson(filtered);
    case 'watch': return watch(flags);
    case 'summary':
    default: return reportSummary(filtered, { filesScanned, skipped }, flags);
  }
}

/**
 * Spend against a budget: how much is used, how fast it is being used, and
 * when it runs out at that rate.
 *
 * Every other command here reports history. This one is the only one that
 * answers the question people actually have while working — "am I about to
 * blow through this?" — and it is the natural thing to call from a statusline
 * or a CI gate, which is why `--json` is honoured here too.
 */
function reportBudget(records, flags) {
  const limit = flags.budget;
  const t = totals(records);
  const spent = t.cost;

  // The window is the span of data we actually have, not a calendar period:
  // a ledger that covers three months but was only used for two days should
  // not report a three-month run rate.
  const stamps = records.map((r) => r.timestamp).filter((n) => typeof n === 'number' && Number.isFinite(n));
  const first = stamps.length ? Math.min(...stamps) : null;
  const last = stamps.length ? Math.max(...stamps) : null;
  const spanDays = first !== null && last !== null && last > first
    ? (last - first) / 86_400_000
    : 0;
  const perDay = spanDays > 0 ? spent / spanDays : 0;

  const remaining = limit - spent;
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  const daysLeft = perDay > 0 && remaining > 0 ? remaining / perDay : null;

  if (flags.json) {
    console.log(JSON.stringify({
      tool: 'agentledger',
      version: version(),
      budgetUSD: round(limit),
      spentUSD: round(spent),
      remainingUSD: round(remaining),
      usedPct: round(pct),
      over: remaining < 0,
      runRateUSDPerDay: round(perDay),
      daysUntilRunOut: daysLeft === null ? null : round(daysLeft),
      window: {
        from: first ? new Date(first).toISOString() : null,
        to: last ? new Date(last).toISOString() : null,
        days: round(spanDays),
      },
      records: records.length,
    }, null, 2));
    return;
  }

  const bar = (used) => {
    const width = 24;
    const filled = Math.max(0, Math.min(width, Math.round((used / 100) * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  };

  console.log('');
  console.log(`  budget    ${money(limit)}`);
  console.log(`  spent     ${money(spent)}   ${bar(pct)}  ${pct.toFixed(1)}%`);
  const overNote = remaining < 0 ? '   OVER by ' + money(-remaining) : '';
  console.log(`  remaining ${money(Math.max(0, remaining))}${overNote}`);
  console.log('');
  if (spanDays > 0) {
    console.log(`  run rate  ${money(perDay)}/day  over ${spanDays.toFixed(1)} days of activity`);
    if (remaining < 0) {
      console.log(`            already ${money(-remaining)} over.`);
    } else if (daysLeft !== null) {
      console.log(`            about ${daysLeft.toFixed(1)} days left at this rate.`);
    } else {
      console.log('            nothing spent yet, so no run rate to project.');
    }
  } else {
    console.log('  run rate  not enough dated records to project one.');
  }
  console.log('');
}

/**
 * Aggregate-only JSON: totals, plus cost and token sums grouped by agent and
 * by model.
 *
 * This is the shareable shape. `json` is the debugging shape and carries one
 * row per usage record including the session id, which on Claude Code and
 * Codex is a UUID that names a real project directory. `aggregate` is what a
 * digest, a README badge or a CI step should read — it answers "what did the
 * spend look like" without publishing whose spend it was.
 */
function reportAggregate(records) {
  const t = totals(records);
  const by = (keyFn) => Object.fromEntries(
    [...groupBy(records, keyFn).entries()]
      .map(([key, rs]) => {
        const s = totals(rs);
        return [key, {
          input: s.input,
          cacheRead: s.cacheRead,
          cacheWrite: s.cacheWrite,
          output: s.output,
          records: rs.length,
          costUSD: round(s.cost),
        }];
      })
      .sort((a, b) => b[1].costUSD - a[1].costUSD),
  );
  console.log(JSON.stringify({
    tool: 'agentledger',
    version: version(),
    generatedAt: new Date().toISOString(),
    totals: {
      tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output },
      costUSD: round(t.cost),
      records: records.length,
    },
    byAgent: by((r) => r.agent),
    byModel: by((r) => r.model),
  }, null, 2));
}

/* ------------------------------ reports ------------------------------ */

function reportSummary(records, meta, flags) {
  if (flags.json) return reportJson(records);
  const t = totals(records);
  if (records.length === 0) {
    console.log('No agent sessions found yet.');
    console.log(`Looked in: ${SOURCES.map((s) => s.root).join(', ')}`);
    return;
  }
  console.log('');
  console.log(`  agentledger — ${meta.filesScanned} session files scanned`);
  console.log('');
  const rows = [
    ['Input tokens', fmtTok(t.input), money(t.costInput)],
    ['Cache read', fmtTok(t.cacheRead), money(t.costCacheRead)],
    ['Cache write', fmtTok(t.cacheWrite), money(t.costCacheWrite)],
    ['Output tokens', fmtTok(t.output), money(t.costOutput)],
    ['TOTAL', fmtTok(t.input + t.cacheRead + t.cacheWrite + t.output), money(t.cost)],
  ];
  printTable(['Metric', 'Tokens', 'Est. cost'], rows);
  console.log('');
  const byAgent = [...groupBy(records, (r) => r.agent).entries()]
    .map(([agent, rs]) => [agent, fmtTok(sum(rs, 'input') + sum(rs, 'cacheRead') + sum(rs, 'output')), money(totals(rs).cost), String(rs.length)])
    .sort((a, b) => num(b[2]) - num(a[2]));
  printTable(['Agent', 'Tokens', 'Est. cost', 'Records'], byAgent);
  console.log('');
  console.log('  Run `agentledger by-model` for a per-model breakdown.');
  if (meta.skipped.length) {
    console.log(`  ${meta.skipped.length} file(s) could not be parsed (skipped).`);
  }
}

function reportByModel(records, flags) {
  if (flags.json) return reportJson(records);
  const groups = [...groupBy(records, (r) => r.model).entries()].map(([model, rs]) => {
    const t = totals(rs);
    return [model, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), String(rs.length)];
  });
  groups.sort((a, b) => num(b[2]) - num(a[2]));
  printTable(['Model', 'Tokens', 'Est. cost', 'Records'], groups.slice(0, flags.top || 50));
}

/**
 * What prompt caching actually saved, priced as the counterfactual: every
 * cache-read token billed at the full fresh-input price instead.
 *
 * This is the number that makes the tool's own headline real. Cache reads are
 * 93% of the tokens on the machine this was written on, and they are the
 * difference between $243 and $1,307 — a fact that is invisible if you only
 * report what you paid.
 */
function reportSavings(records, flags) {
  const saved = savingsOf(records);

  if (flags.json) {
    console.log(JSON.stringify({ tool: 'agentledger', version: version(), ...saved }, null, 2));
    return;
  }

  const pctSaved = saved.withoutCacheUSD > 0
    ? (saved.savingsUSD / saved.withoutCacheUSD) * 100
    : 0;
  const barWidth = 30;

  if (saved.records === 0) {
    console.log('');
    console.log('  No agent sessions found. There is nothing to measure savings against.');
    console.log('');
    return;
  }
  if (saved.savingsUSD === 0) {
    console.log('');
    console.log('  No cache-read tokens in these records, so caching saved nothing.');
    console.log(`  ${fmtTok(saved.totalTokens)} tokens were all billed at full price.`);
    console.log('');
    return;
  }

  const filled = Math.max(0, Math.min(barWidth, Math.round((pctSaved / 100) * barWidth)));
  console.log('');
  console.log('  What prompt caching saved');
  console.log('');
  console.log(`  paid            ${money(saved.actualUSD).padStart(10)}`);
  console.log(`  without cache   ${money(saved.withoutCacheUSD).padStart(10)}`);
  console.log(`  saved           ${money(saved.savingsUSD).padStart(10)}   ${pctSaved.toFixed(1)}% cheaper`);
  console.log('');
  console.log(`  [${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}]  ${pctSaved.toFixed(1)}% saved`);
  console.log('');
  console.log(`  ${fmtTok(saved.cacheReadTokens)} of ${fmtTok(saved.totalTokens)} tokens came from cache`);
  console.log(`  (${((saved.cacheReadTokens / saved.totalTokens) * 100).toFixed(1)}% of the total).`);
  console.log('');
  console.log('  Counted at each model\'s own fresh-input rate, per provider.');
}

/**
 * Counterfactual cost of the same records with caching priced away.
 * Exported for the tests; see reportSavings for the argument.
 */
export function savingsOf(records) {
  const t = totals(records);
  let withoutCache = 0;
  for (const r of records) {
    const p = resolvePricing(r.model);
    withoutCache += (
      ((r.input ?? 0) + (r.cacheRead ?? 0)) * p.input
      + (r.output ?? 0) * p.output
    ) / 1e6 + cacheWriteCost(r, p);
  }
  return {
    actualUSD: round(t.cost),
    withoutCacheUSD: round(withoutCache),
    savingsUSD: round(Math.max(0, withoutCache - t.cost)),
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheWrite,
    inputTokens: t.input,
    outputTokens: t.output,
    totalTokens: t.input + t.cacheRead + t.cacheWrite + t.output,
    records: records.length,
  };
}

function reportWaste(records, flags) {
  if (flags.json) return reportJson(records);
  const t = totals(records);
  const totalCacheRead = t.cacheRead;
  if (totalCacheRead === 0) {
    console.log('No cache reads in these logs; nothing to diagnose.');
    return;
  }

  // Context re-reads are the dominant cost in agent traffic: a turn that
  // re-reads a large prefix bills at the cache-read rate, so the sessions
  // holding most of those tokens are where the money actually went.
  const perSession = [...groupBy(records, (r) => `${r.agent}/${r.session}`).entries()]
    .map(([key, rs]) => {
      const st = totals(rs);
      return { key, cacheRead: st.cacheRead, cost: st.cost, records: rs.length, project: rs.find((r) => r.project)?.project || null };
    })
    .sort((a, b) => b.cacheRead - a.cacheRead);

  const top10 = perSession.slice(0, 10);
  const share = top10.reduce((a, x) => a + x.cacheRead, 0) / totalCacheRead;

  console.log('');
  console.log(`  cache reads are the story: ${fmtTok(totalCacheRead)} of ${fmtTok(t.input + t.cacheRead + t.output)} total tokens`);
  console.log('');
  printTable(
    ['Session', 'Cache read', 'Est. cost', 'Project'],
    top10.map((x) => [x.key.slice(0, 40), fmtTok(x.cacheRead), money(x.cost), (x.project || '-').split('/').slice(-2).join('/')]),
  );
  console.log('');
  console.log(`  These ${top10.length} of ${perSession.length} sessions hold ${(share * 100).toFixed(1)}% of all cache reads.`);
  console.log('  Concentrated re-reads are usually a sign of context churn: a long session');
  console.log('  that keeps re-sending its prefix, or a tool returning large output every turn.');
  console.log('');
}

function reportByProject(records, flags) {
  const groups = [...groupBy(records, (r) => r.project || '(unknown)').entries()]
    .map(([project, rs]) => {
      const t = totals(rs);
      return [project, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), String(rs.length)];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));
  if (flags.json) return reportJson(records);
  if (groups.length === 0) {
    console.log('No project attribution found. Codex and Claude Code record the working');
    console.log('directory; older sessions may predate that field.');
    return;
  }
  printTable(['Project', 'Tokens', 'Est. cost', 'Records'], groups.slice(0, flags.top || 30));
  console.log('');
  console.log('  Which working directory each session ran in, priced separately.');
}

function reportByBranch(records, flags) {
  const groups = [...groupBy(records, (r) => (r.branch ? `${r.branch}` : '(no branch)')).entries()]
    .map(([branch, rs]) => {
      const t = totals(rs);
      return [branch, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), String(rs.length)];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));
  if (flags.json) return reportJson(records);
  if (groups.length === 0) {
    console.log('No branch attribution found in these logs.');
    return;
  }
  printTable(['Branch', 'Tokens', 'Est. cost', 'Records'], groups.slice(0, flags.top || 30));
  console.log('');
  console.log('  What each git branch cost you in agent time.');
}

function reportByDay(records, flags) {
  const days = flags.days || 30;
  const groups = [...groupBy(records, (r) => dayKey(r.timestamp)).entries()]
    .map(([day, rs]) => [day, fmtTok(sum(rs, 'input') + sum(rs, 'cacheRead') + sum(rs, 'output')), money(totals(rs).cost)])
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, days);
  if (flags.json) return reportJson(records);
  printTable(['Day', 'Tokens', 'Est. cost'], groups);
  const t = totals(records);
  console.log('');
  console.log(`  ${money(t.cost)} across ${records.length} records`);
}

function reportSessions(records, flags) {
  const groups = [...groupBy(records, (r) => `${r.agent}/${r.session}`).entries()]
    .map(([key, rs]) => {
      const t = totals(rs);
      return [key, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), new Date(Math.min(...rs.map((r) => r.timestamp || Date.now()))).toISOString().slice(0, 10)];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));
  if (flags.json) return reportJson(records);
  printTable(['Session', 'Tokens', 'Est. cost', 'Started'], groups.slice(0, flags.top || 10));
}

function reportSources() {
  printTable(
    ['Agent', 'Log location', 'Docs'],
    SOURCES.map((s) => [s.agent, s.root, s.docs]),
  );
}

function reportPrices() {
  const rows = Object.entries(PRICING).map(([model, p]) => [
    model,
    `$${p.input}`,
    `$${p.output}`,
    `x${p.cacheReadMultiplier ?? DEFAULT_PRICING.cacheReadMultiplier}`,
    p.cacheWrite1hMultiplier != null
      ? `x${p.cacheWriteMultiplier} / x${p.cacheWrite1hMultiplier}`
      : `x${p.cacheWriteMultiplier}`,
  ]);
  rows.push(['(unknown models)', `$${DEFAULT_PRICING.input}`, `$${DEFAULT_PRICING.output}`,
    `x${DEFAULT_PRICING.cacheReadMultiplier}`, `x${DEFAULT_PRICING.cacheWriteMultiplier} / x${DEFAULT_PRICING.cacheWrite1hMultiplier}`]);
  printTable(['Model', 'In $/Mtok', 'Out $/Mtok', 'Cache read', 'Cache write 5m/1h'], rows);
  console.log('');
  console.log('  Prices are static snapshots of public pricing pages (USD per 1M tokens).');
  console.log('  Cache write shows the TTL tiers where the provider has them (Anthropic:');
  console.log('  5-minute writes x1.25, 1-hour writes x2 of the input price).');
  console.log('  Every row is cross-checked weekly against the LiteLLM model database');
  console.log('  (tools/audit_pricing.py, in CI). agentledger never contacts the network.');
}

function reportJson(records) {
  const t = totals(records);
  console.log(
    JSON.stringify(
      {
        tool: 'agentledger',
        version: version(),
        generatedAt: new Date().toISOString(),
        totals: {
          tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output },
          costUSD: round(t.cost),
        },
        records: records.map((r) => ({
          agent: r.agent,
          model: r.model,
          session: r.session,
          project: r.project ?? null,
          branch: r.branch ?? null,
          timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
          tokens: { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output },
          costUSD: round(r.cost?.total ?? 0),
        })),
      },
      null,
      2,
    ),
  );
}

async function watch(flags) {
  console.log('agentledger watch — Ctrl-C to stop');
  const tick = async () => {
    const { records } = await collect({ agents: flags.agent.length ? flags.agent : null, paths: flags.path });
    const priced = records.map(withCost);
    const t = totals(priced);
    process.stdout.write(`\r  ${money(t.cost)}  ${fmtTok(t.input + t.cacheRead + t.cacheWrite + t.output)} tokens  ${priced.length} records   `);
  };
  await tick();
  const timer = setInterval(tick, 5000);
  timer.unref?.();
  await new Promise(() => {});
}

/* ------------------------------ helpers ------------------------------ */

const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
const num = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;
const dayKey = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown');
const round = (n) => Math.round(n * 1e6) / 1e6;
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const fmtTok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

function printTable(headers, rows) {
  const cols = headers.length;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function version() {
  // package.json is the single source; a hardcoded copy here was how the CLI
  // and the package could disagree silently after a bump. (No caching: main()
  // runs before module-level `let`s below this point, and one small read per
  // invocation is not worth a hoisting hazard.)
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0-unknown';
  }
}


function printHelp() {
  const agentNames = SOURCES.map((x) => x.agent).join(', ');
  console.log(`
agentledger ${version()} — local-first cost ledger for AI coding agents

Usage
  agentledger [command] [options]

Commands
  summary     Totals, cost, and per-agent breakdown (default)
  waste       Where the cache-read spend is concentrated
  savings     What prompt caching saved, priced against no cache
  by-project  Cost per working directory / repository
  by-branch   Cost per git branch
  by-model    Per-model token and cost breakdown
  by-day      Daily spend for the last N days
  sessions    Most expensive sessions
  sources     Which agents are supported and where logs are read from
  prices      The built-in pricing table
  aggregate   Shareable totals + groupings (no session ids)
  budget      Spend against a limit (e.g. budget -b 100)
  json        Machine-readable dump of every record
  watch       Live-refreshing totals

Options
  -a, --agent <name>   Only read this agent (${agentNames})
  -p, --path <dir>     Also read logs from this directory or file
      --since <date>   Only records at/after this date (ISO or timestamp)
  -n, --top <n>        Rows to show in ranked reports (default 10)
  -d, --days <n>       Days to show in by-day (default 30)
      --json           Emit JSON instead of a table
  -h, --help           This help

agentledger reads only local log files and never sends anything anywhere.
`);
}
