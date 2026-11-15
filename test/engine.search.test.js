'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { LogFile } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const S = require('../src/engine/search');
const { createMatcher } = require('../src/engine/matcher');
const levels = require('../src/engine/levels');
const T = require('../src/engine/timestamps');
const G = require('./helpers/gen');

const dir = G.tmpDir('search-');
const opened = [];
test.after(async () => { for (const f of opened) await f.close(); G.rmDir(dir); });

async function source(name, lines, opts) {
  const p = path.join(dir, name);
  G.writeLines(p, lines, opts);
  const f = new LogFile(p, { chunkBytes: 4096, stepLines: 8, stepBytes: 1000 });
  await f.open();
  await f.scan();
  opened.push(f);
  return new FileSource(f);
}

test('levels: structured fields, upper-case words, bracketed words, plain text', () => {
  const cases = [
    ['2026-01-01 10:00:00 ERROR something broke', 4], ['2026-01-01 WARN  disk 91%', 3], ['INFO starting', 2], ['DEBUG x=1', 1], ['TRACE enter', 0], ['FATAL out of memory', 5],
    ['{"ts":"2026-01-01T00:00:00Z","level":"warn","msg":"slow"}', 3], ['time=2026 level=error msg="x"', 4], ['2026/01/01 10:00:00 [error] 12#12: *1 upstream timed out', 4],
    ['2026/01/01 10:00:00 [notice] 12#12: signal', 2], ['Error: cannot open file', 4], ['no level here', -1], ['the error was in the machine', -1], ['Jan  1 00:00:00 host app[1]: CRITICAL meltdown', 5],
    ['{"severity":"CRITICAL"}', 5], ['level=information', 2]
  ];
  for (const [line, rank] of cases) assert.equal(levels.levelRank(line), rank, line);
  assert.equal(levels.levelOf('INFO x').label, 'INFO');
  assert.equal(levels.rankOfWord('Warning'), 3);
});

test('time stamps: hand-computed epoch values in every format', () => {
  const ref = Date.UTC(2026, 4, 20);
  const cases = [
    ['iso', '2024-05-01T12:34:56.789Z msg', Date.UTC(2024, 4, 1, 12, 34, 56, 789)],
    ['iso', '2024-05-01 12:34:56,789 [main] INFO', Date.UTC(2024, 4, 1, 12, 34, 56, 789)],
    ['iso', '2024-05-01T12:34:56+02:00 x', Date.UTC(2024, 4, 1, 10, 34, 56)],
    ['iso', '2024-05-01 12:34:56 -0530 x', Date.UTC(2024, 4, 1, 18, 4, 56)],
    ['slash', '2024/05/01 12:34:56 [error]', Date.UTC(2024, 4, 1, 12, 34, 56)],
    ['clf', '10.0.0.1 - - [01/May/2024:12:34:56 +0200] "GET / HTTP/1.1" 200 5', Date.UTC(2024, 4, 1, 10, 34, 56)],
    ['apache-error', '[Wed May 01 12:34:56.123456 2024] [core:error] x', Date.UTC(2024, 4, 1, 12, 34, 56)],
    ['syslog', 'May  1 12:34:56 host app: x', Date.UTC(2026, 4, 1, 12, 34, 56)],
    ['syslog', 'Dec 31 23:59:59 host app: x', Date.UTC(2025, 11, 31, 23, 59, 59)],
    ['syslog', '<34>Oct 11 22:14:15 mymachine su: x', Date.UTC(2025, 9, 11, 22, 14, 15)],
    ['logcat', '05-01 12:34:56.789 1234 5678 I Tag: x', Date.UTC(2026, 4, 1, 12, 34, 56, 789)],
    ['epoch', '{"ts":1714566896,"msg":"x"}', 1714566896000],
    ['epoch', '{"time":1714566896.250,"msg":"x"}', 1714566896250],
    ['epoch', '{"timestamp":1714566896789}', 1714566896789],
    ['epoch', 'ts=1714566896 level=info', 1714566896000],
    ['time-of-day', '12:34:56.789 started', (12 * 3600 + 34 * 60 + 56) * 1000 + 789]
  ];
  for (const [id, line, ms] of cases) assert.equal(T.extract(id, line, ref), ms, id + ': ' + line);
  assert.ok(isNaN(T.extract('iso', '2024-02-31T10:00:00Z', ref)), '31 February');
  assert.ok(isNaN(T.extract('iso', '2024-13-01T10:00:00Z', ref)));
  assert.ok(isNaN(T.extract('iso', 'nothing', ref)));
});

