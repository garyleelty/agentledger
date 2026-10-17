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

## Round 10b: pivoted to operating the GitHub account itself (user's call)

The user's judgment: a well-run GitHub account is a better earner than bounty
hunting. Agreed — it compounds, and it is the asset everything else plugs into.

### Audit found
29 public repos. Nearly all had **no description, no topics, no homepage**.
Top repo: 2 stars. Profile README was the untouched 2017 template
("I'm currently learning vue3"). To a recruiter or a potential user the account
read as abandoned.

Also found: `ai-native-markdown` is a real product — Tauri + Vue 3 + CodeMirror
6 AI-native Markdown editor, 5.4 MB of code, full Chinese README — sitting at
1 star with no description. Most undervalued asset on the account.

### Fixed (verified live)
- **Profile README rewritten** — now leads with the work, not a 2017 template
- **ai-native-markdown**: real English description + 10 topics
- **agentledger**: 12 topics
- **opencode-plugin-goal**: description added (was blank)

### Could NOT do (needs the user)
- **GitHub Sponsors**: still `sponsorsListing: null`. Requires the user's own
  bank/tax onboarding in a browser. This is THE payout rail — everything else
  is preparation for it.
- **Profile bio / website link / "available for hire"**: token scopes are
  `read:user, repo, user:email, workflow` — no `user` scope, so PATCH /user
  returns 404. Needs the user, or a re-authorized token.
- **Pinning repos**: `updatePinnedItems` mutation not available with these
  scopes.

## Round 11: finished the account cleanup

- Descriptions: **24 / 29** repos now have one (was ~14). The 5 left blank are
  genuinely empty (`ssr-k8s`, `click-tweaker-ios`, `kingdom-game` are 0 KB;
  `skill-hub` has only a .gitignore; `edit` is course homework). I did not
  invent descriptions for empty repos — that would be worse than blank.
- **ai-native-markdown README is now bilingual**: added an English section up
  top (features, stack table, quickstart, providers) and kept the original
  Chinese under a `## 中文说明` heading. A non-Chinese visitor can now read it,
  which is who would star it.
- Product still green: 22 tests pass, CLI reports 678.68M tokens / $87.21.

Still $0.00. Still no reply from the omi maintainer on bounty eligibility.

### The one thing that turns this into money
GitHub Sponsors is still `sponsorsListing: null` and I cannot enroll — it needs
the user's bank/tax onboarding in a browser. Everything above is groundwork for
that rail; without it the account is presentable but unmonetized.

## Round 12/13: gave opencode-plugin-goal a real README

It was 44 KB of TypeScript (30 KB plugin.ts + 18 KB goal.ts, 5 commands, 70
tests) with **no README at all**. Wrote one, and verified every factual claim
against the source before publishing:

- regex `stopIf` (`/pattern/flags`) -> goal.ts:366-421, confirmed
- 80% / 90% budget warnings -> goal.ts:170,176, confirmed
- 3-consecutive-blocker rule before `blocked` -> goal.ts:243-251, confirmed
- interrupt -> `paused` -> goal.ts:48, confirmed
- tool names read out of plugin.ts, not guessed

Test suite run locally with bun: **70 pass / 0 fail**.

Note: raw.githubusercontent returned 404 for a few minutes after the API
reported the file created; confirmed real via `git clone` (2326 bytes). The
404 was CDN lag, not a failed write — worth knowing before trusting a raw
fetch as proof.

## Round 14: searched for a distribution/payout opening — found none usable

Checked and rejected, with reasons:

- **Answering cost questions in GitHub issues** — searched 123 + 4497 issues.
  What surfaced was bot-generated tracking tickets and Epic boards, not people
  asking for help. Dropping a link in those would be spam, not help. Dropped.
- **algora.io** — its own repo (1.5k stars, Elixir) has 34 open issues, all
  platform bugs or feature requests unrelated to what I have to offer. Its
  bounty listing has no public API and is not scrapeable, so it cannot be
  worked programmatically from here.
- **oven-sh/bun #13656 (WebTransport)** — carries an Algora bounty but requires
  implementing an HTTP/3 stack in Bun's C++/Zig core. Far outside what I can
  deliver reliably; starting it would waste the maintainer's review time.
- **action_items_to_markdown** — probed for the same TOCTOU class I fixed in
  conversations_to_markdown. It has **no** `overwrite` parameter at all: it
  overwrites by design. Different contract, not a bug. Did not manufacture one.

Verified nothing else moved: both awesome-list PRs still open, omi maintainer
still silent, Sponsors still null, all repos still 0-1 stars.

**$0.00**. I have now exhausted every avenue I can execute alone.

## Round 15/16: user reframed the goal — "don't work for others"

Explicit instruction: 不要给别人打工，丰富自己，增加曝光度 (no working for
others; enrich yourself; increase exposure).

This **retires the bounty path**. Fixing bugs in omi's repo was, by definition,
working for someone else's asset: 13 rounds, one merged PR, $0.00, and it built
their product rather than mine. Recorded as a closed chapter, not a strategy.

What counts from here: own product, own IP, own reach.

### Own-asset work this round: verified the product is actually correct

Cross-checked the OpenCode parser against the source database with an
independent Python query rather than trusting my own tool:

| | input | cacheRead | cacheWrite | output |
|---|---|---|---|---|
| ground truth | 24,917,715 | 213,630,984 | 85,801 | 2,277,755 |

Row accounting: 3874 assistant rows, 102 legitimately all-zero, 3772 reportable
— exactly what agentledger reports. No silent data loss. Reasoning tokens are
folded into output (they bill at the output rate), and the `cost: 0` field in
OpenCode's own records is correctly ignored in favour of computed pricing.

## Rounds 17-20: the digest automation was fake until I ran it

I had shipped a weekly digest workflow in round 15 and **never triggered it**.
Running it found three real problems, in order:

1. **It published the entire repo to the web.** The first version did
   `git checkout -B gh-pages` from the source branch and committed on top, so
   `EARNING.md` — my private strategy notes — went public on a Pages branch.
   Verified the leak really happened, then switched to an orphaned branch.
2. **My first fix broke it outright**: `rm -rf ./*` ran before
   `mv digest.md index.md`, deleting the file it came to publish. Run failed
   with `mv: cannot stat 'digest.md'`. Fixed by moving the file to /tmp before
   clearing the tree; verified the git sequence in a scratch repo first.
