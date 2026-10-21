import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'agentledger.js');

/**
 * `--sections`: several reports from ONE read of the logs.
 *
 * This is the one place ccusage was genuinely better. A user who wanted a
 * daily view and a weekly view of the same ledger ran the tool twice, and
 * read every log file twice — 298 files on this machine. Here the logs are
 * read once and every section is a different grouping of the same records.
 *
 * Four things are pinned:
 *
 *  1. The JSON shape: the section names are top-level keys, each mapping to
 *     that section's {totals, rows}, with tool/version/generatedAt alongside
 *     — the same envelope every other report in this tool uses.
 *  2. The rows of a section add up to that section's totals, and every
 *     section describes the same ledger, so the four views cannot disagree.
 *  3. ONE load. A `--sections` run must open each log file exactly once,
 *     whatever the number of sections. This is measured by counting the
 *     reads the process actually makes (see `countReads` below) — not by
 *     timing, which would flake, and not by trusting the implementation.
 *  4. A bad section name is an error, the way an unknown `--agent` is: a
 *     typo that quietly produced a shorter report would be a report missing
 *     a section nobody asked to miss.
 */

/** A Claude Code session log with one assistant turn in it. */
function sessionFile(dir, name, ts, model = 'mimo-v2.5-pro') {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg-${name}`,
      model,
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 },
    },
    timestamp: ts,
    sessionId: name,
    cwd: '/work',
  });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), line + '\n');
}

/**
 * A HOME with three Claude Code session files, on three different days.
 *
 * Three files rather than one file with three records: the one-load test
 * counts how many times each FILE is opened, so one file would prove less
 * than three.
 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-sections-'));
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  sessionFile(dir, 's1', '2026-06-01T09:00:00.000Z');
  sessionFile(dir, 's2', '2026-06-03T09:00:00.000Z');
  sessionFile(dir, 's3', '2026-06-08T09:00:00.000Z');
  return { home, dir, files: 3 };
}

/** A HOME with no logs at all. */
function makeEmptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-sections-empty-'));
}

function run(args, home, extra = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: home, ...extra },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function runJson(args, home, extra = {}) {
  const r = run([...args, '--json'], home, extra);
  assert.equal(r.status, 0, `expected a clean exit, got ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/* ------------------------------------------------------------------ *
 * the one-load measurement
 * ------------------------------------------------------------------ */

/**
 * Count how many times the tool opens each log file, from outside the tool.
 *
 * A preload module (`node --import`) patches `node:fs` before the CLI's own
 * modules load, so every read of a log file is recorded. That measures the
 * thing the feature is about — how many times the logs are read — rather
 * than trusting a counter the tool reports about itself, and it cannot
 * flake: it counts reads, not milliseconds.
 */
function countReader(home) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aledger-count-'));
  const out = path.join(dir, 'reads.txt');
  const loader = path.join(dir, 'count.mjs');
  fs.writeFileSync(loader, `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const target = ${JSON.stringify(home)};
const out = ${JSON.stringify(out)};
const count = (file) => {
  try {
    if (typeof file === 'string' && file.startsWith(target)) {
      require('node:fs').appendFileSync(out, file + '\\n');
    }
  } catch {
    // Counting must never be the thing that breaks the tool.
  }
};
const stream = fs.createReadStream;
fs.createReadStream = function (file, ...rest) { count(file); return stream.call(this, file, ...rest); };
const read = fs.readFileSync;
fs.readFileSync = function (file, ...rest) { count(file); return read.call(this, file, ...rest); };
`);
  return {
    out,
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${loader}`].filter(Boolean).join(' ') },
    /** The files that were opened, and how many times each. */
    reads() {
      if (!fs.existsSync(out)) return new Map();
      const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
      const counts = new Map();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    },
  };
}

/* ------------------------------------------------------------------ *
 * the JSON shape
 * ------------------------------------------------------------------ */

test('--sections emits one document with a top-level key per section', () => {
  const { home } = makeHome();
  const d = runJson(['--sections', 'daily,weekly,monthly,session'], home);

  assert.equal(d.tool, 'agentledger');
  assert.equal(typeof d.version, 'string');
  assert.equal(typeof d.generatedAt, 'string');
  for (const name of ['daily', 'weekly', 'monthly', 'session']) {
    assert.ok(name in d, `the document must carry a "${name}" key`);
    const s = d[name];
    assert.ok(Array.isArray(s.rows), `${name} must carry a rows array`);
    assert.equal(typeof s.totals, 'object');
    assert.equal(typeof s.totals.costUSD, 'number');
    assert.equal(typeof s.totals.records, 'number');
    assert.equal(typeof s.totals.tokens.input, 'number');
  }
  // The section names are the top-level keys, and the envelope around them
  // is the same one every other report in this tool uses.
  assert.deepEqual(
    Object.keys(d).sort(),
    ['daily', 'filesScanned', 'generatedAt', 'monthly', 'session', 'tool', 'version', 'weekly'].sort(),
  );
  // How many files were opened, once. It is a number the tool can back, and
  // it is the fact this report is about: one read, several views.
  assert.equal(typeof d.filesScanned, 'number');
  assert.ok(d.filesScanned > 0, 'the fixture home has log files, so files were read');
});

test('--sections on stdout is JSON and nothing else', () => {
  const { home } = makeHome();
  const r = run(['--sections', 'daily,weekly', '--json'], home);
  assert.equal(r.status, 0, r.stderr);
  // A parse that succeeds IS the assertion: any stray line on stdout would
  // break it, and a table printed alongside the JSON would break it too.
  const d = JSON.parse(r.stdout);
  assert.equal(d.tool, 'agentledger');
});

test('a section\'s rows add up to that section\'s totals', () => {
  const { home } = makeHome();
  const d = runJson(['--sections', 'daily,weekly,monthly,session'], home);
  for (const name of ['daily', 'weekly', 'monthly', 'session']) {
    const s = d[name];
    const records = s.rows.reduce((a, r) => a + r.records, 0);
    assert.equal(records, s.totals.records, `${name}'s rows must cover every record they report`);
    const cost = s.rows.reduce((a, r) => a + r.costUSD, 0);
    assert.ok(Math.abs(cost - s.totals.costUSD) < 0.01, `${name}'s row costs must add up to its total`);
  }
});

