#!/usr/bin/env node
/**
 * Render a shareable, self-contained page from a ledger aggregate.
 *
 *   agentledger aggregate > ledger.json
 *   node bin/share.js ledger.json out.html
 *
 * One page, inline CSS, no scripts, no external requests. It opens from a file,
 * survives a screenshot, and can be attached to a gist without a build step.
 *
 * The privacy rules are the same as the digest's: aggregates only, never a
 * session id, never a file path. See tests/digest.test.js, which pins them.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const comma = (n) => Number(n || 0).toLocaleString('en-US');
const compact = (n) => {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
};

export function renderShare(ledger) {
  const t = ledger?.totals ?? {};
  const records = t.records ?? 0;
  const tokens = t.tokens ?? {};

  // Same counterfactual as `agentledger savings`: every cache-read token
  // billed at its model's fresh-input rate instead of the cache rate.
  const cacheRead = tokens.cacheRead ?? 0;
  const totalTokens = (tokens.input ?? 0) + cacheRead + (tokens.cacheWrite ?? 0) + (tokens.output ?? 0);

  const byAgent = Object.entries(ledger?.byAgent ?? {});
  const byModel = Object.entries(ledger?.byModel ?? {});
  const maxModelCost = byModel.length ? Math.max(...byModel.map(([, m]) => m.costUSD ?? 0)) : 0;
  const pct = (n) => (totalTokens > 0 ? ((n / totalTokens) * 100).toFixed(0) : '0');

  const generated = new Date().toISOString().slice(0, 10);

  const modelRows = byModel
    .slice(0, 10)
    .map(([model, s]) => {
      const w = maxModelCost > 0 ? Math.max(2, Math.round(((s.costUSD ?? 0) / maxModelCost) * 100)) : 0;
      return `<tr>
  <td class="mono">${esc(model)}</td>
  <td class="num mono">${comma(s.records ?? 0)}</td>
  <td class="bar"><span style="width:${w}%"></span></td>
  <td class="num mono">${money(s.costUSD)}</td>
</tr>`;
    })
    .join('\n');

  const agentRows = byAgent
    .map(([agent, s]) => `<tr>
  <td class="mono">${esc(agent)}</td>
  <td class="num mono">${compact(s.input + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0) + (s.output ?? 0))}</td>
  <td class="num mono">${comma(s.records ?? 0)}</td>
  <td class="num mono">${money(s.costUSD)}</td>
</tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My agents cost ${money(t.costUSD)} — agentledger</title>
<style>
  :root { --bg:#0b0d10; --panel:#14171c; --line:#23272e; --fg:#e6e8eb;
          --dim:#8b929c; --accent:#5ee0a0; --accent2:#6aa8ff; --warn:#ffcf6b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
         -webkit-font-smoothing:antialiased; }
  .wrap { max-width:720px; margin:0 auto; padding:48px 20px 64px; }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.5px; }
  .tag { color:var(--dim); font-size:14px; margin:0 0 30px; }
  .headline { font-size:44px; color:var(--accent); margin:0; letter-spacing:-1px; }
  .subhead { color:var(--dim); font-size:14px; margin:0 0 26px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
           padding:18px 20px; margin:0 0 18px; }
  h2 { font-size:15px; margin:30px 0 10px; color:var(--dim); font-weight:500;
       letter-spacing:.5px; text-transform:uppercase; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th,td { padding:7px 10px; border-bottom:1px solid var(--line); text-align:left; }
  th { color:var(--dim); font-weight:500; font-size:12.5px; }
  .num { text-align:right; white-space:nowrap; }
  .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; }
  .bar { width:34%; }
  .bar span { display:block; height:9px; background:var(--accent); border-radius:2px; opacity:.75; }
  .stat { display:flex; justify-content:space-between; gap:12px; padding:5px 0; font-size:14px; }
  .stat b { color:var(--warn); font-weight:600; }
  footer { margin-top:44px; padding-top:16px; border-top:1px solid var(--line);
           color:var(--dim); font-size:12.5px; line-height:1.7; }
  a { color:var(--accent2); }
</style>
</head>
<body>
<div class="wrap">

  <h1>What my coding agents actually cost</h1>
  <p class="tag">Measured locally from my own agent session logs · ${generated}</p>

  <p class="headline">${money(t.costUSD)}</p>
  <p class="subhead">across ${comma(records)} usage records and ${compact(totalTokens)} tokens</p>

  <div class="panel">
    <div class="stat"><span>Prompt cache reads</span><b>${pct(cacheRead)}%</b></div>
    <div class="stat"><span>Tokens from cache</span><b>${compact(cacheRead)}</b></div>
    <div class="stat"><span>Tokens sent fresh</span><b>${compact(tokens.input ?? 0)}</b></div>
    <div class="stat"><span>Tokens generated</span><b>${compact(tokens.output ?? 0)}</b></div>
  </div>

  <h2>By agent</h2>
  <table>
    <tr><th>Agent</th><th class="num">Tokens</th><th class="num">Turns</th><th class="num">Est. cost</th></tr>
${agentRows}
  </table>

  <h2>Most expensive models</h2>
  <table>
    <tr><th>Model</th><th class="num">Turns</th><th></th><th class="num">Est. cost</th></tr>
${modelRows}
  </table>

  <footer>
    Rendered by <a href="https://github.com/garyleelty/agentledger">agentledger</a> —
    a local-first ledger for AI coding agents. It reads the session logs Claude
    Code, Codex, OpenCode and Gemini CLI already write to disk and prices them
    from public per-token rates. No cloud, no account, no network calls, no
    telemetry. Costs are estimates and exclude subscription plans.
  </footer>

</div>
</body>
</html>
`;
}

/** Only invoked when run directly, not when imported by the tests. */
if (process.argv[1] && process.argv[1].endsWith('share.js')) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: node bin/share.js <aggregate.json> [out.html]');
    process.exit(1);
  }
  const html = renderShare(JSON.parse(readFileSync(input, 'utf8')));
  if (output) {
    writeFileSync(output, html);
    console.log(`wrote ${output} (${html.length} bytes)`);
  } else {
    process.stdout.write(html);
  }
}