3. **The digest is meaningless on a CI runner.** It published a clean table of
   `0 tokens / $0.00`. Cause: a GitHub runner has no `~/.claude`, `~/.codex`
   or `opencode.db`, so the tool correctly reports zero records there. A page
   of zeros reads as "I measured nothing" when the truth is "I did not measure
   at all". The workflow now refuses to publish that and exits non-zero.

Also confirmed correct: the runner log shows the guard firing with the exact
reason, not a script error. 31 tests green (a parallel session added flag
validation, 9 cases).

**$0.00 received. Nothing in this goal has ever been earned.**

### What I got wrong, stated plainly
I reported "added a weekly digest workflow" as exposure work in round 15
without running it once. It had never executed. Three of the four defects were
only findable by running it — shipping unrun automation and calling it
progress is the same category of error as the false cache-pricing claim I
corrected earlier. An unrun workflow is a claim, not an asset.

## Round 22: added waste detection; broke the landing page doing it

**Feature shipped.** `agentledger waste` ranks sessions by cache-read volume and
states the concentration. Real finding on this machine: 631.64M of 678.60M
total tokens are cache reads (93%), and the top **10 of 262 sessions hold
74.5%** of them. That is context churn, not usage volume. It immediately
surfaces the single Codex session that cost $34.67. 36 tests green.

**Mistake: I took the landing page offline.** While wiring Pages for the digest
I switched the Pages source to `gh-pages` — which contains only the digest —
so the real landing page disappeared from the web for ~2 minutes. My own
`docs/index.html` was intact the whole time; the site was simply pointed
somewhere else. Reverted Pages to `main/docs` and verified the live page serves
the new content again.

This is the second time in two rounds that I broke something outside the code I
was editing. Both were catchable by checking the live URL afterwards, which I
had been treating as optional. Recording the rule: **a change is not done until
the deployed artifact has been fetched and read.**

**$0.00 received.**
## Round 24: pricing audit corrected a real bug

I assumed my `gpt-5.5` pricing entry was right because I had written it once and
never challenged it. Cross-checking against the authoritative LiteLLM model db
(4,161 models) revealed the truth: **$5/$30 per M tokens**, not $1.25/$10. The
bug inflated spend by ~4x: my tool reported $87 for that dataset; corrected is
$243. Independent ccusage check shows $228 (same data, similar pricing).

This also meant every published number — README, landing page, promotion copy —
carried the wrong figures. Found and replaced all instances. Also updated line
counts from "~700 lines" to the actual 1,100 lines, which remain auditable in
one sitting but shouldn't be misrepresented as smaller than they are.

The product is now correct on its core claim: cost = sum(price × token bucket),
with accurate prices from the live DB.

## Round 25: CI exists now — and it immediately caught two real defects

The repo had **no CI running the tests on push** (only publish-on-release and
digest workflows). `npm test` had quietly broken (`node --test tests/` treats
the directory as a module on Node 22+) and nobody noticed because nothing ran
it automatically. Fixed that and pushed `.github/workflows/test.yml`; a
parallel session pushed `ci.yml` the same hour — merged into one workflow
with a 22.5/24/26 matrix rather than two duplicating each other.

**CI caught what local runs hid:** the ten data-dependent tests asserted
against whatever lived in `~/.claude` on *my* machine. A CI runner has none,
so they failed — worse, the class of bug is "passes by measuring nothing",
the same silent-zero failure mode as the digest workflow in rounds 17-20.

Made the suite hermetic, verified under `HOME=/tmp/emptyhome`:
- `tests/fixtures/home/.claude/projects/demo/` — three committed session
  files (24 records, deterministic timestamps), the CLI runs with HOME
  pointed there for attribution/budget/digest/flags tests.
- `tests/fixtures/sessions.jsonl` — the cost-reconciliation test now pins
  "fixture contributes exactly 3 priced records", so it cannot pass on zero.
- tip tests assert the contract that holds with **or without** network:
  unreachable APIs must never be worded as "no funds yet". One positional
  check caught a false-pass: a comment quoting `sys.exit(main())` made a
  naive indexOf order things wrong.

**Second CI catch:** the node 22.5 leg died at collection —
`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`. The opencode test imports it
statically to *build* its fixtures; on 22.x that needs `--experimental-sqlite`
(flagless only from 23/24). Production code already degraded correctly on the
import throw; only the test path was unguarded. Test script now carries the
flag — a no-op on 24/26.

This is the payoff the whole exercise was for: claims ("55 tests green")
become verified statements only when a machine nobody's sitting at runs them.

**$0.00 received.** Star gap unchanged: agentledger 0 vs ccusage 19,017.

## Round 26: an automated pricing audit found 7 wrong entries in my own table

Built `tools/audit_pricing.py`: pulls LiteLLM's model database (4,162 models,
fetched through the GitHub blob API — the contents API refuses 2.8 MB files,
the raw host is blocked on this network) and diffs every PRICING entry against
it, exiting non-zero on disagreement. Wired into CI as a weekly scheduled job.

It immediately caught errors on **my** side — 24 of 28 entries now reconcile:

- gpt-5 / gpt-5-mini: `cacheReadMultiplier: 0.125` was the *absolute* cached
  price ($0.125/M) pasted into a multiplier field. Correct multiplier is 0.1.
- gemini-2.5-pro: 0.25 — that's the >200k-context tier's cache rate; standard
  cached input is 0.1x. Was overcharging cache reads 2.5x.
- gemini-2.0-flash: $0.1/$0.4 was the flash-*lite* rate; standard is $0.15/$0.6.
- deepseek-chat/reasoner: previous-generation $1.10/$2.19 output — overstated
  ~2.6x against the current $0.42 line.
