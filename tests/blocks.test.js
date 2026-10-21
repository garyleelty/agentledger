import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBlocks } from '../src/blocks.js';

/**
 * Billing blocks: the rolling windows a subscription quota resets on.
 *
 * The semantics here were measured against ccusage 20.0.34's `blocks --json`
 * on this machine, and the parts that are easy to get subtly wrong are the
 * parts worth pinning:
 *
 *   1. A block STARTS with activity. Its start is the first record of the
 *      block, floored to the hour, NOT a fixed grid of local-midnight
 *      chunks. Verified against the ccusage binary: a lone record at
 *      13:16:57.333Z produced the block 13:00:00.000Z -> 18:00:00.000Z, and
 *      a lone record at 00:30:00Z produced 00:00:00.000Z -> 05:00:00.000Z.
 *   2. A record exactly ON the block end stays in that block. The window
 *      closes when a record is MORE than blockHours past the block start.
 *   3. An idle stretch longer than one window becomes a synthetic gap block
 *      that starts one window after the last record before it.
 *   4. The active block carries a burn rate and a projection — but a block
 *      whose records share one timestamp has no span to divide by, so it has
 *      neither.
 *
 * Every record here is synthetic: the machine's real logs are not a test
 * fixture, and a test that changes when the machine does is not a test.
 */

const UTC = 'UTC';

/** A usage record with a cost object, the shape `withCost()` produces. */
function rec(iso, over = {}) {
  return {
    timestamp: Date.parse(iso),
    model: 'm',
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    ...over,
  };
}

/** The real blocks, with the synthetic gap blocks taken out. */
const real = (blocks) => blocks.filter((b) => !b.isGap);

test('two records in the same window make one block', () => {
  const blocks = computeBlocks([
    rec('2026-06-18T10:15:00.000Z', { input: 100, output: 10 }),
    rec('2026-06-18T10:45:00.000Z', { input: 200, output: 20 }),
  ], { timezone: UTC });

  assert.equal(blocks.length, 1);
  const [b] = blocks;
  assert.equal(b.id, '2026-06-18T10:00:00.000Z');
  assert.equal(b.startTime, '2026-06-18T10:00:00.000Z');
  assert.equal(b.endTime, '2026-06-18T15:00:00.000Z');
  assert.equal(b.entries, 2);
  assert.equal(b.actualEndTime, '2026-06-18T10:45:00.000Z');
  assert.equal(b.tokenCounts.inputTokens, 300);
  assert.equal(b.tokenCounts.outputTokens, 30);
  assert.equal(b.totalTokens, 330);
  assert.equal(b.isGap, false);
  assert.deepEqual(b.models, ['m']);
});

test('the block start is the hour of the first record, not a fixed grid', () => {
  // The distinction that matters: 13:16 belongs to a block that started at
  // 13:00, NOT to one of the local-midnight 5-hour slots (12:00, 17:00, ...).
  const blocks = computeBlocks([
    rec('2026-06-18T13:16:57.333Z', { output: 7 }),
  ], { timezone: UTC });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startTime, '2026-06-18T13:00:00.000Z');
  assert.equal(blocks[0].endTime, '2026-06-18T18:00:00.000Z');
});

test('a record exactly on the block end stays in that block', () => {
  // The window closes when a record is MORE than blockHours past the start,
  // so the record at 15:00:00.000Z is still the 10:00 block's business.
  const blocks = computeBlocks([
    rec('2026-06-18T10:00:00.000Z'),
    rec('2026-06-18T15:00:00.000Z'),
  ], { timezone: UTC });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].entries, 2);
  assert.equal(blocks[0].startTime, '2026-06-18T10:00:00.000Z');

  // One millisecond later is a new block — and the millisecond of idle time
  // between the two windows is reported as a gap.
  const after = computeBlocks([
    rec('2026-06-18T10:00:00.000Z'),
    rec('2026-06-18T15:00:00.001Z'),
  ], { timezone: UTC });

  assert.equal(after.length, 3);
  assert.equal(after[0].entries, 1);
  assert.equal(after[1].isGap, true);
  assert.equal(after[1].startTime, '2026-06-18T15:00:00.000Z');
  assert.equal(after[1].endTime, '2026-06-18T15:00:00.001Z');
  assert.equal(after[2].startTime, '2026-06-18T15:00:00.000Z');
  assert.equal(after[2].endTime, '2026-06-18T20:00:00.000Z');
});

