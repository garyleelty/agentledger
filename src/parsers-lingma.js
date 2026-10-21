/**
 * Lingma (阿里通义灵码) — Alibaba's AI coding IDE.
 *
 * ccusage has no adapter for this product at all, and neither did agentledger
 * until now. The usage lives in TWO stores, and neither one alone is enough:
 *
 *  1. **The cache database** — the usage itself:
 *     `~/Library/Application Support/Lingma/SharedClientCache/cache/db/local.db`
 *     (SQLite, with `-wal`/`-shm` siblings), table `chat_message`. 94 rows on
 *     this machine, 43 of which carry a `token_info` JSON string with the
 *     token buckets. Table `chat_session` carries the project.
 *  2. **The CLI log** — the cache split, where it exists:
 *     `~/Library/Application Support/Lingma/SharedClientCache/cli/logs/lingmacli.log`
 *     Five lines carry `agentMessage.usage`, and that is the ONLY place the
 *     cache read is reported anywhere in the product.
 *
 * ## One record per CALL, not per turn
 *
 * A "request" in Lingma is an agent TURN, and a turn is many model calls:
 * the model asks for a tool, the tool answers, the model asks for the next
 * tool, and so on until it writes its final message. Every one of those
 * calls is a separate API call and a separate bill, and Lingma writes a
 * `chat_message` row for each of them — with the token counts of THAT call.
 *
 * The 43 usage-bearing rows on this machine are 43 model calls spread over
 * 6 turns (1, 4, 13, 11, 9 and 5 calls each). The rows are NOT all
 * `role = 'assistant'`: 5 are assistant, 5 are user and 33 are tool, because
 * the role records the message the call produced, not who called it. A row
 * is a call exactly when it carries a `token_info`; the role is irrelevant
 * to the usage and is not used to filter.
 *
 * The counts are per call, not cumulative: the completion tokens of one
 * turn go 112, 364, 83, 610, 1048, 65, 1032 — a cumulative counter could
 * not fall from 364 to 83. So summing every usage-bearing row is the real
 * billed total of the session: 2,752,050 prompt and 11,724 completion
 * tokens on this machine.
 *
 * ## `prompt_tokens` is the WHOLE prompt
 *
 * `token_info.prompt_tokens` is the whole prompt of that call (the cached
 * prefix plus the fresh part), not the fresh part. Pricing it as fresh
 * input would charge the cached part a second time.
 *
 * ## The cache split, and where it is missing
 *
 * The log's `agentMessage.usage` is the only place the split is reported:
 *
 *     {"input_tokens":24275,"output_tokens":104,
 *      "cache_creation_tokens":0,"cache_read_tokens":0}
 *
 * `input_tokens` there is the whole prompt as well, and `cache_read_tokens`
 * is the part of it that was cached — so the FRESH part is
 * `input_tokens - cache_read_tokens`. That is measurable, not assumed: on
 * the last three records the two numbers are nearly equal and differ by a
 * plausible per-step fresh count (63928-63432 = 496, 71345-71001 = 344,
 * 77534-77223 = 311). If `input_tokens` were the fresh count it would stay
 * roughly constant across an agentic loop instead of growing with the
 * conversation — it does not.
 *
 * The log reports only the LAST call of each turn, so the split is known
 * for 5 of the 43 calls. For the other 38 it is genuinely unknown, and the
 * established precedent in this repo for a store that reports an aggregate
 * without a split is the Cherry Studio parser: the whole prompt is
 * attributed to the fresh `input` bucket. That is what this parser does,
 * and the consequence is stated plainly: **the lane's dollars are an UPPER
 * BOUND.** 2,465,625 of the 2,752,050 prompt tokens come from those 38
 * calls and are priced as fresh input, when most of them were, in all
 * likelihood, cache reads. On this machine the lane prices at $7.77
 * against the $1.04 the same tokens would cost if every unknown split
 * turned out to be entirely cached.
 *
 * ## The join
 *
 * The log's `agentMessage` carries `request_set_id` (a uuid per call), `id`
 * (the message uuid), `session_id`, `provider`, `created_at`/`updated_at`
 * and `role`; the database's `request_id` is a uuid per call. The request id
 * is tried first — `request_set_id == request_id`, disambiguated by the
 * token counts, because one request id covers many calls — and the token
 * pair (`prompt_tokens == input_tokens` AND `completion_tokens ==
 * output_tokens`) within the same session is the fallback. Both work on
 * this machine, and both name exactly one row. The message id is the last
 * resort.
 *
 * ## The model is not recorded
 *
 * `model_info` is an empty string on every one of the 94 rows and
 * `chat_session.preferred_model_info` is empty too: Lingma does not keep
 * the model name next to the usage. The log's `provider` is `"lingma"`,
 * which is the provider, not the model. The model is therefore reported as
 * `'unknown'` — real spend priced at the pricing table's documented
 * fallback is better than real spend that was dropped, and a model name
 * that was invented would be worse than either.
 *
 * ## The clock
 *
 * `chat_message.gmt_create` is epoch milliseconds, and the log's
 * `created_at`/`updated_at` are epoch milliseconds too, so no clock
 * recovery is needed (unlike the CodeBuddy lane, whose log carries a local
 * wall clock).
 *
 * ## A row with no buckets is an event, not spend
 *
 * A `token_info` whose four counters are all zero is a message that cost
 * nothing to produce; it is skipped, like the Cherry Studio and CodeBuddy
 * lanes skip theirs.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const num = (v) => (Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Where the stores live
 * ------------------------------------------------------------------ */

