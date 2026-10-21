/**
 * Ledger: discover agent session logs on this machine, parse them, and
 * aggregate usage into a single book.
 *
 * The library is intentionally free of I/O side effects beyond reading the
 * log files it is pointed at.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PARSERS } from './parsers.js';
import { PARSERS_CHERRY } from './parsers-cherry.js';
import { PARSERS_CODEBUDDY, CODEBUDDY_LOG_MATCH } from './parsers-codebuddy.js';
import { PARSERS_LINGMA, LINGMA_DB_MATCH } from './parsers-lingma.js';
import { PARSERS_WORKBUDDY, WORKBUDDY_SESSION_MATCH } from './parsers-workbuddy.js';
import { costOf } from './pricing.js';

// The CherryStudio lane lives in its own module because it is the only
// parser that needs a documented dedup relationship with another source;
// merging it here keeps that coupling visible instead of buried.
const ALL_PARSERS = { ...PARSERS, ...PARSERS_CHERRY, ...PARSERS_CODEBUDDY, ...PARSERS_LINGMA, ...PARSERS_WORKBUDDY };

/**
 * Where each supported agent keeps its logs.
 * `glob` entries are expanded against the user's home directory.
 */
export const SOURCES = [
  {
    agent: 'claude-code',
    root: '~/.claude/projects',
    match: (rel) => rel.endsWith('.jsonl'),
    parser: PARSERS['claude-code'],
    docs: 'https://docs.claude.com/en/docs/claude-code',
  },
  {
    agent: 'codex',
    root: '~/.codex/sessions',
    match: (rel) => /\.jsonl$/.test(rel),
    parser: ALL_PARSERS.codex,
    docs: 'https://github.com/openai/codex',
  },
  {
    agent: 'opencode',
    root: '~/.local/share/opencode',
    match: (rel) => /(^|\/)opencode\.db$/.test(rel),
    parser: ALL_PARSERS.opencode,
    docs: 'https://opencode.ai/docs',
  },
  {
    // Kilo is an OpenCode fork; same SQLite store shape, different directory
    // and file name. Verified against a live ~/.local/share/kilo/kilo.db.
    agent: 'kilo',
    root: '~/.local/share/kilo',
    match: (rel) => /(^|\/)kilo\.db$/.test(rel),
    parser: ALL_PARSERS.kilo,
    docs: 'https://kilo.ai',
  },
  {
    // DSH (DeepSeek Harness) keeps zstd-compressed JSONL sessions. Read-only;
    // the parser decompresses in memory and never writes back.
    agent: 'dsh',
    root: '~/.dsh/sessions',
    match: (rel) => /session\.v4\.jsonl\.zstd$/.test(rel),
    parser: ALL_PARSERS.dsh,
    docs: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  {
    agent: 'gemini-cli',
    root: '~/.gemini/tmp',
    match: (rel) => /(^|\/)logs\.json$/.test(rel),
    parser: PARSERS['gemini-cli'],
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    // pi-agent stores one JSONL per session under a cwd-slug directory. The
    // `.jsonl.reset.<ts>` / `.jsonl.deleted.<ts>` siblings OpenClaw leaves
    // behind are not a pi convention — pi only writes the session file.
    agent: 'pi',
    root: '~/.pi/agent/sessions',
    match: (rel) => /(^|\/)[^/]+\.jsonl$/.test(rel),
    parser: ALL_PARSERS.pi,
    docs: 'https://github.com/earendil-works/pi-coding-agent',
  },
  {
    // OpenClaw (clawdbot) keeps one JSONL per session under
    // ~/.openclaw/agents/<agent>/sessions/, plus archived siblings named
    // `<uuid>.jsonl.reset.<ts>` and `<uuid>.jsonl.deleted.<ts>`. Those
    // archives hold real usage ccusage counts (2.03M input tokens on this
    // machine, from a session that was reset mid-run), so the matcher
    // accepts them rather than only a bare `.jsonl`. The sibling SQLite
    // store (`openclaw-agent.sqlite`, table `transcript_events`) holds the
    // same events — reading both would double-count.
    agent: 'openclaw',
    root: '~/.openclaw/agents',
    match: (rel) => /(^|\/)[^/]+\.jsonl(\.|$)/.test(rel),
    parser: ALL_PARSERS.openclaw,
    docs: 'https://github.com/clawdbot/clawdbot',
  },
  {
    // CherryStudio is a GUI that hosts several agents, so it is the one
    // source that can double-count: it writes its own `ai_usage_record` row
    // for every request a hosted agent also logs. `dropHostedDuplicates`
    // removes those, keyed on the agent's own log winning. The rest of its
    // ledger (June/July sessions no other source covers) is additive.
    agent: 'cherry-studio',
    root: '~/Library/Application Support/CherryStudio/Data',
    match: (rel) => /(^|\/)cherrystudio\.sqlite$/.test(rel),
    parser: ALL_PARSERS['cherry-studio'],
    docs: 'https://www.cherry-ai.com/',
  },
  {
    // CodeBuddy CN (腾讯云代码助手) is Tencent's AI coding IDE. Its usage is
    // spread over three stores — the extension log carries the token
    // buckets, the history index carries the clock and the request list,
    // the message files carry the model, and the sessions database carries
    // the working directory. The parser joins them; the source root is the
    // log directory because that is the only one with the usage itself.
    //
    // ccusage has no adapter for this product at all. Its "codebuff"
    // adapter is Manicode, a different tool with a different store.
    agent: 'codebuddy',
    root: '~/Library/Application Support/CodeBuddy CN/logs',
    match: CODEBUDDY_LOG_MATCH,
    parser: ALL_PARSERS.codebuddy,
    docs: 'https://copilot.tencent.com/',
  },
  {
    // Lingma (阿里通义灵码) is Alibaba's AI coding IDE. Its usage is in a
    // SQLite store; a companion CLI log carries the cache split for a few
    // of the calls, and the parser joins them.
    //
    // The matcher is the DATABASE only. The log resolves to the same
    // database, so matching both would read the lane twice.
    agent: 'lingma',
    root: '~/Library/Application Support/Lingma/SharedClientCache/cache/db',
    match: LINGMA_DB_MATCH,
    parser: ALL_PARSERS.lingma,
    docs: 'https://lingma.aliyun.com/',
  },
  {
    // WorkBuddy is Tencent's standalone AI agent desktop app. One JSONL
    // file per session under a cwd slug, each line one model call, with
    // the model on the record.
    //
    // ccusage has no adapter for it. It is the same product family as
    // CodeBuddy CN — same account, same usage object shape — and the two
    // windows are disjoint: CodeBuddy CN spans 2026-04-26 to 2026-05-08,
    // WorkBuddy 2026-09-08 to 2026-10-21, with zero timestamp collisions.
    agent: 'workbuddy',
    root: '~/.workbuddy/projects',
    match: WORKBUDDY_SESSION_MATCH,
    parser: ALL_PARSERS.workbuddy,
    docs: 'https://copilot.tencent.com/',
  },
];

export const expandHome = (p) =>
  p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;

/** Recursively list files under `dir`, skipping unreadable subtrees. */
async function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collect every usage record from every configured source.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.agents]  only these agents (default: all)
 * @param {string[]} [opts.paths]   extra directories or files to scan
 * @param {(pct:number)=>void} [opts.onProgress]
 * @returns {Promise<{records:object[], filesScanned:number, skipped:string[]}>}
 */
