'use strict';
// Adversarial tests of the regular expression engine's guarantee: the work for a text is proportional to
// its length times the size of the pattern, and every call is stopped by a work limit, so that no pattern
// and no text can hold the extension host for long. Every case below finishes or is refused in well under
// two seconds (the limit is about a fifth of a second on a current computer; the ceiling in the tests leaves
// room for a slow machine).
const test = require('node:test');
const assert = require('node:assert/strict');
const safere = require('../src/engine/safere');
const { compile, createMeter, RegexError, WORK_LIMIT } = safere;
const { createMatcher } = require('../src/engine/matcher');
const S = require('../src/engine/search');
const G = require('./helpers/gen');

const CEILING_MS = 2000;

function timed(fn) {
  const t0 = process.hrtime.bigint();
  let outcome;
  try { outcome = { value: fn() }; } catch (e) { outcome = { error: e }; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, outcome: outcome };
}
function finishesOrRefuses(label, fn) {
  const r = timed(fn);
  assert.ok(r.ms < CEILING_MS, label + ' took ' + Math.round(r.ms) + ' ms');
  if (r.outcome.error) {
    assert.ok(r.outcome.error instanceof RegexError, label + ': ' + r.outcome.error.stack);
    assert.equal(r.outcome.error.code, 'budget', label);
    assert.match(r.outcome.error.message, /too much work/);
    assert.match(r.outcome.error.message, /Simplify/);
  }
  return r;
}
function randomAB(n) { const r = G.rng(7); let o = ''; for (let i = 0; i < n; i++) o += r() < 0.5 ? 'a' : 'b'; return o; }

test('a pattern with a huge state space on one 1,000,000-character line: done or refused, never minutes', () => {
  const line = randomAB(1000000);
  for (const k of [20, 200, 1000]) finishesOrRefuses('[ab]*a[ab]{' + k + '}c', () => compile('[ab]*a[ab]{' + k + '}c').test(line));
});

test('hundreds of groups on a long line: row rendering and capture extraction stay bounded', () => {
  const text = 'a'.repeat(2000) + 'b';
  for (const groups of [300, 600]) {
    const pattern = '(a)'.repeat(groups) + 'b';
    finishesOrRefuses(groups + ' groups, exec with captures', () => compile(pattern).exec(text));
    finishesOrRefuses(groups + ' groups, findAll', () => compile(pattern).findAll(text, 200));
    finishesOrRefuses(groups + ' groups, highlights of 100 rows', () => {
      const m = createMatcher({ text: pattern, regex: true, caseSensitive: true });
      const meter = createMeter();
      for (let i = 0; i < 100; i++) m.spans(text, 20, meter);
      return m.tooCostly;
    });
  }
});

test('findAll on a pattern that scans to the end of the line for every match is bounded by one limit for the whole call', () => {
  finishesOrRefuses('a.*b|a on 1,000,000 characters, 500 matches', () => compile('a.*b|a').findAll('a'.repeat(1000000), 500));
  finishesOrRefuses('a.*b|a on 100,000 characters, 200 matches', () => compile('a.*b|a').findAll('a'.repeat(100000), 200));
});

test('classic catastrophic patterns stay fast', () => {
  for (const [p, text] of [['(a+)+$', 'a'.repeat(200000) + 'b'], ['(x+x+)+y', 'x'.repeat(200000)], ['(a|aa)+$', 'a'.repeat(100000) + '!'], ['(.*a){20}x', 'a'.repeat(40000)], ['.*.*.*.*.*x', 'a'.repeat(60000)], ['(a*)*b', 'a'.repeat(30000)]]) {
    const r = finishesOrRefuses(p, () => { const re = compile(p); return [re.test(text), re.exec(text, 0)]; });
    if (!r.outcome.error) assert.equal(r.outcome.value[0], false, p);
  }
});

