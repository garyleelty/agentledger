# agentledger

![agentledger — what your coding agents actually cost](docs/social-preview.png)

**What did that agent actually cost you?**

`agentledger-cli` is a local-first ledger for AI coding agents. It reads the
session logs that Claude Code, Codex, OpenCode, Kilo, DSH, OpenClaw, pi-agent,
Cherry Studio, and Gemini CLI already write to your machine and turns them
into tokens and dollars.

```
$ agentledger

  agentledger — 231 session files scanned

  Metric         Tokens   Est. cost
  ─────────────  ───────  ─────────
  Input tokens   314.52M  $796
  Cache read     2.15B    $318
  Cache write    366.4k   $0.0842
  Output tokens  8.83M    $54.73
  TOTAL          2.47B    $1169

  Agent        Tokens   Est. cost  Records
  ───────────  ───────  ─────────  ───────
  dsh          1.72B    $954       6994
  codex        219.45M  $193       3059
  opencode     295.84M  $25.42     4298
  claude-code  205.05M  $2.24      1462
  cherry-studio 765.8k $1.63      29
  openclaw     31.39M   $1.28      959
  kilo         3.32M    $0.3186    103
  pi           47.7k    $0.0000    5

  ! 10 model(s) have no built-in price and used the
    $3/$15 per-Mtok default ($949 of the total):
      step-5-preview  (1766 records)
      hy4-preview  (1554 records)
      ...
    Fix in one step: `agentledger prices --template` prints a
    fill-in override file for exactly these models.
```

*(That is a real run on the machine it was written on — including the warning,
which is the point of it. Most of that total is placeholder-priced, and the
tool says so rather than letting you quote it.)*

## Why

If you pay per token for your agents, your bill is a lagging indicator. By the
time you see it you have already spent it. `agentledger-cli` gives you the number
while you are still working:

- **Local only.** It reads `~/.claude/projects`, `~/.codex/sessions`,
  `~/.local/share/opencode`, `~/.dsh/sessions`, `~/.openclaw/agents`,
  `~/.pi/agent/sessions`,
  `~/Library/Application Support/CherryStudio/Data`, and `~/.gemini/tmp`.
  Nothing is uploaded, no account, no API key, no network call of any kind.
- **Cache buckets are priced separately.** Cache reads and cache writes bill at
  different rates from fresh input, and they are the majority of real traffic —
  2.00B of the 2.32B tokens in my own logs are cache reads.
- **Fast.** A full scan of ~2.3B tokens of logs takes about a second.
- **Boring dependencies.** Node 22.5+ and the standard library. That's it.

- **Cost attribution.** Codex records the working directory and branch in
  `session_meta`; Claude Code records `cwd` and `gitBranch`; OpenCode's store
  joins messages to sessions. `by-project` and `by-branch` price each of those
  separately, so you can see what a feature branch actually cost rather than
  only what a model cost. Grouping is lossless — per-project costs sum back to
  the grand total, and a test asserts it.

- **Waste you can act on.** Cache reads dominate real agent traffic — 1.93B of
  2.23B tokens on the machine this was written on. `waste` ranks sessions by
  cache-read volume and states what share the top few hold, which points at
  context churn (a long session re-sending its prefix, or a tool returning
  large output every turn) rather than at "usage went up".

### Honest comparison