export async function collect(opts = {}) {
  const wanted = opts.agents?.length ? new Set(opts.agents) : null;
  const records = [];
  const skipped = [];
  let filesScanned = 0;

  const sources = SOURCES.filter((s) => !wanted || wanted.has(s.agent));

  // Every file the built-in lanes read, by absolute path. A `--path` that
  // points at a file one of them already read would otherwise be counted
  // TWICE — the same request, twice, in the same total, with nothing to
  // say so. Measured: `--path` on a Claude Code file took the lane from
  // 1,462 records to 1,574.
  const read = new Set();

  for (const source of sources) {
    const root = expandHome(source.root);
    let files = [];
    const stat = await fsp.stat(root).catch(() => null);
    if (stat?.isFile()) files = [root];
    else if (stat?.isDirectory()) files = (await walk(root)).filter((f) => source.match(path.relative(root, f)));

    for (const file of files) {
      filesScanned++;
      read.add(path.resolve(file));
      try {
        for await (const rec of source.parser(file)) {
          records.push(rec);
        }
      } catch (err) {
        skipped.push(`${file}: ${err.message}`);
      }
      opts.onProgress?.(filesScanned);
    }
  }

  // Extra explicit paths: sniff the format from the file name/shape.
  for (const extra of opts.paths ?? []) {
    const abs = expandHome(extra);
    const stat = await fsp.stat(abs).catch(() => null);
    const files = stat?.isDirectory() ? await walk(abs) : stat ? [abs] : [];
    for (const file of files) {
      // A `.sqlite` file is a store, not a log — it needs a parser that
      // knows the schema, not the text sniffer. Without this branch
      // `--path ~/.../cherrystudio.sqlite` silently read zero records, which
      // is the same failure shape as an empty lane: no error, no data.
      if (/\.(sqlite|db)$/.test(file)) {
        filesScanned++;
        try {
          for await (const rec of sniffDb(file)) records.push(rec);
        } catch (err) {
          skipped.push(`${file}: ${err.message}`);
        }
        continue;
      }
      // `.log` is here for CodeBuddy CN's extension log, which is plain
      // text with the token buckets embedded in it. The sniffer decides
      // whether it is that or something else.
      if (!/\.(jsonl|json|log)$/.test(file)) continue;
      // Already read by a built-in lane: reading it again would double
      // count the same requests.
      if (read.has(path.resolve(file))) continue;
      filesScanned++;
      try {
        for await (const rec of sniff(file)) records.push(rec);
      } catch (err) {
        skipped.push(`${file}: ${err.message}`);
      }
    }
  }

  // LAST, after every source and every explicit path has contributed, so a
  // record from `--path` is deduped against the built-in lanes too.
  return { records: dropHostedDuplicates(records), filesScanned, skipped };
}

