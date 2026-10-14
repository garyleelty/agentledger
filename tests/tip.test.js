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
