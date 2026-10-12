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

/** Default table used when a model is unknown. */
export const DEFAULT_PRICING = {
  input: 3.0,
  output: 15.0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

/** Well-known model -> pricing entry. */
export const PRICING = {
  // ---- Anthropic -------------------------------------------------------
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-opus-4-1-20250805': { input: 15.0, output: 75.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-3-7-sonnet': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },

  // ---- OpenAI ----------------------------------------------------------
  'gpt-5.5': { input: 1.25, output: 10.0, cacheReadMultiplier: 0.125, cacheWriteMultiplier: 1.0 },
  'gpt-5': { input: 1.25, output: 10.0, cacheReadMultiplier: 0.125, cacheWriteMultiplier: 1.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cacheReadMultiplier: 0.125, cacheWriteMultiplier: 1.0 },
  'gpt-4.1': { input: 2.0, output: 8.0, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  'gpt-4o': { input: 2.5, output: 10.0, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1.0 },
  'o3': { input: 2.0, output: 8.0, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },

  // ---- Google ----------------------------------------------------------
  'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },

  // ---- Others seen in the wild ----------------------------------------
  'mimo-v2.5-pro': { input: 0.6, output: 2.4, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.0 },
  'deepseek-chat': { input: 0.27, output: 1.1, cacheReadMultiplier: 0.07, cacheWriteMultiplier: 1.0 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheReadMultiplier: 0.14, cacheWriteMultiplier: 1.0 },
};

/**
 * Resolve the pricing entry for a model id, tolerating dated suffixes and
 * unknown providers.
 */
export function resolvePricing(model) {
  if (!model) return DEFAULT_PRICING;
  const key = String(model).toLowerCase();
  if (PRICING[key]) return PRICING[key];
  // Strip a trailing dated snapshot, e.g. claude-sonnet-4-5-20250929
  const stripped = key.replace(/-\d{8}$/, '');
  if (PRICING[stripped]) return PRICING[stripped];
  for (const name of Object.keys(PRICING)) {
    if (stripped.startsWith(name) || name.startsWith(stripped)) return PRICING[name];
  }
  return DEFAULT_PRICING;
}

/**
 * Compute a cost breakdown for one usage record.
 *
 * @param {object} usage
 * @param {number} usage.input         fresh (non-cached) input tokens
 * @param {number} [usage.cacheRead]   tokens served from cache
 * @param {number} [usage.cacheWrite]  tokens written into cache
 * @param {number} usage.output        output tokens
 * @param {string} usage.model
 * @returns {{input:number,cacheRead:number,cacheWrite:number,output:number,total:number}}
 */
export function costOf(usage) {
  const p = resolvePricing(usage.model);
  const per = (n, price) => (Number(n) || 0) * price / 1e6;
  const input = per(usage.input, p.input);
  const cacheRead = per(usage.cacheRead, p.input * p.cacheReadMultiplier);
  const cacheWrite = per(usage.cacheWrite, p.input * p.cacheWriteMultiplier);
  const output = per(usage.output, p.output);
  const total = input + cacheRead + cacheWrite + output;
  return { input, cacheRead, cacheWrite, output, total };
}
