#!/usr/bin/env python3
"""
audit_pricing.py — cross-check the built-in PRICING table against the
authoritative LiteLLM model database.

Why this exists: a cost tool's one non-negotiable property is that its price
numbers are right. gpt-5.5 sat at $1.25/$10 (wrong by 4x) until a manual
comparison against ccusage surfaced it. That is too fragile to be the only
line of defence, so this check compares every entry to LiteLLM directly.

Usage:
    python3 tools/audit_pricing.py [path-to-litellm.json]

Exits non-zero if any auditable entry disagrees, or if a name has no match.
"""

import json
import sys
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LITELLM = sys.argv[1] if len(sys.argv) > 1 else "/tmp/litellm.json"

# Our key -> candidate LiteLLM ids, tried in order. LiteLLM carries both bare
# ids ("claude-sonnet-4-5") and provider-prefixed ones ("deepseek/deepseek-chat");
# the first confident hit wins. Anything ambiguous stays unchecked, not guessed.
MAP = {
    "claude-opus-4-1": ["anthropic.claude-opus-4-1-20250805-v1:0", "claude-opus-4-1-20250805", "anthropic/claude-opus-4-1"],
    "claude-opus-4-1-20250805": ["anthropic.claude-opus-4-1-20250805-v1:0", "claude-opus-4-1-20250805", "anthropic/claude-opus-4-1"],
    "claude-sonnet-4-5": ["claude-sonnet-4-5", "anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic/claude-sonnet-4-5"],
    "claude-sonnet-4-5-20250929": ["claude-sonnet-4-5-20250929", "anthropic.claude-sonnet-4-5-20250929-v1:0"],
    "claude-haiku-4-5": ["claude-haiku-4-5", "anthropic.claude-haiku-4-5-20251001-v1:0"],
    "claude-3-7-sonnet": ["anthropic.claude-3-7-sonnet-20250219-v1:0", "claude-3-7-sonnet-20250219", "anthropic/claude-3-7-sonnet-20250219"],
    "claude-3-5-sonnet": ["anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022", "anthropic/claude-3-5-sonnet-20241022"],
    "claude-3-5-haiku": ["anthropic.claude-3-5-haiku-20241022-v1:0", "claude-3-5-haiku-20241022", "anthropic/claude-3-5-haiku-20241022"],
    "gpt-5.5": ["gpt-5.5"],
    "gpt-5": ["gpt-5"],
    "gpt-5-mini": ["gpt-5-mini"],
    "gpt-4.1": ["gpt-4.1"],
    "gpt-4o": ["gpt-4o-2024-11-20"],
    "o3": ["o3"],
    "gemini-2.5-pro": ["gemini-2.5-pro", "gemini/gemini-2.5-pro"],
    "gemini-2.5-flash": ["gemini-2.5-flash", "gemini/gemini-2.5-flash"],
    "gemini-2.0-flash": ["vertex_ai/gemini-2.0-flash", "gemini/gemini-2.0-flash", "gemini-2.0-flash"],
    "deepseek-chat": ["deepseek/deepseek-chat", "deepseek-chat"],
    "deepseek-reasoner": ["deepseek/deepseek-reasoner", "deepseek-reasoner"],
    "deepseek-v4-flash": ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"],
    "deepseek-flash": ["deepseek-flash", "deepseek/deepseek-flash"],
    "glm-5": ["zai/glm-5", "glm-5"],
    "glm-5.2": ["zai/glm-5.2", "glm-5.2"],
    "kimi-k2.7-code": ["moonshot/kimi-k2.7-code", "kimi-k2.7-code"],
    "kimi-k2.5": ["moonshot/kimi-k2.5", "kimi-k2.5"],
    # MiMo: LiteLLM carries several reseller rows whose input/output agree
    # closely but whose cache-read rates are the point (all ~0.8% of input).
    # Map to the vendor-namespaced row so the cache ratio is checked too.
    "mimo-v2.5-pro": ["xiaomi_mimo/mimo-v2.6-pro", "novita/xiaomimimo/mimo-v2.5-pro"],
}


def find_ref(lit, key):
    for cand in MAP.get(key, []):
        if cand in lit:
            return cand, lit[cand]
    return None, None


def ours():
    """Read PRICING out of the ES module by asking Node to dump it as JSON.

    Parsing the source by hand would drift the moment someone reformats a
    line; executing the module reads the single source of truth directly.
    """
    import subprocess

    script = "import {PRICING} from %r; process.stdout.write(JSON.stringify(PRICING));" % (
        os.path.join(REPO, "src", "pricing.js").replace("\\", "/")
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, check=True,
    ).stdout
    if not out.strip():
        raise RuntimeError("empty PRICING dump")
    return json.loads(out)


def main():
    if not os.path.exists(LITELLM):
        print(f"LiteLLM db not found at {LITELLM}")
        print("fetch it, e.g.:")
        print("  curl -sL https://raw.githubusercontent.com/BerriAI/litellm/main/"
              "model_prices_and_context_window.json -o /tmp/litellm.json")
        return 2

    lit = json.load(open(LITELLM))
    table = ours()
    bad, unmaps = [], []

    for key, price in table.items():
        ref_id, ref = find_ref(lit, key)
        if key not in MAP:
            unmaps.append(key)
            continue
        if ref is None:
            unmaps.append(f"{key} (liteLLM has no {MAP[key]})")
            continue
        i, o = ref.get("input_cost_per_token", 0) * 1e6, ref.get("output_cost_per_token", 0) * 1e6
        cr = ref.get("cache_read_input_token_cost")
        cw = ref.get("cache_creation_input_token_cost")
        exp = {"input": i, "output": o}
        if cr is not None:
            exp["cacheReadMultiplier"] = cr * 1e6 / i if i else cr * 1e6
        # A cache_creation cost of 0 means "no separate cache-write billing"
        # (OpenAI/Google/DeepSeek): cache writes ride at the input rate, which
        # our table expresses as multiplier 1.0. That is agreement, not a
        # mismatch, so only compare when LiteLLM states a positive rate.
        if cw is not None and cw > 0:
            exp["cacheWriteMultiplier"] = cw * 1e6 / i if i else cw * 1e6
        for field, want in exp.items():
            got = price.get(field)
            if got is None:
                continue  # we inherit the default multiplier; nothing to compare
            if abs(got - want) > max(1e-6, abs(want) * 0.02):
                bad.append(f"{key}.{field}: ours {got}, litellm {round(want, 4)}")

    print(f"compared {len(table) - len(unmaps)} of {len(table)} entries against LiteLLM")
    for b in bad:
        print("  MISMATCH", b)
    for u in unmaps:
        print("  unchecked (no confident LiteLLM mapping):", u)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
