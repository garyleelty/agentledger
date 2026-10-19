/**
 * Pricing tables.
 *
 * Prices are USD per 1M tokens, matching the public pricing pages of each
 * provider. They are deliberately static so `agentledger` works fully offline
 * and never phones home.
 *
 * `cacheReadMultiplier` and `cacheWriteMultiplier` are applied to the input
 * price for cached reads and cache-write tokens respectively.
 */

/**
 * Free lanes bill $0 no matter what the underlying model "would" cost.
 * Two spellings exist in the wild: OpenCode's `-free` suffix and Kilo's
 * `:free` suffix on the model id (e.g. `bytedance-seed/dola-seed-2.0-pro:free`).
 */
export const FREE_PRICING = {
  input: 0, output: 0, cacheReadMultiplier: 0, cacheWriteMultiplier: 0,
};

/** Default table used when a model is unknown. */
export const DEFAULT_PRICING = {
  input: 3.0,
  output: 15.0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  cacheWrite1hMultiplier: 2.0,
};

/**
 * User overrides, loaded from a JSON file (see `--prices`).
 *
 * Why this exists: every estimate in this tool is a *list price*. Users on
 * subscription plans, negotiated rates, or proxy lanes with their own price
 * sheet cannot match their bill without editing the source — so the source
 * gets an official seam. An override is checked BEFORE the built-in table,
 * the free-lane rule, and prefix resolution: if you name `gpt-5:free`
 * explicitly, you meant it.
 *
 * Shape: { "<model-id>": { input?, output?, cacheReadMultiplier?,
 *                           cacheWriteMultiplier?, cacheWrite1hMultiplier? } }
 * Partial entries merge over the built-in row for that model (or over
 * DEFAULT_PRICING when the model is unknown), so overriding one field never
 * silently resets the others.
 */
let overrides = {};

/** Merge one override entry over the row it would otherwise resolve to. */
function buildOverride(modelKey, patch) {
  const base = PRICING[modelKey] ?? DEFAULT_PRICING;
  const known = ['input', 'output', 'cacheReadMultiplier', 'cacheWriteMultiplier', 'cacheWrite1hMultiplier'];
  const merged = { ...base };
  for (const [field, value] of Object.entries(patch)) {
    if (!known.includes(field)) {
      throw new Error(`prices: unknown field ${JSON.stringify(field)} for model ${JSON.stringify(modelKey)} (known: ${known.join(', ')})`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`prices: ${modelKey}.${field} must be a finite number >= 0, got ${JSON.stringify(value)}`);
    }
    merged[field] = value;
  }
  return merged;
}

/**
 * Install overrides from a parsed JSON object. Validates everything up
 * front and throws on the first bad entry — a half-applied price file is
 * worse than no price file, because the report still looks authoritative.
 */
export function loadPricingOverrides(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('prices: file must contain a JSON object of { model: { fields… } }');
  }
  const next = {};
  for (const [model, patch] of Object.entries(map)) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`prices: entry for ${JSON.stringify(model)} must be an object of pricing fields`);
    }
    next[model.toLowerCase()] = buildOverride(model.toLowerCase(), patch);
  }
  overrides = next;
  return Object.keys(next).length;
}

/** Which model keys currently have a user override (for reporting). */
export function overriddenModels() {
  return new Set(Object.keys(overrides));
}

