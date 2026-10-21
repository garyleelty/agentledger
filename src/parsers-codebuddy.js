/**
 * CodeBuddy CN (腾讯云代码助手) — Tencent Cloud's AI coding IDE / plugin.
 *
 * The usage of this agent is spread across FOUR stores, and no single one of
 * them is enough:
 *
 *  1. **The extension log** — the record of WHAT was spent:
 *     `~/Library/Application Support/CodeBuddy CN/logs/`, and under it every
 *     `腾讯云代码助手*.log` (the extension's own log plus its `.1.log` /
 *     `.2.log` / `.3.log` rotations).
 *     One `notifyStepEnd` line per API call, carrying the token buckets.
 *  2. **The history index** — the request list and the wall clock:
 *     `~/Library/Application Support/CodeBuddyExtension/Data/` and, under it,
 *     `CodeBuddyIDE/<userId>/history/<workspaceId>/<conversationId>/index.json`.
 *     `requests[].id` is the SAME id as the log's `requestId` (the join key)
 *     and `requests[].startedAt` is epoch milliseconds.
 *  3. **The message files** — the model:
 *     `<conversationId>/messages/<messageId>.json`, whose `extra` field is a
 *     JSON **string** (it has to be parsed a second time) shaped
 *     `{ requestId, modelId, modelName, traceId, responseId }`.
 *  4. **The sessions database** — the working directory:
 *     `~/Library/Application Support/CodeBuddy CN/codebuddy-sessions.vscdb`
 *     (SQLite, one table `ItemTable(key TEXT, value BLOB)`, key
 *     `session:<conversationId>`, value a JSON string with a `cwd`).
 *
 * ## The buckets
 *
 * `usage.inputTokens` is the WHOLE prompt, not the fresh part:
 * `inputTokens === cacheTokens + cachedMissTokens` holds on every one of the
 * 362 steps on this machine. So the buckets map as
 *
 *     fresh input = cachedMissTokens
 *     cache read  = cacheTokens
 *     cache write = cachedWriteTokens
 *     output      = outputTokens
 *
 * and `inputTokens` itself is NEVER used as the fresh input — pricing it that
 * way would charge the cached part a second time. `totalTokens` is
 * `inputTokens + outputTokens` (verified on all 362) and `lastTokens` is a
 * separate concept that is ignored.
 *
 * `credit` is a QUOTA unit, not money: it does not scale with the token
 * counts and it does not scale with the USD list price (measured: the
 * credit-per-token ratio for one model ranged over 4x..126x). It is
 * therefore neither priced nor carried as `storedCost` — putting it in
 * `storedCost` would report a number in dollars that is not dollars.
 *
 * ## One record per STEP, not per request
 *
 * A request is a multi-step agent loop: the prompt grows step by step and a
 * sub-agent request starts over with a small prompt. Verified on request
 * `367d58f4`: input 30530 -> 43118 -> 49273 -> 53929 -> 57756, then a fresh
 * 2276 for a sub-request. Every step is a separate API call and a separate
 * bill, so every step is a separate record.
 *
 * ## The timestamps are LOCAL, and the offset is recovered
 *
 * The log line prefix is the machine's LOCAL time (`YYYY-MM-DD HH:MM:SS.mmm`),
 * not UTC. The history index gives `startedAt` in epoch ms for the same
 * request, which is what turns the wall clock back into an instant:
 *
 *     candidate = round_to_hour(startedAt - logTimestamp_read_as_UTC)
 *     timestamp = logTimestamp_read_as_UTC + candidate
 *
 * On this machine (Asia/Shanghai) the candidate is -8h for every file: read
 * as UTC the log sits 8h ahead of the truth, and read as local the median
 * gap between a log line and its request's `startedAt` is 14.1 seconds —
 * the time an API call takes to finish its first step. That 14s-vs-8h gap
 * is the proof that the log is local.
 *
 * The candidate is the MEDIAN over the file, not the mean and not the first
 * value, so that one odd request cannot move the whole file: on this machine
 * one request's step is 4.5 hours away from its `startedAt` (a request that
 * was resumed much later), and the median shrugs it off while a mean would
 * not. The lower median is used so the result is always one of the observed
 * whole-hour candidates and never a half hour.
 *
 * When a log file has no request that can be joined to the history index,
 * the offset cannot be recovered and the system's own local zone is used
 * instead (see `localWallToInstant`).
 *
 * The alternative — using the request's `startedAt` for every step of that
 * request — needs no offset recovery at all, but it collapses the steps of
 * a request onto a single instant, and a daily report buckets by the real
 * time of each step. The offset is recovered instead.
 *
 * The agent type in the log (`[BaseAgent:craft]`, `[BaseAgent:plan]`,
 * `[BaseAgent:ask]`, `[BaseAgent:summary]`, `[BaseAgent:web-fetch]`,
 * `[BaseAgent:code-explorer]`) is parsed but not emitted: every parser in
 * this repo emits the same fixed field set, and the agent here is always
 * `codebuddy`.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const HOUR = 3_600_000;

const num = (v) => (Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Where the stores live
 * ------------------------------------------------------------------ */

