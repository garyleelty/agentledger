import test from 'node:test';
import assert from 'node:assert/strict';

import { dayKeyIn, startOfDayIn } from '../src/ledger.js';

/**
 * The day boundary.
 *
 * agentledger counted a day two different ways: `by-day` bucketed on the UTC
 * date, while `budget` and `statusline` started the day at the machine's
 * LOCAL midnight. For a user 8 hours from UTC that is a day boundary 8 hours
 * out — "today" in one report and "yesterday" in another, over the same
 * ledger. These tests pin the one helper both now use.
 *
 * The expectations are computed by hand from the zone's real offset, not
 * copied from the implementation, so a change in the implementation that
 * breaks the answer fails here.
 */

test('dayKeyIn buckets a timestamp by the calendar day of the given zone', () => {
  // 17:30Z on Oct 20 is 01:30 on Oct 21 in Shanghai (UTC+8) and still
  // Oct 20 in New York (UTC-4) and in UTC.
  const ts = Date.parse('2026-10-20T17:30:00Z');
  assert.equal(dayKeyIn(ts, 'UTC'), '2026-10-20');
  assert.equal(dayKeyIn(ts, 'Asia/Shanghai'), '2026-10-21');
  assert.equal(dayKeyIn(ts, 'America/New_York'), '2026-10-20');
});

test('dayKeyIn survives the extremes of the date line', () => {
  // 23:30Z on Oct 20 is already 13:30 on Oct 21 in Kiritimati (UTC+14) —
  // the far side of the date line — while Auckland (UTC+12) is at 11:30 on
  // Oct 21 and UTC is still on Oct 20.
  const ts = Date.parse('2026-10-20T23:30:00Z');
  assert.equal(dayKeyIn(ts, 'Pacific/Kiritimati'), '2026-10-21');
  assert.equal(dayKeyIn(ts, 'Pacific/Auckland'), '2026-10-21');
  assert.equal(dayKeyIn(ts, 'UTC'), '2026-10-20');
  // And the far side the other way: 12:00Z on Oct 21 is still Oct 20 in
  // Kiritimati's neighbour, Midway (UTC-11).
  assert.equal(dayKeyIn(Date.parse('2026-10-21T12:00:00Z'), 'Pacific/Midway'), '2026-10-21');
  assert.equal(dayKeyIn(Date.parse('2026-10-21T06:00:00Z'), 'Pacific/Midway'), '2026-10-20');
});

test('dayKeyIn reports an unknown day for a missing timestamp', () => {
  assert.equal(dayKeyIn(null, 'UTC'), 'unknown');
  assert.equal(dayKeyIn(undefined, 'Asia/Shanghai'), 'unknown');
});

test('dayKeyIn falls back rather than throwing on a bad zone', () => {
  // The CLI validates the zone name up front and exits with a message, but
  // a library caller can pass anything. A report must not die on it.
  const ts = Date.parse('2026-10-20T17:30:00Z');
  assert.doesNotThrow(() => dayKeyIn(ts, 'Not/AZone'));
});

test('startOfDayIn returns the local midnight of the given zone', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  // Shanghai is UTC+8, so its midnight on Oct 21 is 16:00Z on Oct 20.
  assert.equal(new Date(startOfDayIn(now, 'Asia/Shanghai')).toISOString(), '2026-10-20T16:00:00.000Z');
  assert.equal(new Date(startOfDayIn(now, 'UTC')).toISOString(), '2026-10-21T00:00:00.000Z');
  // New York is UTC-4 in October (EDT).
  assert.equal(new Date(startOfDayIn(now, 'America/New_York')).toISOString(), '2026-10-21T04:00:00.000Z');
});

test('startOfDayIn handles both sides of a DST transition', () => {
  // New York is UTC-5 in January (EST) and UTC-4 in July (EDT). A helper
  // that applied a fixed offset would be an hour out in one of them.
  const jan = Date.parse('2026-01-15T12:00:00Z');
  const jul = Date.parse('2026-07-15T12:00:00Z');
  assert.equal(new Date(startOfDayIn(jan, 'America/New_York')).toISOString(), '2026-01-15T05:00:00.000Z');
  assert.equal(new Date(startOfDayIn(jul, 'America/New_York')).toISOString(), '2026-07-15T04:00:00.000Z');
});

test('startOfDayIn lands on the same calendar day the zone reports', () => {
  // The property that matters: whatever the zone, the returned instant must
  // format to the same date the zone calls "today" at that moment, and it
  // must not be in the future.
  const now = Date.parse('2026-10-21T23:30:00Z');
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Auckland']) {
    const start = startOfDayIn(now, tz);
    assert.equal(dayKeyIn(start, tz), dayKeyIn(now, tz), `${tz}: start of day is on a different date`);
    assert.ok(start <= now, `${tz}: start of day is in the future`);
  }
});

test('startOfDayIn without a zone uses the machine local midnight', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const start = startOfDayIn(now);
  const expected = new Date(now);
  expected.setHours(0, 0, 0, 0);
  assert.equal(start, expected.getTime());
});
