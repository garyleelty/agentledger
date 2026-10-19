#!/usr/bin/env node
/**
 * cherry-studio parser: ~/Library/Application Support/CherryStudio/Data/
 * cherrystudio.sqlite, table `ai_usage_record`.
 *
 * CherryStudio is a GUI that hosts several agents, and it keeps its OWN
 * per-invocation usage ledger. That makes it the only source here that
 * carries the provider's own cost alongside the token buckets — and the only
 * one with a double-counting hazard that has to be designed around:
 *
 *   1. **The pi-agent overlap.** CherryStudio can launch pi-agent, and when
 *      it does it records the same requests pi's own session log records.
 *      Verified on this machine: 8 rows at identical timestamps with
 *      identical token counts (17:22:27 -> in 5851 out 13 in BOTH stores).
 *      Reading both lanes double-counts them.
 *   2. **Two record kinds.** `invocation` rows are one API call each and
 *      carry the full cache split; `legacy-aggregate` rows are rolled-up
 *      sessions from before the invocation table existed (request_count
 *      1..37, no cache split at all). They never share a message_id and
 *      their time ranges do not overlap (invocation starts 2026-08-20,
 *      legacy ends 2026-07-24), so both kinds are additive — but the
 *      aggregates are per-session totals, not per-call, and must not be
 *      re-split.
 *   3. **`input_tokens` is the WHOLE prompt** (no_cache + cache_read), not
 *      the fresh part. Verified: no_cache_tokens + cache_read_tokens ==
 *      input_tokens on every invocation row that carries the split. Pricing
 *      `input` as fresh would charge the cached part twice.
 *   4. **`reasoning_tokens` is a SUBSET of output**, not additive:
 *      reasoning <= output on every row, and total == input + output holds
 *      on all 41. So reasoning is dropped rather than added (the opposite of
 *      the OpenCode/pi rule) — adding it would double-count.
 *
 * The store also holds `cost` and a `pricing_snapshot`, but only on 7 rows,
 * all of them free-lane models. Pricing them from the built-in table keeps
 * one code path for the whole ledger.
 *
 * Rows whose model_id is NULL are kept and reported as `unknown` — 4 of 41
 * rows, 115,787 input tokens. Dropping real spend is worse than pricing it
 * at the disclosed default.
 */

import path from 'node:path';

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Which window a timestamp falls in, for the pi overlap check.
 *
 * The overlap is not detectable from the CherryStudio row alone: nothing in
 * it says "this request came from pi-agent". What identifies it is that the
 * same request is in the pi session log, and pi's own log is the one that
 * should win (it is the agent's own record; CherryStudio is a host
 * observing it). So the collector, not the parser, does the dedup — see
 * `dedupeHostedSessions` in ledger.js.
 */
export function parseCherryStudio(file) {
  return parseCherryStudioAsync(file);
}

async function* parseCherryStudioAsync(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return; // Node < 22.5: the lane degrades to zero like any other store
  }
  if (typeof DatabaseSync !== 'function') return;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    try {
      db = new DatabaseSync(file);
    } catch {
      return; // locked, foreign, or not SQLite — skip, never throw
    }
  }
  try {
    const rows = db
      .prepare(
        `SELECT record_kind, request_count, message_kind, source_type, source_id,
                model_id, input_tokens, output_tokens, reasoning_tokens,
                no_cache_tokens, cache_read_tokens, cache_write_tokens,
                total_tokens, created_at
           FROM ai_usage_record
          WHERE modality = 'language'`,
      )
      .all();
    for (const r of rows) {
      // `input_tokens` is the whole prompt; the fresh part is `no_cache`.
      // When the split is absent (every legacy-aggregate row) the whole
      // amount is fresh — those sessions predate cache accounting.
      const fresh = r.no_cache_tokens === null ? num(r.input_tokens) : num(r.no_cache_tokens);
      const cacheRead = num(r.cache_read_tokens);
      const cacheWrite = num(r.cache_write_tokens);
      const output = num(r.output_tokens);
      if (fresh + cacheRead + cacheWrite + output === 0) continue;
      yield {
        agent: 'cherry-studio',
        // A NULL model is real usage we cannot attribute; keep it priced at
        // the disclosed default rather than dropping 115k tokens.
        model: r.model_id || 'unknown',
        // legacy-aggregate rows identify a message; invocation rows do not.
        session: r.source_id || 'cherry-studio',
        timestamp: num(r.created_at) || null,
        input: fresh,
        cacheRead,
        cacheWrite,
        // reasoning is a SUBSET of output here (total == input + output on
        // every row), so it is deliberately NOT added.
        output,
        project: null,
        branch: null,
        // Carried so the collector can drop rows the pi lane already has.
        hostedBy: r.source_type === 'agent' ? r.source_id : null,
      };
    }
  } catch {
    // A locked or foreign database is skipped like a truncated log line.
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

export const PARSERS_CHERRY = { 'cherry-studio': parseCherryStudio };

export default parseCherryStudio;