/**
 * The four CodeBuddy CN store paths, rooted at a home directory.
 *
 * @param {string} [home] defaults to the current user's home
 * @returns {{logsDir: string, dataDir: string, sessionsDb: string}}
 */
export function codebuddyPaths(home = os.homedir()) {
  const app = path.join(home, 'Library', 'Application Support');
  return {
    logsDir: path.join(app, 'CodeBuddy CN', 'logs'),
    dataDir: path.join(app, 'CodeBuddyExtension', 'Data'),
    sessionsDb: path.join(app, 'CodeBuddy CN', 'codebuddy-sessions.vscdb'),
  };
}

/**
 * Matcher for the extension's own log file.
 *
 * The file name is Chinese (`腾讯云代码助手.log`, with `.1.log` / `.2.log`
 * / `.3.log` rotations next to it), so the second branch matches on the
 * ASCII extension directory instead: the file name is then never parsed as
 * text, only its parent directory is, which keeps the matcher working no
 * matter how the file name is encoded on disk.
 *
 * @param {string} rel a path relative to the source root
 * @returns {boolean}
 */
export const CODEBUDDY_LOG_MATCH = (rel) =>
  /腾讯云代码助手(?:\.\d+)?\.log$/.test(rel) ||
  /(?:^|\/)Tencent-Cloud\.coding-copilot\/[^/]+\.log$/.test(rel);

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/**
 * Parse one CodeBuddy CN extension log file.
 *
 * The log file carries the token buckets; the history index, the message
 * files and the sessions database carry the model, the clock and the
 * project. Those three are loaded once per home directory and shared by
 * every log file, so a run over 37 log files reads the history tree once.
 *
 * @param {string} file path to a `腾讯云代码助手*.log` file
 * @param {object} [opts]
 * @param {string} [opts.home] home directory to read the stores from
 * @param {string} [opts.logsDir] override for the log root
 * @param {string} [opts.dataDir] override for the history root
 * @param {string} [opts.sessionsDb] override for the sessions database
 * @returns {AsyncGenerator<object>} normalized usage records
 */