/**
 * The Lingma store paths, rooted at a home directory.
 *
 * @param {string} [home] defaults to the current user's home
 * @returns {{root: string, db: string, log: string}}
 */
export function lingmaPaths(home = os.homedir()) {
  const root = path.join(home, 'Library', 'Application Support', 'Lingma', 'SharedClientCache');
  return {
    root,
    db: path.join(root, 'cache', 'db', 'local.db'),
    log: path.join(root, 'cli', 'logs', 'lingmacli.log'),
  };
}

/**
 * Matcher for the cache database.
 *
 * The `-wal` and `-shm` sidecars are the same data as the database and must
 * not be read a second time, so the pattern is anchored on the end of the
 * name.
 *
 * @param {string} rel a path relative to the source root
 * @returns {boolean}
 */
export const LINGMA_DB_MATCH = (rel) => /(^|\/)local\.db$/.test(rel);

/**
 * Matcher for the CLI log, the store that carries the cache split.
 *
 * @param {string} rel a path relative to the source root
 * @returns {boolean}
 */
export const LINGMA_LOG_MATCH = (rel) => /(^|\/)lingmacli\.log$/.test(rel);

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/**
 * Parse the Lingma cache database into usage records.
 *
 * The file handed in is the database — the store that holds the usage. The
 * log is found next to it (both live under the same `SharedClientCache`
 * root) and is read for the cache split only; it never produces a record of
 * its own, because the five calls it describes are already in the database.
 *
 * Register the source on the DATABASE only (see `LINGMA_DB_MATCH`): the
 * parser derives the log path itself, and pointing the matcher at both
 * stores would read the same calls twice.
 *
 * @param {string} file path to `local.db` (or to the log, whose database is
 *   found next to it)
 * @param {object} [opts]
 * @param {string} [opts.home] home directory to read the stores from
 * @param {string} [opts.db] override for the database path
 * @param {string} [opts.log] override for the log path
 * @param {object} [opts.stats] optional object the parser fills with the
 *   join counts and the record count (diagnostics; the ledger ignores it)
 * @returns {AsyncGenerator<object>} normalized usage records
 */
