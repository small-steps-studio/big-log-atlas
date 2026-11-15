'use strict';
// Regression tests for the smaller defects of the independent audit: the end date of an expired trial,
// numbers with an exponent, case-insensitive matching of letters with unusual case rules, the activation
// label of the editor, the private-gate probe, and the matcher's work limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/pro/profiles');
const FF = require('../src/pro/fieldfilter');
const F = require('./helpers/licence-fakes');
const L = require('../src/licence/licence');
const { compile } = require('../src/engine/safere');
const { createMatcher } = require('../src/engine/matcher');
const G = require('./helpers/gen');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---- 11: the end date of an expired trial ----------------------------------------------------------------

test('trial: after it ended, setting the clock back does not change the end date that is shown', async () => {
  const m = F.make();
  const start = m.now();
  await m.lic.startTrial();
  m.advance(14 * DAY + 5 * HOUR);
  const seen = await m.lic.checkTrial();
  assert.equal(seen.state, 'expired');
  assert.equal(seen.endsAt, start + 14 * DAY, 'the end is 14 days after the start');
  m.advance(-(11 * DAY + 5 * HOUR)); // the clock now says day 3
  const back = m.lic.trialStatus();
  assert.equal(back.state, 'expired', 'an ended trial stays ended');
  assert.equal(back.endsAt, start + 14 * DAY, 'and still ends on day 14, not on day 3');
  const checked = await m.lic.checkTrial();
  assert.equal(checked.endsAt, start + 14 * DAY);
});

test('trial: the other clock checks still hold (used days kept, no extension near the end, a future start is re-anchored)', async () => {
  const a = F.make();
  await a.lic.startTrial();
  a.advance(10 * DAY);
  await a.lic.touchTrial();
  a.advance(-5 * DAY);
  assert.equal(a.lic.trialStatus().daysLeft, 4, 'ten days used stay used');
  const b = F.make();
  await b.lic.startTrial();
  b.advance(13 * DAY + 12 * HOUR);
  await b.lic.touchTrial();
  b.advance(-12 * HOUR);
  assert.equal(b.lic.trialStatus().state, 'active');
  assert.ok(b.lic.trialStatus().daysLeft <= 1);
});

// ---- 13: numbers with an exponent -------------------------------------------------------------------------------

test('numbers in exponent form are compared as exact decimals, in comparisons, filters and sorting', () => {
  const c = P.compareValues;
  assert.equal(c('1e3', '999'), 1);
  assert.equal(c('1e3', '1000'), 0);
  assert.equal(c('1.5e3', '1500'), 0);
  assert.equal(c('2E-7', '0.0000002'), 0);
  assert.equal(c('2E-7', '0.0000003'), -1);
  assert.equal(c('-1e3', '5'), -1);
  assert.equal(c('-1e3', '-999'), -1);
  assert.equal(c('1e+2', '99.9999999999999999999'), 1);
  assert.equal(c('9007199254740993e0', '9007199254740992'), 1, 'digits beyond 2^53 stay exact');
  assert.equal(c('0e5', '0'), 0);
  assert.equal(c('1e999999', '1e999998'), 1, 'a huge exponent costs no memory');
  assert.equal(P.isNumberText('1.5e3'), true);
  assert.equal(P.isNumberText('1e'), false);
  assert.equal(P.isNumberText('e5'), false);
  assert.equal(P.isNumberText('1e1234567'), false, 'an exponent of more than six digits is text');
  const terms = FF.parseFilter('dur_ms>500');
  assert.equal(FF.matches(terms, { dur_ms: '1.5e3' }), true);
  assert.equal(FF.matches(terms, { dur_ms: '4.9e2' }), false);
  const jsonl = P.createProfile('jsonl').parse('{"dur_ms":1.5e3,"n":2E-7}');
  assert.equal(FF.matches(FF.parseFilter('dur_ms>=1500 n<0.000001'), jsonl), true);
  const sorted = ['1e3', '999', '2', '1.5e3', '-1e1'].sort(P.compareValues);
  assert.deepEqual(sorted, ['-1e1', '2', '999', '1e3', '1.5e3']);
});

// ---- 12: case-insensitive matching follows the runtime ----------------------------------------------------------