[ccusage](https://github.com/ccusage/ccusage) is the incumbent and it covers
more agents than this (19 adapters against our 9). It reports reasoning
token **counts** but does not bill them in the OpenCode or Kilo lanes — on the
kilo store `sum(reasoning)` is 133 tokens and ccusage's output total is
`sum(output)` alone, 39,597 against agentledger's 39,730 — and its statusline
shows 5-hour billing blocks and burn rate. Its pricing also comes from LiteLLM's database, embedded at build
time from a locked revision. If you want the most complete tool, use that
one. What we share now: TTL-split cache writes, a statusline that prefers
the host's own session cost over any estimate, and per-model overrides.

Where this differs, as far as I can tell: agentledger's table is a checked-in
static file that a CI job reconciles against **live** LiteLLM weekly — a stale
entry fails a build on a schedule instead of waiting for a manual
`update-litellm-pricing`; `savings` prices the counterfactual (what the same
ledger would have cost with no prompt caching); and the whole tool is ~2,500
lines of zero-dependency JavaScript with no build step, no runtime fetch, and
no network call of any kind.

**One source ccusage cannot read at all.** ccusage has 19 adapters
and **no `dsh` adapter** — `ccusage dsh` returns `Unknown command`. `crosscheck`
reports this automatically rather than trusting prose:

```
  ONLY DSH (DeepSeek Harness) — 1471043240 tokens, $856.72 (ccusage has no adapter)
```

DSH
(DeepSeek Harness) keeps multi-frame zstd sessions at
`~/.dsh/sessions/*/session.v4.jsonl.zstd`; on this machine that is 49 sessions
and ~1.47B tokens, more than every other agent combined. Caveat stated plainly:
most DSH models reach it through gateways with no canonical public price, so a
large share of that lane is placeholder-priced and the report says so. The
token *counts* are real; the dollars in that lane are estimates until you set
real rates with `--prices`.

**Two lanes where ccusage reports $0.00 for every model.** On this machine its
OpenClaw lane reads 31.39M tokens and prices all of it at zero — neither
`glm-4.7:cloud` nor `stepfun/step-3.5-flash:free` is in its embedded table.
agentledger prices `glm-4.7:cloud` from six LiteLLM vendor rows that agree
exactly on $0.60/$2.20 (`zai/glm-4.7`, `novita/zai-org/glm-4.7`,
`novita/zai-org/glm-4.7-h`, `baseten/zai-org/GLM-4.7`,
`vertex_ai/zai-org/glm-4.7-maas`, `zai.glm-4.7`), which is $1.28 of real spend
on this machine's logs. `crosscheck` names that case instead of folding it
into a percentage, because "they say $0" and "we disagree" are different facts.

**Reasoning tokens are billed as output.** OpenCode records them in a separate
`tokens.reasoning` field; verified on this machine that `total = input +
output + reasoning + cache.read + cache.write` holds for all 2,176 rows that
have reasoning, so they are additive and bill at the output rate. (Codex is
the opposite: its `output_tokens` already includes reasoning, and adding the
field again double-counted 244,601 tokens. Both cases are pinned by tests.
ccusage excludes reasoning from OpenCode's output bucket, so it reports lower
output there — 1,220,552 against agentledger's 1,695,212 for the same model.)
pi and OpenClaw keep the same field, and the same rule applies: pi's 800
reasoning tokens bill as output where ccusage drops them.

**Measured against ccusage on the same machine** (ccusage 20.0.34, darwin
arm64, run against the same `~/.claude/projects`, `~/.codex/sessions`,
`opencode.db`, `~/.pi/agent/sessions` and `~/.openclaw`): token counts agree
exactly for codex (219,388,883), opencode (240,912,255), pi (19,254 /
21,191 / 25,472) and openclaw (28,319,456 / 614,261 / 2,457,344), and for
Claude Code after the fix below
(in=2,373,420 / out=511,342 / cache read=202,163,520 for the largest model).
That head-to-head is also how a real bug surfaced: Claude Code re-emits the
same assistant message (resumed sessions, sidechain replays, retries) and this
tool was summing every row — 2,861 rows for 1,260 distinct message ids, a 2.2x
over-count that reported $15.67 for a lane costing ~$2.21. It now deduplicates
on `message.id` with ccusage's rule (prefer non-sidechain, then more tokens).
Where the totals still differ it is pricing, not counting: `mimo-v2.5-pro` has
no canonical LiteLLM entry (only reseller rows that disagree with each other),
so this tool's rate for it is an estimate and ccusage's is a different one.

agentledger exists because I wanted something I could read end to end.
Whether that trade is worth it is your call, not mine.

It still makes no network call of any kind — no telemetry, no update check, no
pricing fetch. The one thing it does ask of the runtime is `node:sqlite`, which
is part of Node itself.

## Install

From a release tarball (no npm account, no registry, no build step):

```bash
npm install -g https://github.com/garyleelty/agentledger/releases/download/v0.4.0/agentledger-cli-0.4.0.tgz
```

The tarball is attached to each release by the release workflow using the
repo's own token, so this path works whether or not the package is on the
registry. Verified: installed from that URL and ran `agentledger --version`.

Or with npm, straight from the repository:

```bash
npm install -g git+https://github.com/garyleelty/agentledger.git   # install
npx --package=git+https://github.com/garyleelty/agentledger.git agentledger  # run once
```

All of these give you `agentledger` and `aledger`.

Or one line, with no npm involvement at all:

```bash
curl -fsSL https://raw.githubusercontent.com/garyleelty/agentledger/main/install.sh | sh
```

That clones into `~/.agentledger` and symlinks `agentledger` (and the shorter
`aledger`) into `~/.local/bin`, printing the `PATH` line to add if
`~/.local/bin` is not already on yours. Upgrade with
`git -C ~/.agentledger pull`, or just re-run the installer.

Or run it straight from a clone, no install step at all:

```bash
git clone https://github.com/garyleelty/agentledger.git && cd agentledger
node bin/agentledger.js
```

> **The registry package is not published yet.** `npx agentledger-cli` fails
> with a 404 because `agentledger-cli` is not on npm; publishing still needs a
> token with 2FA bypass. The `git+https` form above is the way to install
> through npm until that lands. This README will lead with `npx agentledger-cli`
> once the package is actually there.

Requires **Node 22.5+** — the OpenCode lane reads a SQLite database and
`node:sqlite`'s `DatabaseSync` landed in 22.5.

## Usage

```bash
agentledger-cli summary         # totals + per-agent breakdown (also the default with no args)
agentledger-cli sources         # which sources have data on this machine
agentledger-cli by-project      # cost per repository / working directory
agentledger-cli by-branch       # cost per git branch
agentledger-cli waste           # where the cache-read spend is concentrated
agentledger-cli savings         # what prompt caching saved, priced against no cache
agentledger-cli by-model        # which model is eating your budget
agentledger-cli by-day -d 30    # daily spend curve
agentledger-cli sessions -n 20  # most expensive sessions
agentledger-cli budget -b 100   # spend against a limit
agentledger-cli statusline      # one line for Claude Code's status bar
agentledger-cli watch           # live totals, refreshes every 5s
agentledger-cli prices          # the built-in pricing table
agentledger-cli aggregate       # shareable totals + groupings, no session ids
agentledger-cli share -o page.html   # the same, as a self-contained HTML page
agentledger-cli json            # machine-readable dump
```

### Budget

Every other command reports what already happened. `budget` is the one that
answers the question you actually have while working — am I about to go over:

```
$ agentledger budget -b 100

  budget    $100
  spent     $1090   ████████████████████████  1089.5%
  remaining $0.0000   OVER by $990

  run rate  $4.13/day  over 264.0 days of activity
            already $990 over.
```

The run rate is measured over the span of data you actually have, not a
calendar period: a ledger that covers three months but was only used for two
days should not report a three-month run rate. `--json` emits the same numbers
plus the window, which is the shape a statusline or a CI gate wants:

```bash
agentledger budget -b 100 --json | jq '{spent: .spentUSD, over: .over, perDay: .runRateUSDPerDay}'
```

An overrun is reported as `over: true` with `daysUntilRunOut: null`, rather
than a misleading projection.

### Statusline

`statusline` is for Claude Code's status bar. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "agentledger statusline",
    "padding": 0
  }
}
```

Claude Code pipes it a JSON payload on every render. When the payload carries
the session's own cost (current versions do), agentledger echoes that number —
the host's own measurement beats any estimate, and no files are read, so the
bar never stutters. On older payloads it prices just the session's transcript
file, not the whole ledger. It always exits 0 and prints exactly one line: a
statusline that can break your prompt bar is a statusline you delete, so the
degradation paths are tested as hard as the happy one (131 tests, 6 of them
this contract).

### Savings

`budget` tells you what you spent. This tells you what prompt caching saved,
by pricing the same records as though every cache-read token had been billed
at its model's fresh-input rate:

```
$ agentledger savings

  What prompt caching saved

  paid                  $1087
  without cache        $3975
  saved                $2888   72.7% cheaper

  [██████████████████████░░░░░░░░]  72.7% saved

  1.93B of 2.24B tokens came from cache
  (86.5% of the total).