// The two stores write the same request at slightly different moments: the
// agent logs at completion, the host when it persists its row. Measured on
// this machine at 20-60ms apart, so a 2-second window is generous while still
// far tighter than any two independent requests could plausibly collide on
// the same token signature.
const HOST_WINDOW_MS = 2000;

/**
 * Drop records a HOST recorded for a session another source already owns.
 *
 * CherryStudio can host pi-agent, and when it does it records the usage of
 * requests that pi's own session log also records. Verified on this machine:
 * of 8 CherryStudio rows in the pi window, 3 are the same request with
 * byte-identical token counts (17:22:27 -> in 5851 / out 13 in BOTH stores)
 * and 5 are CherryStudio's own requests that pi never logged. Summing both
 * lanes double-counts those 3.
 *
 * The agent's own log wins, not the host's: pi's session file is the
 * authoritative record of what it sent, and CherryStudio is a GUI observing
 * it. The match is on the TOKEN SIGNATURE, with the timestamp only used as a
 * proximity bound, because the two stores write the same request ~20-60ms
 * apart (pi at completion, the host when it persists the row) — an exact
 * millisecond match finds nothing, which is exactly the kind of silent no-op
 * that looks like success.
 *
 * The signature is the whole-prompt token total PLUS the model's family, and
 * nothing else. The whole-prompt total is the one number both stores agree
 * on even when they bucket differently: pi reports input as fresh-only plus
 * a separate cacheRead, while CherryStudio reports input as the whole prompt
 * already, and their output fields differ too (pi folds reasoning into
 * output, the host keeps it separate, so 158 vs 204 for the same request).
 * Matching on output as well silently misses every row that had reasoning.
 *
 * The model family is in the key because whole-prompt totals collide: on
 * this machine 402 of the 14,959 distinct whole-prompt values are shared
 * by two or more non-host records, and 739 of those pairs fall inside the
 * 2-second window. Without the model in the key, a Cherry Studio row that
 * happened to send the same-sized prompt as an unrelated request nearby
 * would be silently dropped. With it, the three real duplicates still match
 * (their models are the same family behind a provider prefix —
 * `new-api:deepseek-v4.1-flash-free` vs `deepseek-v4.1-flash-free`) and a
 * collision across models cannot match at all.
 *
 * 17:22:53 is the counter-example that proves the input-only signature is
 * still safe: pi 567 / 12032 against the host's 6364 / 6272 are the same
 * shape of request counted two ways, with different whole-prompt totals
 * (12,599 vs 6,364), so they are correctly NOT matched.
 *
 * This is deliberately NOT a general "drop anything that looks similar":
 * only `cherry-studio` records are candidates for removal. Everything else
 * passes through untouched.
 */
