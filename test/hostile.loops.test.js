'use strict';
// Loops of calls that are each under the work limit must still not hold the extension host: every loop
// that calls the regular expression engine (the table of parsed rows, the discovery of the columns of an
// export, the export itself, statistics, a field filter, the highlights of a screen of rows, a rule file)
// shares a work limit for the operation or gives the event loop a turn every few milliseconds. Each test
// uses a pattern that costs a large part of the per-call limit on every line (about 50 ms here) and
// measures the longest stretch in which the event loop was not served.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogSession } = require('../src/session');
const { LogFile } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const S = require('../src/engine/search');
const safere = require('../src/engine/safere');
const { createMatcher } = require('../src/engine/matcher');
const P = require('../src/pro/profiles');
const FF = require('../src/pro/fieldfilter');
const X = require('../src/pro/exporter');
const A = require('../src/pro/anonymise');
const { computeStats } = require('../src/pro/stats');
const G = require('./helpers/gen');

const dir = G.tmpDir('hostileloops-');
const sessions = [];
const opened = [];
test.after(async () => { for (const s of sessions) s.dispose(); for (const f of opened) await f.close(); G.rmDir(dir); });

// The longest stretch the event loop may go unserved: one second, or ten times the cost of a single call
// measured at the same moment (on a busy computer a single call is slower, and so is the stall that it causes).
const MAX_STALL_MS = 1000;
function unitCost(fn) { let worst = 0; for (let i = 0; i < 3; i++) { const t0 = Date.now(); fn(); worst = Math.max(worst, Date.now() - t0); } return worst; }
const stallLimit = (unit) => Math.max(MAX_STALL_MS, 10 * unit);
const LINE = 'a'.repeat(1999);
const PATTERN = '^(?<h>.*a.{0,600})$';
const costly = () => P.createProfile('regex', { pattern: PATTERN });

// Runs fn while a timer measures the longest time the event loop was not served.
async function watched(fn) {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const t0 = Date.now();
  let value;
  try { value = await fn(); } finally { clearInterval(timer); }
  return { value: value, worst: worst, total: Date.now() - t0 };
}

async function fileOf(name, lines) {
  const p = path.join(dir, name);
  G.writeLines(p, lines);
  const f = new LogFile(p, { chunkBytes: 1 << 16 });
  await f.open();
  await f.scan();
  opened.push(f);
  return { file: f, source: new FileSource(f), path: p };
}
const manyLines = (n) => Array.from({ length: n }, () => LINE);
// Random lines of a and b: a pattern with a large state space cannot use the cache and works on every character.
function randomAB(count, length, seed) { const r = G.rng(seed); return Array.from({ length: count }, () => { let t = ''; for (let i = 0; i < length; i++) t += r() < 0.5 ? 'a' : 'b'; return t; }); }

test('the pattern of these tests is costly but under the limit: one parse takes a visible part of it and is not refused', () => {
  const prof = costly();
  const t0 = Date.now();
  assert.ok(prof.parse(LINE));
  const one = Date.now() - t0;
  assert.ok(one > 3, 'one parse took ' + one + ' ms; the tests below need a pattern that costs something on every line');
  const meter = safere.createMeter();
  assert.ok(prof.parse(LINE, { meter: meter }));
  assert.ok(meter.used > safere.WORK_LIMIT / 40 && meter.used < safere.WORK_LIMIT, 'used ' + meter.used + ' of ' + safere.WORK_LIMIT);
});

test('the table of a window of rows shares one work limit and gives the event loop turns', async () => {
  const p = path.join(dir, 'table.log');
  G.writeLines(p, manyLines(500));
  const s = new LogSession({
    post: () => {}, settings: () => ({ maxLineChars: 2000, defaultEncoding: 'auto', indexCacheMB: 0, followIntervalMs: 100000, filterMaxMatches: 2000000, colourLevels: true, neutraliseFormulas: true }),
    cacheDir: '', state: { get: (k, f) => f, update: async () => {} }, gate: async () => true, hasAccess: async () => true, clipboard: async () => {}, status: () => {}, notify: () => {}, now: () => Date.UTC(2026, 5, 1)
  });
  sessions.push(s);
  await s.openFile(p, { engine: { chunkBytes: 4096, stepLines: 8, stepBytes: 800 } });
  await s.scanPromise;
  s.setProfile(costly());
  const unit = unitCost(() => costly().parse(LINE));
  const r = await watched(() => s.table(0, null));
  assert.ok(r.worst < stallLimit(unit), 'the event loop was held for ' + r.worst + ' ms');
  // 500 rows of this cost far more than the batch limit: the table says so, quickly, instead of working for 25 s
  assert.equal(r.value.ok, false);
  assert.match(r.value.message, /could not be built: This pattern needs too much work/);
  assert.ok(r.total < Math.max(8000, 150 * unit), 'took ' + r.total + ' ms');
  // a cheap profile on the same rows is not touched by the limit
  s.setProfile(P.createProfile('regex', { pattern: '^(?<h>a{5})' }));
  const cheap = await s.table(0, null);
  assert.equal(cheap.ok, true);
  assert.equal(cheap.window, 500);
});

