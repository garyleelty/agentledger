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

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join as pathJoin, relative as pathRelative, basename as pathBasename } from 'node:path';
import { collect, withCost, totals, groupBy, SOURCES, expandHome, dayKeyIn, startOfDayIn } from '../src/ledger.js';
import { computeBlocks } from '../src/blocks.js';
import { PRICING, DEFAULT_PRICING, resolvePricing, cacheWriteCost, loadPricingOverrides, overriddenModels } from '../src/pricing.js';

// How many --prices overrides are active; read by reportPrices(). Declared
// here, before main() runs at the bottom of the flag block, because a `let`
// below main()'s call site is in the temporal dead zone when version() and
// this are first touched (round 32 learned that the hard way).
let overrideCount = 0;

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

/**
 * Validate an IANA timezone name.
 *
 * An unknown zone name used to be a silent no-op: the report came out in
 * UTC and looked like a real answer. `Intl` throws a RangeError for an
 * unknown zone, which is exactly the signal wanted — but it has to be caught
 * and re-thrown as a message the user can act on, not a stack trace.
 */
function zone(raw) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw });
  } catch {
    throw new Error(`--timezone: ${JSON.stringify(raw)} is not a known IANA zone (try: UTC, Asia/Shanghai, America/New_York)`);
  }
  return raw;
}

/**
 * A calendar date to the start of that day, in the machine's local zone.
 *
 * `Date.parse('2026-02-30')` does not fail — it rolls over to March 2, so
 * a typo becomes a real date and the filter silently reports the wrong
 * range. A date that does not exist on the calendar is an error, not a
 * guess: the day must parse back to itself.
 */
function day(raw, flag) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (!m) {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
      throw new Error(`${flag} could not parse ${JSON.stringify(raw)} as a date (try 2026-06-01)`);
    }
    return parsed;
  }
  const [, y, mo, d] = m;
  const probe = new Date(Number(y), Number(mo) - 1, Number(d));
  if (probe.getFullYear() !== Number(y) || probe.getMonth() !== Number(mo) - 1 || probe.getDate() !== Number(d)) {
    throw new Error(`${flag}: ${JSON.stringify(raw)} is not a real date (2026-02-30 is not)`);
  }
  return probe.getTime();
}