function dropHostedDuplicates(records) {
  // Whole-prompt totals from every non-host record, keyed by the signature.
  const owned = new Map();
  for (const r of records) {
    if (r.agent === 'cherry-studio') continue;
    if (typeof r.timestamp !== 'number') continue;
    const k = signature(r);
    if (!owned.has(k)) owned.set(k, []);
    owned.get(k).push(r.timestamp);
  }
  if (owned.size === 0) return records;

  const kept = [];
  let dropped = 0;
  for (const r of records) {
    if (r.agent === 'cherry-studio' && typeof r.timestamp === 'number') {
      const candidates = owned.get(signature(r));
      if (candidates?.some((t) => Math.abs(t - r.timestamp) <= HOST_WINDOW_MS)) {
        dropped++;
        continue;
      }
    }
    kept.push(r);
  }
  if (dropped > 0) {
    // Attach the count where callers can see it, without changing the shape
    // of every record.
    Object.defineProperty(kept, 'hostedDuplicatesDropped', {
      value: dropped, enumerable: false, configurable: true,
    });
  }
  return kept;
}

/** Fresh + cached read = the whole prompt, the number both stores agree on. */
function wholePrompt(r) {
  return (r.input || 0) + (r.cacheRead || 0);
}

/**
 * The dedup key: whole-prompt tokens plus the model's family.
 *
 * The family is the model id with any provider prefix removed, so
 * `new-api:deepseek-v4.1-flash-free` and `deepseek-v4.1-flash-free` are the
 * same model behind two naming conventions — which is exactly how the host
 * and the agent record the same request. Two different models never share a
 * family, so a same-sized prompt from a different model cannot collide.
 *
 * The prefix separator is not fixed: pi writes `new-api:model` (a colon),
 * OpenCode writes `provider/model` (a slash), Cherry Studio writes the bare
 * name. All three spellings have to reduce to the same family, and the
 * families have to be taken from the LAST segment so a colon-separated
 * prefix is stripped the same way a slash-separated one is.
 */
function signature(r) {
  return `${wholePrompt(r)}|${modelFamily(r.model)}`;
}

/** The model id without its provider prefix, lowercased. */
function modelFamily(model) {
  if (!model) return '';
  const s = String(model).toLowerCase();
  // The last separator wins: `new-api:deepseek-v4.1-flash-free` -> the tail
  // after the colon, `opencode/deepseek-v4-flash` -> after the slash. A model
  // id may contain both (`Cherry-New-API/gpt-5.5` has a slash only), and in
  // every observed spelling the provider prefix comes first.
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  return cut === -1 ? s : s.slice(cut + 1);
}

/**
 * Pick a parser for an arbitrary SQLite file by inspecting its tables.
 *
 * Same contract as `sniff`, for the database-shaped sources: a `.sqlite` or
 * `.db` file could be an OpenCode store, a Kilo store, a Cherry Studio store,
 * or something this tool has never seen. The table list is the sniff, and a
 * store this tool cannot read is skipped rather than guessed at — an
 * unrecognised schema parsed with the wrong query yields wrong numbers, which
 * is worse than none.
 */
async function* sniffDb(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return; // Node < 22.5: no sqlite, no database lane
  }
  if (typeof DatabaseSync !== 'function') return;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return;
  }
  let tables = [];
  try {
    tables = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table').map((r) => r.name);
  } catch {
    return; // not a database (or not a readable one)
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  if (tables.includes('ai_usage_record')) {
    yield* ALL_PARSERS['cherry-studio'](file);
    return;
  }
  // Lingma's store: a `chat_message` table carrying a `token_info` column.
  if (tables.includes('chat_message')) {
    yield* ALL_PARSERS.lingma(file);
    return;
  }
  // OpenCode and Kilo both have a `message` table; the file name decides.
  if (tables.includes('message')) {
    if (/kilo\.db$/.test(file)) yield* ALL_PARSERS.kilo(file);
    else yield* ALL_PARSERS.opencode(file);
  }
  // Anything else: unknown schema, no records. Silence, not a wrong number.
}

