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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
// Whether the user actually named a command, as opposed to falling through
// to the default one. `--sections` needs the difference: it is its own
// report, and a command alongside it is a mistake rather than a modifier.
let explicitCommand = false;
try {
  explicitCommand = !!(argv[0] && !argv[0].startsWith('-'));
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
  // `topSet` and `daysSet` remember whether the user asked for a number, as
  // opposed to the default standing in. The commands treat a count as how
  // many rows to PRINT; the sections report treats it as a WINDOW onto the
  // ledger, and there "30" means "the last 30 days" only if the user asked
  // for 30 days. The defaults themselves stay exactly as they were.
  const out = { agent: [], path: [], json: false, template: false, top: 10, days: 30, topSet: false, daysSet: false, since: null, budget: null, prices: null, timezone: null, blockHours: 5, sections: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' || a === '-a') out.agent.push(args[++i]);
    else if (a === '--path' || a === '-p') out.path.push(args[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--template') out.template = true;
    else if (a === '--sections') {
      const raw = args[++i];
      if (raw === undefined) {
        throw new Error('--sections expects a comma-separated list of section names (e.g. --sections daily,weekly)');
      }
      out.sections = raw;
    }
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
    else if (a === '--top' || a === '-n') { out.top = positiveInt(args[++i], a); out.topSet = true; }
    else if (a === '--days' || a === '-d') { out.days = positiveInt(args[++i], a); out.daysSet = true; }
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

/**
 * Start over with `--experimental-sqlite` if this Node needs it.
 *
 * `node:sqlite` landed in Node 22.5 behind a flag and was unflagged in
 * 23.8 — with a backport into the 22.x line partway through. On a Node
 * where it is still flagged, importing it THROWS, and every parser that
 * opens a database catches that and returns zero records. The result is
 * the worst failure this tool can have: on Node 22.5.0 exactly, five of
 * the eleven lanes — OpenCode, Kilo, Cherry Studio, CodeBuddy and Lingma
 * — read nothing, and the report says so with a total that looks
 * complete.
 *
 * So the tool restarts itself with the flag. The alternative is to tell
 * the user to add a flag to every invocation, which is not a thing a
 * tool should require of someone who just wants their number.
 *
 * The re-exec is skipped when the flag is already there, when
 * NODE_OPTIONS carries it, when `node:sqlite` imports fine anyway, and
 * when a guard env var says this process has already restarted once.
 */
function needsSqliteFlag() {
  if (process.execArgv.some((a) => a.includes('experimental-sqlite'))) return false;
  if ((process.env.NODE_OPTIONS || '').includes('experimental-sqlite')) return false;
  if (process.env.ALEDGER_REEXEC === '1') return false;
  return true;
}

async function sqliteUnavailable() {
  try {
    await import('node:sqlite');
    return false;
  } catch {
    return true;
  }
}

async function restartWithSqlite() {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(
    process.execPath,
    ['--experimental-sqlite', self, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ALEDGER_REEXEC: '1' } },
  );
  // A signal (Ctrl-C) is not an exit code; report it as one so the shell
  // sees the same thing it would have seen without the restart.
  if (r.error) throw r.error;
  process.exit(r.status === null ? 1 : r.status);
}

async function main() {
  if (flags.help) return printHelp();
  if (flags.version) return console.log(version());

  if (needsSqliteFlag() && (await sqliteUnavailable())) {
    return restartWithSqlite();
  }

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

  // `--sections` names several reports at once, so there is no single command
  // for it to modify. A command alongside it is a mistake, and silently
  // ignoring the command would be the worst answer: the user would think
  // they had asked for a by-day report and got something else.
  if (flags.sections !== null && explicitCommand) {
    throw new Error(
      `--sections is its own report and cannot be combined with the ${command} command; ` +
      `run \`agentledger --sections ${flags.sections}\``,
    );
  }
  // The section names are checked before a single log file is opened: a typo
  // should cost nothing, and a report that half-runs is worse than one that
  // refuses to start.
  const sections = flags.sections !== null ? parseSections(flags.sections) : null;

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
    case 'share': return renderSharePage(filtered, flags, { filesScanned });
    case 'by-project': return reportByProject(filtered, flags);
    case 'by-branch': return reportByBranch(filtered, flags);
    case 'by-model': return reportByModel(filtered, flags);
    case 'by-day': return reportByDay(filtered, flags);
    case 'by-week': return reportByPeriod(filtered, flags, 'by-week', (ts) => weekKeyIn(ts, flags.timezone), 'Week');
    case 'by-month': return reportByPeriod(filtered, flags, 'by-month', (ts) => monthKeyIn(ts, flags.timezone), 'Month');
    case 'blocks': return reportBlocks(filtered, flags);
    case 'sessions': return reportSessions(filtered, flags);
    case 'budget':
      if (flags.budget === null) {
        throw new Error('budget needs a limit, e.g. `agentledger budget --budget 100` (or -b 100)');
      }
      return reportBudget(filtered, flags);
    case 'sources': return reportSources(flags);
    case 'prices': return reportPrices(flags, filtered);
    case 'aggregate': return reportAggregate(filtered, { filesScanned });
    case 'json': return reportJson(filtered);
    case 'statusline': return statusline(flags);
    case 'watch': return watch(flags);
    case 'summary':
    default:
      // `--sections` is its own report, and it is the one that reads the logs
      // ONCE and prints several views of them.
      if (sections) return reportSections(filtered, flags, sections, { filesScanned });
      return reportSummary(filtered, { filesScanned, skipped }, flags);
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
function reportAggregate(records, meta = {}) {
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
      // The cost of each bucket, so a document built from this can print
      // the per-bucket rows without guessing. The docs pipeline needed
      // this: the README's summary block has a row per bucket, and the
      // sync tool could only refresh the token column, so its costs went
      // stale and the gate did not notice — the README's total was $1169
      // while the tool said $1227.
      costByBucket: {
        input: round(t.costInput),
        cacheRead: round(t.costCacheRead),
        cacheWrite: round(t.costCacheWrite),
        output: round(t.costOutput),
      },
      records: records.length,
      // How many files were opened. It is a meaningful fact — "it read
      // 298 of your session files" — and it was hand-pasted into the
      // README, where it went stale silently. Carried here so the docs
      // pipeline can keep it true.
      filesScanned: meta.filesScanned ?? null,
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
  // When the agent wrote its own cost, print BOTH numbers. ccusage picks one
  // (`auto` mode prefers the stored cost, `calculate` prefers its own table);
  // a disagreement between two independent calculations of the same bill is
  // information, and hiding one of them is how a pricing table quietly
  // drifts out of date.
  const stored = records.filter((r) => typeof r.storedCost === 'number');
  if (stored.length) {
    const storedTotal = stored.reduce((a, r) => a + r.storedCost, 0);
    const storedTokens = stored.reduce(
      (a, r) => a + (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.output || 0),
      0,
    );
    const sameScope = storedTokens === t.input + t.cacheRead + t.cacheWrite + t.output;
    console.log(`  The agent's own total for the ${sameScope ? 'whole' : 'part of it it'} ledger: ${money(storedTotal)}`);
    console.log(`  agentledger's estimate for the same ${sameScope ? 'scope' : 'scope is a different slice'}: ${money(totals(stored).cost)}`);
    if (sameScope) {
      const diff = storedTotal - totals(stored).cost;
      const pct = storedTotal ? (diff / storedTotal) * 100 : 0;
      console.log(`  Difference: ${money(diff)} (${pct.toFixed(1)}%) — same tokens, different price table.`);
    }
    console.log('');
  }
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
async function renderSharePage(records, flags, meta = {}) {
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
      // The cost of each bucket, so a document built from this can print
      // the per-bucket rows without guessing. The docs pipeline needed
      // this: the README's summary block has a row per bucket, and the
      // sync tool could only refresh the token column, so its costs went
      // stale and the gate did not notice — the README's total was $1169
      // while the tool said $1227.
      costByBucket: {
        input: round(t.costInput),
        cacheRead: round(t.costCacheRead),
        cacheWrite: round(t.costCacheWrite),
        output: round(t.costOutput),
      },
      records: records.length,
      // How many files were opened. It is a meaningful fact — "it read
      // 298 of your session files" — and it was hand-pasted into the
      // README, where it went stale silently. Carried here so the docs
      // pipeline can keep it true.
      filesScanned: meta.filesScanned ?? null,
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

/**
 * A calendar key for a timestamp at a coarser grain than a day.
 *
 * `by-week` and `by-month` differ from `by-day` only in the key they group
 * by, and both are "the same report, rolled up". The week starts on
 * Monday — the ISO convention, and the one ccusage's `weekly` uses — and
 * the month is the calendar month.
 *
 * The week is computed in the reporting zone, not in UTC, so a week is a
 * local week. A Monday 00:30 in Shanghai is Sunday 16:30 UTC, and calling
 * that Monday while every other Monday in the report is local is the kind
 * of inconsistency this tool has already had one of.
 */
function weekKeyIn(ts, timeZone) {
  if (!ts) return 'unknown';
  // The local date, then the Monday on or before it.
  const day = dayKeyIn(ts, timeZone);
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** The calendar month a timestamp falls in, as YYYY-MM. */
function monthKeyIn(ts, timeZone) {
  if (!ts) return 'unknown';
  return dayKeyIn(ts, timeZone).slice(0, 7);
}

/**
 * The groups behind a period report: one group per day, week or month,
 * newest first.
 *
 * The by-day, by-week and by-month commands and the `--sections` report all
 * come through this function, so a section and its command cannot drift
 * apart — the two paths differ only in what they do with the groups.
 */
function periodGroups(records, keyFn) {
  return [...groupBy(records, (r) => keyFn(r.timestamp)).entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

/**
 * The groups behind a session report: one per agent/session pair, most
 * expensive first.
 */
function sessionGroups(records) {
  return [...groupBy(records, (r) => `${r.agent}/${r.session}`).entries()]
    .map(([key, rs]) => ({ key, rs, cost: totals(rs).cost }))
    .sort((a, b) => b.cost - a.cost)
    .map((g) => [g.key, g.rs]);
}

/** The rows of a session report: the group, plus when the session started. */
function sessionRows(groups) {
  return groups.map(([key, rs]) => ({
    ...groupRow(key, rs),
    started: new Date(Math.min(...rs.map((r) => r.timestamp || Date.now()))).toISOString(),
  }));
}

/** The by-day table: a day, its tokens, its cost. */
function printDayTable(groups) {
  printTable(['Day', 'Tokens', 'Est. cost'], groups.map(([day, rs]) => [
    day,
    fmtTok(sum(rs, 'input') + sum(rs, 'cacheRead') + sum(rs, 'output')),
    money(totals(rs).cost),
  ]));
}

/** The by-week and by-month tables: a period, its tokens, its cost, its records. */
function printPeriodTable(groups, label) {
  printTable([label, 'Tokens', 'Est. cost', 'Records'], groups.map(([key, rs]) => {
    const t = totals(rs);
    return [key, fmtTok(t.input + t.cacheRead + t.cacheWrite + t.output), money(t.cost), String(rs.length)];
  }));
}

/** The sessions table: a session, its tokens, its cost, when it started. */
function printSessionTable(groups) {
  printTable(['Session', 'Tokens', 'Est. cost', 'Started'], groups.map(([key, rs]) => {
    const t = totals(rs);
    return [key, fmtTok(t.input + t.cacheRead + t.output), money(t.cost), new Date(Math.min(...rs.map((r) => r.timestamp || Date.now()))).toISOString().slice(0, 10)];
  }));
}

function reportByDay(records, flags) {
  const days = flags.days || 30;
  const tz = flags.timezone;
  const groups = periodGroups(records, (ts) => dayKeyIn(ts, tz)).slice(0, days);
  if (flags.json) {
    return reportGroupJson('by-day', groups.map(([day, rs]) => groupRow(day, rs)), records);
  }
  printDayTable(groups);
  const t = totals(records);
  console.log('');
  console.log(`  ${money(t.cost)} across ${records.length} records`);
}

/**
 * A period report: by-week and by-month are the same thing at a different
 * grain, and they are built from the same code so they cannot drift apart.
 */
function reportByPeriod(records, flags, command, keyFn, label) {
  const groups = periodGroups(records, keyFn);
  if (flags.json) {
    return reportGroupJson(command, groups.map(([key, rs]) => groupRow(key, rs)), records);
  }
  printPeriodTable(groups, label);
  console.log('');
  const t = totals(records);
  console.log(`  ${money(t.cost)} across ${records.length} records in ${groups.length} ${label.toLowerCase()}(s).`);
}

function reportSessions(records, flags) {
  const groups = sessionGroups(records);
  if (flags.json) {
    return reportGroupJson('sessions', sessionRows(groups), records);
  }
  printSessionTable(groups.slice(0, flags.top || 10));
}

/* ------------------------------ sections ------------------------------ */

/**
 * The rows of a period section: one row per day, week or month.
 *
 * A function declaration, not a `const`: the SECTIONS table below refers to
 * it while it is being built, and a `const` would be in its temporal dead
 * zone at that moment. This is the same shape of bug the `--since` filter
 * had — a ReferenceError in a module body, which takes every command down
 * with it.
 */
function periodRows(groups) {
  return groups.map(([key, rs]) => groupRow(key, rs));
}

/**
 * The reports `--sections` can emit, and how each one is built.
 *
 * The names are ccusage's — daily, weekly, monthly, session — so a script
 * written against one works against the other. Each one is a report this
 * tool already has, grouped a different way: daily is by-day, weekly is
 * by-week, monthly is by-month, and session is sessions. The table output
 * names the agentledger command as well, so the mapping is never a guess.
 *
 * `groups` returns the [key, records] pairs, `rows` turns them into the
 * JSON rows, and `print` draws the table. The by-day, by-week, by-month and
 * sessions commands use the same builders, so a section and its command
 * cannot disagree about the numbers.
 */
const SECTIONS = {
  daily: {
    blurb: 'spend per day (the by-day report)',
    groups: (records, flags) => periodGroups(records, (ts) => dayKeyIn(ts, flags.timezone)),
    // A cap here narrows the report to a WINDOW, not to a number of rows, so
    // it applies only when the user asked for one: `--days 7` is the last
    // seven days, and with no `--days` the section shows every day.
    limit: (flags) => (flags.daysSet ? flags.days : undefined),
    rows: periodRows,
    print: printDayTable,
  },
  weekly: {
    blurb: 'spend per week, weeks starting Monday (the by-week report)',
    groups: (records, flags) => periodGroups(records, (ts) => weekKeyIn(ts, flags.timezone)),
    limit: () => undefined,
    rows: periodRows,
    print: (groups) => printPeriodTable(groups, 'Week'),
  },
  monthly: {
    blurb: 'spend per month (the by-month report)',
    groups: (records, flags) => periodGroups(records, (ts) => monthKeyIn(ts, flags.timezone)),
    limit: () => undefined,
    rows: periodRows,
    print: (groups) => printPeriodTable(groups, 'Month'),
  },
  session: {
    blurb: 'the most expensive sessions (the sessions report)',
    groups: (records) => sessionGroups(records),
    limit: (flags) => (flags.topSet ? flags.top : undefined),
    rows: sessionRows,
    print: printSessionTable,
  },
};

/** The section names `--sections` accepts, in the order they are documented. */
const SECTION_NAMES = ['daily', 'weekly', 'monthly', 'session'];

/**
 * Parse and validate a `--sections` list.
 *
 * A bad name is an error, the way an unknown `--agent` is: a typo that
 * quietly produced a shorter report would be a report missing a section
 * nobody asked to miss. The order the user wrote is the order they get.
 */
function parseSections(spec) {
  const names = String(spec).split(',').map((s) => s.trim()).filter((s) => s.length);
  if (!names.length) {
    throw new Error(`--sections expects at least one section name (${SECTION_NAMES.join(', ')})`);
  }
  const unknown = names.filter((n) => !SECTION_NAMES.includes(n));
  if (unknown.length) {
    throw new Error(
      `unknown section ${unknown.map((n) => JSON.stringify(n)).join(', ')}; ` +
      `known sections: ${SECTION_NAMES.join(', ')}`,
    );
  }
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) throw new Error(`duplicate section ${JSON.stringify(n)} in --sections`);
    seen.add(n);
  }
  return names;
}

/**
 * Several reports from ONE read of the logs.
 *
 * This is the one place ccusage was genuinely better: a user who wanted a
 * daily view and a weekly view of the same ledger ran the tool twice, and
 * read every log file twice — 298 files on this machine. Here the logs are
 * read once and every section is a different grouping of the same records.
 *
 * Every section covers the whole ledger unless the user caps it, and a
 * capped section's totals cover exactly the rows it shows.
 */
function reportSections(records, flags, names, meta = {}) {
  const sections = names.map((name) => {
    const spec = SECTIONS[name];
    const all = spec.groups(records, flags);
    const limit = spec.limit(flags);
    const groups = limit === undefined ? all : all.slice(0, limit);
    // The records are kept because a section's totals must cover exactly the
    // rows it shows: a capped section reports the window it is showing, not
    // the totals of a ledger the user cannot see.
    return {
      name, groups,
      rows: spec.rows(groups),
      records: groups.flatMap(([, rs]) => rs),
      print: () => spec.print(groups),
      capped: groups.length < all.length,
      all,
    };
  });

  if (flags.json) {
    const doc = {
      tool: 'agentledger',
      version: version(),
      generatedAt: new Date().toISOString(),
      filesScanned: meta.filesScanned ?? null, // how many files were opened, once
    };
    for (const s of sections) {
      const body = reportBody(s.rows, s.records);
      // An empty section says so rather than handing back an empty array to
      // interpret.
      if (!s.rows.length) { body.empty = true; body.note = EMPTY_LEDGER_NOTE; }
      doc[s.name] = body;
    }
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  for (const s of sections) {
    console.log('');
    console.log(`  ${s.name} — ${SECTIONS[s.name].blurb}`);
    if (!s.rows.length) {
      console.log(`  ${EMPTY_LEDGER_NOTE}`);
      console.log('');
      continue;
    }
    s.print();
    const t = totals(s.records);
    console.log('');
    console.log(`  ${money(t.cost)} across ${t.records} records`);
    if (s.capped) {
      console.log(`  (capped: showing ${s.groups.length} of ${s.all.length}; the totals above are that window)`);
    }
    console.log('');
  }
}

/** What an empty section says, in a table and in JSON alike. */
const EMPTY_LEDGER_NOTE =
  'No usage records in this ledger. Run `agentledger sources` to see which lanes are readable on this machine.';

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
  console.log(
    JSON.stringify(
      {
        tool: 'agentledger',
        version: version(),
        generatedAt: new Date().toISOString(),
        command,
        ...reportBody(rows, records),
      },
      null,
      2,
    ),
  );
}

/**
 * The {totals, rows} body every grouped report carries.
 *
 * The totals are the totals of the records the rows cover. A report whose
 * rows are a window of the ledger (`by-day --days 7`) still reports the
 * whole ledger's totals here, because that is what every grouped command has
 * always done — but the sections report does not use this shape for a
 * capped section, because there the rows and the totals must describe the
 * same window.
 */
function reportBody(rows, records) {
  const t = totals(records);
  return {
    totals: {
      tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output },
      costUSD: round(t.cost),
      records: t.records,
    },
    rows,
  };
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
          // The agent's own figure, when it wrote one. `null` means the
          // source does not record a cost of its own — not zero, which would
          // be a claim.
          storedCostUSD: typeof r.storedCost === 'number' ? round(r.storedCost) : null,
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
  const all = records.map(withCost);
  const priced = all.filter((r) => (r.timestamp ?? 0) >= startOfDay);
  const t = totals(priced);

  // The active billing block, with the time left in it and the burn rate.
  //
  // This is the part of ccusage's statusline that agentledger used to
  // concede outright. Two things make it better here: it is computed
  // across EVERY lane, not just Claude Code, so a subscription that is
  // not Claude's still gets a window; and the block is a real window with
  // a real end, not an estimate.
  const block = activeBlock(all, flags);
  const blockPart = block
    ? ` · block ${money(block.costUSD)} (${block.remainingLabel})`
    : '';
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      session: null,
      costUSD: round(t.cost),
      tokens: t.input + t.cacheRead + t.cacheWrite + t.output,
      records: t.records,
      block: block
        ? {
            id: block.id,
            costUSD: round(block.costUSD),
            tokens: block.totalTokens,
            remainingMinutes: block.remainingMinutes,
            burnRateCostPerHour: round(block.burnRate?.costPerHour ?? 0),
            burnRateTokensPerMinute: round(block.burnRate?.tokensPerMinute ?? 0),
          }
        : null,
    }) + '\n');
    return;
  }
  console.log(
    t.records
      ? `agentledger · today ${money(t.cost)} · ${fmtTok(t.input + t.cacheRead + t.cacheWrite + t.output)} tok${blockPart}`
      : `agentledger · no usage today${blockPart}`,
  );
}

/**
 * The billing block that is running right now, if any.
 *
 * Returns null when nothing has been used recently enough to open a
 * block. `<synthetic>` records are excluded for the same reason the
 * `blocks` command excludes them: they are not usage, and they would
 * open a window that contains nothing.
 */
function activeBlock(priced, flags) {
  const blocks = computeBlocks(
    priced.filter((r) => r.model !== '<synthetic>'),
    { now: Date.now(), timezone: flags.timezone, blockHours: flags.blockHours },
  );
  const active = blocks.find((b) => b.isActive && !b.isGap);
  if (!active) return null;
  const remainingMinutes = Math.max(0, Math.round((Date.parse(active.endTime) - Date.now()) / 60000));
  const h = Math.floor(remainingMinutes / 60);
  const m = remainingMinutes % 60;
  return {
    id: active.id,
    costUSD: active.costUSD,
    totalTokens: active.totalTokens,
    burnRate: active.burnRate,
    remainingMinutes,
    remainingLabel: remainingMinutes > 0 ? `${h}h ${m}m left` : 'ending now',
  };
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
  by-week     The same, rolled up by week (weeks start on Monday)
  by-month    The same, rolled up by month
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
      --sections <list> Several reports from ONE read of the logs:
                       daily, weekly, monthly, session (comma-separated).
                       Its own report — not a modifier of a command.
      --prices <file>  Override prices from a JSON map before reporting
      --timezone <tz>  IANA zone for day boundaries (default: the system zone)
      --json           Emit JSON instead of a table
  -o, --out <file>     Write the share page to a file instead of stdout
  -h, --help           This help

agentledger reads only local log files and never sends anything anywhere.
`);
}