export async function* parseCodeBuddy(file, opts = {}) {
  const steps = await readSteps(file);
  if (!steps.length) return;
  const stores = await getStores(opts);
  const offset = recoverOffset(steps, stores.requests);
  for (const s of steps) {
    const req = stores.requests.get(s.requestId);
    const input = freshInput(s.usage);
    const cacheRead = num(s.usage.cacheTokens);
    const cacheWrite = num(s.usage.cachedWriteTokens);
    const output = num(s.usage.outputTokens);
    // A step whose buckets are all zero is an event, not spend.
    if (input + cacheRead + cacheWrite + output === 0) continue;
    yield {
      agent: 'codebuddy',
      // A request whose model cannot be resolved is real spend, so the
      // record is kept and priced at the table's documented fallback. The
      // model is never invented.
      model: req?.model || 'unknown',
      // The conversation id, when the history index knows it. When it does
      // not (the request outlived the history rotation) the request id is
      // used instead, so the steps of one request still group together.
      session: req?.conversationId || s.requestId,
      // The recovered local offset, or the system's own zone when the
      // offset could not be recovered from this file.
      timestamp: offset === null ? localWallToInstant(s.wall) : s.wall + offset,
      input,
      cacheRead,
      cacheWrite,
      output,
      // The working directory of the conversation, when the sessions
      // database still holds it.
      project: req ? (stores.cwds.get(req.conversationId) ?? null) : null,
      // CodeBuddy does not record a branch.
      branch: null,
    };
  }
}

/** The fresh part of the prompt: `cachedMissTokens`, never the whole prompt. */
function freshInput(usage) {
  if (Number.isFinite(usage.cachedMissTokens)) return usage.cachedMissTokens;
  // Older builds did not always split the prompt; fall back to the whole
  // prompt minus the cached part, which is the same identity the split
  // obeys (`inputTokens === cacheTokens + cachedMissTokens`).
  return Math.max(0, num(usage.inputTokens) - num(usage.cacheTokens));
}

/* ------------------------------------------------------------------ *
 * The log file
 * ------------------------------------------------------------------ */

/**
 * A usage line. The `notifyStepEnd` marker is what distinguishes a step
 * from the other lines that repeat the same usage (the `AgentReporter`
 * summary repeats the final step's buckets for the whole request — reading
 * those too would double-count every request).
 */
const STEP_RE = new RegExp(
  '^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})' + // local timestamp
  '\\s+\\[[^\\]]*\\]' + // level
  '\\s+\\[BaseAgent:([^\\]]+)\\]' + // agent type
  '\\s+\\[[^\\]]*\\]' + // trace id
  '\\s+notifyStepEnd,\\s*step:\\s*(\\d+),' +
  '\\s*requestId:\\s*([0-9A-Za-z_-]+),' +
  '\\s*messageId:\\s*([0-9A-Za-z_-]+),' +
  '\\s*usage:\\s*',
);

/**
 * Read a log file and return its usage steps.
 *
 * The file is streamed a line at a time — the largest one on this machine is
 * 5.2 MB and the set is ~120 MB — and a line that does not parse is
 * skipped, not fatal: the IDE is killed mid-write often enough that the
 * last line of a log is regularly truncated.
 *
 * @param {string} file
 * @returns {Promise<Array<object>>}
 */
async function readSteps(file) {
  const steps = [];
  let rl;
  try {
    rl = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return steps; // unreadable file — no records, never a crash
  }
  try {
    for await (const line of rl) {
      if (!line.includes('notifyStepEnd')) continue;
      const step = parseStepLine(line);
      if (step) steps.push(step);
    }
  } catch {
    // A torn tail or an unreadable file: keep the steps already read.
  }
  return steps;
}

/** Parse one `notifyStepEnd` line into a step. */
function parseStepLine(line) {
  const m = STEP_RE.exec(line);
  if (!m) return null;
  const usage = extractJsonObject(line, m.index + m[0].length);
  if (!usage || typeof usage !== 'object') return null;
  // The prefix is a LOCAL wall clock. It is read as if it were UTC here;
  // the offset that turns it back into an instant is recovered later.
  const wall = Date.parse(`${m[1].replace(' ', 'T')}Z`);
  if (!Number.isFinite(wall)) return null;
  return {
    wall,
    agent: m[2],
    step: Number(m[3]),
    requestId: m[4],
    messageId: m[5],
    usage,
  };
}

