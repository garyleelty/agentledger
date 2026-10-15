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
import { costOf } from './pricing.js';

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
    parser: PARSERS.codex,
    docs: 'https://github.com/openai/codex',
  },
  {
    agent: 'opencode',
    root: '~/.local/share/opencode',
    match: (rel) => /(^|\/)opencode\.db$/.test(rel),
    parser: PARSERS.opencode,
    docs: 'https://opencode.ai/docs',
  },
  {
    // Kilo is an OpenCode fork; same SQLite store shape, different directory
    // and file name. Verified against a live ~/.local/share/kilo/kilo.db.
    agent: 'kilo',
    root: '~/.local/share/kilo',
    match: (rel) => /(^|\/)kilo\.db$/.test(rel),
    parser: PARSERS.kilo,
    docs: 'https://kilo.ai',
  },
  {
    agent: 'gemini-cli',
    root: '~/.gemini/tmp',
    match: (rel) => /(^|\/)logs\.json$/.test(rel),
    parser: PARSERS['gemini-cli'],
    docs: 'https://github.com/google-gemini/gemini-cli',
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
      if (!/\.(jsonl|json)$/.test(file)) continue;
      filesScanned++;
      try {
        for await (const rec of sniff(file)) records.push(rec);
      } catch (err) {
        skipped.push(`${file}: ${err.message}`);
      }
    }
  }

  return { records, filesScanned, skipped };
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