```

That is the theorem behind the whole tool: cache reads are the overwhelming
majority of agent traffic, they bill at a fraction of the input rate, and a
tool that does not price them separately is wrong by an order of magnitude.
`savings` is the same arithmetic run backwards — and the reason a cache-aware
budget matters more than an invoice.

Counted per model at that model's own rates, with no provider-level averaging.

Two JSON shapes, deliberately:

| Command | Use it for | Contents |
| --- | --- | --- |
| `aggregate` | sharing, CI, a digest | totals + per-agent and per-model groupings |
| `json` | debugging, spreadsheets | one row per usage record, **including session ids** |

`json` is the debugging shape. On Claude Code and Codex the session id is a
UUID that names a real log file under the agent's own directory, so a report
built from it publishes a map of your projects. Use `aggregate` for anything
that leaves your machine:

```bash
agentledger-cli aggregate > spend.json     # ~3 kB
agentledger-cli json        > records.json  # one row per record, much larger
```

### share

The ledger is local, so there is nothing to link to — the only shareable
artifact is a snapshot. `share` renders one as a single HTML file: inline CSS,
no scripts, no external requests, opens straight from `file://` and survives a
screenshot.

```bash
agentledger-cli share -o spend.html   # writes the file
agentledger-cli share                 # or prints to stdout
```