/** Read the JSON object that starts at/after `from` in `line`. */
function extractJsonObject(line, from) {
  const start = line.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(line.slice(start, i + 1));
        } catch {
          return null; // malformed — the line is skipped, not fatal
        }
      }
    }
  }
  return null; // truncated object
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

/**
 * Recover the file's UTC correction from the joined requests.
 *
 * Each joinable step gives one candidate: how far the request's
 * `startedAt` sits from the log timestamp read as if it were UTC, rounded
 * to the nearest hour. The lower MEDIAN of those candidates is the file's
 * offset — a median because one odd request must not move the whole file,
 * and the lower median because the candidates are whole hours and the
 * result should stay one of them rather than land between two.
 *
 * @param {Array<object>} steps
 * @param {Map<string, object>} requests
 * @returns {number|null} the correction in ms, or null when unrecoverable
 */
function recoverOffset(steps, requests) {
  const candidates = [];
  for (const s of steps) {
    const req = requests.get(s.requestId);
    if (!req || !Number.isFinite(req.startedAt)) continue;
    candidates.push(Math.round((req.startedAt - s.wall) / HOUR) * HOUR);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor((candidates.length - 1) / 2)];
}

/**
 * The fallback for a log file with nothing to join: read the wall clock in
 * the system's own local zone.
 *
 * The offset is looked up at the instant itself, so a file that straddles a
 * daylight-saving change is still read correctly. `getTimezoneOffset`
 * returns the minutes to ADD to the local reading to get UTC, so the zone
 * offset is its negation.
 *
 * @param {number} wall the wall clock read as if it were UTC
 * @returns {number} the instant in epoch ms
 */
function localWallToInstant(wall) {
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const zoneOffset = -new Date(instant).getTimezoneOffset() * 60_000;
    instant = wall - zoneOffset;
  }
  return instant;
}

/* ------------------------------------------------------------------ *
 * The other three stores
 * ------------------------------------------------------------------ */

/** Directories that are never part of the history tree. */
const SKIP_DIRS = new Set([
  'messages', 'plan-task', 'connectors', 'Cache', 'CachedData',
  'node_modules', 'logs', 'User', 'UserData',
]);

/**
 * The store index, cached per home directory.
 *
 * @type {Map<string, Promise<{requests: Map<string, object>, cwds: Map<string, string|null>}>>}
 */
const storeCache = new Map();

/** Drop the cached store index (used by the tests). */
export function clearCodeBuddyCache() {
  storeCache.clear();
}

function getStores(opts) {
  const home = opts.home || os.homedir();
  const paths = {
    ...codebuddyPaths(home),
    ...(opts.logsDir ? { logsDir: opts.logsDir } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.sessionsDb ? { sessionsDb: opts.sessionsDb } : {}),
  };
  const key = [home, paths.dataDir, paths.sessionsDb].join('\u0000');
  let pending = storeCache.get(key);
  if (!pending) {
    pending = loadStores(paths);
    storeCache.set(key, pending);
  }
  return pending;
}

async function loadStores(paths) {
  const [requests, cwds] = await Promise.all([
    loadHistory(paths.dataDir),
    loadSessionCwds(paths.sessionsDb),
  ]);
  return { requests, cwds };
}

/**
 * The history index and the message files.
 *
 * `requests` maps a request id to `{ conversationId, startedAt, model }`.
 * The model comes from the message files: their `extra` field is a JSON
 * STRING that has to be parsed a second time, and its `requestId` is the
 * join key back to the request.
 *
 * @param {string} dataDir the `CodeBuddyExtension/Data` root
 * @returns {Promise<Map<string, object>>}
 */
async function loadHistory(dataDir) {
  const requests = new Map();
  for (const root of await findHistoryRoots(dataDir, 0, [])) {
    for (const workspace of await readDirSafe(root)) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = path.join(root, workspace.name);
      for (const conversation of await readDirSafe(workspaceDir)) {
        if (!conversation.isDirectory()) continue;
        const convDir = path.join(workspaceDir, conversation.name);
        await loadConversation(convDir, conversation.name, requests);
      }
    }
  }
  return requests;
}

