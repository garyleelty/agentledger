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

## MERGED (2026-10-14)

PR **#21447 was merged** at `2026-10-14T14:41:55Z` by maintainer `kodjima33`
(merge commit `2badce4016120a2f3c49f6ea7117844559bf3377`). It closed #21168.

Verified after merge:
- `conversations_to_markdown.py` on `main` contains `open("x")` + `FileExistsError`
- `tests/test_conversations_export_atomic.py` present on `main`
- PR labeled `positive-signal`; reviewer verified it end to end

Context: a maintainer stated in #20697 that "97% of similar PRs resolved
without merge over the last window" and that community bounty-style submissions
in `sdks/python-cli` were being closed as a class. This one was merged anyway.

## Payout — blocked, and why this is not yet income

Official rules (`docs/doc/developer/Contribution.mdx`):

> Claiming payment | Email team@basedhardware.com with bounty link + PayPal account

Payment is **not** automatic on merge and **not** on-chain. The EVM address in
the PR body came from the auto-generated template, not omi's real process, so
`tools/tip.py` will keep reading 0 regardless.

I could not send the claim email:
- outbound SMTP blocked (smtp.gmail.com:587 and :465 both time out)
- no mail credentials in keychain, no msmtp/mail config
- omi has no Opire bot integration

Only 3 issues carry the `Paid Bounty` label, all from 2025 hardware/mobile
work. #21168 had no bounty label and no stated amount, so this may simply be
unpaid community work.

## Status
Merged, but **not paid**. $0.00 received.