Privacy rules are the digest's: aggregates only, never a session id, never a
path. `tests/share.test.js` pins that, plus the offline guarantee (no `<script>`,
no inline handler, no `url()`, no stylesheet link).

Useful flags:

| Flag | Meaning |
| --- | --- |
| `-a, --agent <name>` | only one agent (`claude-code`, `codex`, `opencode`, `kilo`, `dsh`, `gemini-cli`) |
| `-p, --path <dir>` | also scan a directory or single file |
| `--since <date>` | only records at/after a date |
| `-n, --top <n>` | rows in ranked reports |
| `--prices <file>` | override prices from a JSON map (see below) |
| `--json` | JSON instead of a table |

Examples:

```bash
# What did today's Claude Code session cost?
agentledger-cli -a claude-code --since "$(date +%F)" by-day

# Export everything for a spreadsheet
agentledger-cli json > ledger.json

# Pipe into a status line / CI check
agentledger-cli json | jq '.totals.costUSD'
```

### Custom prices (`--prices`)

Every number this tool prints is a list price. If you pay something else —
a negotiated rate, a proxy lane, a regional price — bring your own:

```bash
# my-prices.json — partial entries merge over the built-in row,
# so overriding `input` never resets output or the cache multipliers.
{
  "gpt-5.5": { "input": 4.0, "output": 24.0 },
  "minimax-cn/MiniMax-M2.7": { "input": 0.25, "output": 1.0 },
  "my-gateway-model": { "input": 0.5, "output": 1.5 }
}

agentledger --prices my-prices.json           # any report
agentledger prices --prices my-prices.json    # the table, overrides marked *
```

Overrides win over everything, including the `-free`/`:free` zero-lane rule:
if you name a model explicitly, you meant it. A bad file fails the run with
a clear message — a half-applied price file would still print an
authoritative-looking table, which is the one outcome this feature must
never produce.

Don't want to write the file by hand? Ask for it:

```bash
agentledger prices --template > prices.json   # only the unpriced models, blank
$EDITOR prices.json                           # fill in your rates
agentledger --prices prices.json
```

The template names exactly the models in *your* ledger that fell back to the
default, each with its record count and token volume, so you can see what a
blank line is worth before you go looking up rates.

## Supported agents