/** Well-known model -> pricing entry. */
export const PRICING = {
  // ---- Anthropic -------------------------------------------------------
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-opus-4-1-20250805': { input: 15.0, output: 75.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-3-7-sonnet': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, cacheWrite1hMultiplier: 2.0 },

  // ---- OpenAI ----------------------------------------------------------
  // gpt-5.5 is NOT priced like gpt-5. Caught by cross-checking against
  // LiteLLM's live model_prices_and_context_window.json (2026-10-15):
  // $5 / $30 per Mtok, cached input $0.50/M (10%). The earlier entry had
  // inherited gpt-5's $1.25/$10 and under-reported a real bill ~4x.
  'gpt-5.5': { input: 5.0, output: 30.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  // gpt-5 / gpt-5-mini had cacheReadMultiplier 0.125: the absolute cached
  // rate ($0.125/M) pasted into a *multiplier* field. Correct value is
  // 0.125 / 1.25 = 0.1. Overstated cache reads by 25% until the automated
  // audit (tools/audit_pricing.py) caught it. cacheWriteMultiplier 1.0 on
  // all OpenAI/Google/DeepSeek rows means "billed as ordinary input", which
  // is how those providers work; only Anthropic bills cache writes at 1.25x.
  'gpt-5': { input: 1.25, output: 10.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  'gpt-4.1': { input: 2.0, output: 8.0, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  'gpt-4o': { input: 2.5, output: 10.0, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1.0 },
  'o3': { input: 2.0, output: 8.0, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },

  // ---- Google ----------------------------------------------------------
  // gemini-2.5-pro cacheReadMultiplier was 0.25 — the >200k-context tier's
  // cache rate — while standard cached input is $0.125/M on a $1.25/M base,
  // i.e. 0.1. Cache reads were overstated 2.5x.
  'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  // gemini-2.0-flash standard tier is $0.15/$0.60 (the $0.1/$0.4 row was the
  // flash-lite rate); cache read $0.0375/M = 0.25x.
  'gemini-2.0-flash': { input: 0.15, output: 0.6, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },

  // ---- Others seen in the wild ----------------------------------------
  // MiMo (Xiaomi) cached reads are ~0.8% of input, not the 10% Anthropic
  // convention. Three independent LiteLLM entries agree on the ratio —
  // xiaomi_mimo/mimo-v2.6-pro 0.0036/0.435, novita 0.0043/0.522, aihubmix
  // 0.0016/0.2 — all ≈0.008. This entry carried 0.1, a 12x overcharge on the
  // cache-read bucket, which is where 98% of this model's tokens are. Found by
  // running ccusage against the same logs: its $2.21 vs my $15.67 was entirely
  // this multiplier. Rate follows the vendor-canonical xiaomi_mimo/* row.
  'mimo-v2.5-pro': { input: 0.435, output: 0.87, cacheReadMultiplier: 0.0083, cacheWriteMultiplier: 1.0 },
  // DeepSeek repriced to the current V4 line ($0.28/$0.42, cached 0.1x);
  // the old rows carried the previous generation's $1.10/$2.19 output,
  // overstating output cost ~2.6x.
  // DSH (DeepSeek's own harness) reports provider `deepseek-account` with
  // model id `deepseek-flash`; LiteLLM carries a canonical `deepseek-flash`
  // entry under provider `deepseek` at $0.30/$1.20, cached $0.006/M (0.02x).
  // Same vendor, canonical id, not a reseller row — so this is a real price
  // rather than a guess. Models like hy4-preview/qfmodel/step-5-preview have
  // no canonical entry anywhere, so they stay on the disclosed default.
  'deepseek-flash': { input: 0.3, output: 1.2, cacheReadMultiplier: 0.02, cacheWriteMultiplier: 1.0 },
  'deepseek-chat': { input: 0.28, output: 0.42, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  'deepseek-reasoner': { input: 0.28, output: 0.42, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },

  // ---- OpenCode's own lane --------------------------------------------
  // Promotional models bill $0. Leaving them out let them fall through to
  // DEFAULT_PRICING ($3 in / $15 out), which overstated one machine's
  // 240M-token free lane by hundreds of dollars.
  'big-pickle': { input: 0, output: 0, cacheReadMultiplier: 0, cacheWriteMultiplier: 0 },
  'deepseek-v4-flash-free': { input: 0, output: 0, cacheReadMultiplier: 0, cacheWriteMultiplier: 0 },
  'hy3-free': { input: 0, output: 0, cacheReadMultiplier: 0, cacheWriteMultiplier: 0 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheReadMultiplier: 0.02, cacheWriteMultiplier: 1.0 },
  // deepseek-v4.1-flash: 5 of 13 LiteLLM rows agree on $0.30/$1.20
  // (together_ai, tencent, azure_ai as an exact triple; nebius and baseten
  // agree on in/out). coralbricks' $0.01 is a 30x outlier and is excluded.
  // Cached read $0.006/M = 0.02x. This was the second-largest unpriced model
  // on the DSH lane ($130 at the default), and it is a gateway-agnostic rate,
  // not one reseller's markup.
  'deepseek-v4.1-flash': { input: 0.3, output: 1.2, cacheReadMultiplier: 0.02, cacheWriteMultiplier: 1.0 },

  // ---- Chinese labs -----------------------------------------------------
  // Aligned to LiteLLM's official-provider entries (zai/*, moonshot/*).
  // The rows before this were guessed proxy-lane rates; on a 5.2M-token
  // glm-5.2 day the guessed $0.6/$2.2 under-reported ~$4.2 against the
  // official $1.4/$4.4 the audit cross-checks against.
  'glm-5.2': { input: 1.4, output: 4.4, cacheReadMultiplier: 0.186, cacheWriteMultiplier: 1.0 },
  'glm-5': { input: 1.0, output: 3.2, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.0 },
  // glm-4.7: 6 of LiteLLM's vendor rows agree exactly on $0.60/$2.20
  // (zai/glm-4.7, novita/zai-org/glm-4.7, novita/zai-org/glm-4.7-h,
  // baseten/zai-org/GLM-4.7, vertex_ai/zai-org/glm-4.7-maas, zai.glm-4.7).
  // Cached read $0.11/M = 0.1833x on three of them, 0.1x and 0.2x on the
  // other two — the 0.1833 cluster is the majority, and it is the same
  // multiplier zai/glm-5.2 carries. OpenClaw records this model as
  // `glm-4.7:cloud`; the `:cloud` tail is a routing suffix, and the model
  // behind it is the one priced here (2.08M tokens on this machine were
  // sitting on the $3/$15 default before this entry).
  'glm-4.7': { input: 0.6, output: 2.2, cacheReadMultiplier: 0.1833, cacheWriteMultiplier: 1.0 },
  'kimi-k2.7-code': { input: 0.95, output: 4.0, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.0 },
  'kimi-k2.5': { input: 0.6, output: 3.0, cacheReadMultiplier: 0.167, cacheWriteMultiplier: 1.0 },
  // MiniMax M2.7 as carried by LiteLLM (novita/minimax/minimax-m2.7):
  // $0.30 in / $1.20 out, cached read $0.06/M = 0.2x. Kilo routes through
  // minimax-cn and minimax providers; the bare name resolves for both.
  'minimax-m2.7': { input: 0.3, output: 1.2, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.0 },
};

/**
 * Resolve the pricing entry for a model id, tolerating dated suffixes and
 * unknown providers.
 *
 * The prefix pass is deliberately last and deliberately one-directional. A
 * longer unknown name may match a shorter known one (`gpt-5.5-codex` ->
 * `gpt-5.5`), never the other way round: `deepseek-v4-flash-free` must not
 * be priced as `deepseek-v4-flash` just because the paid id is a prefix of
 * the free one, and the free lanes are exactly where the mistake costs the
 * most. Anything that still misses is priced by DEFAULT_PRICING and shows up
 * under `by-model` as its own row, so the gap is visible instead of silent.
 */
export function resolvePricing(model) {
  if (!model) return DEFAULT_PRICING;
  const key = String(model).toLowerCase();
  if (overrides[key]) return overrides[key];
  if (PRICING[key]) return PRICING[key];
  // A `:free` / `-free` tail means the provider bills this lane at zero —
  // it must be decided BEFORE any prefix or stripped-name match, or
  // `gpt-5:free` would inherit gpt-5's paid rate. Found in Kilo's store:
  // 13 records priced at $3/$15 by the default while Kilo's own cost field
  // said 0.
  if (/[:-]free$/.test(key)) return FREE_PRICING;
  // Strip a trailing dated snapshot, e.g. claude-sonnet-4-5-20250929
  const stripped = key.replace(/-\d{8}$/, '');
  if (PRICING[stripped]) return PRICING[stripped];
  // Provider-qualified ids ("opencode/deepseek-v4-flash-free", "moonshotai/
  // kimi-k2.7-code", "deepseek/deepseek-v4.1-flash-1017") are stored by the
  // bare model name, so try the tail too. The tail needs the SAME treatment
  // as the full id — exact, then prefix — because gateways append dated
  // build suffixes. `deepseek/deepseek-v4.1-flash-1017` fell through to the
  // $3/$15 default while the bare `deepseek-v4.1-flash-1017` resolved
  // correctly; only the slash-tail path was missing the prefix pass.
  const slash = stripped.lastIndexOf('/');
  if (slash !== -1) {
    const tail = stripped.slice(slash + 1);
    if (PRICING[tail]) return PRICING[tail];
    for (const name of Object.keys(PRICING)) {
      if (tail.startsWith(name)) return PRICING[name];
    }
  }
  for (const name of Object.keys(PRICING)) {
    if (stripped.startsWith(name)) return PRICING[name];
  }
  return DEFAULT_PRICING;
}

/**
 * Price the cache-write bucket of one record under a resolved pricing entry.
 *
 * Anthropic bills 1-hour cache writes at 2x input, 5-minute at 1.25x
 * (LiteLLM: cache_creation_input_token_cost_above_1hr = 6e-6 vs 3e-6 base on
 * sonnet-4-5 — verified 2026-10-16). When the parser supplied the TTL split,
 * bill each subset at its own rate; pricing the lump at 1.25x undercharges
 * every 1-hour write by 37.5%. Models without a cacheWrite1hMultiplier (every
 * non-Anthropic provider) keep one rate.
 *
 * Exported because `savings` must use the *identical* formula: its
 * counterfactual cancels cache writes against themselves, and two copies of
 * this rule that drift would invent phantom savings out of a pricing change.
 */
export function cacheWriteCost(usage, p) {
  const per = (n, price) => (Number(n) || 0) * price / 1e6;
  const w1h = p.cacheWrite1hMultiplier ?? null;
  const split = w1h !== null && ((usage.cacheWrite1h || 0) + (usage.cacheWrite5m || 0) > 0);
  return split
    ? per(usage.cacheWrite5m, p.input * p.cacheWriteMultiplier)
      + per(usage.cacheWrite1h, p.input * w1h)
    : per(usage.cacheWrite, p.input * p.cacheWriteMultiplier);
}

/**
 * Compute a cost breakdown for one usage record.
 *
 * @param {object} usage
 * @param {number} usage.input         fresh (non-cached) input tokens
 * @param {number} [usage.cacheRead]   tokens served from cache
 * @param {number} [usage.cacheWrite]  tokens written into cache (lumped)
 * @param {number} [usage.cacheWrite1h] TTL-split subset: 1-hour writes
 * @param {number} [usage.cacheWrite5m] TTL-split subset: 5-minute writes
 * @param {number} usage.output        output tokens
 * @param {string} usage.model
 * @returns {{input:number,cacheRead:number,cacheWrite:number,output:number,total:number}}
 */
export function costOf(usage) {
  const p = resolvePricing(usage.model);
  const per = (n, price) => (Number(n) || 0) * price / 1e6;
  const input = per(usage.input, p.input);
  const cacheRead = per(usage.cacheRead, p.input * p.cacheReadMultiplier);
  const cacheWrite = cacheWriteCost(usage, p);
  const output = per(usage.output, p.output);
  const total = input + cacheRead + cacheWrite + output;
  return { input, cacheRead, cacheWrite, output, total };
}