export async function* parseLingma(file, opts = {}) {
  const paths = lingmaPaths(opts.home);
  const dbPath = opts.db || resolveDb(file, paths);
  const logPath = opts.log || resolveLog(file, paths);

  const store = await readStore(dbPath);
  if (!store) return; // no database, no records — never a crash

  const splits = await readLogSplits(logPath);
  const joins = { request: 0, 'token-pair': 0, 'message-id': 0, none: 0 };
  let emitted = 0;
  // The stats object is live: it is filled in as the records are produced,
  // so a consumer that stops early still sees the joins it has.
  const stats = opts.stats && typeof opts.stats === 'object' ? opts.stats : null;
  if (stats) {
    stats.joins = joins;
    stats.records = 0;
  }

  for (const row of store.rows) {
    const info = parseTokenInfo(row.token_info);
    if (!info) continue; // malformed token_info — skipped, never fatal
    const prompt = num(info.prompt_tokens);
    const completion = num(info.completion_tokens);

    const hit = lookupSplit(row, prompt, completion, splits);
    joins[hit.how]++;
    const cacheRead = hit.split ? num(hit.split.cacheRead) : 0;
    const cacheWrite = hit.split ? num(hit.split.cacheWrite) : 0;
    // The whole prompt, minus the part that was cached. When the split is
    // unknown the whole prompt is fresh — the Cherry Studio precedent, and
    // the reason this lane's dollars are an upper bound.
    const input = hit.split ? Math.max(0, prompt - cacheRead) : prompt;
    const output = completion;
    // A row whose buckets are all zero is an event, not spend.
    if (input + cacheRead + cacheWrite + output === 0) continue;

    emitted++;
    if (stats) stats.records = emitted;
    yield {
      agent: 'lingma',
      // Lingma does not record the model next to the usage. The record is
      // kept and priced at the table's documented fallback; the model is
      // never invented.
      model: 'unknown',
      session: typeof row.session_id === 'string' && row.session_id ? row.session_id : 'lingma',
      timestamp: num(row.gmt_create) || null,
      input,
      cacheRead,
      cacheWrite,
      output,
      project: store.sessions.get(row.session_id) ?? null,
      // Lingma records no branch.
      branch: null,
    };
  }
}

/**
 * Parse the `token_info` column.
 *
 * @param {unknown} raw the column value
 * @returns {object|null} the parsed object, or null when it is unusable
 */
function parseTokenInfo(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON — the row is skipped, not fatal
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Find the cache split for one database row.
 *
 * The request id is tried first — `request_set_id == request_id` — but only
 * together with the token counts, because one request id covers every call
 * of a turn and the split belongs to ONE of them. The token pair within the
 * same session is the fallback, and the message id the last resort.
 *
 * @param {object} row a `chat_message` row
 * @param {number} prompt the row's whole-prompt token count
 * @param {number} completion the row's completion token count
 * @param {object} splits the log's split index
 * @returns {{split: object|null, how: string}}
 */
function lookupSplit(row, prompt, completion, splits) {
  if (row.request_id) {
    const hit = splits.byRequestToken.get(pairKey(row.request_id, prompt, completion));
    if (hit) return { split: hit, how: 'request' };
  }
  if (row.session_id) {
    const hit = splits.bySessionToken.get(pairKey(row.session_id, prompt, completion));
    if (hit) return { split: hit, how: 'token-pair' };
  }
  if (row.id) {
    const hit = splits.byMessageId.get(row.id);
    if (hit) return { split: hit, how: 'message-id' };
  }
  return { split: null, how: 'none' };
}

/** The join key: an id, the whole prompt and the completion count. */
const pairKey = (id, prompt, completion) => `${id}\u0000${prompt}\u0000${completion}`;

/* ------------------------------------------------------------------ *
 * The store paths
 * ------------------------------------------------------------------ */

/**
 * The `SharedClientCache` root a file lives under, if any.
 *
 * @param {string} file
 * @returns {string|null}
 */
function sharedRoot(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === 'SharedClientCache') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The database to read, given the file the source matcher handed over. */
function resolveDb(file, paths) {
  if (file && path.basename(file) === 'local.db') return file;
  const root = sharedRoot(file);
  if (root) return path.join(root, 'cache', 'db', 'local.db');
  return paths.db;
}

/** The log to read, given the file the source matcher handed over. */
function resolveLog(file, paths) {
  if (file && path.basename(file) === 'lingmacli.log') return file;
  const root = sharedRoot(file);
  if (root) return path.join(root, 'cli', 'logs', 'lingmacli.log');
  return paths.log;
}

/* ------------------------------------------------------------------ *
 * The database
 * ------------------------------------------------------------------ */

/**
 * Read the usage rows and the session table.
 *
 * Read-only, and closed again — the tool never takes a write lock on a file
 * a running IDE holds open. A missing database, a foreign database, a
 * locked one or a Node too old for `node:sqlite` each degrade to "no
 * records" instead of throwing.
 *
 * @param {string} dbPath
 * @returns {Promise<{rows: Array<object>, sessions: Map<string, string|null>}|null>}
 */
async function readStore(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null; // Node < 22.5 — the lane degrades to zero like any other store
  }
  if (typeof DatabaseSync !== 'function') return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      // `readOnly` is also 22.5+. A plain open keeps the lane working on the
      // older builds; only SELECTs are ever issued.
      db = new DatabaseSync(dbPath);
    } catch {
      return null; // locked, foreign, or not SQLite — skip, never throw
    }
  }

  const rows = [];
  const sessions = new Map();
  try {
    // The project of a session. A missing table is not fatal: the records
    // still carry their usage, only the project is lost.
    for (const s of db.prepare('SELECT session_id, project_uri FROM chat_session').all()) {
      if (!s || typeof s.session_id !== 'string' || !s.session_id) continue;
      sessions.set(
        s.session_id,
        typeof s.project_uri === 'string' && s.project_uri ? s.project_uri : null,
      );
    }
  } catch {
    // No session table — the project degrades to null.
  }
  try {
    // The usage rows. An empty `token_info` means "this message cost
    // nothing to produce"; the row is not a model call.
    for (const r of db.prepare(
      `SELECT id, session_id, request_id, role, token_info, gmt_create
         FROM chat_message
        WHERE token_info IS NOT NULL AND token_info != ''`,
    ).all()) {
      rows.push(r);
    }
  } catch {
    // No message table — the lane has no records.
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  return { rows, sessions };
}

