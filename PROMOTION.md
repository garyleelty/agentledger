# Promotion kit

The machine this was built on cannot reach news.ycombinator.com, reddit.com,
v2ex.com or linux.do (all DNS/connect blocked), so these posts could not be
submitted automatically. They are written to be pasted as-is.

Pick **one** channel first — Show HN is the highest-leverage one.

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
      Input tokens   18.30M   $20.74
      Cache read     418.01M  $43.58
      Output tokens  1.47M    $10.66
      TOTAL          437.77M  $74.98

      Agent        Tokens   Est. cost  Records
      codex        219.58M  $59.31     3053
      claude-code  218.19M  $15.67     3531

One Codex session had quietly burned $34. I had no idea.

The part that surprised me: cache reads are 418M of those 438M tokens. Most
cost dashboards count cache-read and cache-write tokens as ordinary input,
which wildly misreports the bill. agentledger prices each bucket at its own
rate (cache read is 10% of input on Claude, 12.5% on GPT-5.x).

It reads ~/.claude/projects, ~/.codex/sessions and ~/.gemini/tmp read-only,
has zero dependencies (Node 18+ stdlib only), and makes no network calls at
all — I made that a hard rule because the input is your entire coding history.
~700 lines, so it is auditable in one sitting.

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
418M out of 438M total tokens. If you bill those as input you are off by
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

有个坑值得说一下：缓存 token。我自己日志里 438M token 中有 418M 是 cache
read。如果把 cache read 当普通 input 算，那一块会差将近 10 倍。agentledger
把 fresh input / cache read / cache write / output 分开计价。

    npx agentledger-cli
    agentledger-cli by-model     # 哪个模型最烧钱
    agentledger-cli by-day -d 30 # 每日花费曲线
    agentledger-cli sessions     # 最贵的 session

我这边跑出来的结果：单个 Codex session 烧了 $34，之前完全没察觉。

MIT，没有付费版，没有 telemetry。

需要说明的是这是估算，用的是公开的单 token 价格；如果你用的是订阅制（Claude
Pro/Max 之类），跟实际账单对不上。
```

---

## 4. If it gets traction

Submit to `hesreallyhim/awesome-claude-code` via their issue form — but only
once it has either 100 stars or 14+ days of commits. Their bot auto-closes
submissions that fail this, and being closed looks worse than not applying.
