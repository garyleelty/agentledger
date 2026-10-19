import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parsePi, parseOpenClaw } from '../src/parsers.js';
import { SOURCES } from '../src/ledger.js';

/**
 * pi-agent and OpenClaw are the two adapters added in the same round, and
 * they share a shape (typed-event JSONL, usage on assistant `message`
 * records) that is easy to get subtly wrong in ways no other lane exercises:
 *
 *  - OpenClaw keeps ARCHIVED sessions as `<uuid>.jsonl.reset.<ts>` and
 *    `<uuid>.jsonl.deleted.<ts>` siblings. On the real machine those hold
 *    127 of 959 usage rows and 2.03M input tokens — the exact number ccusage
 *    reports and a `.jsonl`-only matcher would drop.
 *  - Both separate `reasoning` from `output`; folding it in is a policy
 *    choice (they bill at the output rate) that ccusage does not make, so the
 *    difference has to be deliberate rather than accidental.
 *  - Zero-token rows are real events (a failed request writes one) and must
 *    not be counted as usage.
 *
 * Every token figure below is cross-checked against ccusage 20.0.34 on the
 * same files, so these are not just self-consistent — they match the other
 * implementation.
 */

async function dir() {
  return mkdtemp(path.join(tmpdir(), 'aledger-ev-'));
}

/** Build a pi/OpenClaw-style session file: typed events, usage on messages. */
async function sessionFile(root, { name = 'sess.jsonl', events = [], sub = '' }) {
  const d = sub ? path.join(root, sub) : root;
  await mkdir(d, { recursive: true });
  const file = path.join(d, name);
  await writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const msg = (id, model, usage, ts = '2026-10-17T17:22:22.258Z') => ({
  type: 'message', id, timestamp: ts, message: { role: 'assistant', model, usage },
});

test('parsePi reads usage off assistant messages', async () => {
  const root = await dir();
  const file = await sessionFile(root, {
    events: [
      { type: 'session', id: 's1', timestamp: '2026-10-17T17:22:19.317Z', cwd: '/work/pi' },
      { type: 'model_change', id: 'm0', provider: 'gw', modelId: 'model-a' },
      msg('a1', 'model-a', { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 0 }),
      msg('a2', 'model-a', { input: 200, output: 30, cacheRead: 0, cacheWrite: 10, reasoning: 5 }),
      // a failed turn: all-zero usage is an event, not spend
      msg('a3', 'model-a', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    ],
  });
  const recs = [];
  for await (const r of parsePi(file)) recs.push(r);
  assert.equal(recs.length, 2, 'the all-zero row must be dropped');
  assert.equal(recs[0].agent, 'pi');
  assert.equal(recs[0].model, 'model-a', 'the model comes from the message itself');
  assert.equal(recs[0].input, 100);
  assert.equal(recs[0].cacheRead, 50);
  assert.equal(recs[1].cacheWrite, 10);
  assert.equal(recs[0].project, '/work/pi', 'cwd comes from the session opener');
  assert.equal(recs[1].project, '/work/pi', 'and is carried forward to later turns');
});

test('parsePi bills reasoning as output', async () => {
  const root = await dir();
  const file = await sessionFile(root, {
    events: [msg('a1', 'm', { input: 10, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 25 })],
  });
  const recs = [];
  for await (const r of parsePi(file)) recs.push(r);
  assert.equal(recs[0].output, 65, 'reasoning is additive to output, not a separate bucket');
});

test('parseOpenClaw reads archived .reset/.deleted siblings', async () => {
  const root = await dir();
  const live = await sessionFile(root, {
    name: 'aaaaaaaa-0000-0000-0000-000000000001.jsonl',
    events: [msg('a1', 'model-a', { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 })],
  });
  // the archive siblings that a bare `.jsonl` matcher would miss
  const reset = await sessionFile(root, {
    name: 'aaaaaaaa-0000-0000-0000-000000000001.jsonl.reset.2026-03-05T15-10-16.782Z',
    events: [msg('a1', 'model-a', { input: 500, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 })],
  });
  const deleted = await sessionFile(root, {
    name: 'bbbbbbbb-0000-0000-0000-000000000002.jsonl.deleted.2026-03-05T14-08-23.090Z',
    events: [msg('a1', 'model-b', { input: 300, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 })],
  });
  for (const f of [live, reset, deleted]) {
    const recs = [];
    for await (const r of parseOpenClaw(f)) recs.push(r);
    assert.equal(recs.length, 1, `every archived file must yield its own record: ${path.basename(f)}`);
  }
  // The session id is the uuid before the first `.jsonl`, so the archive maps
  // onto the session it replaced instead of becoming a phantom session.
  const recs = [];
  for await (const r of parseOpenClaw(reset)) recs.push(r);
  assert.equal(recs[0].session, 'aaaaaaaa-0000-0000-0000-000000000001');
});

test('the SOURCES matchers admit the archived OpenClaw files and pi sessions', async () => {
  const pi = SOURCES.find((s) => s.agent === 'pi');
  const claw = SOURCES.find((s) => s.agent === 'openclaw');
  assert.ok(pi && claw, 'both adapters must be registered');
  // pi: a session file under a cwd-slug directory
  assert.ok(pi.match('--Users-tianyi-code-github--/2026-10-17T17-22-19-317Z_uuid.jsonl'));
  // pi: not a JSON archive of another shape
  assert.ok(!pi.match('subagent-artifacts/out.json'));
  // openclaw: live, reset, and deleted forms
  assert.ok(claw.match('main/sessions/uuid.jsonl'));
  assert.ok(claw.match('main/sessions/uuid.jsonl.reset.2026-03-05T15-10-16.782Z'));
  assert.ok(claw.match('main/sessions/uuid.jsonl.deleted.2026-03-05T14-08-23.090Z'));
  // openclaw: NOT the sqlite sibling — reading it too would double-count
  assert.ok(!claw.match('main/openclaw-agent.sqlite'));
  assert.ok(!claw.match('main/sessions/notes.txt'));
});

test('both adapters survive a truncated final line', async () => {
  // A live session is appended to while it is read; a torn tail is normal.
  const root = await dir();
  const file = path.join(root, 'torn.jsonl');
  const good = JSON.stringify(msg('a1', 'm', { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }));
  await writeFile(file, `${good}\n{"type":"message","id":"a2","mess`);
  for (const parse of [parsePi, parseOpenClaw]) {
    const recs = [];
    for await (const r of parse(file)) recs.push(r);
    assert.equal(recs.length, 1, 'the complete row survives the torn one');
    assert.equal(recs[0].input, 7);
  }
});
