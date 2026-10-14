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

import { collect, withCost, totals, groupBy, SOURCES } from '../src/ledger.js';
import { PRICING, DEFAULT_PRICING, resolvePricing } from '../src/pricing.js';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'summary';
const flags = parseFlags(argv);

main().catch((err) => {
  console.error(`agentledger: ${err.message}`);
  process.exitCode = 1;
});

function parseFlags(args) {
  const out = { agent: [], path: [], json: false, top: 10, days: 30, since: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' || a === '-a') out.agent.push(args[++i]);
    else if (a === '--path' || a === '-p') out.path.push(args[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--top' || a === '-n') out.top = Number(args[++i]);
    else if (a === '--days' || a === '-d') out.days = Number(args[++i]);
    else if (a === '--since') out.since = Date.parse(args[++i]);
    else if (a === '--help' || a === '-h') { out.help = true; }
    else if (a === '--version' || a === '-v') { out.version = true; }
  }
  return out;
}

async function main() {
  if (flags.help) return printHelp();
  if (flags.version) return console.log(version());

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
    case 'by-model': return reportByModel(filtered, flags);
    case 'by-day': return reportByDay(filtered, flags);
    case 'sessions': return reportSessions(filtered, flags);
    case 'sources': return reportSources();
    case 'prices': return reportPrices();
    case 'json': return reportJson(filtered);
    case 'watch': return watch(flags);
    case 'summary':
    default: return reportSummary(filtered, { filesScanned, skipped }, flags);
  }
}

/* ------------------------------ reports ------------------------------ */

function reportSummary(records, meta, flags) {
  if (flags.json) return reportJson(records);
  const t = totals(records);
  const grand = totals(records.map((r) => r));
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
  ]);
  rows.push(['(unknown models)', `$${DEFAULT_PRICING.input}`, `$${DEFAULT_PRICING.output}`, `x${DEFAULT_PRICING.cacheReadMultiplier}`]);
  printTable(['Model', 'In $/Mtok', 'Out $/Mtok', 'Cache read'], rows);
  console.log('');
  console.log('  Prices are static snapshots of public pricing pages (USD per 1M tokens).');
  console.log('  agentledger never contacts the network.');
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
  const seen = new Set();
  console.log('agentledger watch — Ctrl-C to stop');
  const tick = async () => {
    const { records } = await collect({ agents: flags.agent.length ? flags.agent : null, paths: flags.path });
    const priced = records.map(withCost);
    const fresh = priced.filter((r) => !seen.has(keyOf(r)));
    for (const r of fresh) seen.add(keyOf(r));
    const t = totals(seen.size ? priced : fresh);
    process.stdout.write(`\r  ${money(totals(priced).cost)}  ${fmtTok(sum(priced, 'input') + sum(priced, 'cacheRead') + sum(priced, 'output'))} tokens  ${priced.length} records   `);
  };
  await tick();
  const timer = setInterval(tick, 5000);
  timer.unref?.();
  await new Promise(() => {});
}

/* ------------------------------ helpers ------------------------------ */

const keyOf = (r) => `${r.agent}/${r.session}/${r.timestamp}/${r.input}/${r.output}`;
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
  return '0.1.0';
}

function printHelp() {
  console.log(`
agentledger ${version()} — local-first cost ledger for AI coding agents

Usage
  agentledger [command] [options]

Commands
  summary     Totals, cost, and per-agent breakdown (default)
  by-model    Per-model token and cost breakdown
  by-day      Daily spend for the last N days
  sessions    Most expensive sessions
  sources     Which agents are supported and where logs are read from
  prices      The built-in pricing table
  json        Machine-readable dump of every record
  watch       Live-refreshing totals

Options
  -a, --agent <name>   Only read this agent (claude-code, codex, opencode, gemini-cli)
  -p, --path <dir>     Also read logs from this directory or file
      --since <date>   Only records at/after this date (ISO or timestamp)
  -n, --top <n>        Rows to show in ranked reports (default 10)
  -d, --days <n>       Days to show in by-day (default 30)
      --json           Emit JSON instead of a table
  -h, --help           This help

agentledger reads only local log files and never sends anything anywhere.
`);
}
