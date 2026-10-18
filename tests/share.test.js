import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

import { renderShare } from '../bin/share.js';

/**
 * `share` renders the ledger as one self-contained HTML file.
 *
 * The reason it exists as a *renderer* rather than a link: there is nothing to
 * link to. The whole ledger is local, so the only shareable artifact is a
 * snapshot. That makes two properties load-bearing, and they are what these
 * tests pin:
 *
 *   1. **No scripts, no external requests.** A page that fetches a CDN or runs
 *      JS either breaks when opened from disk or leaks the reader. It must
 *      survive `file://` and a screenshot with zero network.
 *   2. **No session id, no file path.** Same rule as `aggregate`/digest — see
 *      tests/digest.test.js, which documents why the session id is sensitive
 *      (it is a UUID in a path that reveals the author's projects).
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');
// Fixture HOME with committed session logs, so assertions do not depend on the
// machine running them (a CI runner has no agent logs).
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');

/** Run the real CLI against the fixtures — the shape under test is the real one. */
const agentledger = (args, opts = {}) =>
  execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: fixtureHome },
    ...opts,
  });

const ledger = () => JSON.parse(agentledger(['aggregate']));

test('share: renders a complete, valid HTML document', () => {
  const html = renderShare(ledger());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  // Balances — an unclosed table is the most common rendering slip.
  for (const tag of ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'style', 'body', 'html']) {
    const open = html.match(new RegExp(`<${tag}[\\s>]`, 'gi'))?.length ?? 0;
    const close = html.match(new RegExp(`</${tag}>`, 'gi'))?.length ?? 0;
    assert.equal(open, close, `<${tag}>: ${open} open vs ${close} close`);
  }
});

test('share: is offline — no scripts, no external requests', () => {
  const html = renderShare(ledger());
  assert.doesNotMatch(html, /<script/i, 'a script tag breaks the offline promise');
  assert.doesNotMatch(html, /\son\w+=/i, 'inline handlers are scripts with another name');
  // Any http(s) URL that is not the attribution link is an external request.
  const urls = [...html.matchAll(/https?:\/\/[^"'\s>)]+/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(urls)],
    ['https://github.com/garyleelty/agentledger'],
    'only the attribution link may be external',
  );
  assert.doesNotMatch(html, /<link\s/i, 'a stylesheet link is an external request');
  assert.doesNotMatch(html, /url\(/, 'CSS url() is an external request');
});

test('share: leaks no session id and no file path', () => {
  const html = renderShare(ledger());
  // UUIDs and home/absolute paths are the two shapes that would de-anonymise.
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(html, /\/(Users|home)\//);
  // The fixture's own directory, spelled out (a plain string is enough here,
  // but the regex form also catches it embedded in a longer path).
  assert.doesNotMatch(html, new RegExp(escapeRe(fixtureHome)));
});

/** escapeRe — make a literal path safe to embed in a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('share: escapes model and agent names instead of injecting them', () => {
  const hostile = {
    totals: { tokens: { input: 1 }, costUSD: 3, records: 2 },
    byAgent: {},
    byModel: {
      '<img src=x onerror=alert(1)>': {
        input: 1, cacheRead: 0, cacheWrite: 0, output: 1, records: 1, costUSD: 1,
      },
      '"quoted"': {
        input: 1, cacheRead: 0, cacheWrite: 0, output: 1, records: 1, costUSD: 2,
      },
    },
  };

  const html = renderShare(hostile);
  // No *live* markup — the raw tag must not survive as an element.
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /onerror="alert/);
  // But it must still be *visible*: escaped, not dropped.
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
});

test('share: totals agree with the aggregate it was built from', () => {
  const l = ledger();
  const html = renderShare(l);
  const cost = `$${l.totals.costUSD.toFixed(2)}`;
  assert.ok(html.includes(cost), `headline should read ${cost}`);
  assert.ok(html.includes(l.totals.records.toLocaleString('en-US')));
});

test('share: survives an empty ledger rather than rendering NaN', () => {
  const empty = {
    tool: 'agentledger',
    totals: { tokens: {}, costUSD: 0, records: 0 },
    byAgent: {},
    byModel: {},
  };
  const html = renderShare(empty);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  assert.match(html, /\$0\.00/);
});

test('share -o: writes the file and reports its size on stderr', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aledger-share-'));
  const out = path.join(dir, 'page.html');
  // execFileSync resolves to *stdout* only. The message is deliberately on
  // stderr (stdout stays clean so `share` can be piped into a file), so it has
  // to be captured through a wrapper rather than read from the return value.
  const stderr = run([cli, 'share', '-o', out], fixtureHome).stderr;
  assert.match(stderr, new RegExp(`wrote ${escapeRe(out)}`));
  assert.match(stderr, /\d+ bytes/);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<script/i);
});

/** run — execute the CLI, capturing stdout/stderr/status without throwing. */
function run(args, home) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