/** Read one conversation's index and message files into `requests`. */
async function loadConversation(convDir, conversationId, requests) {
  const index = await readJsonSafe(path.join(convDir, 'index.json'));
  const list = Array.isArray(index?.requests) ? index.requests : [];
  for (const r of list) {
    if (!r || typeof r.id !== 'string') continue;
    const startedAt = num(r.startedAt);
    requests.set(r.id, {
      conversationId,
      startedAt: startedAt > 0 ? startedAt : null,
      model: null,
    });
  }
  // The model is not in the index: it is in the message files, whose `extra`
  // field is a JSON string.
  const messagesDir = path.join(convDir, 'messages');
  for (const file of await readDirSafe(messagesDir)) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const message = await readJsonSafe(path.join(messagesDir, file.name));
    const extra = parseExtra(message?.extra);
    if (!extra || typeof extra.requestId !== 'string') continue;
    const model = typeof extra.modelId === 'string' ? extra.modelId : null;
    const known = requests.get(extra.requestId);
    if (known) {
      // A request can carry several messages; the first model wins.
      if (!known.model && model) known.model = model;
    } else if (model) {
      // A message whose request is not in the index (the index was rotated
      // but the messages were not) still names the model and the
      // conversation, so the request is kept rather than lost.
      requests.set(extra.requestId, { conversationId, startedAt: null, model });
    }
  }
}

/** `extra` is a JSON string on disk, but an object is tolerated. */
function parseExtra(extra) {
  if (extra && typeof extra === 'object') return extra;
  if (typeof extra !== 'string') return null;
  try {
    const parsed = JSON.parse(extra);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Find every `history` directory under the extension's data root. */
async function findHistoryRoots(dir, depth, out) {
  if (depth > 6) return out;
  for (const entry of await readDirSafe(dir)) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'history') out.push(full);
    else await findHistoryRoots(full, depth + 1, out);
  }
  return out;
}

/**
 * The sessions database: `session:<conversationId>` -> the conversation's
 * working directory.
 *
 * Read-only, and closed again — the tool never takes a write lock on a file
 * a running IDE holds open. A missing database, a foreign database or a
 * Node too old for `node:sqlite` each degrade to "no project".
 *
 * @param {string} dbPath
 * @returns {Promise<Map<string, string|null>>}
 */
async function loadSessionCwds(dbPath) {
  const cwds = new Map();
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return cwds; // Node < 22.5 — the project degrades, the usage does not
  }
  if (typeof DatabaseSync !== 'function') return cwds;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      // `readOnly` is also 22.5+. A plain open keeps the lane working on
      // the older builds; only SELECTs are ever issued.
      db = new DatabaseSync(dbPath);
    } catch {
      return cwds; // locked, foreign, or not SQLite — skip, never throw
    }
  }
  try {
    const rows = db.prepare('SELECT key, value FROM ItemTable').all();
    for (const row of rows) {
      const key = decodeText(row.key);
      if (!key || !key.startsWith('session:')) continue;
      const value = decodeText(row.value);
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed.conversationId !== 'string') continue;
      cwds.set(
        parsed.conversationId,
        typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : null,
      );
    }
  } catch {
    // Not a CodeBuddy sessions database — the project degrades to null.
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  return cwds;
}

/** SQLite values come back as a string or as bytes, depending on the column. */
function decodeText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

async function readDirSafe(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The parser map, in the shape `ledger.js` merges into `PARSERS`.
 * Mirrors the CherryStudio lane's `PARSERS_CHERRY`.
 */
export const PARSERS_CODEBUDDY = { codebuddy: parseCodeBuddy };

export default parseCodeBuddy;