test('the limit is a count of work, so it is the same on every machine: a small budget refuses the same call every time', () => {
  const re = compile('[ab]*a[ab]{200}c');
  const line = randomAB(100000);
  for (let i = 0; i < 3; i++) {
    const meter = createMeter(50000);
    assert.throws(() => re.test(line, { meter: meter }), (e) => e.code === 'budget');
    assert.ok(meter.used >= 50000 && meter.used < 50000 + 100000, 'stopped close to the limit: ' + meter.used);
  }
  assert.throws(() => compile('a.*b|a').findAll('a'.repeat(5000), 100, { budget: 1000 }), (e) => e.code === 'budget');
  // an ordinary call is far below the limit
  const meter = createMeter();
  assert.equal(compile('error.{0,120}timeout').test('2026-01-15 ERROR something then a timeout', { meter: meter }), false);
  assert.equal(compile('error.{0,120}timeout', { ignoreCase: true }).test('2026-01-15 ERROR something then a timeout', { meter: meter }), true);
  assert.ok(meter.used < WORK_LIMIT / 100, 'used ' + meter.used);
});

test('a shared meter limits a whole batch, not only each call', () => {
  const re = compile('(a)(a)(a)(a)(a)(a)(a)(a)b');
  const meter = createMeter(200000);
  const t0 = Date.now();
  let refused = 0;
  for (let i = 0; i < 500; i++) {
    try { re.findAll('a'.repeat(3000) + 'b', 5, { meter: meter }); } catch (e) { assert.equal(e.code, 'budget'); refused++; }
  }
  assert.ok(refused > 0 && refused < 500, 'refused ' + refused);
  assert.ok(Date.now() - t0 < CEILING_MS);
});

test('realistic patterns on 100,000 realistic lines finish at once and are never refused', () => {
  const rnd = G.rng(31);
  const lines = [];
  for (let i = 0; i < 100000; i++) lines.push(G.standardLine(i, rnd));
  for (const [pattern, expectAny] of [['error.{0,120}timeout', true], ['id=.{2}0000', true], ['(?:\\w+\\s){30}ZZ', false], ['svc=(?<u>\\w+).*status=5\\d\\d', false], ['ERROR|WARN', true], ['\\bretry\\b', true]]) {
    const re = compile(pattern, { ignoreCase: true });
    const r = timed(() => { let c = 0; for (const l of lines) if (re.test(l)) c++; return c; });
    assert.ok(!r.outcome.error, pattern + ': ' + (r.outcome.error && r.outcome.error.message));
    assert.ok(r.ms < CEILING_MS, pattern + ' took ' + Math.round(r.ms) + ' ms');
    assert.equal(r.outcome.value > 0, expectAny, pattern + ' matched ' + r.outcome.value);
  }
});

test('the simulation that takes over from a cache that keeps overflowing gives the same answers as the runtime', () => {
  const rnd = G.rng(20261113);
  const atoms = ['a', 'b', '.', '[ab]', '[^a]', 'a?', 'b*', '(?:ab|ba)'];
  let compared = 0;
  for (let n = 0; n < 1500; n++) {
    let pattern = '';
    const parts = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < parts; i++) pattern += atoms[Math.floor(rnd() * atoms.length)] + (rnd() < 0.3 ? '{1,3}' : rnd() < 0.2 ? '+' : '');
    if (rnd() < 0.3) pattern = '[ab]*' + pattern;
    if (rnd() < 0.3) pattern += '$';
    let native;
    try { native = new RegExp(pattern); } catch (e) { continue; }
    const tiny = compile(pattern, { maxStates: 4 });
    const normal = compile(pattern);
    for (let k = 0; k < 6; k++) {
      let text = '';
      const len = 30 + Math.floor(rnd() * 400);
      for (let j = 0; j < len; j++) text += 'abc'[Math.floor(rnd() * 3)];
      const expected = native.test(text);
      assert.equal(tiny.test(text, { budget: 1e9 }), expected, 'tiny cache: ' + pattern + ' on ' + text);
      assert.equal(normal.test(text), expected, 'normal cache: ' + pattern + ' on ' + text);
      compared++;
    }
  }
  assert.ok(compared > 5000, 'compared ' + compared);
});