| Agent | Logs read | Status |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ |
| OpenCode | `~/.local/share/opencode/opencode.db` | ✅ |
| Kilo | `~/.local/share/kilo/kilo.db` | ✅ |
| DSH (DeepSeek Harness) | `~/.dsh/sessions/*/session.v4.jsonl.zstd` | ✅ |
| OpenClaw | `~/.openclaw/agents/*/sessions/*.jsonl*` | ✅ |
| pi-agent | `~/.pi/agent/sessions/**/*.jsonl` | ✅ |
| Gemini CLI | `~/.gemini/tmp/**/logs.json` | ✅ |
| Cherry Studio | `~/Library/Application Support/CherryStudio/Data/cherrystudio.sqlite` | ✅ |
| Anything else | `--path` + format sniffing | partial |

`agentledger sources` tells you which of those are actually present on your
machine, so an empty lane is never mistaken for a wrong path:

```
$ agentledger sources
  Agent          Log location                                     Here         Docs                                             
  ─────────────  ───────────────────────────────────────────────  ───────────  ─────────────────────────────────────────────────
  claude-code    ~/.claude/projects                               62 file(s)   https://docs.claude.com/en/docs/claude-code      
  codex          ~/.codex/sessions                                11 file(s)   https://github.com/openai/codex                  
  opencode       ~/.local/share/opencode                          1 file(s)    https://opencode.ai/docs                         
  kilo           ~/.local/share/kilo                              1 file(s)    https://kilo.ai                                  
  dsh            ~/.dsh/sessions                                  49 file(s)   https://github.com/deepseek-ai/deepseek-harness  
  gemini-cli     ~/.gemini/tmp                                    not found    https://github.com/google-gemini/gemini-cli      
  pi             ~/.pi/agent/sessions                             5 file(s)    https://github.com/earendil-works/pi-coding-agent
  openclaw       ~/.openclaw/agents                               101 file(s)  https://github.com/clawdbot/clawdbot             
  cherry-studio  ~/Library/Application Support/CherryStudio/Data  1 file(s)    https://www.cherry-ai.com/                       

  8 of 9 sources have data on this machine.
```

`agentledger-cli sources` prints this table with links.

OpenCode and Cherry Studio are the two supported agents whose store is a
SQLite database rather than append-only text. Both are opened read-only — a
running agent is never blocked — and a locked or foreign database is skipped
exactly the way a truncated log line is.

**Cherry Studio needs a dedup rule the others do not.** It is a GUI that
hosts other agents, so it writes a usage row for requests the hosted agent
also logs. On this machine 3 of its 33 rows are the same request as a pi-agent
row with identical token counts (17,858 tokens that would otherwise be counted
twice). The agent's own log wins; the host's copy is dropped. The match is on
the **whole-prompt token total plus the model's family**, within a 2-second
window. Each half was forced by a measurement:

- *Whole-prompt, not input and not output.* The two stores write the same
  request 20-60ms apart, so an exact-timestamp match finds nothing — a
  silent no-op that looks like success. And they bucket differently: pi
  reports input as fresh-only plus a separate cache read, the host reports
  the whole prompt, and the host keeps reasoning out of output while pi
  folds it in (158 vs 204 for the same request). So matching on output
  misses every row that had reasoning.
- *The model's family, because whole-prompt totals collide.* 402 of the
  14,959 distinct whole-prompt values on this machine are shared by two or
  more records, and 739 of those pairs fall inside the 2-second window. A
  prompt-size-only key would therefore be one collision away from deleting
  a legitimate row. The family is the model id with its provider prefix
  removed — `new-api:deepseek-v4.1-flash-free` and
  `deepseek-v4.1-flash-free` are the same model behind two naming
  conventions — so a same-sized prompt from a *different* model can never
  match.

Cherry Studio's other 30 rows are its own — June and July sessions no other
source covers.

Two of the newer adapters share a shape and are worth naming, because both
differences are invisible in a diff and each one silently loses real spend:

