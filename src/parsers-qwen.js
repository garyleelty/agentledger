/**
 * Qwen Code (阿里通义千问 / QwenLM) — Alibaba's Gemini CLI fork.
 *
 * ccusage has had a `qwen` adapter since v20; agentledger did not, so this
 * lane closes a real coverage gap. The store is plain JSONL, one file per
 * session:
 *
 *   `~/.qwen/projects/<cwd-slug>/chats/<session-uuid>.jsonl`
 *
 * The `<cwd-slug>` is the working directory with `/` replaced by `-`, which
 * is lossy (a directory whose name contains a dash cannot be recovered from
 * it), so the project comes from the record's own `cwd`, which is the real
 * path. The slug is only used to find the file. Verified on this machine:
 * cwd `/Users/tianyi` → slug `-Users-tianyi`.
 *
 * ## THE SECOND STORE IS DELIBERATELY NOT READ
 *
 * Qwen Code also writes `~/.qwen/tmp/<sha256>/logs.json` — a JSON **array**
 * of `{sessionId, messageId, type, message, timestamp}` objects, the same
 * shape as the Gemini CLI's `~/.gemini/tmp/<hash>/logs.json`. The
 * `gemini-cli` lane in `parsers.js` already reads that file, and a source
 * that globbed recursively for a `logs.json` under `tmp` would count the same
 * requests twice.
 * This lane is therefore scoped to `~/.qwen/projects/`, and the matcher
 * requires a `chats/` segment, so it stays safe even if the root is ever
 * widened to `~/.qwen`. There is a test that fails if either guard moves.
 *
 * ## The record
 *
 * The envelope is written by qwen-code's own `createBaseRecord` (read out of
 * the installed bundle, `/opt/homebrew/lib/node_modules/@qwen-code/qwen-code/cli.js`,
 * v0.14.5 — the exact version that produced the files on this machine):
 *
 *   { uuid, parentUuid, sessionId, timestamp, type, cwd, version, gitBranch }
 *
 * `timestamp` is `new Date().toISOString()` (RFC3339 with milliseconds and a
 * `Z`), `cwd` is the project root, `version` is the CLI version, and
 * `gitBranch` is the branch of the project root. `gitBranch` is `undefined`
 * when the project is not a git repository, and `JSON.stringify` drops an
 * undefined property — which is why none of the 17 records measured on this
 * machine carries one: their cwd is `/Users/tianyi`, which is not a git
 * repository. It is mapped anyway, because a project that IS a git
 * repository will carry it, and the ledger has a branch column for it.
 *
 * Assistant turns add two more top-level fields, also from the bundle:
 * `model` (the model id) and `usageMetadata` (the token counts). System
 * turns carry `subtype` and `systemPayload` instead, and user turns carry
 * `message: {role, parts: [{text}]}`.
 *
 * ## The usage block
 *
 * `usageMetadata` is attached at the TOP LEVEL of the line — not inside
 * `message` — and only on an assistant turn:
 *
 *   if (this.currentMessage.type === "assistant" && this.currentMessage.usageMetadata) {
 *     exportMessage.usageMetadata = this.currentMessage.usageMetadata;
 *   }
 *
 * Its fields are the Gemini names:
 *
 *   promptTokenCount         the WHOLE prompt
 *   cachedContentTokenCount  the part of the prompt that was cached
 *   candidatesTokenCount     the visible output
 *   thoughtsTokenCount       the reasoning
 *   totalTokenCount          the total
 *
 * ## THE `usageMetadataFromVertex()` TRAP — DO NOT "FIX" IT
 *
 * The bundle also contains a function called `usageMetadataFromVertex`,
 * which RENAMES `candidatesTokenCount` to `responseTokenCount`:
 *
 *   const fromResponseTokenCount = getValueByPath(fromObject, ["candidatesTokenCount"]);
 *   if (fromResponseTokenCount != null) setValueByPath(toObject, ["responseTokenCount"], ...);
 *
 * That is a VERTEX request/response transformer — it converts a Gemini
 * response into the shape Vertex expects on the wire. It is NOT the shape
 * that lands on disk. The persisted shape keeps `candidatesTokenCount`:
 * it is the key written by `emitUsageMetadata`, by the `agent_message_chunk`
 * mapping, by the summary mapping and by the OpenAI-compatible response
 * builder, all four of which agree. Reading `responseTokenCount` off disk
 * would find nothing. The four writers are also why `thoughtsTokenCount` is
 * a sibling of `candidatesTokenCount` and not a component of it.
 *
 * ## The cache read is a SUBSET of the prompt
 *
 * `promptTokenCount` is the WHOLE prompt, cached part included, so the
 * fresh part is `promptTokenCount - cachedContentTokenCount` and the cache
 * read is `cachedContentTokenCount`. This is INFERRED, not measured: the
 * bundle's own OpenAI-compatible conversion is
 *
 *   prompt_tokens     = usageMetadata.promptTokenCount            // NOT debited
 *   completion_tokens = usageMetadata.candidatesTokenCount
 *   total_tokens      = usageMetadata.totalTokenCount
 *   if (usageMetadata.cachedContentTokenCount !== undefined)
 *     prompt_tokens_details = { cached_tokens: usageMetadata.cachedContentTokenCount }
 *
 * `prompt_tokens` is not reduced by `cached_tokens`, so the cached tokens
 * are a SUBSET of the prompt count rather than an addition to it. That is
 * the opposite of the Cherry Studio lane, where the fresh part is reported
 * separately and the cache read is disjoint from it.
 *
 * It could not be measured on this machine: there are no usage records
 * here to measure it against (see below). The inference is from the
 * producer's own code, which is the next best thing, and it is stated here
 * so that the first person to get a real record can check it.
 *
 * ## The reasoning is ADDITIVE, not a subset of the output
 *
 * `thoughtsTokenCount` is a SIBLING of `candidatesTokenCount` — the
 * visible output — and not a component of it, so the two are added. This
 * is the OpenCode/pi rule, and the opposite of the Cherry Studio and
 * WorkBuddy lanes, where the reasoning is already inside the output. The
 * lanes do not agree with each other, so this one is decided per lane from
 * the record shape and not by analogy.
 *
 * ## There is no cache-write field
 *
 * The Gemini family exposes no cache-write count — the fields are the five
 * listed above and there is no sixth. So `cacheWrite` is always 0 here, and
 * it is 0 because the product does not report one, not because a write
 * never happened. Nothing in this lane may ever invent a cache-write number.
 *
 * ## `totalTokenCount` is a check, not a source
 *
 * The buckets are taken from the bucket fields and `totalTokenCount` is
 * never used to derive them. Gemini's total can include tool-use prompt
 * tokens, which have no bucket of their own, so folding the remainder into
 * the output would invent spend in the wrong bucket. A record whose buckets
 * are all zero is an event, not spend, and is skipped — the same rule the
 * Cherry Studio and WorkBuddy lanes use.
 *
 * ## What is actually on this machine
 *
 * Qwen Code IS installed here (`/opt/homebrew/bin/qwen` → the global npm
 * package `@qwen-code/qwen-code`, v0.14.5) and is configured against
 * Alibaba's ModelStudio Coding Plan. It has two sessions:
 *
 *   ~/.qwen/projects/-Users-tianyi/chats/c2afe3f0-….jsonl  4,803 B, 12 records
 *   ~/.qwen/projects/-Users-tianyi/chats/fa14eacd-….jsonl  2,460 B,  5 records
 *
 * Seventeen records in all — 14 `system`, 3 `user`, and **0 `assistant`** —
 * and therefore **0 usage records**. All four API calls in those sessions
 * failed with `401 invalid access token or token expired`, so no assistant
 * turn was ever written. The only numbers in the whole corpus are four
 * `duration_ms` values and four `status_code` values of 401.
 *
 * So this lane reads zero records on this machine, exactly like the
 * `gemini-cli` lane (whose `~/.gemini/tmp` does not exist either). That is
 * a correct lane with no data, not a broken one, and the `sources` command
 * says so.
 */