test('records in different windows are different blocks', () => {
  const blocks = computeBlocks([
    rec('2026-06-18T10:15:00.000Z'),
    rec('2026-06-18T16:15:00.000Z'),
  ], { timezone: UTC });

  const used = real(blocks);
  assert.equal(used.length, 2);
  assert.equal(used[0].startTime, '2026-06-18T10:00:00.000Z');
  assert.equal(used[1].startTime, '2026-06-18T16:00:00.000Z');
  assert.ok(
    used[0].startTime < used[1].startTime,
    'blocks come back oldest first',
  );
});

test('an idle stretch becomes a gap block with the right shape', () => {
  const blocks = computeBlocks([
    rec('2026-06-18T10:15:00.000Z', { input: 5 }),
    rec('2026-06-19T09:00:00.000Z', { input: 7 }),
  ], { timezone: UTC });

  assert.equal(blocks.length, 3);
  const [first, gap, second] = blocks;

  assert.equal(gap.isGap, true);
  assert.equal(gap.id, 'gap-2026-06-18T15:15:00.000Z');
  assert.equal(gap.startTime, '2026-06-18T15:15:00.000Z', 'the gap starts one window after the last record');
  assert.equal(gap.endTime, '2026-06-19T09:00:00.000Z', 'and runs until the next record');
  assert.equal(gap.actualEndTime, null);
  assert.equal(gap.entries, 0);
  assert.equal(gap.totalTokens, 0);
  assert.equal(gap.costUSD, 0);
  assert.deepEqual(gap.models, []);
  assert.deepEqual(gap.tokenCounts, {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.equal(gap.isActive, false);
  assert.equal(gap.burnRate, null);
  assert.equal(gap.projection, null);

  assert.equal(first.isGap, false);
  assert.equal(first.entries, 1);
  assert.equal(second.isGap, false);
  assert.equal(second.startTime, '2026-06-19T09:00:00.000Z');
});

test('a pause inside a window is not a gap', () => {
  // Three hours of silence is not a gap: the block is still running, so the
  // pause is part of it.
  const blocks = computeBlocks([
    rec('2026-06-18T10:00:00.000Z'),
    rec('2026-06-18T13:00:00.000Z'),
  ], { timezone: UTC });

  assert.equal(blocks.length, 1);
  assert.ok(blocks.every((b) => !b.isGap));
  assert.equal(blocks[0].entries, 2);
});

test('a gap covers the idle time that is left after a window closes', () => {
  // The window closed at 15:00 and the next record arrived at 15:30, so the
  // gap is those 30 minutes — not the whole hour and a half of silence.
  const blocks = computeBlocks([
    rec('2026-06-18T10:00:00.000Z'),
    rec('2026-06-18T15:30:00.000Z'),
  ], { timezone: UTC });

  assert.equal(blocks.length, 3);
  const [first, gap, second] = blocks;
  assert.equal(first.isGap, false);
  assert.equal(gap.isGap, true);
  assert.equal(gap.startTime, '2026-06-18T15:00:00.000Z');
  assert.equal(gap.endTime, '2026-06-18T15:30:00.000Z');
  assert.equal(second.isGap, false);
  assert.equal(second.startTime, '2026-06-18T15:00:00.000Z');
});

test('the active block is flagged and carries a burn rate and a projection', () => {
  const records = [
    rec('2026-06-18T10:00:00.000Z', { input: 1000, output: 100 }),
    rec('2026-06-18T10:20:00.000Z', { input: 1000, output: 100 }),
  ];
  // "Now" is 40 minutes into the window, which ends at 15:00.
  const now = Date.parse('2026-06-18T10:40:00.000Z');
  const [b] = computeBlocks(records, { timezone: UTC, now });

  assert.equal(b.isActive, true);
  // 2200 tokens over 20 minutes of activity.
  assert.equal(b.burnRate.tokensPerMinute, 110);
  assert.equal(b.burnRate.tokensPerMinuteForIndicator, 110);
  // 260 minutes of window left, 110 tokens a minute.
  assert.equal(b.projection.remainingMinutes, 260);
  assert.equal(b.projection.totalTokens, 2200 + 110 * 260);
  assert.equal(Number.isInteger(b.projection.totalTokens), true, 'the projection counts whole tokens');
});

test('a block with no measurable span has no burn rate and no projection', () => {
  // One record: there is no span to divide the tokens by, so the rate is
  // undefined rather than infinite, and the projection that depends on it
  // goes with it.
  const [b] = computeBlocks([
    rec('2026-06-18T10:00:00.000Z', { input: 1000 }),
  ], { timezone: UTC, now: Date.parse('2026-06-18T10:30:00.000Z') });

  assert.equal(b.isActive, true);
  assert.equal(b.burnRate, null);
  assert.equal(b.projection, null);
});

test('a block whose records share a timestamp has no rate either', () => {
  const [b] = computeBlocks([
    rec('2026-06-18T10:00:00.000Z', { input: 1000 }),
    rec('2026-06-18T10:00:00.000Z', { input: 1000 }),
  ], { timezone: UTC, now: Date.parse('2026-06-18T10:30:00.000Z') });

  assert.equal(b.entries, 2);
  assert.equal(b.burnRate, null);
  assert.equal(b.projection, null);
});

test('a block that is over is not active', () => {
  const [b] = computeBlocks([
    rec('2026-06-18T10:00:00.000Z', { input: 1000 }),
  ], { timezone: UTC, now: Date.parse('2026-06-18T16:00:00.000Z') });

  assert.equal(b.isActive, false);
  assert.equal(b.burnRate, null);
  assert.equal(b.projection, null);
});

test('a record without a timestamp is skipped, not crashed on', () => {
  const blocks = computeBlocks([
    rec('2026-06-18T10:15:00.000Z', { input: 100 }),
    { ...rec('2026-06-18T10:20:00.000Z'), timestamp: null },
    { model: 'm', input: 999 }, // no timestamp at all
    rec('2026-06-18T10:45:00.000Z', { input: 200 }),
  ], { timezone: UTC });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].entries, 2, 'only the records with a timestamp are placed');
  assert.equal(blocks[0].tokenCounts.inputTokens, 300);
});