test('the discovery of the columns and the export itself give the event loop turns and stay responsive', async () => {
  const { source } = await fileOf('export.log', manyLines(60));
  const out = path.join(dir, 'export.csv');
  const unit = unitCost(() => costly().parse(LINE));
  const r = await watched(() => X.exportLines(source, { outPath: out, format: 'csv', pred: () => true, profile: costly() }));
  assert.equal(r.value.written, 60);
  assert.ok(r.worst < stallLimit(unit), 'the event loop was held for ' + r.worst + ' ms (total ' + r.total + ' ms)');
  assert.ok(r.total > 600, 'the loop really had work to do: ' + r.total + ' ms');
  // cancelling stops the discovery too
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const c = await watched(() => X.exportLines(source, { outPath: out, format: 'csv', pred: () => true, profile: costly(), signal: ctl.signal }));
  assert.ok(c.total < Math.max(3000, 40 * unit), 'a cancelled export took ' + c.total + ' ms');
  assert.ok(c.worst < stallLimit(unit));
});

test('an anonymised export with a costly rule file stays responsive', async () => {
  const { source } = await fileOf('anon.log', manyLines(60).map((l) => l + 'b'));
  const parsed = A.parseRuleFile(JSON.stringify([{ name: 'costly', pattern: 'a.{0,600}b', replace: 'mask' }]));
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 4), rules: parsed.rules, builtins: [] });
  const unit = unitCost(() => an.apply(LINE + 'b'));
  const r = await watched(() => X.exportLines(source, { outPath: path.join(dir, 'anon.out'), format: 'text', pred: () => true, transform: an.apply }));
  assert.equal(r.value.written, 60);
  assert.ok(r.total > 300, 'the rule really had work to do: ' + r.total + ' ms');
  assert.ok(r.worst < stallLimit(unit), 'the event loop was held for ' + r.worst + ' ms (total ' + r.total + ' ms)');
});

test('statistics with a costly profile stay responsive', async () => {
  const { source } = await fileOf('stats.log', manyLines(60));
  const unit = unitCost(() => costly().parse(LINE));
  const r = await watched(() => computeStats(source, { profile: costly(), topFields: ['h'] }));
  assert.equal(r.value.lines, 60);
  assert.ok(r.worst < stallLimit(unit), 'the event loop was held for ' + r.worst + ' ms (total ' + r.total + ' ms)');
});

test('a field filter with a costly expression over many lines stays responsive', async () => {
  const { source } = await fileOf('filter.log', manyLines(60));
  const prof = costly();
  const terms = FF.parseFilter('h~^a.*a.{0,500}b');
  const pred = S.makePredicate({ extra: (rec) => FF.matches(terms, prof.parse(rec.text) || {}) });
  const unit = unitCost(() => pred({ text: LINE }));
  const r = await watched(() => S.runFilter(source, pred, {}));
  assert.equal(r.value.scanned, 60);
  assert.ok(r.worst < stallLimit(unit), 'the event loop was held for ' + r.worst + ' ms (total ' + r.total + ' ms)');
});

test('highlights of a screen of rows with a costly pattern share one limit', () => {
  const m = createMatcher({ text: 'a.{0,600}b', regex: true, caseSensitive: true });
  const meter = safere.createMeter();
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) m.spans(LINE + 'b', 20, meter);
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, 'two hundred rows took ' + ms + ' ms');
  assert.ok(meter.used <= meter.limit + 2000000, 'the shared meter stopped the work at ' + meter.used);
});

test('a find, a count and a filter over many lines with a pattern that needs the whole state space stay responsive', async () => {
  const { source } = await fileOf('count.log', randomAB(80, 2000, 11));
  const m = createMatcher({ text: '[ab]*a[ab]{300}c', regex: true, caseSensitive: true });
  const pred = (rec) => m.test(rec.text);
  const unit = unitCost(() => pred({ text: randomAB(1, 2000, 99)[0] }));
  const r = await watched(() => S.countMatches(source, pred, {}));
  assert.equal(r.value.scanned, 80);
  assert.ok(r.total > 300, 'the loop really had work to do: ' + r.total + ' ms');
  assert.ok(r.worst < stallLimit(unit), 'the event loop was held for ' + r.worst + ' ms (total ' + r.total + ' ms)');
  const f = await watched(() => S.runFilter(source, S.makePredicate({ matcher: m }), {}));
  assert.equal(f.value.scanned, 80);
  assert.ok(f.worst < stallLimit(unit), 'the filter held the event loop for ' + f.worst + ' ms');
  const n = await watched(() => S.findNext(source, pred, -1, {}));
  assert.ok(n.worst < stallLimit(unit), 'the search held the event loop for ' + n.worst + ' ms');
});