/** Pick a parser for an arbitrary file by inspecting the first record. */
async function* sniff(file) {
  const head = await readHead(file, 256 * 1024);
  if (head.includes('"session_meta"')) {
    yield* PARSERS.codex(file);
    return;
  }
  if (head.includes('"usageMetadata"') || head.includes('"promptTokenCount"')) {
    yield* PARSERS['gemini-cli'](file);
    return;
  }
  // CodeBuddy CN's extension log is plain text, not JSON: it carries the
  // token buckets in a `notifyStepEnd ... usage: {...}` line. Without this,
  // `--path some-codebuddy.log` read nothing at all — a silent zero, the
  // failure shape this project keeps meeting.
  if (head.includes('notifyStepEnd') && head.includes('"cachedMissTokens"')) {
    yield* ALL_PARSERS.codebuddy(file);
    return;
  }
  // WorkBuddy's session file has a `message.usage` block that looks
  // EXACTLY like Claude Code's, so without this it fell through to the
  // Claude Code parser and produced numbers that were wrong in three ways
  // at once: the whole prompt priced as fresh input (the cached part
  // charged twice), and every timestamp null, because WorkBuddy's
  // `timestamp` is epoch milliseconds rather than an ISO string. A wrong
  // number is worse than no number.
  if (head.includes('"providerData"') && head.includes('"rawUsage"')) {
    yield* ALL_PARSERS.workbuddy(file);
    return;
  }
  yield* PARSERS['claude-code'](file);
}

async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Attach a `cost` object to a usage record. */
export function withCost(rec) {
  return { ...rec, cost: costOf(rec) };
}

/** Sum token + cost totals over records. */
export function totals(records) {
  const t = {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    cost: 0, costInput: 0, costCacheRead: 0, costCacheWrite: 0, costOutput: 0,
    records: records.length,
  };
  for (const r of records) {
    t.input += r.input || 0;
    t.cacheRead += r.cacheRead || 0;
    t.cacheWrite += r.cacheWrite || 0;
    t.output += r.output || 0;
    const c = r.cost ?? costOf(r);
    t.costInput += c.input;
    t.costCacheRead += c.cacheRead;
    t.costCacheWrite += c.cacheWrite;
    t.costOutput += c.output;
    t.cost += c.total;
  }
  return t;
}

/** Group records by an arbitrary key function. */
export function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = String(keyFn(r));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * The calendar day a timestamp falls on, as YYYY-MM-DD.
 *
 * The timezone matters, and getting it wrong is not cosmetic. This tool
 * counted a day two different ways: `by-day` bucketed on the UTC date while
 * `budget` and `statusline` started the day at the machine's LOCAL midnight
 * (`setHours(0,0,0,0)`). For a user 8 hours from UTC that is a day boundary
 * 8 hours out — "today" in one report and "yesterday" in another, over the
 * same ledger. One helper, used by both, is the fix.
 *
 * `timeZone` is an IANA name; undefined means the system's local zone.
 * `en-CA` formats as YYYY-MM-DD, which is the shape the reports expect
 * (and sorts correctly as a string).
 */
export function dayKeyIn(ts, timeZone) {
  if (!ts) return 'unknown';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
  } catch {
    // An unknown IANA name must not take the report down; fall back to the
    // system zone, which is what an unqualified `--timezone` would mean.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
  }
}

/** The start of the current day in the given zone, as epoch milliseconds. */
export function startOfDayIn(now, timeZone) {
  if (!timeZone) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const day = dayKeyIn(now, timeZone);
  // The zone's offset is not fixed across the year (DST), so it cannot be
  // applied as a constant. Compute the offset AT the candidate instant, then
  // verify the result by re-formatting it: an offset that is off by an hour
  // (the DST hour) shows up immediately as a different date, and the loop
  // corrects it. This is the same "guess, then check" approach Intl itself
  // uses, and it degrades to a correct answer rather than a plausible one.
  let guess = Date.parse(`${day}T00:00:00Z`);
  for (let i = 0; i < 4; i++) {
    const offset = zoneOffsetMs(guess, timeZone);
    const candidate = guess - offset;
    if (dayKeyIn(candidate, timeZone) === day && candidate <= now) return candidate;
    // Not there yet: the true midnight is later (a zone ahead of UTC) or the
    // offset landed on the wrong side of a DST boundary. Step by an hour in
    // the direction that can only help, then try again.
    guess = candidate > now ? guess + 3600000 : guess - 3600000;
  }
  return now;
}

/** How far ahead of UTC a zone is at a given instant, in milliseconds. */
function zoneOffsetMs(ts, timeZone) {
  // Format the instant in the zone as if it were UTC, then compare with the
  // instant itself. The difference IS the offset, DST included.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
}