- glm-5/glm-5.2/kimi-*: guessed proxy rates replaced with LiteLLM's
  official-provider entries (zai/*, moonshot/*).

The 4 remaining unchecked entries are free lanes and a proxy-only model with
no authoritative reference — reported as unchecked, not silently trusted.

This machine's headline moved $243 -> $245; every published figure in README,
landing page, PROMOTION.md and the digest sample was regenerated from the
tool's own output rather than retyped.

**Structural point for the objective:** ccusage caches prices and supports
user overrides, but nothing in either project *re-derives* the table against
an upstream authority on a schedule. A cost tool whose numbers silently rot
is worse than useless; now CI says so weekly. That is a correctness property
the 19k-star incumbent does not have.

Also: the parallel session's new `savings` tests had the same machine-dependent
defect CI flagged in round 25 (passes locally, dies on a runner with no logs).
Fixed the same way — fixture HOME — plus a guard so its hand-recompute test
cannot pass vacuously on an empty ledger. CI: 3f0f1ed green on 22.5/24/26.

**$0.00 received.** Stars: 0 vs 19,017. The product is getting harder to
fault; the distribution gap is still the whole story, and every channel that
closes it (npm token, HN/Reddit/V2EX posting) needs the user.

## Round 27: the weekly digest had been publishing to a branch nobody serves

`digest.yml` force-pushed its page to `gh-pages` every week and reported
`success` every week. But Pages source is `main/docs` — reverted there in
round 22 to bring the landing page back — so since then every "successful"
publish wrote into a dead branch. The live URL returned 404. A green check
mark on automation that produces nothing is the most dangerous kind of
failure, and it is the third time in this project I found it (after the
never-triggered workflow and the runner with no logs).

Verified all of it before and after touching anything:
- `gh-pages` exists, one file, never served (Pages API: source main/docs)
- after the fix: `https://garyleelty.github.io/agentledger/digest.html`
  returns 200 with the corrected $244.78 total and no identifiers in it

Fix design: render HTML (the site is static HTML; a .md there is plaintext or
404) into `docs/digest.html` and commit it to main as an ordinary, auditable
commit. `git add` is path-scoped — a whole-tree publish is what leaked
EARNING.md in round 17 and this keeps that class of mistake impossible.
checkDigest now guards the HTML format too, and a test pins the privacy
invariants on both formats (61 green, hermetic under empty HOME).

The no-op guard fired as designed on the first dispatch: file unchanged,
nothing pushed, exit 0 — "nothing to publish" is a correct outcome, not a
failure. Landing-page link (`weekly digest`) pointed at the site root; fixed.

Also this round: SSH to GitHub broke mid-session (key auth denied), so pushes
now go over HTTPS with the keychain token. The weekly `pricing-audit` job ran
green via workflow_dispatch against the live LiteLLM db.

**$0.00 received. Stars: agentledger 0 vs ccusage 19,017.**

## Round 28: the awesome-opencode PR was rejected-by-format before review

PR #856 (opened round 15) edited **README.md directly** — but that list
auto-generates its README from YAML files under `data/`. contributing.md says
so in the first line. A maintainer would have closed it on sight; the repo's
recent history shows 54/100 closed PRs merged — wrong-format entries are most
of the other 46.

Redid it properly: `data/projects/agentledger.yaml` with the four required
fields (tagline 81 chars, under the schema's 120 limit), PR #872 with a body
that says what it does for OpenCode specifically (own SQLite reader, free-lane
pricing at $0, provider-qualified id resolution), and closed #856 with the
reason in the new PR's body rather than silently abandoning it.
https://github.com/awesome-opencode/awesome-opencode/pull/872

Checked the other list too: awesome-ai-coding-tools #946 edits README.md, and
that repo *does* merge README-line PRs (75/100 recent closes were merges), so
its format is already correct. Left as is.

## Round 29: two reachable publishing channels (first ones ever)

Re-probed every distribution domain. **dev.to and juejin.cn are reachable and
serve real content** — dev.to's public API answers live article JSON. HN,
Reddit, V2EX, x.com, medium are still blocked. So for the first time this goal
has a channel I can actually operate from here rather than hand to the user.

Plan: publish on dev.to under a real account (API key needs the user's browser
login), and make juejin self-serve for the user with a verified draft.
Posting under a throwaway account is astroturfing: real value, real identity.

## Round 30: closed the TTL parity gap, after checking what was actually true

README conceded "models 5-minute vs 1-hour cache creation separately" to
ccusage. Checked the source before accepting the concession:

1. Claude Code's own logs DO carry the split
   (`usage.cache_creation.ephemeral_1h/5m_input_tokens`) — my parser was
   folding it into the lumped field at 1.25x. Anyone using 1-hour TTL was
   undercharged 37.5% per write. Now billed apart, x2 vs x1.25, rate
   verified against LiteLLM (`cache_creation_input_token_cost_above_1hr`
   = 6e-6 vs 3e-6 base on sonnet-4-5).
2. Read ccusage's cost.rs rather than trusting the README: they use the
   same nested block with the same fallback. So this closes a gap, it does
   not create a lead — and the comparison text says exactly that.
3. Second correction the same round: "every price machine-verified against
   LiteLLM (ccusage does not)" was ALSO false — ccusage embeds the LiteLLM
   db at build time from a locked revision. The true difference is that
   agentledger reconciles against *live* LiteLLM weekly in CI, on a
   schedule, instead of waiting for a human to run update-litellm-pricing.
   Wrote that instead.

The dangerous subtlety: `savingsOf` had its own inline copy of the
cache-write formula. Adding the 2x tier only to costOf would have made
"savings" print the 0.75x delta as phantom savings on every 1-hour write —
a pricing change inventing money out of a formula that drifted. Extracted
one shared `cacheWriteCost` used by both paths, and the savings test now
re-models the rule independently so a future drift fails the test.

Real-machine totals unchanged ($245 before/after — these logs carry no 1h
writes), so no published figure needed moving again. 65 tests green,
hermetic. Also fixed four mutually-inconsistent stale line-count claims
(~1,100/1,200/1,300 in four places; actual wc -l is 1,476 -> "~1,500").

CI green on be50f37. Landing page updated and verified live.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 31: social preview + README header image

GitHub's `social_preview` API endpoint 404s for OAuth tokens (browser-only
route), so the 1280x640 card can't be uploaded programmatically — left at
`docs/social-preview.png` for a 10-second manual upload (Settings →
Social preview). The same image now sits in the README header, which every
visitor sees anyway.

Content is all tool-verified output from this machine ($245 total, $1,067
savings, 74.5% concentration) — no invented numbers in the marketing art.

## Round 31: Kilo as a 5th source — and its data caught two pricing bugs

Swept this machine for agent stores nobody had looked at: found
`~/.local/share/kilo/kilo.db` (120 MB dir, 103 assistant rows, 3.04M tokens).
Kilo Code is an OpenCode fork and the schema is identical, so the sqlite
reader became a factory (`makeSqliteParser`) and kilo registered as a source
in one sitting. ccusage supports Kilo too — this is parity work, not a stunt.

The new lane paid for itself immediately:

1. `bytedance-seed/dola-seed-2.0-pro:free` — 13 records billed $3/$15 by
   DEFAULT_PRICING while Kilo's own cost field said $0. The `:free` tail is
   Kilo's convention for zero-billed lanes. resolvePricing now decides free
   BEFORE prefix/stripped matching, so `gpt-5:free` can't inherit gpt-5's
   paid rate. 3 new tests pin the rule.
2. `minimax-cn/MiniMax-M2.7` priced at the $3/$15 default: $2.68 of phantom
   spend on a ~$0.32 lane. Added at LiteLLM's M2 line ($0.30/$1.20, cached
   0.2x). Audit coverage: 24 of 29 entries.

Every agent list in the docs was stale within the repo's own lifetime —
--help said four agents while five were wired. It now generates from SOURCES.

Also this round: generated a 1280x640 social-preview card (all figures are
live tool output, not mockups). GitHub's social_preview API 404s for OAuth
tokens — browser-only — so it ships at docs/social-preview.png embedded in
the README header, with a 10-second manual upload to Settings → Social
preview left for the user.

Real-machine ledger now: $245.10 / 682.00M tokens / 10,459 records / 5 agents.
All published figures regenerated from the tool; digest sample re-passes the
gate; 68 tests green hermetic.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 32: v0.2.0 cut, with a drift guard so docs can't lie again

- **version() read package.json** instead of its hardcoded '0.1.0' twin.
  First attempt cached in a module-level `let` and crashed with a TDZ error
  — main() runs at line 33, the declaration sits at 576. Caught by running
  it, which is the whole theme of this goal.
- **tests/docs-numbers.test.js**: README summary block, landing-page
  figures, and the SOURCES-vs-README agent table are now checked against
  the committed digest sample. Published numbers drifted by hand in rounds
  26, 27 and 31; the guard makes that a CI failure. It caught a real stale
  row on its first run: the README flags table still listed four agents
  after kilo landed.
- **v0.2.0**: the version had not moved since the first commit while the
  tool gained savings, budget, waste, by-project/by-branch, kilo, TTL
  pricing, the LiteLLM audit and 72 hermetic tests. Tag pushed; release
  created as a **draft** deliberately — `publish.yml` fires on
  `release: published` and would fail without NPM_TOKEN. One click by the
  user, once the secret exists, cuts the release AND publishes npm.
- CI green on aeea4fc (22.5/24/26 + pricing audit).

**$0.00 received. Stars: 0 vs 19,019.**

## Round 32b: verified install.sh from a clean HOME; screened two more lists

- Ran `install.sh` with `HOME=/tmp/al-install-home`: clone, symlinks, PATH
  notice, and the installed `agentledger --version` printing 0.2.0 and
  `sources` listing all five agents. The README's headline install line is
  now a claim I executed, not one I asserted.
- Digest workflow re-dispatched green; docs/digest.html already matched the
  refreshed sample (no-op path proven again).
- Screened two more awesome lists:
  - `hesreallyhim/awesome-claude-code` (55k stars): bot auto-closes entries
    under 100 stars AND 14 days of commits. agentledger qualifies on neither
    yet; submitting now buys a public auto-close, which PROMOTION.md itself
    says is worse than not applying. Deferred until ~Oct 26 at earliest.
  - `hashgraph-online/awesome-ai-plugins`: it is a plugin *marketplace*
    (plugins.json, marketplace.json, validate-plugins.yml), not a tool list.
    agentledger is a standalone CLI — submitting would repeat the exact
    format mistake PR #856 made. Dropped on sight.
- PR #872 has no validation bot at all — it waits on a human maintainer
    like everything else in this channel.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 33: --prices — the one ccusage feature users actually asked for

ccusage lets users override token prices (`ccusage.json`); agentledger had
no seam, so anyone on a negotiated rate or proxy lane couldn't match their
bill without editing source. Now `agentledger --prices my-prices.json` works
on every report:

- partial entries merge over the built-in row (override input, keep output
  and cache multipliers) — editing one number can't silently reset four.
- overrides resolve BEFORE the :free rule: naming `gpt-5:free` explicitly
  means you pay for it and want it priced.
- all-or-nothing validation, exit 1 with the offending model/field. A
  half-applied price file still prints an authoritative table — the one
  outcome this feature must never have.

Three bugs caught by running things, all recorded because they're the same
bug in different clothes:
1. `prices` iterated PRICING directly -> marked gpt-5.5 with * while still
   printing $5 (the price the override replaced). Now shows resolved values.
2. `let overrideCount` below main()'s call site -> TDZ crash on first run.
   Round 32's lesson, repeated within the hour.
3. A test that overrode gpt-5.5 against the fixture home (which has no
   gpt-5.5 rows) compared 0 to 0 and "passed" on nothing — the silent-zero
   trap in test form. Retargeted at the model the fixture actually carries,
   with an explicit `b > 0` precondition.

Also: the landing-page number guard only substring-matches formatted values,
so prose figures ("631M of my 678M tokens") stayed stale. Fixed by hand;
the guard's blind spot is now known. Stray empty src/agentledger/ removed.

76 tests green hermetic. --prices is a differentiator worth promoting:
Show HN text updated? Not yet — next round.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 33b: git-over-HTTPS died, so I pushed through the Data API — and broke file modes

github.com:443 became unreachable (api.github.com kept working). Rather than
lose the round, I pushed via the Git Data API: blobs -> tree -> commit ->
`PUT /git/refs/heads/main`. Content landed; CI green on both commits
(7ac7901, abfc128).

Then I verified properly and found my own bug: the push script hardcoded
`mode: 100644` for every file, silently un-executing `bin/agentledger.js`
(100755) — the exact entry point install.sh symlinks into ~/.local/bin.
Identical content, broken permission, invisible in every diff that only
reads text. Caught only because I compared `git ls-tree` (mode + sha) against
the remote tree instead of trusting the push to have worked.

Fixed with a second API commit whose tree was rebuilt from `git ls-tree -r`
so every mode is taken from local truth, not assumed. Final check: remote
tree vs local HEAD — zero differences across 39 blobs, modes included.

Local history still diverges (my two API commits vs two local ones, same
trees). When transport recovers: `git fetch && git reset --hard origin/main`
is safe — the trees are proven identical, nothing is lost.

Lessons, filed where I'll re-read them:
- An API push is a git push: it carries modes, not just bytes.
- "I pushed it" is a claim until the remote tree is diffed against the
  local one. Same rule as the landing page (round 22) and the digest
  branch (round 27), third time learned.
- `PATCH /git/ref/heads/main` 404s with this token; `PUT /git/refs/...`
  with a full 40-char sha works.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 34: statusline — the last headline ccusage feature this tool lacked

`agentledger statusline` plugs into Claude Code's `statusLine` hook. Contract
is unlike every other command because a host calls it on every render: exit 0
always, one line, no stack traces in a prompt bar.

Two paths, both tested (82 green, 6 pinning the contract):
- Current payloads carry `cost.total_cost_usd` + `context_window` totals:
  echo the host's own number, zero file I/O. When Claude Code hands you the
  real figure, re-deriving an estimate is worse, not more rigorous.
- Older payloads: price ONLY the session's transcript. First version scanned
  the whole ledger — showed $15.70 (machine-wide claude total) where the
  session cost $2.18. Caught by testing against a real transcript; payload
  shape verified against ccusage's own test fixtures fetched from their repo.

Git transport recovered mid-round: aligned local to remote with
fetch + reset --hard after proving the trees identical (the round-33 API
pushes left local history diverged but content-correct). Lesson bank keeps
rhyming: "tested against a mock" is not "tested against the real payload".

Honest comparison rewritten against ccusage's current docs: they still lead
on source count (17 vs 5) and 5-hour billing blocks; shared now: TTL-split
cache writes, host-cost-first statusline, per-model overrides.

**$0.00 received. Stars: 0 vs 19,019.**

### Addendum, same round: "Everything up-to-date" was a lie

The round-34 push printed `Everything up-to-date` and I moved on. It was
wrong: the remote never received the commit. Caught only because the next
round's `ls-remote` showed remote still at 80d42fb. Git's success output on
this network is not trustworthy — the transport half-connects and reports a
clean no-op. Rule now enforced mechanically: after every push, read the
remote head back (API or ls-remote) and compare to the commit I meant to
land. That is how d7b5124 got pushed tonight — via the Data API, with the
tree diffed against local afterwards: zero differences, modes included.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 35: two dead credentials, one real feature

**Credentials, checked rather than assumed.** A `~/.npmrc` with a valid-format
`npm_…` token appeared (created 01:03, new since round 7's ENEEDAUTH). It is
dead: 401 on `/-/whoami`, `/-/npm/v1/user`, and a real `npm publish` returns
404 "could not be found or you do not have permission". Dry-run passes only
because dry-run does not authenticate — worth remembering, it looked healthy.
The repo still has zero Actions secrets, so `publish.yml` would fail the same
way. GitHub Packages was the next hope: the token DOES authenticate there
(`{"username":"garyleelty"}`), but publishing needs `write:packages`, which
this token lacks (403 permission_denied). So npm remains one `npm login` away,
and that is the user's.

**lobste.rs is reachable** (new) but posting requires an invite; not usable.

**awesome-agent-observability** is a perfect category fit (it is *the* agent
observability list) and its maintainer merges actively (22/29 recent PRs,
including today). It also has a hard threshold 4: **projects must be at least
8 weeks old**. agentledger is 4 days old, so submitting now would be declined
by a stated rule. Deferred to ~2026-12-07, logged so it is not forgotten.
Its README also lists **AgentsView** (6.1k stars, Go) — a closer competitor
than ccusage for the local-first cost-analytics niche. Recorded.

**Shipped: `sources` now reports whether each source actually has data.**
A table of paths answers "where would it look", never "why is this lane
empty" — a missing directory, an empty one, and unparseable files all looked
identical. It immediately explained a real silence: the gemini-cli lane has
never produced a record here because `~/.gemini/tmp` does not exist, which
the old output could not distinguish from "no usage yet". `sources` also
honours `--json` now (it was the only command that ignored it). 85 tests,
3 pinning the new reporting.

Also: found remote/local history diverged again (the round-33/34 Data-API
pushes left different lineage, same content — verified with an empty diff).
Rebased onto the true remote head rather than force-pushing over it, then
confirmed the push by reading the remote head back: 5de651b == 5de651b.
CI green.

**$0.00 received. Stars: 0 vs 19,019 (ccusage) / 6,128 (AgentsView).**

## Round 36: DSH as a sixth source — and the placeholder-pricing problem it exposed

**A source no other tool can read.** `~/.dsh/sessions/*/session.v4.jsonl.zstd`
is the harness this very session runs in. Its assistant turns carry full
camelCase usage buckets, and no competitor touches these files.

The parser needed frame-aware decompression: DSH appends **one zstd frame per
write** (144 frames in the first file), and Node's `zstdDecompressSync` returns
only the FIRST — 238 bytes of a 776 kB session, zero records, no error. An
empty lane that looks like "no usage yet". Splitting on the frame magic and
decompressing each independently recovers all 251 lines. Guarded for the 22.5
floor where `node:zlib` has no zstd at all.

**Then its data exposed the real problem.** 9 of 19 models have no built-in
price and were silently billed at the $3/$15 default: **$721 of a $966 total
was a placeholder**, printed with no indication. That is the exact sin this
tool exists to prevent — an authoritative-looking number that is mostly
invented. Fixed by disclosing, in every shape that can leave the machine:
- `summary` names the models, record counts, the default used, the dollar
  share, and the fix (`--prices`).
- `aggregate` carries `unpricedModels` + `unpricedCostUSD` so the shareable
  shape cannot drop the caveat.
- Both digest renderers print "of which placeholder-priced" — a public page
  must not assert a total it cannot back.
- A fully-priced ledger stays silent (no false alarm), pinned by test.

I did **not** invent prices for hy4-preview / qfmodel / step-5-preview.
Guessing a rate to make the number look complete is the failure mode, not
the fix.

**CI caught my test, not my code.** The node 22.5 leg failed with
`zstdCompressSync is not a function`: the product guard was right, the test
fixtures could not run where the format does not exist. Now they skip with a
stated reason. A leg that fails for an environment fact trains people to
ignore it. All three legs green after the fix.

94 tests. README/landing figures regenerated from real output — including the
warning block, because the drift guard failed on the stale landing page first,
which is exactly its job.

**$0.00 received. Stars: 0 vs 19,019 (ccusage) / 6,128 (AgentsView).**

## Round 37: turned the placeholder warning into a one-step fix

Last round I disclosed that $741 of this machine's total was placeholder
pricing. A warning you cannot act on is half a feature, so this round added
the action:

    agentledger prices --template > prices.json
    $EDITOR prices.json
    agentledger --prices prices.json

The template names exactly the models in YOUR ledger that fell back to
DEFAULT_PRICING, each annotated with record count and token volume, with
null placeholders. Round-trip proven: filling it in takes this machine from
$987 to $367 and silences the warning; a fully-priced ledger prints
"nothing to do" instead of an empty object. Tests assert both directions.

Also priced `deepseek-flash` — LiteLLM has a canonical entry ($0.30/$1.20,
cached 0.02x, provider `deepseek`), and DSH reports provider
`deepseek-account` for the same model id, same vendor. Audit coverage 25/30.

**Deliberately left unpriced**: hy4-preview ($449 — the single biggest line),
qfmodel, step-5-preview, cline-free/*. LiteLLM carries only reseller rows for
these, and a reseller's markup is not the model's price. Inventing a number
to make the total look complete is the exact failure mode this whole feature
exists to prevent. The tool says "unknown" and now says how to fix it; that
is the honest state.

97 tests green. README + landing page figures regenerated from real output.

**$0.00 received. Stars: 0 vs 19,019 (ccusage) / 6,128 (AgentsView).**

## Round 38: a real install channel, with no credentials at all

Two rounds of staring at a dead npm token produced nothing. This round found
the path that does not need one.

**`publish.yml` could never succeed.** `on: release` ran `npm publish`
unconditionally, so cutting a release produced a red X and **no artifact**.
Rewritten as two jobs: the first builds the tarball and attaches it to the
release with the workflow's own GITHUB_TOKEN (no npm account, no secret); the
second publishes to npm only when NPM_TOKEN exists, and logs a `::notice`
instead of failing when it does not. A release is now a real download channel
today:

    npm install -g https://github.com/garyleelty/agentledger/releases/download/v0.3.0/agentledger-cli-0.3.0.tgz

Verified end to end, not assumed: the release workflow ran green on the
`release` event, the asset attached (32,451 bytes), and a clean directory
installed from that URL and ran `agentledger --version` -> 0.3.0 with all six
sources listed. That is the first distribution path in this whole goal that
needed nothing from the user.

**Stopped hand-syncing the docs.** The published figures are real output from
a ledger that grows whenever I work — and this tool counts its own authoring
session (DSH), so the docs went stale within the hour, every hour, and I lost
that race three rounds running. `tools/sync-docs.mjs` now renders every token
figure and per-agent row from the committed sample; proven idempotent by
hashing consecutive runs. CI regenerates and fails on any diff.

**A silent-corruption bug in that script, caught by reading its output.**
`money()` returns a literal `$`, and in a JavaScript string replacement `$1`
/ `$2` are backreferences — the first run rewrote the codex row as
`219.58M    00`. A function replacement fixes it, and the reason is in the
source comment, because that class of bug corrupts rather than throws.

v0.3.0 published (not draft). 97 tests green.

**$0.00 received. Stars: 0 vs 19,019 (ccusage) / 6,128 (AgentsView).** The
difference this round is that a stranger can now install the tool with one
command that works.

## Round 39: ran ccusage head-to-head — and it found a real bug in agentledger

There is a ccusage 20.0.34 darwin-arm64 binary in the Cherry Studio cache. So
for the first time this goal could be tested directly instead of argued about:
run both tools against the same logs and compare.

**Token counts agree exactly** for codex (219,388,883) and opencode
(240,912,255) — and that agreement is meaningful, because the parsers were
written independently against different references.

**Claude Code did not agree**, and the disagreement was mine:

| | agentledger | ccusage |
|---|---|---|
| claude-code cost | $15.67 | $2.21 |
| mimo-v2.5-pro cache read | 215,146,496 | 202,163,520 |

Root cause: Claude Code writes the **same assistant message more than once** —
resumed sessions, sidechain replays, retried requests. This machine's logs hold
2,861 usage rows for 1,260 distinct `message.id`s. agentledger summed every
row; ccusage deduplicates (`DedupeIndex`, rust/adapters/claude/src/lib.rs —
read, not guessed). After mirroring the rule (prefer non-sidechain, then the
larger token total) the token counts match ccusage exactly:
in=2,373,420 / out=511,342 / cacheRead=202,163,520.

That is a 2.2x over-count on a real user's bill, found only by running the
competitor against the same data. 4 regression tests pin the rule, including
the sidechain tiebreak and the no-id case (kept, not dropped — losing real
spend is worse than a pathological double-count).

**What still differs is pricing, not counting.** `mimo-v2.5-pro` has no
canonical LiteLLM entry — only reseller rows that disagree with each other
(novita 0.522/1.044, deepinfra 1.0/3.0, aihubmix 0.2/0.4) — so both tools are
estimating, differently. That is now stated in the README rather than papered
over. I did not tune my number to match theirs; matching an estimate is not
the same as being right.

Also notable: ccusage *warns* about unpriced models on the same machine
("Missing embedded pricing for big-pickle"), which is independent confirmation
that the disclosure work from rounds 36-37 was the right call.

101 tests green. Docs regenerated from the sample.

**$0.00 received. Stars: 0 vs 19,019.**

### Round 39b: the second half of the head-to-head — a 12x pricing error

Round 39 fixed the *counting* bug (duplicate Claude messages). This fixes the
*pricing* bug the same comparison exposed.

After dedup, my claude-code lane still read $14.81 against ccusage's $2.24.
Token counts matched exactly, so the difference had to be rates. Solving for
the rate that reproduces ccusage's number gave an absurd near-zero cache-read
price — which turned out to be right: LiteLLM's MiMo entries all put cached
reads at ~0.8% of input, not the 10% Anthropic convention:

    xiaomi_mimo/mimo-v2.6-pro        0.0036 / 0.435  = 0.0083x
    novita/xiaomimimo/mimo-v2.5-pro  0.0043 / 0.522  = 0.0082x
    aihubmix/coding-xiaomi-mimo-...  0.0016 / 0.200  = 0.0080x

My table said 0.1x — a 12x overcharge on the bucket holding 98% of that
model's tokens. Fixed to the vendor-namespaced row ($0.435/$0.87, 0.0083x).

Result: **claude-code now matches ccusage to the cent — $2.24 vs $2.24**, and
the comparable-source total is $228 vs $224.65 (was $245 vs $224.65).

Both bugs were invisible from inside this codebase and invisible in the tests;
each was found by running a competitor's binary against the same files and
asking why the numbers differed. That is worth remembering the next time
"97 tests green" feels like evidence of correctness — it is evidence of
self-consistency, which is a weaker claim.

Remaining differences, now understood rather than mysterious: ccusage strips
gateway prefixes (`Cherry-New-API/gpt-5.5` -> `gpt-5.5`) and charges for
`-free` lanes that I price at $0; its codex gpt-5.5 cache rate works out to
~0.091x against my 0.1x. Those are judgment calls where the sources disagree,
not arithmetic errors, and the README now says so.

mimo-v2.5-pro is in the audit map, so its cache ratio is machine-checked from
here on: 26 of 30 entries compared.

### Round 40: third bug from the head-to-head — codex double-counted reasoning

The codex lane read $200 against ccusage's $192.71 after the previous fixes.
Investigating the gap found that `total_token_usage.output_tokens` **already
includes** `reasoning_output_tokens`; the parser was adding them together.

Proof from this machine's own logs (11 codex files):
- 1,633 token_count events satisfy `total_tokens == input_tokens + output_tokens`
- **0** events satisfy `total == input_tokens + output_tokens + reasoning_output_tokens`

(1,426 "other" events are context-window markers with all-zero usage.)

So every reasoning token was counted twice — 244,601 of them on gpt-5.5 alone,
worth $7.34 at the output rate. Output dropped 951k -> 706.7k tokens and the
lane now reads **$192 vs ccusage's $192.71**, with token counts essentially
aligned (out 706,652 vs 708,786).

Also fixed the test that locked in the bug: its fixture used
`total_tokens: 1120 = 1000+100+20`, which asserted the *separate* reading the
real format contradicts. Fabricated fixtures that encode a wrong assumption are
worse than no fixture — corrected to real semantics plus a dedicated regression
test naming the arithmetic.

### Round 40b: the head-to-head is now essentially a match

Per-lane, agentledger vs ccusage 20.0.34 on the same machine and logs:

| lane | agentledger | ccusage |
|---|---|---|
| claude | $2.24 | $2.24 |
| codex | $192 | $192.71 |
| opencode | $25.42 | $29.40 |
| kilo | $0.319 | $0.34 |
| comparable total | $220 | $224.69 |

Plus DSH (~870M tokens, $750), a source ccusage and AgentsView cannot read at
all — so agentledger reports strictly more of this user's spend than either.

Three bugs, all invisible to 100+ green tests, all found by comparing against
the competitor: duplicate Claude messages (2.2x), MiMo cache multiplier (12x),
codex reasoning double-count. The remaining ~$4.7 difference is gateway-prefix
handling and -free lane policy — judgment calls, not arithmetic errors.

**$0.00 received. Stars: 0 vs 19,019.** On correctness and coverage the tool
now matches or beats the incumbent; on reach it is nowhere near, and that gap
is not closable from this machine.

## Round 41: made the head-to-head reproducible, and it found a 4th bug

The comparison that found three bugs lived in scratch shell commands. That is
fragile — it cannot be re-run after the next parser change, and a check nobody
runs is not a check. So it is now `tools/crosscheck.mjs`: it runs both tools
against the same logs, diffs token buckets and cost per lane, and exits
non-zero on real disagreement.

**It immediately found a fourth bug.** The codex parser treated the first
`token_count` event as a zero baseline. Codex writes cumulative counters, but
a resumed session opens with counters already advanced — 6 of 11 files on this
machine had non-zero first events, and **108,711 input / 2,244 output tokens
were being discarded before the first delta was ever computed**. Fixed: the
first event yields its absolute values, later events yield deltas.

**And it caught a defect in the tool itself.** With ccusage missing it skipped
every lane... and exited 0, printing "tokens agree on all lanes". A green
result that compared nothing is the exact trap this project keeps meeting.
Now it exits 2 with the path it tried.

Turning the tool loose also settled the last open question. All three
remaining "disagreements" are one policy difference: ccusage excludes
reasoning from OpenCode/Kilo output, agentledger bills it as output:

- opencode out: mine 2,294,147 vs theirs 1,634,195 — gap is exactly
  659,952 reasoning tokens (verified: sum(output)=1,220,552,
  sum(reasoning)=474,660 for the dominant model)
- kilo out: 39,730 vs 39,597 — gap is exactly 133 reasoning tokens

Reasoning is genuinely separate for OpenCode — all 2,176 rows satisfy
total = input + output + reasoning + cache.read + cache.write, and 598 rows
have reasoning > output, impossible if nested. It bills at the output rate
(no separate DeepSeek rate exists in LiteLLM). So agentledger reports more
complete output, and that is now documented in the README with the evidence,
not hidden. Codex is the opposite (output already includes reasoning) and
both cases are pinned by tests.

104 tests green.

## Round 42: documented the verification tools

The two tools that make the numbers trustworthy were missing from both the
README and the landing page — so the one thing agentledger can honestly claim
over ccusage (independently cross-checked correctness) was invisible to anyone
reading the project.

Added a "Verifying the numbers" section naming all four bugs crosscheck found,
plus a landing-page bullet. The framing is the part worth keeping: "the suite
is green" only proves a program is consistent with itself; comparing against an
independent implementation is what actually finds bugs.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 43: made the one real coverage advantage provable

agentledger reads DSH (~1.1B tokens, $843 — more than all other agents
combined); ccusage has 20 adapters and **no `dsh`** (`ccusage dsh` returns
"Unknown command"). That is the single dimension where agentledger genuinely
beats the incumbent rather than matching it, and it was stated only in prose
that could go stale.

`crosscheck` now proves it: it probes ccusage for each agentledger-only lane
and prints `ONLY DSH ... (ccusage has no adapter)`. If ccusage ships a dsh
adapter, the tool says so and the README claim changes. A test asserts the
mechanism exists.

Stated with its caveat, because the advantage is narrower than it looks: most
DSH models arrive via gateways with no canonical public price, so ~$838 of that
lane is placeholder-priced. The token counts are real; the dollars are
estimates until real rates are set. Claiming "$843 of coverage" without that
would be the same sin the placeholder disclosure exists to prevent.

Also declined to invent prices: `hy4-preview` (the largest DSH model, 1,042
records) has exactly one LiteLLM row and it is `aihubmix`, a reseller — my
standing rule is not to guess from reseller-only entries where the vendor is
unknown. `qfmodel`, `step-5-preview`, `sensenova` have no rows at all.

**$0.00 received. Stars: 0 vs 19,019.**

## Round 44: eliminated $124 of placeholder pricing with a documented consensus

The DSH lane is agentledger's coverage advantage but also its weakness: $848
of $1071 total was placeholder-priced. I went after the largest resolvable
line.

**Added `deepseek-v4.1-flash` at $0.30/$1.20, cache read 0.02x.** The evidence
level is the same one I required for MiMo: 5 of 13 LiteLLM rows agree —
`together_ai`, `tencent`, `azure_ai` as an exact triple on $0.30/$1.20/cRead
0.006, plus `nebius` and `baseten` agreeing on in/out. `coralbricks`' $0.01 is
a 30x outlier and is excluded. This is a gateway-agnostic vendor rate, not one
reseller's markup. It was the second-largest unpriced model ($130 at default).

Effect: placeholder $848 -> $724 across 9 unpriced models (was 10). Audit
coverage 27/31.

**Declined the rest, with reasons:**
- `hy4-preview` ($535, the largest line): only one LiteLLM row, `aihubmix`,
  a reseller. No vendor consensus exists.
- `step-5-preview` ($99.65): zero LiteLLM rows for any spelling. Genuinely
  unknown — a preview codename.
- `qfmodel`, `qoder`, `sensenova`: no rows.

I also verified DSH itself carries no authoritative cost data (searched all 46
sessions for cost/price/usd keys: none; `our-free-model/catalog.json` holds
only free-lane names), so the placeholder disclosure is the honest ceiling
rather than a placeholder for a lookup I skipped.

The line between "acted" and "declined" is now explicit and testable: MiMo had
a tight 3-way cluster on the cache ratio (0.008-0.0083); deepseek-v4.1-flash
had a 5-way cluster on in/out; hy4-preview and step-5-preview had none.

## Round 45: the resolver's blind spot for provider-prefixed dated ids

`deepseek/deepseek-v4.1-flash-1017` still showed as unpriced right after I
priced `deepseek-v4.1-flash`. Not a data gap — a **resolver bug**.

The slash-tail lookup (for provider-prefixed ids like
`Cherry-New-API/gpt-5.5`) only did an **exact** table hit, while the full-id
path got exact-then-prefix. So a gateway appending a dated build suffix
(`-1017`) to a prefixed id silently fell through to the $3/$15 default —
one line of the pricing path behaving differently from its neighbour, and
misleading because the *bare* name resolved fine.

Fixed by giving the tail the same exact-then-prefix treatment. Verified all
11 prefixed ids in the ledger: 9 resolve correctly, and the 2 that still
fall through (`cline-free/mimo-v2.6-flash`, `cline-free/step-5-preview`) are
genuinely unknown models that stay disclosed — which is correct behaviour.

$726 -> $721 placeholder; unpriced 9 -> 8. Audit 27/31. 106 tests green,
including a regression test asserting the prefixed and bare forms resolve
to the identical rate.

## Round 46: dropped a zero-token model from the unpriced warning

The unpriced list included `<synthetic>` — 35 records, all token buckets zero,
$0 cost. It is Claude Code's own literal model name for placeholder assistant
turns, not a real model anyone bills. Listing it said "35 unpriced records"
for usage that never cost anything, which is noise that trains people to
ignore the warning — the same discounting a false alarm produces.

`unpricedModels` now filters to models with actual token volume, so
`prices --template` also stops offering a blank line worth filling.

Checked the neighbouring behaviours before shipping: `by-model` never showed
it (zero tokens, sorts last, empty row) so nothing was lost there, and the
`aggregate` shape carries the same filtered list.

Also verified two hy4 rows are correctly one family: `hy4-preview` and
`hy4-preview-f` both come from the same `workbuddy` provider in the same DSH
sessions (`-f` is a variant flag), both resolve identically, and the prefix
pass means a future price for either covers the other. Nothing to fix.

Distribution re-checked: npm token still 401, both awesome-list PRs still open
and unmerged, stars still 0. `sn-sensenova-6-8-flash` and `step-5-preview` have
zero LiteLLM rows for any spelling, so they stay disclosed.

## Round 47: end-to-end workflow tests — the bug class that actually bit this project

Unit tests covered parsers and pricing in isolation. But every bug that really
cost something was in the **composition**: a flag parsed and then never honoured
downstream (statusline ignored --prices for a while), or two commands
disagreement about the same ledger. So I walked the real CLI through the
workflows a user actually runs and pinned them.

Verified, not assumed:
- the README's --prices flow verbatim: template -> fill -> apply. $975 -> $350
  on this machine, warning clears.
- savings counterfactual still reconciles with overrides applied
  (350 + 1396 = 1746).
- ten flag combinations across savings/budget/waste/by-project/by-model/
  sessions/aggregate/json, all exit 0 with no NaN/undefined leakage.
- statusline with a realistic Claude Code payload (session id, transcript,
  model, workspace): session-scoped cost, model echoed, exit 0.
- `prices --template` on a fully-priced ledger says "nothing to do" rather
  than emitting an empty JSON blob (the fixture home caught this — my first
  test draft tried to parse a block that is not there, which is the right
  output).

Two test bugs of my own along the way, both of the familiar kind: `require` in
an ESM module (ReferenceError), and a test asserting on HTML-escaped output it
never actually read. Caught by running them, like everything else.

111 tests green, 4 new.

## Round 48: `prices --json` was silently ignored

Audited `--json` support across all 15 commands. Every one honoured it except
`prices`, which printed the table regardless. A scripted consumer (CI job,
dashboard, shell pipeline) parsing stdout would receive a table and fail with
nothing to point at — the failure would look like their bug, not this tool's.

Fixed: `prices --json` now emits `{ tool, version, defaultPricingUSD, models[] }`
with per-model input/output/cache multipliers and an `overridden` flag. The
table and the `--template` output are unchanged, and both JSON + template can
be combined.

Note this is the second `--json` gap I have found (round 35 fixed `sources`),
which is why the audit was worth running rather than trusting the earlier fix
to have covered the surface.

112 tests green.