test('time stamp format detection picks the dominant format and tolerates stack trace lines', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push('2026-01-15 10:00:' + String(i % 60).padStart(2, '0') + ' INFO x');
  lines.push('\tat com.example.Foo(Foo.java:10)', '\tat com.example.Bar(Bar.java:20)');
  assert.equal(T.detect(lines, Date.UTC(2026, 0, 1)).id, 'iso');
  assert.equal(T.detect(['no time here', 'nor here', 'nothing'], 0), null);
  assert.equal(T.detect(['May  1 10:00:00 a b: c', 'May  1 10:00:01 a b: c', 'May  1 10:00:02 a b: c'], Date.UTC(2026, 4, 2)).id, 'syslog');
});

test('time stamps do not depend on the time zone of the computer', () => {
  const code = "const T=require(" + JSON.stringify(path.join(__dirname, '..', 'src', 'engine', 'timestamps.js')) + ");" +
    "console.log([T.extract('iso','2026-03-29 01:30:00 x'),T.extract('syslog','Mar 29 02:30:00 h a: b',Date.UTC(2026,2,30)),T.extract('clf','[08/Nov/2026:00:30:00 +0000]'),T.parseUserTime('2026-11-01 01:30'),T.toIso(0)].join('|'))";
  const outs = new Set();
  for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
    const r = cp.spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    outs.add(r.stdout.trim());
  }
  assert.equal(outs.size, 1, Array.from(outs).join(' / '));
});

test('user times: dates, times of day, epoch numbers', () => {
  assert.equal(T.parseUserTime('2024-05-01'), Date.UTC(2024, 4, 1));
  assert.equal(T.parseUserTime('2024-05-01 10:30'), Date.UTC(2024, 4, 1, 10, 30));
  assert.equal(T.parseUserTime('2024-05-01T10:30:15.5Z'), Date.UTC(2024, 4, 1, 10, 30, 15, 500));
  assert.equal(T.parseUserTime('1714566896'), 1714566896000);
  assert.equal(T.parseUserTime('1714566896789'), 1714566896789);
  assert.ok(isNaN(T.parseUserTime('yesterday')));
  assert.ok(isNaN(T.parseUserTime('25:00')));
});

test('findNext, findPrevious and countMatches agree with a naive scan on a random file', async () => {
  const rnd = G.rng(11);
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push(G.standardLine(i, rnd) + (rnd() < 0.05 ? ' needle' : ''));
  const s = await source('find.log', lines);
  const pred = (rec) => rec.text.includes('needle');
  const hits = [];
  lines.forEach((l, i) => { if (l.includes('needle')) hits.push(i); });
  assert.ok(hits.length > 20);
  let cur = -1;
  for (const expected of hits) {
    const r = await S.findNext(s, pred, cur);
    assert.equal(r.line, expected);
    cur = r.line;
  }
  assert.equal((await S.findNext(s, pred, cur)).line, null);
  cur = lines.length;
  for (let k = hits.length - 1; k >= 0; k--) {
    const r = await S.findPrevious(s, pred, cur);
    assert.equal(r.line, hits[k]);
    cur = r.line;
  }
  assert.equal((await S.findPrevious(s, pred, cur)).line, null);
  const c = await S.countMatches(s, pred);
  assert.equal(c.count, hits.length);
  assert.equal(c.scanned, 1500);
});

