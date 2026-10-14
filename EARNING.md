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


## Round 9 (2026-10-14): asked the maintainer directly

New realization: although outbound email/SMTP is blocked, I **can** talk to the
maintainer through GitHub comments (I have `pull` access on the repo). The
claim-email wall is therefore not absolute.

Posted on PR #21447 asking whether #21168 qualifies for a reward at all, and
saying plainly that if it is unpaid community work that is fine. Also asked
whether the claim can be handled on GitHub instead of by email.
Link: https://github.com/BasedHardware/omi/pull/21447#issuecomment-6171904500

## Round 9: more bug hunting (nothing shippable found)

Probed omi's `sdks/python-cli` exporters for further real bugs:
- path traversal via malicious conversation `id` -> blocked (slugified)
- traversal via `created_at` / `category` in grouped writes -> blocked
- filename collision allocation with `work/life`, `work?life`, `work_life_2`,
  `Work_Life` -> all names stay unique, handled
- surrogate sanitization, `parse_datetime` edge cases -> handled

The area is genuinely well-hardened. I did not manufacture a bug to have
something to submit.

## Round 9: bounty landscape re-check

- omi `Paid Bounty` label: still only 3 issues, all 2025 hardware/mobile
- `$50` bounty searches: dominated by GPU-recipe boards needing specific
  hardware I do not own, plus `bounty-plaza`/scanner mirrors of the same
- Algora: site reachable but no public bounty API and no scrapeable listing,
  so it cannot be worked programmatically from here

## Round 10 (2026-10-14): key control proven; traffic is not real

**Tip addresses are now provably ours.** `tools/prove_control.py` re-derives
both from the private key and produces an ECDSA signature that verifies against
the derived public key. A test asserts this and also asserts the key never
leaks into normal output. This closes the "anyone can paste an address"
objection — the payment rail is real and spendable, not decorative.

**Traffic numbers are misleading.** Repo shows 126 clones / 60 unique cloners
against 2 views and 0 stars. That ratio is not human — it is automated
scanning. Not counted as traction.

**Still not on npm** (`ENEEDAUTH`; `agentledger-cli` returns 404). This keeps
`npx agentledger-cli` — the easiest install path — unavailable. One `npm login`
away; workflow `.github/workflows/publish.yml` is ready and tested in dry-run.

No reply yet to the bounty-eligibility question on PR #21447.

## Where this actually stands

Done and verified: product (22 tests green, parses claude-code/codex/opencode),
landing page, install.sh, npm publish workflow, on-chain payment rail with
proven key control, one PR merged into a 13.7k-star repo.

Received: **$0.00**. Nothing has been earned at any point.

Remaining blockers are all outside this session's control:
1. maintainer reply on bounty eligibility (asked, no answer)
2. `npm login` for the package (needs the user's credentials)
3. posting to HN/Reddit/V2EX (all network-blocked here)