test('the hour boundary follows the timezone', () => {
  const records = [rec('2026-06-18T13:16:57.333Z', { output: 7 })];

  const utc = computeBlocks(records, { timezone: 'UTC' });
  const shanghai = computeBlocks(records, { timezone: 'Asia/Shanghai' });
  const kolkata = computeBlocks(records, { timezone: 'Asia/Kolkata' });

  // Asia/Shanghai is a whole number of hours ahead of UTC, so its hour
  // boundaries ARE the UTC hour boundaries — the same block ccusage reports
  // for the same record, which is what makes the head-to-head comparison
  // meaningful.
  assert.equal(shanghai[0].startTime, utc[0].startTime);
  assert.equal(shanghai[0].startTime, '2026-06-18T13:00:00.000Z');

  // Asia/Kolkata is 5h30 ahead, so its hours start half an hour earlier in
  // UTC: local 18:46 is the 18:00 local block, which is 12:30Z.
  assert.equal(kolkata[0].startTime, '2026-06-18T12:30:00.000Z');
  assert.notEqual(kolkata[0].startTime, utc[0].startTime);
});

test('a block is as long as it was asked to be', () => {
  const blocks = computeBlocks([
    rec('2026-06-18T10:15:00.000Z'),
  ], { timezone: UTC, blockHours: 3 });

  assert.equal(blocks[0].startTime, '2026-06-18T10:00:00.000Z');
  assert.equal(blocks[0].endTime, '2026-06-18T13:00:00.000Z');
});

test('the cost of a record is what the block reports', () => {
  const blocks = computeBlocks([
    rec('2026-06-18T10:00:00.000Z', {
      input: 1000,
      cost: { input: 0.001, cacheRead: 0, cacheWrite: 0, output: 0.002, total: 0.003 },
    }),
    rec('2026-06-18T10:10:00.000Z', {
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0.001 },
    }),
  ], { timezone: UTC });

  assert.equal(blocks[0].costUSD, 0.004);
});

test('a flat costUSD is accepted, and a record with no cost is worth zero', () => {
  const blocks = computeBlocks([
    { timestamp: Date.parse('2026-06-18T10:00:00.000Z'), model: 'm', costUSD: 0.25 },
    { timestamp: Date.parse('2026-06-18T10:10:00.000Z'), model: 'm' },
  ], { timezone: UTC });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].costUSD, 0.25);
});

test('empty input gives no blocks', () => {
  assert.deepEqual(computeBlocks([], { timezone: UTC }), []);
  assert.deepEqual(computeBlocks(undefined, { timezone: UTC }), []);
});
