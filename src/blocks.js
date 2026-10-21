/**
 * Billing blocks: the rolling windows in which a subscription quota resets.
 *
 * A block is a slice of usage that a Claude-style subscription would bill
 * against one quota window. The output is ccusage's `blocks --json` shape,
 * field for field, because the point of the command is that a number already
 * used against ccusage reads the same here.
 *
 * Two semantics are worth writing down, because both are easy to get wrong
 * and both were measured on this machine against ccusage 20.0.34:
 *
 *   - A block STARTS with activity; it is not a fixed grid. The first record
 *     of a block sets the block start, floored to the hour, and the block runs
 *     for `blockHours` from there. Verified: a lone record at 13:16:57.333Z
 *     produced the block 13:00:00.000Z -> 18:00:00.000Z, and a lone record
 *     at 00:30:00Z produced 00:00:00.000Z -> 05:00:00.000Z. A "local
 *     midnight, then 5-hour chunks" grid would have said 12:00:00.000Z and
 *     21:00:00.000Z for those two, and matched neither. ccusage's own guide
 *     agrees with the measurement: "Block Start: Triggered by your first
 *     message", "Rolling Windows: New blocks start with activity after
 *     previous block expires", "UTC Time Handling: Block boundaries are
 *     calculated in UTC".
 *   - A record that lands EXACTLY on the block end still belongs to that
 *     block. The window closes when a record is MORE than `blockHours` past
 *     the block start, not at the boundary itself.
 *
 * The module is pure: same records in, same blocks out, no clock and no
 * filesystem unless `now` is supplied.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A finite number, or 0. Records carry token counts that may be missing. */
const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Group usage records into billing blocks.
 *
 * @param {object[]} records usage records. Each record may carry
 *   `timestamp` (epoch ms; a record without one is skipped — it cannot be
 *   placed in a window), `model`, the token buckets `input`, `cacheRead`,
 *   `cacheWrite`, `output`, and either a `cost` object (`{ input, cacheRead,
 *   cacheWrite, output, total }`, the shape `withCost()` in ledger.js
 *   produces) or a flat `costUSD` number. A record with no cost counts as $0.
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms to treat as "now" (default: Date.now()).
 * @param {string} [opts.timezone] IANA zone the hour boundaries are taken in
 *   (default: the system zone).
 * @param {number} [opts.blockHours] length of a block in hours (default: 5).
 * @returns {object[]} blocks, oldest first, idle stretches included as gaps.
 */
export function computeBlocks(records, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const timeZone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const blockHours = Number.isFinite(opts.blockHours) && opts.blockHours > 0 ? opts.blockHours : 5;
  const duration = Math.trunc(blockHours * HOUR_MS);

  // A record with no timestamp cannot be placed in any window. Dropping it is
  // the only honest option: inventing a position would move real spend into
  // a block it never happened in.
  const placed = [];
  for (const rec of records ?? []) {
    const ts = rec?.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    placed.push({
      ts,
      model: typeof rec.model === 'string' ? rec.model : null,
      input: num(rec.input),
      cacheRead: num(rec.cacheRead),
      cacheWrite: num(rec.cacheWrite),
      output: num(rec.output),
      cost: costOfRecord(rec),
    });
  }
  // Stable, so two records with the same millisecond keep their input order.
  placed.sort((a, b) => a.ts - b.ts);

  const blocks = [];
  let current = null;

  for (const item of placed) {
    if (current) {
      const last = current.entries[current.entries.length - 1].ts;
      const sinceStart = item.ts - current.start;
      const sinceLast = item.ts - last;
      if (sinceStart > duration || sinceLast > duration) {
        blocks.push(buildBlock(current, now, duration));
        // Only an idle stretch long enough to outlast a whole window is worth
        // reporting as a gap; a short pause inside a window is not a gap.
        if (sinceLast > duration) blocks.push(buildGap(last, item.ts, duration));
        current = { start: floorToHour(item.ts, timeZone), entries: [] };
      }
    } else {
      current = { start: floorToHour(item.ts, timeZone), entries: [] };
    }
    current.entries.push(item);
  }
  if (current && current.entries.length > 0) {
    blocks.push(buildBlock(current, now, duration));
  }

  return blocks;
}

/**
 * The cost of one record, in USD.
 *
 * `withCost()` in ledger.js already prices a record into
 * `{ input, cacheRead, cacheWrite, output, total }`; that total is the number
 * a block reports. A flat `costUSD` is the fallback for callers that priced
 * the record elsewhere, and a record with neither is worth $0 — a missing
 * price is not a guess.
 */
function costOfRecord(rec) {
  const cost = rec?.cost;
  if (typeof cost === 'number') return Number.isFinite(cost) ? cost : 0;
  if (cost && typeof cost === 'object') {
    if (Number.isFinite(cost.total)) return cost.total;
    return num(cost.input) + num(cost.cacheRead) + num(cost.cacheWrite) + num(cost.output);
  }
  if (Number.isFinite(rec?.costUSD)) return rec.costUSD;
  return 0;
}

/**
 * Floor a timestamp to the top of the hour in `timeZone`.
 *
 * ccusage floors to the UTC hour. For every zone whose offset is a whole
 * number of hours — which is every zone this tool is likely to be asked
 * about, Asia/Shanghai among them — the local hour IS the UTC hour, so the
 * two agree exactly. The half-hour zones (Asia/Kolkata +05:30, Asia/Tehran
 * +03:30) are the only ones where the choice shows, and there the local hour
 * is the more useful answer: it is the boundary a person reading the report
 * would call "the top of the hour".
 */
