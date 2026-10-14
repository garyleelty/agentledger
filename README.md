# agentledger

**What did that agent actually cost you?**

`agentledger-cli` is a local-first ledger for AI coding agents. It reads the
session logs that Claude Code, Codex, OpenCode, and Gemini CLI already write
to your machine and turns them into tokens and dollars.

```
$ npx agentledger-cli

  agentledger — 73 session files scanned

  Metric         Tokens   Est. cost
  ─────────────  ───────  ─────────
  Input tokens   18.30M   $20.74
  Cache read     418.01M  $43.58
  Cache write    0        $0.0000
  Output tokens  1.47M    $10.66
  TOTAL          437.77M  $74.98

  Agent        Tokens   Est. cost  Records
  ───────────  ───────  ─────────  ───────
  codex        219.58M  $59.31     3053
  claude-code  218.19M  $15.67     3531
```

*(That is a real run on the machine it was written on.)*

## Why

If you pay per token for your agents, your bill is a lagging indicator. By the
time you see it you have already spent it. `agentledger-cli` gives you the number
while you are still working:

- **Local only.** It reads `~/.claude/projects`, `~/.codex/sessions`,
  `~/.local/share/opencode`, and `~/.gemini/tmp`. Nothing is uploaded, no
  account, no API key, no network call of any kind.
- **Cache buckets are priced separately.** Cache reads and cache writes bill at
  different rates from fresh input, and they are the majority of real traffic —
  418M of the 438M tokens in my own logs were cache reads.
- **Fast.** A full scan of ~180M tokens of logs takes about a second.
- **Boring dependencies.** Node 18+ and the standard library. That's it.

### Honest comparison

[ccusage](https://github.com/ccusage/ccusage) is the incumbent and it is more
capable than this: it covers far more agents, prefers Claude Code's own
`costUSD` field when present, models 5-minute vs 1-hour cache creation
separately, and prices reasoning tokens. If you want the most complete tool,
use that one.

agentledger exists because I wanted something I could read end to end: ~700
lines, zero dependencies, no network, no build step. Whether that trade is
worth it is your call, not mine.

## Install

```bash
# run it once, no install
npx agentledger-cli

# or add it to a project
npm install --save-dev agentledger-cli
```

Prefer not to wait for npm? One line, no npm account involved:

```bash
curl -fsSL https://raw.githubusercontent.com/garyleelty/agentledger/main/install.sh | sh
```

That clones into `~/.agentledger` and symlinks `agentledger` (and the shorter
`aledger`) into `~/.local/bin`, printing the `PATH` line to add if
`~/.local/bin` is not already on yours. Upgrade with
`git -C ~/.agentledger pull`, or just re-run the installer.

## Usage

```bash
agentledger-cli                 # totals + per-agent breakdown
agentledger-cli by-model        # which model is eating your budget
agentledger-cli by-day -d 30    # daily spend curve
agentledger-cli sessions -n 20  # most expensive sessions
agentledger-cli watch           # live totals, refreshes every 5s
agentledger-cli prices          # the built-in pricing table
agentledger-cli json            # machine-readable dump
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `-a, --agent <name>` | only one agent (`claude-code`, `codex`, `opencode`, `gemini-cli`) |
| `-p, --path <dir>` | also scan a directory or single file |
| `--since <date>` | only records at/after a date |
| `-n, --top <n>` | rows in ranked reports |
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

## Supported agents

| Agent | Logs read | Status |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ |
| OpenCode | `~/.local/share/opencode/opencode.db` | ✅ |
| Gemini CLI | `~/.gemini/tmp/**/logs.json` | ✅ |
| Anything else | `--path` + format sniffing | partial |

`agentledger-cli sources` prints this table with links.

OpenCode is the one supported agent whose store is a SQLite database rather
than append-only text. It is opened read-only — a running OpenCode is never
blocked — and a locked or foreign database is skipped exactly the way a
truncated log line is.

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

## Privacy

`agentledger-cli` opens your log files in read mode and writes nothing. There is no
telemetry, no update check, and no code path that can reach the network. You
can verify this in a few minutes — the whole tool is ~700 lines with zero
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