test('every section describes the same ledger', () => {
  // Four views of one set of records. If a section quietly covered a
  // different slice, the four totals would not agree, and a reader would
  // have no way to tell which one was right.
  const { home } = makeHome();
  const d = runJson(['--sections', 'daily,weekly,monthly,session'], home);
  const totals = ['daily', 'weekly', 'monthly', 'session'].map((n) => d[n].totals.records);
  assert.equal(new Set(totals).size, 1, `the sections disagree about how many records there are: ${totals}`);
  const costs = ['daily', 'weekly', 'monthly', 'session'].map((n) => d[n].totals.costUSD);
  assert.equal(new Set(costs).size, 1, `the sections disagree about the cost: ${costs}`);
});

test('a section is the report its command prints, not a copy of it', () => {
  // The point of sharing the row builders: a section and its command cannot
  // drift apart. This is the check that they have not.
  const { home } = makeHome();
  const sections = runJson(['--sections', 'daily,weekly,monthly,session'], home);
  const day = runJson(['by-day'], home);
  const week = runJson(['by-week'], home);
  const month = runJson(['by-month'], home);
  const session = runJson(['sessions'], home);

  assert.deepEqual(sections.daily.rows.map((r) => r.key), day.rows.map((r) => r.key));
  assert.deepEqual(sections.weekly.rows.map((r) => r.key), week.rows.map((r) => r.key));
  assert.deepEqual(sections.monthly.rows.map((r) => r.key), month.rows.map((r) => r.key));
  assert.deepEqual(sections.session.rows.map((r) => r.key), session.rows.map((r) => r.key));
  assert.equal(sections.daily.totals.costUSD, day.totals.costUSD);
  assert.equal(sections.session.totals.costUSD, session.totals.costUSD);
});

test('--sections with one name emits only that section', () => {
  const { home } = makeHome();
  const d = runJson(['--sections', 'weekly'], home);
  assert.ok('weekly' in d);
  assert.equal('daily' in d, false, 'a section that was not asked for must not appear');
  assert.equal('session' in d, false);
});

/* ------------------------------------------------------------------ *
 * the table output
 * ------------------------------------------------------------------ */

test('without --json the sections print as several reports under their own headings', () => {
  const { home } = makeHome();
  const r = run(['--sections', 'daily,weekly,monthly,session'], home);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['daily', 'weekly', 'monthly', 'session']) {
    assert.match(r.stdout, new RegExp(`^\\s+${name} — `, 'm'), `the ${name} section needs a heading`);
  }
  assert.match(r.stdout, /Day\s+Tokens\s+Est\. cost/);
  assert.match(r.stdout, /Week\s+Tokens\s+Est\. cost\s+Records/);
  assert.match(r.stdout, /Month\s+Tokens\s+Est\. cost\s+Records/);
  assert.match(r.stdout, /Session\s+Tokens\s+Est\. cost\s+Started/);
  // It is a report, not a JSON document.
  assert.doesNotMatch(r.stdout, /"tool"\s*:/);
});

test('a section shows the real numbers, not a heading and an empty table', () => {
  const { home } = makeHome();
  const r = run(['--sections', 'daily'], home);
  assert.equal(r.status, 0, r.stderr);
  // Three records on three different days, in June 2026.
  assert.match(r.stdout, /2026-06-01/);
  assert.match(r.stdout, /2026-06-03/);
  assert.match(r.stdout, /2026-06-08/);
});

/* ------------------------------------------------------------------ *
 * ONE load
 * ------------------------------------------------------------------ */