function floorToHour(timestamp, timeZone) {
  const offset = zoneOffsetMs(timestamp, timeZone);
  return Math.floor((timestamp + offset) / HOUR_MS) * HOUR_MS - offset;
}

/**
 * The zone's UTC offset, in ms, at the given instant.
 *
 * The wall clock in the zone is read back out of `Intl`, and the difference
 * between that wall clock and the instant is the offset. Asking Intl for the
 * offset directly is not an option — it has no such API — and asking for it
 * "now" would be wrong across a DST boundary.
 */
function zoneOffsetMs(timestamp, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
  const field = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallClock = Date.UTC(
    field('year'), field('month') - 1, field('day'),
    field('hour'), field('minute'), field('second'),
  );
  const ms = ((timestamp % 1000) + 1000) % 1000;
  return wallClock + ms - timestamp;
}

const formatters = new Map();

/** A cached formatter: building one is expensive and this runs per record. */
function formatterFor(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Build one real block from the records that landed in it. */
function buildBlock(current, now, duration) {
  const start = current.start;
  const end = start + duration;
  const entries = current.entries;
  const actualEnd = entries[entries.length - 1].ts;

  const tokenCounts = {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  let costUSD = 0;
  const models = [];
  const seen = new Set();
  for (const e of entries) {
    tokenCounts.cacheCreationInputTokens += e.cacheWrite;
    tokenCounts.cacheReadInputTokens += e.cacheRead;
    tokenCounts.inputTokens += e.input;
    tokenCounts.outputTokens += e.output;
    costUSD += e.cost;
    if (e.model && !seen.has(e.model)) {
      seen.add(e.model);
      models.push(e.model);
    }
  }
  const totalTokens = tokenCounts.cacheCreationInputTokens + tokenCounts.cacheReadInputTokens
    + tokenCounts.inputTokens + tokenCounts.outputTokens;

  // A block is active while it is still running and still being used. A block
  // whose last record is older than one window has been left behind.
  const isActive = (now - actualEnd) < duration && now < end;

  const block = {
    start,
    end,
    entries,
    actualEnd,
    tokenCounts,
    totalTokens,
    costUSD,
    models,
    isActive,
  };
  const burnRate = isActive ? burnRateOf(block) : null;
  const projection = isActive ? projectionOf(block, now) : null;

  // Key order matches ccusage's JSON so the two outputs can be compared as
  // text, not just as parsed objects.
  return {
    actualEndTime: isoMillis(actualEnd),
    burnRate,
    costUSD,
    endTime: isoMillis(end),
    entries: entries.length,
    id: isoMillis(start),
    isActive,
    isGap: false,
    models,
    projection,
    startTime: isoMillis(start),
    tokenCounts,
    totalTokens,
  };
}

/**
 * Build the synthetic block that stands for an idle stretch.
 *
 * The gap starts one window after the last record of the block before it —
 * the moment that block's window would have closed anyway — and runs until
 * the next record arrives.
 */
function buildGap(last, next, duration) {
  const start = last + duration;
  return {
    actualEndTime: null,
    burnRate: null,
    costUSD: 0,
    endTime: isoMillis(next),
    entries: 0,
    id: `gap-${isoMillis(start)}`,
    isActive: false,
    isGap: true,
    models: [],
    projection: null,
    startTime: isoMillis(start),
    tokenCounts: {
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    totalTokens: 0,
  };
}

/**
 * How fast the block is being consumed.
 *
 * Measured across the block's own activity span, first record to last, not
 * across the window: a block that ran for five hours but was only used for
 * twenty minutes was consumed at the rate of those twenty minutes. A block
 * whose records share one timestamp has no span to divide by, so it has no
 * rate at all rather than an infinite one.
 */
function burnRateOf(block) {
  const first = block.entries[0].ts;
  const last = block.entries[block.entries.length - 1].ts;
  const minutes = (last - first) / MINUTE_MS;
  if (minutes <= 0) return null;
  const nonCache = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
  return {
    costPerHour: (block.costUSD / minutes) * 60,
    tokensPerMinute: block.totalTokens / minutes,
    tokensPerMinuteForIndicator: nonCache / minutes,
  };
}

/**
 * What the block will have consumed by the time its window closes.
 *
 * The rate so far is extended over the minutes that are left, so the
 * projection is "tokens so far plus the rate times the rest of the window".
 * A block with no measurable rate has no projection either.
 */
function projectionOf(block, now) {
  const burn = burnRateOf(block);
  if (!burn) return null;
  const remainingMinutes = Math.round((block.end - now) / MINUTE_MS);
  const totalTokens = block.totalTokens + burn.tokensPerMinute * remainingMinutes;
  const totalCost = block.costUSD + (burn.costPerHour / 60) * remainingMinutes;
  return {
    remainingMinutes,
    totalCost: Math.round(totalCost * 100) / 100,
    totalTokens: Math.round(totalTokens),
  };
}

/** UTC ISO-8601 with milliseconds, the format ccusage prints. */
function isoMillis(timestamp) {
  return new Date(timestamp).toISOString();
}