test('case-insensitive matching of letters with unusual case rules agrees with the runtime (seeded differential test)', () => {
  const rnd = G.rng(9091);
  const letters = ['a', 'k', 's', 'S', 'K', 'ſ', 'K', 'Ǆ', 'ǅ', 'ǆ', 'ß', 'é', 'É', 'ı', 'İ', 'i', 'I', 'x', ' ', '\t'];
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let compared = 0;
  for (let n = 0; n < 6000; n++) {
    let pattern = '';
    const parts = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < parts; i++) {
      const r = rnd();
      let atom = r < 0.2 ? '[' + pick(letters) + pick(letters) + ']' : r < 0.3 ? '[^' + pick(letters) + ']' : r < 0.36 ? '\\w' : r < 0.4 ? '\\W' : pick(letters);
      const q = rnd();
      if (q < 0.15) atom += '*'; else if (q < 0.3) atom += '+'; else if (q < 0.4) atom += '?';
      pattern += atom;
    }
    let native;
    try { native = new RegExp(pattern, 'i'); } catch (e) { continue; }
    const mine = compile(pattern, { ignoreCase: true });
    for (let k = 0; k < 4; k++) {
      let text = '';
      const len = Math.floor(rnd() * 8);
      for (let j = 0; j < len; j++) text += pick(letters);
      assert.equal(mine.test(text), native.test(text), 'pattern ' + JSON.stringify(pattern) + ' on ' + JSON.stringify(text));
      compared++;
    }
  }
  assert.ok(compared > 20000, 'compared ' + compared);
  // the pair the audit found
  assert.equal(compile('ǆ*?ſ\\d?S+', { ignoreCase: true }).test('\tSsékKs'), new RegExp('ǆ*?ſ\\d?S+', 'i').test('\tSsékKs'));
  assert.equal(compile('k', { ignoreCase: true }).test('K'), false, 'the Kelvin sign is not a k for the runtime in this mode');
  assert.equal(compile('s', { ignoreCase: true }).test('ſ'), false, 'the long s is not an s');
  assert.equal(compile('é', { ignoreCase: true }).test('É'), true);
  assert.equal(compile('abc', { ignoreCase: true }).test('xABCx'), true);
});

// ---- 21: the activation label -----------------------------------------------------------------------------------

test('the activation name carries the editor name and the platform, never a host name', async () => {
  assert.equal(L.instanceName('win32', 'Visual Studio Code'), 'Visual Studio Code on Windows');
  assert.equal(L.instanceName('linux', 'VSCodium'), 'VSCodium on Linux');
  assert.equal(L.instanceName('darwin', ''), 'VS Code on macOS');
  assert.equal(L.instanceName('darwin'), 'VS Code on macOS');
  assert.equal(L.instanceName('linux', 'Ed<script>itor\u0000'), 'Edscriptitor on Linux', 'only letters, digits and a few marks are kept');
  assert.ok(L.instanceName('linux', 'x'.repeat(200)).length <= 'x'.repeat(40).length + ' on Linux'.length);
  const m = F.make({ editorName: 'Visual Studio Code' });
  await m.lic.activate('KEY-PERSONAL');
  assert.equal(m.srv.calls[0].body.name, 'Visual Studio Code on Windows');
});

// ---- 2: the work limit as the guarantee ---------------------------------------------------------------------------

function timed(fn) {
  const t0 = process.hrtime.bigint();
  let outcome;
  try { outcome = { value: fn() }; } catch (e) { outcome = { error: e }; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, outcome: outcome };
}

test('the matcher stops a pattern that needs too much work with a message, and a match without any trouble is not refused', () => {
  const m = createMatcher({ text: 'x*x*x*x*x*x*x*x*y', regex: true, caseSensitive: true });
  assert.equal(m.ok, true);
  const line = 'x'.repeat(50000);
  const r = timed(() => m.test(line));
  assert.ok(r.ms < 1500, 'took ' + r.ms + ' ms');
  // either a plain answer or the budget error, never a hang
  if (r.outcome.error) { assert.equal(r.outcome.error.code, 'budget'); assert.match(r.outcome.error.message, /too much work/); } else assert.equal(r.outcome.value, false);
  const easy = createMatcher({ text: 'timeout|error', regex: true });
  assert.equal(easy.test('2026-01-15 ERROR something failed'), true);
  assert.equal(easy.test('all fine'), false);
});

test('rows share one work limit and a pattern that is too costly leaves its rows without highlights', () => {
  const safere = require('../src/engine/safere');
  const m = createMatcher({ text: '(a)'.repeat(600) + 'b', regex: true, caseSensitive: true });
  const meter = safere.createMeter();
  const t0 = Date.now();
  let spans = 0;
  for (let i = 0; i < 200; i++) spans += m.spans('a'.repeat(2000) + 'b', 20, meter).length;
  assert.ok(Date.now() - t0 < 2000, 'two hundred rows took ' + (Date.now() - t0) + ' ms');
  assert.equal(spans, 0);
  assert.equal(m.tooCostly, true);
  assert.ok(meter.used >= meter.limit, 'the shared limit was reached');
});
