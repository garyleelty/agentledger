/**
 * Source parsers.
 *
 * Every parser takes a path to a session log file and returns zero or more
 * normalized usage records:
 *
 *   { agent, model, session, timestamp, input, cacheRead, cacheWrite, output }
 *
 * Tokens are raw counts. Cost is computed later by pricing.js so that the
 * user can override prices without re-parsing.
 *
 * Design rules:
 *  - Never throw on a malformed line; skip it. Logs are huge and partially
 *    written files are common (a crashed agent leaves a truncated tail).
 *  - Never write anything. These are read-only parsers.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const num = (v) => (Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Claude Code: ~/.claude/projects/  (one .jsonl file per session)
 * Each assistant message carries a `message.usage` block.
 * ------------------------------------------------------------------ */
export async function* parseClaudeCode(file) {
  let session = path.basename(file, '.jsonl');
  let project = null;
  let branch = null;
  for await (const rec of jsonl(file)) {
    // Attribution is carried on the first record that has it; later turns keep
    // the same working directory but do not repeat these fields.
    if (!project && rec.cwd) project = rec.cwd;
    if (!branch && rec.gitBranch) branch = rec.gitBranch;
    const msg = rec.message;
    if (!msg || typeof msg !== 'object') continue;
    const usage = msg.usage;
    if (!usage) continue;
    // Anthropic bills cache writes by TTL: 5-minute writes at 1.25x input,
    // 1-hour writes at 2x. `cache_creation_input_tokens` is the lumped
    // total; the nested `cache_creation` block splits it when present. Carry
    // the split so pricing.js can bill the two TTLs apart — the lumped
    // multiplier (1.25) silently undercharges every 1-hour write.
    const r = {
      agent: 'claude-code',
      model: msg.model || 'unknown',
      session,
      timestamp: rec.timestamp ? Date.parse(rec.timestamp) : null,
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
      project,
      branch,
    };
    const split = usage.cache_creation;
    if (split && typeof split === 'object') {
      const w1h = num(split.ephemeral_1h_input_tokens);
      const w5m = num(split.ephemeral_5m_input_tokens);
      if (w1h || w5m) {
        r.cacheWrite1h = w1h;
        r.cacheWrite5m = w5m;
      }
    }
    yield r;
  }
}

/* ------------------------------------------------------------------ *
 * Codex CLI: ~/.codex/sessions/ (rollout-*.jsonl files)
 * Cumulative `token_count` events carrying `total_token_usage`; we emit the
 * delta between consecutive events so the records can be summed directly.
 * ------------------------------------------------------------------ */export async function* parseCodex(file) {
  const state = { session: null, prev: null, model: null, project: null, branch: null };
  for await (const rec of jsonl(file)) {
    if (rec.type === 'session_meta' && rec.payload) {
      if (rec.payload.id) state.session = rec.payload.id;
      // Attribution: where the session ran and which branch it was on.
      if (rec.payload.cwd) state.project = rec.payload.cwd;
      const git = rec.payload.git;
      if (git && typeof git === 'object') {
        if (git.branch) state.branch = git.branch;
        if (!state.project && git.repository_url) state.project = git.repository_url;
      }
    }
    if (rec.type === 'turn_context' && rec.payload && rec.payload.model) {
      state.model = rec.payload.model;
    }
    if (rec.type !== 'event_msg') continue;
    const payload = rec.payload || {};
    if (payload.type !== 'token_count') continue;
    const info = payload.info || {};
    if (info.model) state.model = info.model;
    const total = info.total_token_usage;
    if (!total) continue;
    const cum = {
      input: Math.max(0, num(total.input_tokens) - num(total.cached_input_tokens)),
      cacheRead: num(total.cached_input_tokens),
      cacheWrite: 0,
      output: num(total.output_tokens) + num(total.reasoning_output_tokens),
    };
    if (state.prev) {
      yield {
        agent: 'codex',
        model: state.model || 'unknown',
        session: state.session || path.basename(file),
        timestamp: Date.parse(rec.timestamp || '') || null,
        input: Math.max(0, cum.input - state.prev.input),
        cacheRead: Math.max(0, cum.cacheRead - state.prev.cacheRead),
        cacheWrite: 0,
        output: Math.max(0, cum.output - state.prev.output),
        project: state.project,
        branch: state.branch,
      };
    }
    state.prev = cum;
  }
}

/* ------------------------------------------------------------------ *
 * OpenCode: ~/.local/share/opencode/opencode.db — SQLite, one row per
 * message in `message`, token counts nested under `data`->`tokens`.
 *
 * OpenCode is the only supported agent whose store is a database rather
 * than append-only text, so it gets its own reader instead of the jsonl
 * helper. Read-only throughout: the tool never takes a write lock on a
 * file a running agent holds open.
 * ------------------------------------------------------------------ */
/**
 * Shared reader for the OpenCode-family stores (OpenCode and Kilo — Kilo is
 * an OpenCode fork and its `message`/`session` schema is byte-identical,
 * verified against a live kilo.db on 2026-10-16). `agent` only labels the
 * records; the query is the same because the schema is the same.
 */
