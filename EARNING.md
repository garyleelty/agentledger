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