/* ------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------ */

/**
 * Read the CLI log and index the cache splits it reports.
 *
 * The file is streamed a line at a time — it is 256 KB on this machine and
 * one of its lines is 158 KB long — and a line that does not parse is
 * skipped, not fatal.
 *
 * @param {string} logPath
 * @returns {Promise<{byRequestToken: Map<string, object>, bySessionToken: Map<string, object>, byMessageId: Map<string, object>}>}
 */
async function readLogSplits(logPath) {
  const splits = {
    byRequestToken: new Map(),
    bySessionToken: new Map(),
    byMessageId: new Map(),
  };
  let rl;
  try {
    rl = createInterface({
      input: createReadStream(logPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return splits; // unreadable file — no splits, never a crash
  }
  try {
    for await (const line of rl) {
      const rec = parseLogLine(line);
      if (!rec) continue;
      if (rec.requestSetId) {
        splits.byRequestToken.set(pairKey(rec.requestSetId, rec.input, rec.output), rec);
      }
      if (rec.sessionId) {
        splits.bySessionToken.set(pairKey(rec.sessionId, rec.input, rec.output), rec);
      }
      if (rec.messageId) splits.byMessageId.set(rec.messageId, rec);
    }
  } catch {
    // A torn tail or an unreadable file: keep the splits already read.
  }
  return splits;
}

/**
 * Parse one log line into the usage it carries.
 *
 * A line is a tab-separated header followed by a JSON payload. The payload
 * is the field after the third tab on this machine (the header is
 * timestamp, level, source and a label), so the parser anchors on field
 * index 3 and takes the first `{` from there: a layout that puts the
 * payload one field earlier works just as well.
 *
 * @param {string} line
 * @returns {object|null}
 */
function parseLogLine(line) {
  if (!line || !line.includes('{')) return null;
  const payload = extractJsonObject(line);
  if (!payload || typeof payload !== 'object') return null;
  const am = payload.agentMessage;
  if (!am || typeof am !== 'object') return null;
  const usage = am.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    messageId: typeof am.id === 'string' ? am.id : null,
    requestSetId: typeof am.request_set_id === 'string' ? am.request_set_id : null,
    sessionId: typeof am.session_id === 'string' ? am.session_id : null,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_tokens),
    cacheWrite: num(usage.cache_creation_tokens),
  };
}

/**
 * Read the JSON object that starts at the first `{` of the payload field.
 *
 * The scanner is string-aware: the payload carries the model's answer, and
 * an answer can contain braces, so a plain brace count would stop inside a
 * string. Trailing content after the object is ignored.
 *
 * @param {string} line
 * @returns {object|null}
 */
function extractJsonObject(line) {
  const start = line.indexOf('{', payloadStart(line));
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
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

/** The offset of the payload field: just after the third tab. */
function payloadStart(line) {
  let idx = -1;
  for (let i = 0; i < 3; i++) {
    idx = line.indexOf('\t', idx + 1);
    if (idx === -1) return 0; // fewer than three tabs — scan the whole line
  }
  return idx + 1;
}

/**
 * The parser map, in the shape `ledger.js` merges into `PARSERS`.
 * Mirrors the Cherry Studio and CodeBuddy lanes' maps.
 */
export const PARSERS_LINGMA = { lingma: parseLingma };

export default parseLingma;
