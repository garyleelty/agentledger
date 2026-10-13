# Earning log

## Strategy
Passive donations to a me-too CLI with zero traffic were not working (0 stars,
all promo sites network-blocked). Pivoted to **bounty work**: find a real bug in
an actively maintained repo, fix it, get paid on merge.

## Screening done (2026-10-14)
| Board | Verdict |
|---|---|
| claude-builders-bounty | **dead** — 4449 PRs, 0 merged, never pushed since creation day |
| FuRongJun-1999/dsh-bounty | 9 merged, active — but README says "no funds involved" |
| sybil-solutions/local-ai-registry | 188 merged, pays $50 — needs specific GPUs I don't own |
| BasedHardware/omi | **legit** — 13.7k stars, 10046 merged PRs, pays to EVM address |

## Submitted
**BasedHardware/omi PR #21447** — `fix(python-cli)`: export path TOCTOU race.
<https://github.com/BasedHardware/omi/pull/21447>

`export_conversations(overwrite=False)` did `exists()` then `write_text()`. A
file created in between gets truncated despite the no-overwrite request —
silent data loss. Fixed with atomic `open("x")`.

Evidence:
- reproduced the loss deterministically (stub `Path.exists()`)
- fix verified: existing file preserved, export goes to `_2`
- 5-test regression file; confirmed it **fails** on old code, **passes** on fix
- `mergeable: true`, 2 files, +114/-8

Payout destination: EVM `0xB30a208B84814D3F7091Bb779f2b0225288349aE`
(same address as `tools/tip.py` — check both with `python3 tools/tip.py`).

## Status
Not yet paid. Pending maintainer merge.