import os from 'node:os';
import path from 'node:path';

import { jsonl } from './parsers.js';

const num = (v) => (Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Where the sessions live
 * ------------------------------------------------------------------ */

/**
 * The Qwen Code projects root, rooted at a home directory.
 *
 * @param {string} [home] defaults to the current user's home
 * @returns {string}
 */
export const qwenProjects = (home = os.homedir()) =>
  path.join(home, '.qwen', 'projects');

/**
 * Matcher for a chat file: `<cwd-slug>/chats/<session-uuid>.jsonl`.
 *
 * The `chats/` segment is REQUIRED, and that is the double-count guard.
 * Qwen Code's other store, `~/.qwen/tmp/<sha>/logs.json`, is a JSON array
 * with the Gemini CLI's shape, and the `gemini-cli` lane already reads that
 * file under `~/.gemini/tmp`; a matcher that accepted it would count the
 * same requests twice. Requiring `chats/` keeps this lane safe even if the
 * source root is ever widened from `~/.qwen/projects` to `~/.qwen`.
 *
 * @param {string} rel a path relative to the source root
 * @returns {boolean}
 */
export const QWEN_SESSION_MATCH = (rel) => /(^|\/)chats\/[^/]+\.jsonl$/.test(rel);

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/**
 * Parse one Qwen Code session file into usage records.
 *
 * @param {string} file path to a `<session-uuid>.jsonl` chat file
 * @returns {AsyncGenerator<object>} normalized usage records
 */
export async function* parseQwen(file) {
  // The file stem is the session id, and is the fallback for a record that
  // does not carry one.
  const stem = path.basename(file, '.jsonl');
  try {
    for await (const rec of jsonl(file)) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      // Only an assistant turn is a model call. The bundle attaches the
      // usage to assistant turns and to nothing else, so a usage block on
      // any other kind of record is a record this lane does not own — it is
      // skipped rather than read, which is also what ccusage's qwen parser
      // does.
      if (rec.type !== 'assistant') continue;
      const usage = rec.usageMetadata;
      if (!usage || typeof usage !== 'object') continue;

      // The whole prompt, and the part of it that was cached. The cached
      // part is a SUBSET of the prompt, so the fresh part is the
      // difference.
      const prompt = num(usage.promptTokenCount);
      const cacheRead = num(usage.cachedContentTokenCount);
      const input = Math.max(0, prompt - cacheRead);
      // The reasoning is a SIBLING of the visible output, not a component
      // of it, so the two are added.
      const output = num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount);
      // There is no cache-write field in the Gemini family, so there is no
      // cache write to report. It is not invented.
      const cacheWrite = 0;
      // A record whose buckets are all zero is an event, not spend.
      if (input + cacheRead + cacheWrite + output === 0) continue;

      yield {
        agent: 'qwen',
        // The model id, on the assistant turn. It is absent on this
        // machine's records (none of them is an assistant turn) and absent
        // on any turn that failed, so the fallback is the common case here.
        model: typeof rec.model === 'string' && rec.model ? rec.model : 'unknown',
        session: typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : stem,
        timestamp: parseTimestamp(rec.timestamp),
        input,
        cacheRead,
        cacheWrite,
        output,
        // The real working directory of the record, not the lossy slug the
        // file sits in.
        project: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : null,
        // The branch of the project root, when it is a git repository. The
        // field is `undefined` otherwise and `JSON.stringify` drops it, so
        // a record without one is normal.
        branch: typeof rec.gitBranch === 'string' && rec.gitBranch ? rec.gitBranch : null,
      };
    }
  } catch {
    // A missing or unreadable file yields no records, never a crash.
  }
}

/**
 * The record's timestamp, in epoch milliseconds.
 *
 * `Date.parse` returns `NaN` for an unparseable string, and `0` for the
 * epoch itself — so the zero is checked explicitly rather than with `||`,
 * which would turn the epoch into "no timestamp".
 *
 * @param {unknown} value the record's `timestamp`
 * @returns {number|null}
 */
function parseTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The parser map, in the shape `ledger.js` merges into `PARSERS`.
 * Mirrors the Cherry Studio, CodeBuddy, Lingma and WorkBuddy lanes' maps.
 */
export const PARSERS_QWEN = { qwen: parseQwen };

export default parseQwen;
