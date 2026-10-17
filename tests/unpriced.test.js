import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An unknown model is priced at DEFAULT_PRICING so the report still adds up.
 * That fallback is fine; printing the result without saying so is not. On this
 * machine 9 of 19 models were unpriced and $720 of a $965 total was the
 * placeholder — a confident number that was mostly invented. These tests pin
 * the disclosure, in every shape that can leave the machine.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'agentledger.js');

function run(args, home = path.join(root, 'tests', 'fixtures', 'home')) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HOME: home },
    }), stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** A transcript using a model that is definitely not in the price table. */
async function unknownModelTranscript() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-unp-'));
  const file = path.join(dir, 'sess-unp.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'user', cwd: '/x', message: { role: 'user' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-01T00:00:00.000Z',
      message: { model: 'totally-made-up-model-9', usage: { input_tokens: 1000000, output_tokens: 1000000 } } }),
  ].join('\n') + '\n');
  return file;
}

test('summary names unpriced models instead of silently defaulting them', async () => {
  const file = await unknownModelTranscript();
  const { stdout } = run(['summary', '-p', file]);
  assert.match(stdout, /no built-in price/, 'the fallback must be disclosed');
  assert.match(stdout, /totally-made-up-model-9/);
  assert.match(stdout, /\$3\/\$15 per-Mtok default/);
  assert.match(stdout, /prices --template/, 'the disclosure must say how to fix it');
});

test('a fully-priced ledger prints no placeholder warning', () => {
  // The fixture home uses claude-sonnet-4-5, which IS in the table.
  const { stdout } = run(['summary']);
  assert.doesNotMatch(stdout, /no built-in price/, 'no false alarm when everything is priced');
});

test('aggregate carries the placeholder split for downstream consumers', async () => {
  const file = await unknownModelTranscript();
  const d = JSON.parse(run(['aggregate', '-p', file]).stdout);
  assert.ok(d.unpricedCostUSD > 0, 'the shareable shape must carry the caveat');
  assert.ok(Array.isArray(d.unpricedModels));
  assert.ok(d.unpricedModels.some((m) => m.model === 'totally-made-up-model-9'));
  assert.deepEqual(d.defaultPricingUSD, { input: 3, output: 15 });
});

test('the rendered digest states the placeholder portion', async () => {
  const file = await unknownModelTranscript();
  const { renderDigest, renderDigestHtml } = await import('../bin/digest.js');
  const dump = JSON.parse(run(['aggregate', '-p', file]).stdout);
  assert.match(renderDigest(dump), /placeholder-priced/);
  assert.match(renderDigestHtml(dump), /placeholder-priced/);
});

test('prices --template emits a fill-in override file for the unpriced models', async () => {
  const file = await unknownModelTranscript();
  const { stdout } = run(['prices', '--template', '-p', file]);
  // the comment lines name each model with its weight
  assert.match(stdout, /totally-made-up-model-9: \d+ records/);
  assert.match(stdout, /--prices prices\.json/);
  // and the JSON block parses, with null placeholders (not invented numbers)
  const json = stdout.slice(stdout.indexOf('{'));
  const obj = JSON.parse(json);
  assert.deepEqual(obj['totally-made-up-model-9'], { input: null, output: null });
  // The template must also state the rate currently being assumed, per model —
  // a user cannot judge what to write without knowing what it costs them today.
  assert.match(stdout, /Each model currently costs the \$3\/\$15 default/);
  assert.match(stdout, /now billed at \$3\/\$15/);
  assert.match(stdout, /Set a field to 0 for a free lane/);
});

test('the template round-trips: filling it in removes the warning', async () => {
  const file = await unknownModelTranscript();
  const { stdout: tpl } = run(['prices', '--template', '-p', file]);
  const obj = JSON.parse(tpl.slice(tpl.indexOf('{')));
  for (const k of Object.keys(obj)) obj[k] = { input: 1, output: 2 };
  const dir = await mkdtemp(path.join(tmpdir(), 'aledger-tpl-'));
  const pricesFile = path.join(dir, 'prices.json');
  await writeFile(pricesFile, JSON.stringify(obj));

  const before = run(['summary', '-p', file]).stdout;
  const after = run(['summary', '-p', file, '--prices', pricesFile]).stdout;
  assert.match(before, /no built-in price/);
  assert.doesNotMatch(after, /no built-in price/, 'pricing the models must silence the warning');
});

test('prices --template says so when everything is already priced', () => {
  const { stdout } = run(['prices', '--template']); // fixture home is fully priced
  assert.match(stdout, /every model in this ledger already has a price/);
});
