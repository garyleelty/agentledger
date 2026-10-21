/**
 * WorkBuddy — Tencent's standalone AI agent desktop app.
 *
 * ccusage has no adapter for this product at all. WorkBuddy keeps its usage
 * in plain JSONL, one file per session:
 *
 *   `~/.workbuddy/projects/<cwd-slug>/<sessionId>.jsonl`
 *
 * Ten such files on this machine, append-only, one JSON object per line.
 * The `<cwd-slug>` is the working directory with `/` replaced by `-`, which
 * is lossy (a directory whose name contains a dash cannot be recovered from
 * it), so the project comes from the record's own `cwd` — which is the real
 * path — and the slug is only used to find the file.
 *
 * ## One record per model CALL
 *
 * A line is not necessarily a model call. The files hold `ai-title`,
 * `credit-usage`, `file-history-snapshot`, `function_call_result`,
 * `reasoning` and `session-meta` records too. The discriminator is the
 * usage: a record with no `providerData.usage` is not a model call and is
 * skipped. On this machine 487 of the 2,049 lines carry a usage — 448
 * `function_call` and 39 `message` (all of them `role: 'assistant'`).
 *
 * ## The buckets, and the fields that look right and are wrong
 *
 * `providerData.usage` is the normalised view and `providerData.rawUsage`
 * the raw one. The raw view is the only place the CACHE SPLIT is reported,
 * and three of its fields are decoys:
 *
 *   * `rawUsage.cache_read_input_tokens` is **0 on every one of the 487
 *     records**. It is the field that looks like the cache read and is not.
 *   * `rawUsage.cached_tokens` is **0 on every record** as well.
 *   * The `message.usage` block on the record is a third copy of the same
 *     numbers (`input_tokens`, `output_tokens`, `total_tokens`,
 *     `cache_read_input_tokens`) with NO cache-miss split. Its
 *     `input_tokens` is the WHOLE prompt, so pricing it as fresh input
 *     would charge the cached part a second time — and its
 *     `cache_read_input_tokens` is 0 on 9 of the 487 records, so it would
 *     lose part of the 36.8M cached tokens as well.
 *
 * The counts that do hold:
 *
 *   * `usage.inputTokens` is the WHOLE prompt (fresh + cached), and
 *     `rawUsage.prompt_cache_hit_tokens + rawUsage.prompt_cache_miss_tokens
 *     === usage.inputTokens` on all 487 records (4,028,544 + 467,419 =
 *     4,495,963 on the first one).
 *   * So **fresh input = `prompt_cache_miss_tokens`** and
 *     **cache read = `prompt_cache_hit_tokens`**. The same cached count is
 *     also `rawUsage.prompt_tokens_details.cached_tokens` and
 *     `usage.inputTokensDetails[0].cached_tokens`; all three agree on all
 *     487 records.
 *   * `rawUsage.cache_creation_input_tokens` is the cache write. It is 0 on
 *     every record on this machine, but it is the field, so it is mapped.
 *
 * ## Reasoning is a SUBSET of output, not additive
 *
 * `usage.outputTokensDetails[0].reasoning_tokens` is already inside
 * `usage.outputTokens`: the measured ratio runs from 0.07 to 0.80 (output
 * 750 with reasoning 520; output 2362 with reasoning 1798). Adding it
 * would double-count, which is the same trap the Cherry Studio lane
 * documents. The output is therefore `usage.outputTokens`, and the
 * reasoning is not carried.
 *
 * (On two of the 487 records the provider's own numbers put the reasoning
 * ONE token above the output — 111 against 110, and 110 against 109. That
 * is the provider's rounding, and it changes nothing here, because the
 * reasoning is never added.)
 *
 * ## The model
 *
 * `providerData.model` is the machine id (`hy3`, `hy4-preview`,
 * `step-5-preview`, `deepseek-v4.1-flash`, `glm-5.3-flash`) and is the
 * model the pricing table knows. `providerData.requestModelName` is the
 * DISPLAY name and is never the model — one of them on this machine is the
 * Chinese string `快速`. `providerData.requestModelId` is a machine id but
 * not always the same one: on the 4 `glm-5.3-flash` records it is
 * `fast-model`, the route the fast model was called through.
 *
 * ## The same id on two lines
 *
 * 136 of the 1,754 record ids in these ten files appear on TWO lines: the
 * assistant `message` and the `function_call` that shares its id, one
 * millisecond apart. Only ONE of the pair carries the usage — the
 * `function_call` copy — so there is no double count, and there are 487
 * distinct usage-bearing ids for 487 usage-bearing lines. A parser that
 * deduplicated by record id would DROP 136 real records, so this lane does
 * not dedupe.
 *
 * ## No double count with the CodeBuddy lane
 *
 * WorkBuddy and the CodeBuddy CN IDE extension are the same product family
 * on the same account, so the same model call could in principle be
 * counted twice. Measured on this machine: the CodeBuddy lane's 362
 * records span 2026-04-26 → 2026-05-08 and this lane's 487 records span
 * 2026-09-08 → 2026-10-21 — four months apart, no shared day and no
 * shared timestamp. The two windows are disjoint.
 */

import os from 'node:os';
import path from 'node:path';

import { jsonl } from './parsers.js';

