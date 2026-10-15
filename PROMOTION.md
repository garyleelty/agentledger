# Promotion kit

The machine this was built on cannot reach news.ycombinator.com, reddit.com,
v2ex.com or linux.do (all DNS/connect blocked), so these posts could not be
submitted automatically. They are written to be pasted as-is.

Pick **one** channel first — Show HN is the highest-leverage one, but dev.to
and juejin are now reachable from the build machine (verified 2026-10-16:
both serve real content; dev.to even has a working API once you have a key).
If you (the maintainer) get a dev.to API key or a juejin login, sections 5
and 6 below can be published directly.

---

## 1. Show HN (news.ycombinator.com/submit)

**Title** (≤80 chars, "Show HN:" is added by the form):

```
Show HN: Agentledger – what your coding agents actually cost, from their local logs
```

**URL:** `https://github.com/garyleelty/agentledger`

**Text** (optional, but a good first comment raises the odds a lot):

```
I run Claude Code and Codex on API billing and had no idea what I was spending
until the invoice arrived. So I wrote a thing that reads the session logs they
already leave on disk.

    $ npx agentledger-cli

      agentledger — 73 session files scanned

      Metric         Tokens   Est. cost
      Input tokens   43.21M   $92.49
      Cache read     631.64M  $120
      Output tokens  3.75M    $32.55
      TOTAL          678.68M  $245

      Agent        Tokens   Est. cost  Records
      codex        219.58M  $200       3053
      opencode     240.83M  $28.64     3772
      claude-code  218.19M  $15.70     3531

One Codex session had quietly burned $118. I had no idea.

Two things surprised me. First, cache reads dominate everything: 631M of 678M
total tokens. Second, they are badly concentrated — the top 10 sessions out of
262 hold 74.5% of all cache reads. That is not "I used it a lot", that is
context churn: one long session kept re-sending its prefix, and a single Codex
session cost $118 by itself.

    agentledger waste        # where the cache-read spend actually went
    agentledger by-branch    # what one branch cost
    agentledger by-project   # what one repo cost

The `web` branch alone was $206.

To be fair up front: ccusage (19k stars) already does this, covers more
agents, and prefers Claude's own costUSD field. I am not claiming to beat it.
I wanted a tool small enough to read end to end that I could read end to end, and
that makes no network calls at all.

It reads ~/.claude/projects, ~/.codex/sessions and ~/.gemini/tmp read-only,
has zero dependencies (Node 18+ stdlib only), and makes no network calls at
all — I made that a hard rule because the input is your entire coding history.
~1,500 lines, so it is auditable in one sitting.

Costs are estimates from public per-million-token prices; they won't match a
subscription plan or a negotiated rate, and I say so in the README.

MIT. No paid tier, no license keys, no telemetry.
```

**Timing:** submit Tue–Thu, 8–10am US Eastern. Be around for 2 hours after;
most Show HNs die from unanswered questions in the first hour.

---

## 2. Reddit — r/ClaudeAI or r/ChatGPTProlD (pick ONE, read the rules first)

**Title:**

```
Built a local-only CLI that shows what your Claude Code / Codex sessions actually cost
```

**Body:**

```
Posting this because I got an unpleasant invoice and could not find a tool
that answered a simple question: how much did that session just cost?

agentledger reads the JSONL logs Claude Code, Codex CLI and Gemini CLI already
write locally and turns them into token and dollar totals. No account, no API
key, no network calls — it only opens files read-only, which mattered to me
because those logs contain my whole coding history.

The thing most tools get wrong: cache tokens. In my own logs, cache reads are
631M out of 678M total tokens. If you bill those as input you are off by
roughly 10x on that bucket. agentledger prices cache read / cache write /
fresh input separately.

    npx agentledger-cli
    agentledger-cli by-model
    agentledger-cli by-day -d 30
    agentledger-cli sessions -n 20
    agentledger-cli watch

Zero dependencies, Node 18+, MIT. GitHub link in the comments if the spam
filter eats top-level links.

Caveat I want to be upfront about: these are estimates from public per-M-token
prices. If you are on Claude Pro/Max or ChatGPT Plus this will not match your
bill, and it does not model discounts.
```

---

## 3. V2EX (v2ex.com/new/post) — node 程序员 or 分享创造

**标题：**

```
写了个小工具：读本地日志，算出 Claude Code / Codex 到底花了多少钱
```

**正文：**

```
起因是收到账单，发现完全不知道钱花在哪了。

agentledger 读 Claude Code、Codex CLI、Gemini CLI 已经写在本地的 session
日志（~/.claude/projects、~/.codex/sessions、~/.gemini/tmp），算出 token 和
钱的明细。只读本地文件，零依赖（Node 18+ 标准库），完全不联网 —— 这点对我
很重要，因为那些日志基本等于我的完整编码历史。

有个坑值得说一下：缓存 token。我自己日志里 678M token 中有 631M 是 cache
read（93%）。如果把 cache read 当普通 input 算，那一块会差将近 10 倍。
agentledger 把 fresh input / cache read / cache write / output 分开计价。

    npx agentledger-cli
    agentledger-cli by-model     # 哪个模型最烧钱
    agentledger-cli by-day -d 30 # 每日花费曲线
    agentledger-cli sessions     # 最贵的 session

我这边跑出来的结果：单个 Codex session 烧了 $118，之前完全没察觉。

MIT，没有付费版，没有 telemetry。

需要说明的是这是估算，用的是公开的单 token 价格；如果你用的是订阅制（Claude
Pro/Max 之类），跟实际账单对不上。
```

---

## 4. If it gets traction

Submit to `hesreallyhim/awesome-claude-code` via their issue form — but only
once it has either 100 stars or 14+ days of commits. Their bot auto-closes
submissions that fail this, and being closed looks worse than not applying.


---

## 5. dev.to (reachable — needs an API key from https://dev.to/settings/account)

Title:

```
What your coding agents actually cost — reading their local logs, no cloud
```

Tags: `ai`, `clawdbot` no — use `ai`, `development`, `coding`, `opensource`.
Body = the Show HN text from section 1, with this closer added:

```
The tool: https://github.com/garyleelty/agentledger
Install (verified, no npm account needed):
    npm install -g git+https://github.com/garyleelty/agentledger.git
Zero dependencies, MIT, and it never makes a network call — the input is
your entire coding history.
```

Publish once via API, then iterate on the tags/cover image by hand.

## 6. 稀土掘金 juejin.cn (reachable — needs browser login, Chinese draft ready)

标题：

```
写了个本地工具，读 Agent 日志算清楚 Claude Code / Codex 到底花了多少钱
```

分类「程序员」，标签：AI编程、开源、工具。正文用第 3 节 V2EX 中文稿，
外加两句：

```
补充两点新进展：
1. 内置价格表每周在 CI 里和 LiteLLM 模型库自动对账（tools/audit_pricing.py），
   价格过期会直接让构建失败——上个月它抓出我自己写错的 7 个价格。
2. Anthropic 的 1 小时缓存写入按 2 倍计价（5 分钟是 1.25 倍），
   agentledger 现在从日志里的 cache_creation 嵌套字段分开计费。

安装（不需要 npm 账号，实测可用）：
    npm install -g git+https://github.com/garyleelty/agentledger.git
GitHub: https://github.com/garyleelty/agentledger
```