test('a start in the middle of a text keeps the context of ^ and word boundaries (used by findAll)', () => {
  const m = compile('^a|\\bb').findAll('ab a b', 10);
  assert.deepEqual(m.map((x) => [x.index, x.text]), [[0, 'a'], [5, 'b']]);
  const words = compile('\\bcat\\b').findAll('cat concat cat, cat', 10);
  assert.deepEqual(words.map((x) => x.index), [0, 11, 16]);
  const long = ('x'.repeat(300) + ' cat ').repeat(3);
  assert.deepEqual(compile('\\bcat\\b').findAll(long, 10).map((x) => x.index), [301, 606, 911]);
});

// ---- passes: event loop and cancellation ------------------------------------------------------------------------

function fakeSource(count, make) {
  return {
    kind: 'fake', lineCount: count, complete: true,
    async forEachText(start, cb, opts) {
      for (let i = start; i < count; i++) {
        let keep = cb({ no: i, offset: i, text: make(i), byteLength: 0, capped: false, tag: '' });
        if (keep && typeof keep.then === 'function') keep = await keep;
        if (keep === false) return { aborted: false, stopped: true, longLines: 0 };
      }
      return { aborted: false, stopped: false, longLines: 0 };
    }
  };
}

test('a filter pass over many lines gives the event loop a turn every few milliseconds', async () => {
  const rnd = G.rng(5);
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(G.standardLine(i, rnd));
  const src = fakeSource(1200000, (i) => lines[i % 20000]);
  const matcher = createMatcher({ text: 'user=(?<u>\\w+).*status=5\\d\\d|id=.{0,40}9999', regex: true, caseSensitive: false });
  const pred = S.makePredicate({ matcher: matcher });
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const res = await S.runFilter(src, pred, {});
  clearInterval(timer);
  assert.equal(res.error, undefined);
  assert.ok(res.scanned === 1200000);
  assert.ok(worst < 250, 'the longest stretch without a turn of the event loop was ' + worst + ' ms');
});

test('a pass whose pattern is too costly stops with the message, keeps nothing half done and takes about the limit, not minutes', async () => {
  const line = randomAB(400000);
  const src = fakeSource(50, () => line);
  const pred = S.makePredicate({ matcher: createMatcher({ text: '[ab]*a[ab]{200}c', regex: true, caseSensitive: true }) });
  const t0 = Date.now();
  const res = await S.runFilter(src, pred, {});
  assert.match(res.error, /too much work/);
  assert.equal(res.aborted, false);
  assert.ok(Date.now() - t0 < CEILING_MS, 'took ' + (Date.now() - t0) + ' ms');
  const count = await S.countMatches(src, (rec) => createMatcher({ text: '[ab]*a[ab]{200}c', regex: true, caseSensitive: true }).test(rec.text), {});
  assert.match(count.error, /too much work/);
  const next = await S.findNext(src, (rec) => createMatcher({ text: '[ab]*a[ab]{200}c', regex: true, caseSensitive: true }).test(rec.text), -1, {});
  assert.match(next.error, /too much work/);
});

test('cancelling stops a pass within a fraction of a second even when every line is slow', async () => {
  const src = fakeSource(100000, (i) => 'line ' + i);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 60);
  const slow = (rec) => { const t0 = Date.now(); while (Date.now() - t0 < 2) { /* one line takes 2 ms */ } return false; };
  const t0 = Date.now();
  const res = await S.runFilter(src, slow, { signal: ctl.signal });
  assert.equal(res.aborted, true);
  assert.ok(Date.now() - t0 < 1000, 'stopped after ' + (Date.now() - t0) + ' ms');
  assert.ok(res.scanned < 2000, 'scanned ' + res.scanned);
});