const num = (v) => (Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Where the sessions live
 * ------------------------------------------------------------------ */

/**
 * The store path, rooted at a home directory.
 *
 * @param {string} [home] defaults to the current user's home
 * @returns {string}
 */
export const workbuddyProjects = (home = os.homedir()) =>
  path.join(home, '.workbuddy', 'projects');

/**
 * Matcher for a session file: `<cwd-slug>/<sessionId>.jsonl`.
 *
 * The project root is the `projects` directory, which holds nothing but
 * the session files. The other JSONL files under `~/.workbuddy` — the
 * traces, the audit log, the app logs — carry no usage at all (verified:
 * not one `"usage"` in 89 files), so they are not part of this lane.
 *
 * @param {string} rel a path relative to the source root
 * @returns {boolean}
 */
export const WORKBUDDY_SESSION_MATCH = (rel) => /(^|\/)[^/]+\.jsonl$/.test(rel);

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/**
 * Parse one WorkBuddy session file into usage records.
 *
 * @param {string} file path to a `<sessionId>.jsonl` session file
 * @returns {AsyncGenerator<object>} normalized usage records
 */
export async function* parseWorkBuddy(file) {
  // The file stem is the session id, and is the fallback for a record that
  // does not carry one.
  const stem = path.basename(file, '.jsonl');
  try {
    for await (const rec of jsonl(file)) {
      if (!rec || typeof rec !== 'object') continue;
      const pd = rec.providerData;
      if (!pd || typeof pd !== 'object') continue;
      const usage = pd.usage;
      // No usage: not a model call. The file also holds titles, snapshots,
      // tool results and credit records.
      if (!usage || typeof usage !== 'object') continue;
      const raw = pd.rawUsage && typeof pd.rawUsage === 'object' ? pd.rawUsage : {};

      const cacheRead = cachedTokens(usage, raw);
      const input = freshTokens(usage, raw, cacheRead);
      const cacheWrite = num(raw.cache_creation_input_tokens);
      // The reasoning tokens are already inside the output; they are not
      // added to it.
      const output = num(usage.outputTokens);
      // A record whose buckets are all zero is an event, not spend.
      if (input + cacheRead + cacheWrite + output === 0) continue;

      yield {
        agent: 'workbuddy',
        // The machine id. The display name (`快速` on some records) is not a
        // model the pricing table knows, and the provider is not a model
        // either.
        model: modelOf(pd),
        session: typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : stem,
        timestamp: num(rec.timestamp) || null,
        input,
        cacheRead,
        cacheWrite,
        output,
        // The real working directory of the record, not the lossy slug the
        // file sits in.
        project: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : null,
        // WorkBuddy records no branch.
        branch: null,
      };
    }
  } catch {
    // A missing or unreadable file yields no records, never a crash.
  }
}

/**
 * The cached part of the prompt.
 *
 * `rawUsage.prompt_cache_hit_tokens` is the field; the two other copies of
 * the same number are the fallbacks for a record whose raw view is
 * incomplete. The decoys — `cache_read_input_tokens` and
 * `rawUsage.cached_tokens` — are 0 on every record and are never read.
 *
 * @param {object} usage the normalised usage
 * @param {object} raw the raw usage
 * @returns {number}
 */
function cachedTokens(usage, raw) {
  if (Number.isFinite(raw.prompt_cache_hit_tokens)) return raw.prompt_cache_hit_tokens;
  const details = raw.prompt_tokens_details;
  if (details && Number.isFinite(details.cached_tokens)) return details.cached_tokens;
  const inputDetails = usage.inputTokensDetails;
  if (Array.isArray(inputDetails) && inputDetails[0] && Number.isFinite(inputDetails[0].cached_tokens)) {
    return inputDetails[0].cached_tokens;
  }
  return 0;
}

/**
 * The fresh part of the prompt.
 *
 * `rawUsage.prompt_cache_miss_tokens` is the field, and it is the same
 * identity the split obeys: hit + miss === the whole prompt. Without it the
 * fresh part is the whole prompt minus the cached part.
 *
 * @param {object} usage the normalised usage
 * @param {object} raw the raw usage
 * @param {number} cacheRead the cached part
 * @returns {number}
 */
function freshTokens(usage, raw, cacheRead) {
  if (Number.isFinite(raw.prompt_cache_miss_tokens)) return raw.prompt_cache_miss_tokens;
  return Math.max(0, num(usage.inputTokens) - cacheRead);
}

/**
 * The model of a call: the machine id.
 *
 * @param {object} providerData the record's `providerData`
 * @returns {string}
 */
function modelOf(providerData) {
  if (typeof providerData.model === 'string' && providerData.model) return providerData.model;
  // The request model id is a machine id too, but not always the same one
  // (`fast-model` on the `glm-5.3-flash` records) — it is only a fallback.
  if (typeof providerData.requestModelId === 'string' && providerData.requestModelId) {
    return providerData.requestModelId;
  }
  return 'unknown';
}

/**
 * The parser map, in the shape `ledger.js` merges into `PARSERS`.
 * Mirrors the Cherry Studio, CodeBuddy and Lingma lanes' maps.
 */
export const PARSERS_WORKBUDDY = { workbuddy: parseWorkBuddy };

export default parseWorkBuddy;
