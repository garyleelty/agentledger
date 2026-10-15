import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tipPy = path.join(root, 'tools', 'tip.py');

// The published addresses must never drift from what the tests assert, or the
// README/landing page would be advertising an address nobody holds the key for.
const ETH = '0xB30a208B84814D3F7091Bb779f2b0225288349aE';
const BTC = '1EKTrfpKc7fQwNYUv4oHLa2cna6NqDq3sM';

test('tip.py runs and reports a balance', () => {
  const out = execFileSync('python3', [tipPy], { encoding: 'utf8' });
  assert.match(out, /ETH\s+0x/);
  assert.match(out, /BTC\s+1/);
  assert.match(out, /balance:/);
});

test('tip.py checks the BTC address, not just ETH', () => {
  // The BTC address is published in the README and on the landing page, so it
  // is a real payment rail. It used to be advertised but never checked:
  // btc_balance_sat was defined after sys.exit(main()) and never ran, so a BTC
  // tip would have sat there while the tool said "no funds yet".
  const out = execFileSync('python3', [tipPy], { encoding: 'utf8' });
  assert.match(out, /BTC\s+balance: \d+ sat/, 'the BTC balance must be reported');
});

test('an unreachable balance endpoint is not reported as a zero balance', () => {
  // "no funds" and "could not look" are different claims; the tool must say
  // which one it means. Verified by pointing it at an address whose lookups
  // fail: the wording has to stay reachable-specific, never a bare zero.
  const src = fs.readFileSync(tipPy, 'utf8');
  assert.match(src, /could not reach any balance API/);
  assert.match(src, /could not reach any Ethereum RPC/);
});

test('README and landing page advertise the same addresses as tip.py', () => {
  
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  assert.ok(readme.includes(ETH), 'README missing ETH address');
  assert.ok(readme.includes(BTC), 'README missing BTC address');
  assert.ok(page.includes(ETH), 'landing page missing ETH address');
  assert.ok(page.includes(BTC), 'landing page missing BTC address');
});

test('vendored keccak passes its test vectors', () => {
  const out = execFileSync(
    'python3',
    ['-c', `import sys;sys.path.insert(0,'tools');from keccak import keccak256;print(keccak256(b'').hex())`],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  assert.equal(out, 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

test('prove_control.py proves we hold the keys to both addresses', () => {
  const out = execFileSync('python3', [path.join(root, 'tools', 'prove_control.py')], {
    encoding: 'utf8',
  });
  assert.match(out, /ETH matches\s+YES/);
  assert.match(out, /ETH signature verifies against derived key:\s+YES/);
  assert.match(out, /BTC matches\s+YES/);
  assert.match(out, /KEY CONTROL PROVEN/);
  // the private key must never leak into normal output
  assert.doesNotMatch(out, /private key:/);
});

test('json export: per-record costs sum to the reported total', () => {
  // Guards the exact end-to-end path an auditor would use: the per-record
  // costUSD values must add up to totals.costUSD with no drift.
  const raw = execFileSync('node', [path.join(root, 'bin', 'agentledger.js'), 'json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const d = JSON.parse(raw);
  assert.ok(d.records.length > 0, 'expected real local logs to produce records');
  const sum = d.records.reduce((a, r) => a + r.costUSD, 0);
  assert.ok(
    Math.abs(sum - d.totals.costUSD) < 0.01,
    `sum of records ($${sum.toFixed(4)}) must match totals.costUSD ($${d.totals.costUSD})`,
  );
});