function parseFlags(args) {
  const out = { agent: [], path: [], json: false, template: false, top: 10, days: 30, since: null, budget: null, prices: null, timezone: null, blockHours: 5 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' || a === '-a') out.agent.push(args[++i]);
    else if (a === '--path' || a === '-p') out.path.push(args[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--template') out.template = true;
    else if (a === '--prices') {
      const raw = args[++i];
      if (!raw || raw.startsWith('-')) throw new Error('--prices expects a JSON file path');
      out.prices = raw;
    }
    else if (a === '-o' || a === '--out') {
      const raw = args[++i];
      if (!raw) throw new Error(`${a} needs a file path (e.g. -o out.html)`);
      out.out = raw;
    }
    else if (a === '--budget' || a === '-b') out.budget = money0(args[++i], a);
    else if (a === '--timezone' || a === '-z') {
      const raw = args[++i];
      if (!raw) throw new Error('--timezone expects an IANA zone name (e.g. Asia/Shanghai)');
      out.timezone = zone(raw);
    }
    else if (a === '--block-hours') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--block-hours expects a positive number of hours, got ${JSON.stringify(raw)}`);
      }
      out.blockHours = n;
    }
    else if (a === '--top' || a === '-n') out.top = positiveInt(args[++i], a);
    else if (a === '--days' || a === '-d') out.days = positiveInt(args[++i], a);
    else if (a === '--until' || a === '-u') {
      const raw = args[++i];
      if (!raw) throw new Error('--until expects a date');
      const bound = day(raw, '--until');
      // A bare date means "through the end of that day", so the bound is the
      // start of the next one. A full timestamp means that instant.
      const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim());
      out.until = bound;
      if (isBareDate) {
        const next = new Date(bound);
        next.setDate(next.getDate() + 1);
        out.untilExclusive = next.getTime();
      }
    }
    else if (a === '--since') {
      const raw = args[++i];
      // Date.parse returns NaN for junk. `if (NaN)` is falsy, so the old code
      // skipped filtering entirely and printed the full ledger as if the user
      // had asked for it — the single most misleading failure this tool had.
      out.since = day(raw, '--since');
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

  // User price overrides load before any pricing happens, so every report —
  // including `prices` itself — reflects them. Validation is all-or-nothing:
  // a half-applied price file would still print an authoritative-looking
  // table, which is the failure mode this feature must not have.
  if (flags.prices) {
    let text;
    try {
      text = readFileSync(flags.prices, 'utf8');
    } catch (err) {
      throw new Error(`--prices could not read ${JSON.stringify(flags.prices)}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`--prices file is not valid JSON: ${err.message}`);
    }
    const n = loadPricingOverrides(parsed);
    overrideCount = n;
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
  // `--until` is INCLUSIVE of the day named, so the bound is the start of the
  // NEXT day and the comparison is exclusive. Without a next day (the bound
  // was given as a full timestamp rather than a date) the bound itself is
  // exclusive.
  if (flags.until) {
    const to = flags.untilExclusive ?? flags.until;
    filtered = filtered.filter((r) => (r.timestamp ?? 0) < to);
  }

  switch (command) {
    case 'waste': return reportWaste(filtered, flags);
    case 'savings': return reportSavings(filtered, flags);
    case 'share': return renderSharePage(filtered, flags);
    case 'by-project': return reportByProject(filtered, flags);
    case 'by-branch': return reportByBranch(filtered, flags);
    case 'by-model': return reportByModel(filtered, flags);
    case 'by-day': return reportByDay(filtered, flags);
    case 'blocks': return reportBlocks(filtered, flags);
    case 'sessions': return reportSessions(filtered, flags);
    case 'budget':
      if (flags.budget === null) {
        throw new Error('budget needs a limit, e.g. `agentledger budget --budget 100` (or -b 100)');
      }
      return reportBudget(filtered, flags);
    case 'sources': return reportSources(flags);
    case 'prices': return reportPrices(flags, filtered);
    case 'aggregate': return reportAggregate(filtered);
    case 'json': return reportJson(filtered);
    case 'statusline': return statusline(flags);
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
  // The shareable shape carries the caveat too. A digest built from this is
  // published on a public page; if a chunk of the total is a placeholder, the
  // page has to say so or it is asserting a number it cannot back.
  const unpriced = unpricedModels(records);
  const unpricedCost = records
    .filter((r) => r.model && resolvePricing(r.model) === DEFAULT_PRICING)
    .reduce((a, r) => a + (r.cost?.total ?? 0), 0);
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
    ...(unpriced.length ? {
      unpricedModels: unpriced.map(([model, n]) => ({ model, records: n })),
      unpricedCostUSD: round(unpricedCost),
      defaultPricingUSD: { input: DEFAULT_PRICING.input, output: DEFAULT_PRICING.output },
    } : {}),
  }, null, 2));
}

/* ------------------------------ reports ------------------------------ */


/**
 * Models whose cost came from DEFAULT_PRICING because nothing in the table
 * matched. The estimate is still printed — refusing to price a model helps
 * nobody — but the summary has to say so. Silence here is how a $3/$15
 * fallback becomes a number someone quotes: on this machine 7 of 10 models
 * in one lane were unpriced, and the total read $719 with no hint that most
 * of it was a placeholder.
 */
function unpricedModels(records) {
  const out = new Map();
  for (const r of records) {
    if (r.model && resolvePricing(r.model) === DEFAULT_PRICING) {
      const prev = out.get(r.model) || { records: 0, tokens: 0 };
      prev.records++;
      prev.tokens += (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.output || 0);
      out.set(r.model, prev);
    }
  }
  // Drop records that carry no tokens at all: Claude Code writes <synthetic>
  // placeholder turns with every bucket zero, and listing "35 unpriced
  // records" for a model that never billed anything is noise that trains
  // people to ignore the warning. Real unpriced models have real volume.
  return [...out.entries()]
    .filter(([, v]) => v.tokens > 0)
    .map(([model, v]) => [model, v.records])
    .sort((a, b) => b[1] - a[1]);
}