test('a --sections run opens every log file exactly once', () => {
  const { home, files } = makeHome();
  const counter = countReader(home);
  const r = run(['--sections', 'daily,weekly,monthly,session', '--json'], home, counter.env);
  assert.equal(r.status, 0, r.stderr);

  const reads = counter.reads();
  assert.equal(reads.size, files, `expected ${files} log files to be read, saw ${reads.size}`);
  for (const [file, n] of reads) {
    assert.equal(n, 1, `${path.basename(file)} was opened ${n} times — the logs must be read once`);
  }
});

test('more sections does not mean more reads', () => {
  // The property itself: one load, many reports. Four sections must cost
  // exactly what one section costs.
  const { home, files } = makeHome();

  const one = countReader(home);
  assert.equal(run(['--sections', 'daily', '--json'], home, one.env).status, 0);
  const oneReads = one.reads();

  const four = countReader(home);
  assert.equal(run(['--sections', 'daily,weekly,monthly,session', '--json'], home, four.env).status, 0);
  const fourReads = four.reads();

  assert.equal(oneReads.size, files, 'the instrumented run must actually read the logs');
  assert.equal(fourReads.size, oneReads.size, 'four sections must not open more files than one');
  for (const [file, n] of fourReads) {
    assert.equal(n, oneReads.get(file) ?? 1, `${path.basename(file)} was read ${n} times for four sections`);
  }
});

test('a --sections run reads the logs no more often than the command it replaces', () => {
  // The comparison that matters to a user: the old way was two commands, so
  // two scans. One --sections run must not be a scan per section.
  const { home, files } = makeHome();

  const command = countReader(home);
  assert.equal(run(['by-day', '--json'], home, command.env).status, 0);
  const commandReads = command.reads();

  const sections = countReader(home);
  assert.equal(run(['--sections', 'daily,weekly,monthly,session', '--json'], home, sections.env).status, 0);
  const sectionReads = sections.reads();

  assert.equal(commandReads.size, files);
  assert.equal(sectionReads.size, commandReads.size);
  for (const [file, n] of sectionReads) {
    assert.equal(n, commandReads.get(file), `${path.basename(file)} was read ${n} times`);
  }
});

/* ------------------------------------------------------------------ *
 * bad input
 * ------------------------------------------------------------------ */

test('an unknown section name is an error that lists the valid ones', () => {
  const { home } = makeHome();
  const r = run(['--sections', 'daily,bogus'], home);
  assert.notEqual(r.status, 0, 'a bad section name must not exit 0');
  assert.match(r.stderr, /unknown section "bogus"/);
  assert.match(r.stderr, /known sections: daily, weekly, monthly, session/);
  assert.doesNotMatch(r.stdout, /Day\s+Tokens/, 'a bad flag must not print a report');
});

test('--sections with no name is an error', () => {
  const { home } = makeHome();
  const r = run(['--sections'], home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--sections expects/);
});

test('a repeated section is an error rather than a silent duplicate', () => {
  const { home } = makeHome();
  const r = run(['--sections', 'daily,daily'], home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate section "daily"/);
});

test('--sections is its own report and refuses a command alongside it', () => {
  // Silently ignoring the command would be the worst answer: the user would
  // think they had asked for a by-day report and got something else.
  const { home } = makeHome();
  const r = run(['by-day', '--sections', 'weekly'], home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--sections is its own report/);
  assert.match(r.stderr, /cannot be combined with the by-day command/);
});

/* ------------------------------------------------------------------ *
 * the empty ledger
 * ------------------------------------------------------------------ */

test('an empty section says so instead of handing back an empty array', () => {
  const home = makeEmptyHome();
  const d = runJson(['--sections', 'daily,weekly'], home);
  for (const name of ['daily', 'weekly']) {
    assert.deepEqual(d[name].rows, [], `${name} has no records`);
    assert.equal(d[name].empty, true, `${name} must say it is empty`);
    assert.match(d[name].note, /No usage records/);
  }
});

test('an empty section says so in the table too', () => {
  const home = makeEmptyHome();
  const r = run(['--sections', 'daily'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No usage records in this ledger/);
  assert.doesNotMatch(r.stdout, /Day\s+Tokens/, 'an empty section must not print an empty table');
});

/* ------------------------------------------------------------------ *
 * capping a section
 * ------------------------------------------------------------------ */

test('--days narrows the daily section to a window, and the totals follow it', () => {
  const { home } = makeHome();
  const d = runJson(['--sections', 'daily,monthly', '--days', '2'], home);
  assert.equal(d.daily.rows.length, 2, 'the daily section must be capped to two days');
  // The capped section reports the window it shows, not the whole ledger.
  const dailyRecords = d.daily.rows.reduce((a, r) => a + r.records, 0);
  assert.equal(dailyRecords, d.daily.totals.records);
  assert.ok(dailyRecords < d.monthly.totals.records, 'the daily window must be smaller than the whole ledger');
});

test('a capped section says that it is capped', () => {
  const { home } = makeHome();
  const r = run(['--sections', 'daily', '--days', '2'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /capped: showing 2 of 3/);
});