test('filters: level with continuation lines, text, regular expression, time range', async () => {
  const lines = [
    '2026-01-15 10:00:00 INFO start', '2026-01-15 10:00:01 ERROR failed to open', '\tat Foo.bar(Foo.java:1)', '\tat Foo.baz(Foo.java:2)', '2026-01-15 10:00:02 INFO next',
    '2026-01-15 10:00:03 WARN slow', 'continuation of a warning', '2026-01-15 10:05:00 ERROR again', '2026-01-15 10:05:01 DEBUG x'
  ];
  const s = await source('filter.log', lines);
  const run = async (opts) => (await S.runFilter(s, S.makePredicate(opts))).list;
  let list = await run({ levels: [4, 5] });
  assert.deepEqual(Array.from({ length: list.length }, (_, i) => list.get(i)), [1, 2, 3, 7], 'errors with their stack lines');
  list = await run({ levels: [4, 5], keepContinuation: false });
  assert.deepEqual(Array.from({ length: list.length }, (_, i) => list.get(i)), [1, 7]);
  list = await run({ levels: [3] , timeFormat: 'iso' });
  assert.deepEqual(Array.from({ length: list.length }, (_, i) => list.get(i)), [5, 6]);
  list = await run({ matcher: createMatcher({ text: 'ERROR|WARN', regex: true, caseSensitive: true }) });
  assert.deepEqual(Array.from({ length: list.length }, (_, i) => list.get(i)), [1, 5, 7]);
  list = await run({ timeFormat: 'iso', from: Date.UTC(2026, 0, 15, 10, 1, 0), to: Date.UTC(2026, 0, 15, 10, 9, 0) });
  assert.deepEqual(Array.from({ length: list.length }, (_, i) => list.get(i)), [7, 8]);
  list = await run({});
  assert.equal(list.length, 9);
  assert.equal(list.lowerBound(5), 5);
  assert.equal(list.lowerBound(100), 9);
});

test('a filter that finds more than its limit says so and does not drop silently', async () => {
  const s = await source('limit.log', Array.from({ length: 500 }, (_, i) => 'INFO line ' + i));
  const r = await S.runFilter(s, S.makePredicate({}), { limit: 100 });
  assert.equal(r.limited, true);
  assert.equal(r.list.length, 100);
  const r2 = await S.runFilter(s, S.makePredicate({}), { limit: 1000 });
  assert.equal(r2.limited, false);
  assert.equal(r2.list.length, 500);
});

test('a pass can be cancelled and reports progress', async () => {
  const p = path.join(dir, 'prog.log');
  await G.writeStandard(p, 40000);
  const f = new LogFile(p, { chunkBytes: 32768 });
  await f.open(); await f.scan();
  const s = new FileSource(f);
  const ctl = new AbortController();
  let reports = 0;
  let seen = 0;
  const r = await S.countMatches(s, () => { if (++seen === 5000) ctl.abort(); return true; }, { signal: ctl.signal, onProgress: () => { reports++; } });
  assert.equal(r.aborted, true);
  assert.ok(r.scanned < 40000 && r.scanned >= 5000);
  assert.ok(reports >= 1);
  await f.close();
});

test('lines longer than the scan limit are counted, not hidden', async () => {
  const p = path.join(dir, 'longl.log');
  fs.writeFileSync(p, 'short needle\n' + 'y'.repeat(2000000) + ' needle\nend\n');
  const f = new LogFile(p); await f.open(); await f.scan();
  const s = new FileSource(f);
  const r = await S.countMatches(s, (rec) => rec.text.includes('needle'));
  assert.equal(r.count, 1, 'the needle after the first million characters is outside the scanned part');
  assert.equal(r.longLines, 1, 'and the pass says that one line was read only in part');
  await f.close();
});