- **OpenClaw keeps archives.** Alongside the live `<uuid>.jsonl` files it
  writes `<uuid>.jsonl.reset.<ts>` and `<uuid>.jsonl.deleted.<ts>` siblings —
  on this machine 127 of 959 usage rows and 2.03M input tokens, from sessions
  that were reset mid-run. Matching only bare `.jsonl` would drop them. The
  sibling `openclaw-agent.sqlite` (`transcript_events`) holds the same events,
  so reading both would double-count; only the JSONL is read.
- **pi-agent puts the model on the message.** DSH's usage record has no model
  field at all and needs the preceding `request/header` carried forward; pi
  and OpenClaw carry it on the same record as the usage, and a `model_change`
  event can switch models mid-session, so the per-message value is read
  directly.

## How costs are calculated

Each parser extracts raw token counts, then
[`src/pricing.js`](src/pricing.js) prices them:

```
cost = input            × in-price
     + cacheRead        × in-price × cacheReadMultiplier
     + cacheWrite       × in-price × cacheWriteMultiplier
     + output           × out-price
```

Prices are USD per 1M tokens, snapshotting the public pricing pages. They are
baked into the package so the tool works offline and stays deterministic.
Override a model by editing `PRICING` in `src/pricing.js` — it is a plain
object.

Costs are **estimates**. They do not include subscription plans (Claude Pro /
Max, ChatGPT Plus), discounts, negotiated rates, or taxes. For API-billed usage
they are normally within a few percent.

## Verifying the numbers

Two tools exist to check the tool against the world rather than against
itself. Both are in `tools/` and both run offline.

```bash
python3 tools/audit_pricing.py /path/to/litellm.json   # prices vs LiteLLM
node tools/crosscheck.mjs --ccusage /path/to/ccusage   # totals vs ccusage
```

**`audit_pricing.py`** diffs every built-in price against the authoritative
LiteLLM model database and exits non-zero on disagreement. It runs weekly in
CI. Its first run caught 7 wrong entries in this table, including an absolute
price pasted into a *multiplier* field (gpt-5: cached reads overstated 25%).

**`crosscheck.mjs`** runs agentledger and ccusage against the same logs and
diffs token buckets and cost per lane. This is what found four real bugs that
no amount of internal testing surfaced:

| bug | what it did |
| --- | --- |
| duplicate Claude messages | 2,861 rows for 1,260 message ids — 2.2x over-count |
| MiMo cache multiplier | 0.1x where LiteLLM says ~0.008x — 12x overcharge |
| codex reasoning | `output_tokens` already includes reasoning; adding it double-counted 244,601 tokens |
| codex baseline | first `token_count` is real usage, not zero — 108,711 tokens dropped |

Token buckets must agree exactly (they are counted facts); cost is allowed a
tolerance because two tools estimating models with no canonical price will
legitimately differ.

Neither tool is a substitute for thinking, but "the suite is green" only proves
a program is consistent with itself. Comparing against an independent
implementation is what actually finds bugs.

## Privacy

`agentledger-cli` opens your log files in read mode and writes nothing. There is
no telemetry, no update check, and no code path that can reach the network. You
can verify this in a few minutes — the whole tool is ~2,500 lines with zero
dependencies.

## Contributing

Issues and PRs welcome, especially:

- parsers for other agents (Cursor, Aider, Continue, Amp, …)
- more accurate pricing tables
- a statusline snippet for your shell of choice

## Support

agentledger is MIT-licensed and free forever. If it saved you a surprise bill,
you can send something directly — no account, no signup, no intermediary:

```
ETH  0xB30a208B84814D3F7091Bb779f2b0225288349aE
BTC  1EKTrfpKc7fQwNYUv4oHLa2cna6NqDq3sM
```

Check whether anything has arrived (queries public endpoints, read-only):

```bash
python3 tools/tip.py
```

There is no paid tier, no license key and no ads. Tipping is the only way this
project makes money, and it is entirely optional.

These addresses are not just pasted here — `python3 tools/prove_control.py`
re-derives both from the private key and produces an ECDSA signature that
verifies against the derived public key, so you can confirm they really are
the project's before sending anything.

## License

[MIT](LICENSE).