function makeSqliteParser(agent) {
return async function* parseStore(file) {
  // DatabaseSync only exists from Node 22.5. On 18/20 (which package.json
  // still admits) the import throws, and an unhandled throw here would take
  // down the whole scan instead of just the OpenCode lane -- so this source
  // degrades to "no records" rather than failing the run.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return;
  }
  if (typeof DatabaseSync !== 'function') return;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    try {
      // `readOnly` is also 22.5+. Falling back to a plain open keeps the lane
      // working on the 22.x builds that predate it; the parser only ever
      // issues SELECTs, so it never writes regardless.
      db = new DatabaseSync(file);
    } catch {
      return; // not a readable database (or not SQLite at all) — skip, never throw
    }
  }
  try {
    // `open` on a non-database succeeds; the failure surfaces on first use,
    // so the query itself is the sniff. Guarded the same way as a bad line.
    const rows = db
      .prepare(
        `SELECT m.session_id AS session,
                json_extract(m.data, '$.providerID') AS provider,
                json_extract(m.data, '$.modelID')    AS model,
                json_extract(m.data, '$.time.created') AS created,
                json_extract(m.data, '$.tokens.input')     AS input,
                json_extract(m.data, '$.tokens.output')    AS output,
                json_extract(m.data, '$.tokens.reasoning') AS reasoning,
                json_extract(m.data, '$.tokens.cache.read')  AS cacheRead,
                json_extract(m.data, '$.tokens.cache.write') AS cacheWrite,
                s.directory AS project
           FROM message m
           LEFT JOIN session s ON s.id = m.session_id
          WHERE json_extract(m.data, '$.role') = 'assistant'`,
      )
      .all();
    for (const row of rows) {
      // Reasoning tokens bill as output on every provider that separates
      // them, so they are folded in rather than dropped: OpenCode records
      // them in their own field and the price is the output price.
      const output = num(row.output) + num(row.reasoning);
      if (num(row.input) === 0 && num(row.cacheRead) === 0 && num(row.cacheWrite) === 0 && output === 0) continue;
      yield {
        agent,
        model: row.model ? `${row.provider ? `${row.provider}/` : ''}${row.model}` : agent,
        session: row.session || path.basename(file, path.extname(file)),
        timestamp: num(row.created) || null,
        input: num(row.input),
        cacheRead: num(row.cacheRead),
        cacheWrite: num(row.cacheWrite),
        output,
        project: row.project || null,
        branch: null, // neither store records a branch in these rows
      };
    }
  } catch {
    // A locked or foreign database is skipped like a truncated log line.
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
};
}

export const parseOpenCode = makeSqliteParser('opencode');
export const parseKilo = makeSqliteParser('kilo');

/* ------------------------------------------------------------------ *
 * Gemini CLI: ~/.gemini/tmp/<hash>/logs.json — JSON array of events.
 * ------------------------------------------------------------------ */
export async function* parseGemini(file) {
  const records = await readJsonSafe(file);
  if (!Array.isArray(records)) return;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const usage = rec.usage || rec.usageMetadata;
    if (!usage) continue;
    const model = rec.model || rec.model_name || 'gemini';
    yield {
      agent: 'gemini-cli',
      model,
      session: rec.session_id || path.basename(file),
      timestamp: Date.parse(rec.timestamp || '') || null,
      input: num(usage.promptTokenCount),
      cacheRead: num(usage.cachedContentTokenCount),
      cacheWrite: 0,
      output: num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount),
    };
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/** Stream a .jsonl file as parsed objects, skipping bad lines. */
export async function* jsonl(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // truncated / partially written line — ignore
    }
  }
}

async function readJsonSafe(file) {
  const { readFile } = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * DSH (DeepSeek Harness): one zstd session file per directory under
 * ~/.dsh/sessions (session.v4.jsonl.zstd)
 *
 * The only source whose log is compressed. Each session is a zstd frame of
 * JSONL events; assistant turns carry a `usage` block with camelCase token
 * buckets. The model is NOT on the usage record — it lives on the preceding
 * `request/header` event, so the parser tracks the latest one and attributes
 * every subsequent turn to it. No other tool reads these logs.
 * ------------------------------------------------------------------ */

/**
 * DSH appends to its session file one zstd frame per write, so a real file is
 * dozens of concatenated frames. Node's zstdDecompressSync stops after the
 * first one — on this machine that yielded 238 bytes of a 776 kB session, and
 * the lane silently reported zero records. Split on the frame magic and
 * decompress each independently; the magic cannot appear inside a frame
 * header/payload in a way that matters here, and a torn final frame (a live
 * session mid-write) is skipped rather than failing the file.
 */
function decompressZstdFrames(zlib, raw) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  let i = 0;
  while ((i = raw.indexOf(magic, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length <= 1) return zlib.zstdDecompressSync(raw).toString('utf8');
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(offsets[k], end)));
    } catch {
      // torn tail of a session being written right now
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function* parseDsh(file) {
  let text;
  try {
    // zstd support landed in Node 23.8. On the 22.5 floor the import or the
    // call throws, and this lane degrades to zero records like any other
    // unreadable store rather than taking down the scan.
    const zlib = await import('node:zlib');
    if (typeof zlib.zstdDecompressSync !== 'function') return;
    const { readFileSync } = await import('node:fs');
    text = decompressZstdFrames(zlib, readFileSync(file));
  } catch {
    return;
  }
  const session = path.basename(path.dirname(file));
  let model = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // a torn tail is normal for a live session
    }
    if (rec.type === 'request/header') {
      model = rec.data?.header?.config?.model ?? model;
      continue;
    }
    if (rec.type !== 'assistant/message') continue;
    const u = rec.data?.usage;
    if (!u) continue;
    const input = num(u.inputTokens);
    const cacheRead = num(u.cacheReadTokens);
    const cacheWrite = num(u.cacheWriteTokens);
    const output = num(u.outputTokens);
    if (input + cacheRead + cacheWrite + output === 0) continue;
    yield {
      agent: 'dsh',
      model: model || 'unknown',
      session,
      timestamp: num(rec.time) || null,
      input, cacheRead, cacheWrite, output,
      project: null,
      branch: null,
    };
  }
}

export const PARSERS = {
  'claude-code': parseClaudeCode,
  codex: parseCodex,
  opencode: parseOpenCode,
  kilo: parseKilo,
  dsh: parseDsh,
  'gemini-cli': parseGemini,
};
