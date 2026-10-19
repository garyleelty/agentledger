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
import { costOf } from './pricing.js';

// The CherryStudio lane lives in its own module because it is the only
// parser that needs a documented dedup relationship with another source;
// merging it here keeps that coupling visible instead of buried.
const ALL_PARSERS = { ...PARSERS, ...PARSERS_CHERRY };

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

  for (const source of sources) {
    const root = expandHome(source.root);
    let files = [];
    const stat = await fsp.stat(root).catch(() => null);
    if (stat?.isFile()) files = [root];
    else if (stat?.isDirectory()) files = (await walk(root)).filter((f) => source.match(path.relative(root, f)));

    for (const file of files) {
      filesScanned++;
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
      if (!/\.(jsonl|json)$/.test(file)) continue;
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
 * The signature is the whole-prompt token total — fresh input plus cache
 * read — and NOTHING else. That is the one number both stores agree on even
 * when they bucket differently: pi reports input as fresh-only plus a
 * separate cacheRead, while CherryStudio reports input as the whole prompt
 * already, and their output fields differ too (pi folds reasoning into
 * output, the host keeps it separate, so 158 vs 204 for the same request).
 * Matching on output as well silently misses every row that had reasoning.
 *
 * 17:22:53 is the counter-example that proves the input-only signature is
 * still safe: pi 567 / 12032 against the host's 6364 / 6272 are the same
 * shape of request counted two ways, with different whole-prompt totals
 * (12,599 vs 6,364), so they are correctly NOT matched.
 *
 * This is deliberately NOT a general "drop anything that looks similar":
 * only `cherry-studio` records carry `hostedBy`, and only those are
 * candidates for removal. Everything else passes through untouched.
 */
function dropHostedDuplicates(records) {
  // Whole-prompt totals from every non-host record, keyed by the signature.
  const owned = new Map();
  for (const r of records) {
    if (r.agent === 'cherry-studio') continue;
    if (typeof r.timestamp !== 'number') continue;
    const k = wholePrompt(r);
    if (!owned.has(k)) owned.set(k, []);
    owned.get(k).push(r.timestamp);
  }
  if (owned.size === 0) return records;

  const kept = [];
  let dropped = 0;
  for (const r of records) {
    if (r.agent === 'cherry-studio' && typeof r.timestamp === 'number') {
      const candidates = owned.get(wholePrompt(r));
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
