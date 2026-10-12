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
  for await (const rec of jsonl(file)) {
    const msg = rec.message;
    if (!msg || typeof msg !== 'object') continue;
    const usage = msg.usage;
    if (!usage) continue;
    yield {
      agent: 'claude-code',
      model: msg.model || 'unknown',
      session,
      timestamp: rec.timestamp ? Date.parse(rec.timestamp) : null,
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Codex CLI: ~/.codex/sessions/ (rollout-*.jsonl files)
 * Cumulative `token_count` events carrying `total_token_usage`; we emit the
 * delta between consecutive events so the records can be summed directly.
 * ------------------------------------------------------------------ */export async function* parseCodex(file) {
  const state = { session: null, prev: null, model: null };
  for await (const rec of jsonl(file)) {
    if (rec.type === 'session_meta' && rec.payload && rec.payload.id) {
      state.session = rec.payload.id;
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
      };
    }
    state.prev = cum;
  }
}

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

export const PARSERS = {
  'claude-code': parseClaudeCode,
  codex: parseCodex,
  'gemini-cli': parseGemini,
};