function reportSummary(records, meta, flags) {
  if (flags.json) return reportJson(records);
  const t = totals(records);
  if (records.length === 0) {
    // First run for a fresh user. Listing raw paths with no next step is a
    // dead end: they cannot tell whether they installed wrong, have no logs,
    // or have logs somewhere unusual. `sources` answers "why is this lane
    // empty?", so say so and say what to do.
    console.log('No agent sessions found yet.');
    console.log(`Looked in: ${SOURCES.map((s) => s.root).join(', ')}`);
    console.log('');
    console.log('Run `agentledger sources` to see which paths exist on this machine.');
    console.log('If your logs live elsewhere:  agentledger -p /path/to/logs');
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
  const unpriced = unpricedModels(records);
  if (unpriced.length) {
    const cost = records
      .filter((r) => r.model && resolvePricing(r.model) === DEFAULT_PRICING)
      .reduce((a, r) => a + (r.cost?.total ?? 0), 0);
    console.log('');
    console.log(`  ! ${unpriced.length} model(s) have no built-in price and used the`);
    console.log(`    $${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per-Mtok default (${money(cost)} of the total):`);
    for (const [model, n] of unpriced.slice(0, 5)) {
      console.log(`      ${model}  (${n} records)`);
    }
    if (unpriced.length > 5) console.log(`      … and ${unpriced.length - 5} more`);
    console.log('    Fix in one step: `agentledger prices --template` prints a');
    console.log('    fill-in override file for exactly these models.');
  }
  if (meta.skipped.length) {
    console.log(`  ${meta.skipped.length} file(s) could not be parsed (skipped).`);
  }
}

function reportByModel(records, flags) {
  const byModel = [...groupBy(records, (r) => r.model).entries()];
  if (flags.json) {
    const rows = byModel.map(([model, rs]) => groupRow(model, rs))
      .sort((a, b) => b.costUSD - a.costUSD);
    return reportGroupJson('by-model', rows, records);
  }
  const groups = byModel.map(([model, rs]) => {
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

/**
 * A shareable page: one file, inline CSS, no scripts, no network. It opens from
 * disk and survives a screenshot, which is the only form of "link" that
 * actually gets shared.
 *
 * The aggregate is built here rather than read from a file so
 * `agentledger share -o out.html` is a single step from fresh logs. Privacy
 * rules are the digests': aggregates only, never a session id, never a path.
 */
async function renderSharePage(records, flags) {
  const t = totals(records);
  const by = (keyFn) => Object.fromEntries(
    [...groupBy(records, keyFn).entries()]
      .map(([key, rs]) => {
        const s = totals(rs);
        return [key, {
          input: s.input, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, output: s.output,
          records: rs.length, costUSD: round(s.cost),
        }];
      })
      .sort((a, b) => b[1].costUSD - a[1].costUSD),
  );
  const ledger = {
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
    // The share page is the one artifact that leaves the machine, so it must
    // carry the placeholder disclosure that `summary` and `aggregate` already
    // carry. Without it the page asserts a total it cannot back.
    ...(() => {
      const unpriced = unpricedModels(records);
      if (!unpriced.length) return {};
      const unpricedCost = records
        .filter((r) => r.model && resolvePricing(r.model) === DEFAULT_PRICING)
        .reduce((a, r) => a + (r.cost?.total ?? 0), 0);
      return {
        unpricedModels: unpriced.map(([model, n]) => ({ model, records: n })),
        unpricedCostUSD: round(unpricedCost),
      };
    })(),
  };

  const { renderShare } = await import('./share.js');
  const html = renderShare(ledger);

  if (flags.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(flags.out, html);
    console.error(`wrote ${flags.out} (${html.length} bytes)`);
    return;
  }
  process.stdout.write(html);
}

function reportWaste(records, flags) {
  const t = totals(records);
  const totalCacheRead = t.cacheRead;
  if (totalCacheRead === 0) {
    if (flags.json) return reportGroupJson('waste', [], records);
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

  // The JSON shape carries the diagnosis, not just the ranking: the share is
  // the whole point of the report, and a consumer that had to recompute it
  // from the rows was doing the work twice.
  if (flags.json) {
    const rows = perSession.map((x) => ({
      key: x.key,
      cacheRead: x.cacheRead,
      costUSD: round(x.cost),
      records: x.records,
      project: x.project,
      shareOfCacheReads: totalCacheRead ? round(x.cacheRead / totalCacheRead, 6) : 0,
    }));
    console.log(
      JSON.stringify(
        {
          tool: 'agentledger',
          version: version(),
          generatedAt: new Date().toISOString(),
          command: 'waste',
          totals: {
            cacheRead: totalCacheRead,
            tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output },
            costUSD: round(t.cost),
            records: t.records,
          },
          topSessionsShareOfCacheReads: round(share, 6),
          sessions: perSession.length,
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }

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
  const byProject = [...groupBy(records, (r) => r.project || '(unknown)').entries()];
  if (flags.json) {
    const rows = byProject.map(([project, rs]) => groupRow(project, rs))
      .sort((a, b) => b.costUSD - a.costUSD);
    return reportGroupJson('by-project', rows, records);
  }
  const groups = byProject
    .map(([project, rs]) => {
      const t = totals(rs);
      return [project, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), String(rs.length)];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));
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
  const byBranch = [...groupBy(records, (r) => (r.branch ? `${r.branch}` : '(no branch)')).entries()];
  if (flags.json) {
    const rows = byBranch.map(([branch, rs]) => groupRow(branch, rs))
      .sort((a, b) => b.costUSD - a.costUSD);
    return reportGroupJson('by-branch', rows, records);
  }
  const groups = byBranch
    .map(([branch, rs]) => {
      const t = totals(rs);
      return [branch, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), String(rs.length)];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));
  if (groups.length === 0) {
    console.log('No branch attribution found in these logs.');
    return;
  }
  printTable(['Branch', 'Tokens', 'Est. cost', 'Records'], groups.slice(0, flags.top || 30));
  console.log('');
  console.log('  What each git branch cost you in agent time.');
}

/**
 * Billing blocks: the rolling windows in which a subscription quota resets.
 *
 * ccusage has this as a Claude-Code-only report. agentledger computes it for
 * EVERY lane, because a quota window is a property of the subscription, not
 * of the tool: a DeepSeek or Kimi subscription that resets on a rolling
 * window is billed the same way, and nobody has to teach a second tool
 * where the log files are.
 *
 * The block algorithm is ccusage's, measured rather than assumed: a block
 * starts with activity (its first record, floored to the hour) and runs
 * `blockHours` from there. A "local midnight, then 5-hour chunks" grid was
 * the natural guess and it is wrong — ccusage's own example block
 * (13:00Z -> 18:00Z) is not on that grid.
 *
 * `<synthetic>` records are excluded. Claude Code writes placeholder turns
 * under that model name with every bucket zero, and they are not usage: kept
 * in, they open blocks that contain nothing. Verified against ccusage's own
 * output on this machine: with them excluded, the block boundaries, entry
 * counts and token totals match ccusage exactly, record for record.
 */
function reportBlocks(records, flags) {
  const usable = records.filter((r) => r.model !== '<synthetic>');
  const blocks = computeBlocks(usable.map(withCost), {
    now: Date.now(),
    timezone: flags.timezone,
    blockHours: flags.blockHours,
  });

  // Gaps are idle stretches: they explain why two blocks are far apart, but
  // they are not spend, so they are not rows of a spend report unless asked.
  const real = blocks.filter((b) => !b.isGap);
  const active = real.find((b) => b.isActive);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          tool: 'agentledger',
          version: version(),
          generatedAt: new Date().toISOString(),
          command: 'blocks',
          blockHours: flags.blockHours,
          timezone: flags.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          activeBlockId: active ? active.id : null,
          blocks,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (real.length === 0) {
    console.log('No usage in these logs; no billing blocks to report.');
    return;
  }

  // The share is relative to the largest block, which is the one that
  // decides whether a window was blown.
  const largest = Math.max(...real.map((b) => b.totalTokens)) || 1;
  const rows = real.map((b) => {
    const spent = b.totalTokens;
    // `actualEndTime` is an ISO string, not epoch ms: subtracting it as a
    // number gave NaN, and a NaN duration renders as a column of dashes.
    const end = b.actualEndTime ? Date.parse(b.actualEndTime) : null;
    const span = end && Number.isFinite(end) ? end - Date.parse(b.startTime) : 0;
    const dur = span > 0 ? `${Math.floor(span / 3600000)}h ${Math.floor((span % 3600000) / 60000)}m` : '-';
    const status = b.isActive ? 'ACTIVE' : dur;
    return [
      new Date(b.startTime).toISOString().replace('T', ' ').slice(0, 16),
      status,
      b.models.slice(0, 2).join(', ') + (b.models.length > 2 ? ` +${b.models.length - 2}` : ''),
      fmtTok(spent),
      `${((spent / largest) * 100).toFixed(1)}%`,
      money(b.costUSD),
    ];
  });

  printTable(['Block start (UTC)', 'Elapsed', 'Models', 'Tokens', 'Share', 'Est. cost'], rows);

  console.log('');
  if (active) {
    const b = active.burnRate;
    console.log(`  Active block: ${new Date(active.startTime).toISOString().slice(0, 16)}Z, ends ${new Date(active.endTime).toISOString().slice(0, 16)}Z.`);
    if (b) {
      console.log(`  Burn rate: ${Math.round(b.tokensPerMinute).toLocaleString()} tokens/min (${money(b.costPerHour)}/hr).`);
    }
    if (active.projection) {
      console.log(`  Projected at window end: ${fmtTok(active.projection.totalTokens)} tokens, ${money(active.projection.totalCost)}.`);
    }
  } else {
    console.log('  No active block: nothing is being used right now.');
  }
  const gapCount = blocks.length - real.length;
  if (gapCount) console.log(`  ${gapCount} idle stretch(es) between blocks, not shown.`);
  console.log('');
}

function reportByDay(records, flags) {
  const days = flags.days || 30;
  const tz = flags.timezone;
  const byDay = [...groupBy(records, (r) => dayKeyIn(r.timestamp, tz)).entries()];
  if (flags.json) {
    const rows = byDay.map(([day, rs]) => groupRow(day, rs))
      .sort((a, b) => (a.key < b.key ? 1 : -1))
      .slice(0, days);
    return reportGroupJson('by-day', rows, records);
  }
  const groups = byDay
    .map(([day, rs]) => [day, fmtTok(sum(rs, 'input') + sum(rs, 'cacheRead') + sum(rs, 'output')), money(totals(rs).cost)])
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, days);
  printTable(['Day', 'Tokens', 'Est. cost'], groups);
  const t = totals(records);
  console.log('');
  console.log(`  ${money(t.cost)} across ${records.length} records`);
}

function reportSessions(records, flags) {
  const bySession = [...groupBy(records, (r) => `${r.agent}/${r.session}`).entries()];
  if (flags.json) {
    const rows = bySession.map(([key, rs]) => ({
      ...groupRow(key, rs),
      started: new Date(Math.min(...rs.map((r) => r.timestamp || Date.now()))).toISOString(),
    })).sort((a, b) => b.costUSD - a.costUSD);
    return reportGroupJson('sessions', rows, records);
  }
  const groups = bySession
    .map(([key, rs]) => {
      const t = totals(rs);
      return [key, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), new Date(Math.min(...rs.map((r) => r.timestamp || Date.now()))).toISOString().slice(0, 10)];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));
  printTable(['Session', 'Tokens', 'Est. cost', 'Started'], groups.slice(0, flags.top || 10));
}

/**
 * Which agents are supported, AND whether each one is actually readable here.
 *
 * The status column is the point. A table of paths tells you where the tool
 * would look; it does not tell you why you got "no sessions found" — a missing
 * directory, an empty one, and a directory full of files this tool cannot
 * parse all look identical from the outside. That is the silent-zero failure
 * mode this project keeps meeting, so `sources` now reports it directly.
 */
function reportSources(flags = {}) {
  const rows = SOURCES.map((src) => {
    const root = expandHome(src.root);
    let state = 'not found';
    let files = 0;
    try {
      const st = statSync(root);
      if (st.isFile()) {
        files = src.match(pathBasename(root)) ? 1 : 0;
        state = files ? '1 file' : 'unreadable shape';
      } else if (st.isDirectory()) {
        files = countMatching(root, src.match, 0);
        state = files ? `${files} file(s)` : 'empty';
      }
    } catch {
      state = 'not found';
    }
    return { agent: src.agent, root: src.root, state, files, docs: src.docs };
  });
  if (flags.json) {
    console.log(JSON.stringify({
      tool: 'agentledger',
      version: version(),
      sources: rows,
      withData: rows.filter((r) => r.files > 0).length,
    }, null, 2));
    return;
  }
  printTable(['Agent', 'Log location', 'Here', 'Docs'],
    rows.map((r) => [r.agent, r.root, r.state, r.docs]));
  const total = rows.filter((r) => r.files > 0).length;
  console.log('');
  console.log(`  ${total} of ${rows.length} sources have data on this machine.`);
  if (total === 0) {
    console.log('  None found — if an agent is installed elsewhere, point at it with -p <dir>.');
  }
}

/** Count files under `dir` whose relative path passes the source's matcher. */
function countMatching(dir, match, depth) {
  if (depth > 8) return 0;
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = pathJoin(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      n += countMatching(full, match, depth + 1);
    } else if (e.isFile() && match(pathRelative(dir, full))) {
      n++;
    }
  }
  return n;
}

function reportPrices(flags, records) {
  const over = overriddenModels();

  // `prices --json` was silently ignored — it printed the table like every
  // other command honours --json. A scripted consumer (CI, a dashboard)
  // parsing stdout would get a table and fail, with no error to point at.
  const priceRow = (model) => {
    const p = resolvePricing(model);
    return {
      model,
      inputUSDPerMtok: p.input,
      outputUSDPerMtok: p.output,
      cacheReadMultiplier: p.cacheReadMultiplier,
      cacheWriteMultiplier: p.cacheWriteMultiplier,
      cacheWrite1hMultiplier: p.cacheWrite1hMultiplier ?? null,
      overridden: over.has(model),
    };
  };
  if (flags?.json) {
    const models = Object.keys(PRICING).map(priceRow);
    for (const key of over) {
      if (!(key in PRICING)) models.push(priceRow(key));
    }
    console.log(JSON.stringify({
      tool: 'agentledger',
      version: version(),
      defaultPricingUSD: {
        input: DEFAULT_PRICING.input,
        output: DEFAULT_PRICING.output,
        cacheReadMultiplier: DEFAULT_PRICING.cacheReadMultiplier,
        cacheWriteMultiplier: DEFAULT_PRICING.cacheWriteMultiplier,
      },
      models,
    }, null, 2));
    if (flags.template) reportPriceTemplate(records);
    return;
  }
  // Show what pricing ACTUALLY resolves to (resolvePricing), not the static
  // table — otherwise an override marks its row with * and still prints the
  // price it replaced. Caught by running it, of course.
  const rows = Object.keys(PRICING).map((model) => {
    const p = resolvePricing(model);
    return [
      over.has(model) ? `${model} *` : model,
      `$${p.input}`,
      `$${p.output}`,
      `x${p.cacheReadMultiplier ?? DEFAULT_PRICING.cacheReadMultiplier}`,
      p.cacheWrite1hMultiplier != null
        ? `x${p.cacheWriteMultiplier} / x${p.cacheWrite1hMultiplier}`
        : `x${p.cacheWriteMultiplier}`,
    ];
  });
  for (const key of over) {
    if (!(key in PRICING)) {
      const p = resolvePricing(key);
      rows.push([`${key} *`, `$${p.input}`, `$${p.output}`, `x${p.cacheReadMultiplier}`,
        p.cacheWrite1hMultiplier != null ? `x${p.cacheWriteMultiplier} / x${p.cacheWrite1hMultiplier}` : `x${p.cacheWriteMultiplier}`]);
    }
  }
  rows.push(['(unknown models)', `$${DEFAULT_PRICING.input}`, `$${DEFAULT_PRICING.output}`,
    `x${DEFAULT_PRICING.cacheReadMultiplier}`, `x${DEFAULT_PRICING.cacheWriteMultiplier} / x${DEFAULT_PRICING.cacheWrite1hMultiplier}`]);
  printTable(['Model', 'In $/Mtok', 'Out $/Mtok', 'Cache read', 'Cache write 5m/1h'], rows);
  console.log('');
  if (overrideCount) {
    console.log(`  ${overrideCount} model(s) overridden by --prices; overridden rows are marked with *.`);
    console.log('');
  }
  console.log('  Prices are static snapshots of public pricing pages (USD per 1M tokens).');
  console.log('  Cache write shows the TTL tiers where the provider has them (Anthropic:');
  console.log('  5-minute writes x1.25, 1-hour writes x2 of the input price).');
  console.log('  Every row is cross-checked weekly against the LiteLLM model database');
  console.log('  (tools/audit_pricing.py, in CI). agentledger never contacts the network.');

  if (flags?.template) reportPriceTemplate(records);
}

/** Print a fill-in override file for the models this ledger could not price. */
function reportPriceTemplate(records) {
  // Turn the warning into a one-step fix: emit an override file naming
  // exactly the models in THIS ledger that fell back to the default, with
  // their token volumes and the rate currently being assumed, so each blank
  // line has a visible weight and a visible cost.
  const unpriced = unpricedModels(records ?? []);
  if (!unpriced.length) {
    console.log('');
    console.log('  --template: every model in this ledger already has a price.');
    return;
  }
  const byModel = new Map();
  for (const r of (records ?? [])) {
    if (r.model && resolvePricing(r.model) === DEFAULT_PRICING) {
      const cur = byModel.get(r.model) ?? { records: 0, tokens: 0 };
      cur.records++;
      cur.tokens += (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.output || 0);
      byModel.set(r.model, cur);
    }
  }
  console.log('');
  console.log('  --template: fill in real rates below, save as prices.json, then run');
  console.log('  any command with:   agentledger --prices prices.json');
  console.log('');
  console.log(`  Each model currently costs the $${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} default`);
  console.log('  (per Mtok, input/output) — that is what the totals above assume.');
  console.log('  Set a field to 0 for a free lane. Fields may be omitted;');
  console.log('  anything you leave null keeps the default.');
  console.log('');
  const obj = {};
  for (const [model] of unpriced) {
    const v = byModel.get(model);
    obj[model] = { input: null, output: null };
    console.log(`  // ${model}: ${v.records} records, ${fmtTok(v.tokens)} tokens` +
      ` (now billed at $${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output})`);
  }
  console.log('');
  console.log(JSON.stringify(obj, null, 2));
}

/**
 * JSON for a grouped report: the breakdown the command name implies.
 *
 * Six commands used to answer `--json` with the full record dump. Asking for
 * "by-model JSON" got 18,017 rows and no model breakdown, so a script had to
 * group them itself — the same work the command had already done, thrown
 * away on the way out. This is the shape each of them should have had.
 *
 * The record dump is still one command away: `agentledger json`.
 */
function reportGroupJson(command, rows, records) {
  const t = totals(records);
  console.log(
    JSON.stringify(
      {
        tool: 'agentledger',
        version: version(),
        generatedAt: new Date().toISOString(),
        command,
        totals: {
          tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output },
          costUSD: round(t.cost),
          records: t.records,
        },
        rows,
      },
      null,
      2,
    ),
  );
}

/** One row of a grouped report: its key, its tokens, its cost, its record count. */
function groupRow(key, rs) {
  const t = totals(rs);
  return {
    key,
    tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output },
    costUSD: round(t.cost),
    records: rs.length,
  };
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

/**
 * `agentledger statusline` — one line, for Claude Code's statusLine hook.
 *
 * Claude Code invokes a statusline command before each render and pipes it a
 * JSON payload (session id, transcript path, model, workspace). This reads
 * that payload, prices ONLY the current session's transcript file — one
 * file, not the whole ledger, because a statusline re-renders on every
 * message and a full scan would make the UI stutter — and prints one line.
 *
 * Rules that come from the hook contract, not taste:
 *  - exit 0 always; a statusline that fails must never break the prompt bar.
 *  - print nothing but the line itself; no headers, no colors, no stderr noise.
 *  - if the payload is missing or unparseable, degrade to the today-total
 *    over the normal sources; if THAT has no data, print a plain marker.
 */
async function statusline(flags) {
  let payload = null;
  try {
    const chunks = [];
    if (!process.stdin.isTTY) {
      for await (const c of process.stdin) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text) payload = JSON.parse(text);
    }
  } catch {
    payload = null; // a statusline must survive a payload it cannot read
  }

  // Fast path: modern Claude Code payloads carry the session's own cost and
  // token totals. Using them means zero file I/O per render — the bar updates
  // as fast as the host can print it. It is also the host's own number, which
  // is the most honest thing available for "what is this session costing";
  // our transcript scan below is the estimate. Older payloads lack these
  // fields, so every access is optional and falls through to the scan.
  if (payload?.cost?.total_cost_usd != null) {
    const cost = Number(payload.cost.total_cost_usd) || 0;
    const cw = payload.context_window ?? {};
    const tok = (Number(cw.total_input_tokens) || 0) + (Number(cw.total_output_tokens) || 0);
    const model = payload?.model?.display_name || payload?.model?.id || '';
    if (flags.json) {
      process.stdout.write(JSON.stringify({
        session: payload?.session_id ?? null, costUSD: cost, tokens: tok,
        records: null, source: 'hook-payload',
      }) + '\n');
      return;
    }
    console.log(`agentledger · ${money(cost)}${tok ? ` · ${fmtTok(tok)} tok` : ''}${model ? ` · ${model}` : ''}`);
    return;
  }

  const transcript = payload?.transcript_path;
  if (transcript) {
    try {
      const { records } = await collect({ agents: ['claude-code'], paths: [transcript] });
      // The claude-code parser walks its whole root when the path matches a
      // directory tree, so `records` can include the entire ledger. The
      // session id is the transcript file's basename without extension;
      // filter to it so the bar prices THIS session, not the machine.
      const base = transcript.slice(transcript.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      const priced = records.filter((r) => r.session === base).map(withCost);
      const t = totals(priced);
      const model = payload?.model?.id ? ` ${payload.model.id}` : '';
      if (flags.json) {
        process.stdout.write(JSON.stringify({ session: payload?.session_id ?? null, costUSD: round(t.cost), tokens: t.input + t.cacheRead + t.cacheWrite + t.output, records: t.records }) + '\n');
        return;
      }
      if (t.records === 0) {
        console.log(`agentledger · session starting${model}`);
        return;
      }
      const tok = t.input + t.cacheRead + t.cacheWrite + t.output;
      console.log(`agentledger · ${money(t.cost)} · ${fmtTok(tok)} tok · ${t.records} calls${model}`);
      return;
    } catch {
      // fall through to the ledger-wide fallback
    }
  }

  // No transcript (older Claude Code, another agent, or a manual run):
  // price today across the normal sources instead of printing nothing.
  const startOfDay = startOfDayIn(Date.now(), flags.timezone);
  const { records } = await collect({ agents: flags.agent.length ? flags.agent : null, paths: flags.path });
  const priced = records.map(withCost).filter((r) => (r.timestamp ?? 0) >= startOfDay);
  const t = totals(priced);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ session: null, costUSD: round(t.cost), tokens: t.input + t.cacheRead + t.cacheWrite + t.output, records: t.records }) + '\n');
    return;
  }
  console.log(t.records ? `agentledger · today ${money(t.cost)} · ${fmtTok(t.input + t.cacheRead + t.cacheWrite + t.output)} tok` : 'agentledger · no usage today');
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
  blocks      Billing blocks: the windows a subscription quota resets in
  sessions    Most expensive sessions
  sources     Which agents are supported and where logs are read from
  prices      The built-in pricing table
  aggregate   Shareable totals + groupings (no session ids)
  share       Render a self-contained HTML page (e.g. share -o page.html)
  budget      Spend against a limit (e.g. budget -b 100)
  json        Machine-readable dump of every record
  statusline  One line for Claude Code's status bar (reads hook JSON on stdin)
  watch       Live-refreshing totals

Options
  -a, --agent <name>   Only read this agent (${agentNames})
  -p, --path <dir>     Also read logs from this directory or file
      --since <date>   Only records at/after this date (ISO or timestamp)
      --until <date>   Only records before this date (inclusive of the day)
  -n, --top <n>        Rows to show in ranked reports (default 10)
  -d, --days <n>       Days to show in by-day (default 30)
      --prices <file>  Override prices from a JSON map before reporting
      --timezone <tz>  IANA zone for day boundaries (default: the system zone)
      --json           Emit JSON instead of a table
  -o, --out <file>     Write the share page to a file instead of stdout
  -h, --help           This help

agentledger reads only local log files and never sends anything anywhere.
`);
}
