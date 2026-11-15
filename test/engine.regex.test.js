'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, RegexError, escapeText } = require('../src/engine/safere');
const { createMatcher } = require('../src/engine/matcher');
const G = require('./helpers/gen');

function refuses(pattern, code) {
  assert.throws(() => compile(pattern), (e) => e instanceof RegexError && (!code || e.code === code), pattern);
}

test('hand-checked matches and spans', () => {
  const cases = [
    ['abc', 'xxabcxx', 2, 'abc'], ['a+b', 'caaab', 1, 'aaab'], ['colou?r', 'my color', 3, 'color'], ['(a|ab)(c|bcd)', 'abcd', 0, 'abcd'],
    ['\\d{3}-\\d{4}', 'call 555-1234 now', 5, '555-1234'], ['^\\s*#', '  # note', 0, '  #'], ['x*', 'aaa', 0, ''], ['a+?', 'aaa', 0, 'a'],
    ['\\bcat\\b', 'a cat sat', 2, 'cat'], ['[^a-c]+', 'abcxyzabc', 3, 'xyz'], ['(?:ab){2,3}', 'xababababx', 1, 'ababab'], ['é+', 'caféé', 3, 'éé']
  ];
  for (const [p, text, index, matched] of cases) {
    const m = compile(p).exec(text);
    assert.ok(m, p);
    assert.equal(m.index, index, p);
    assert.equal(m.text, matched, p);
    assert.equal(compile(p).test(text), true, p);
  }
  assert.equal(compile('\\bcat\\b').test('concatenate'), false);
  assert.equal(compile('^abc$').test('abcd'), false);
});

test('named groups and capture positions', () => {
  const m = compile('^(?<time>\\d{4}-\\d{2}-\\d{2}) (?<level>[A-Z]+) (?<msg>.*)$').exec('2026-01-15 ERROR disk almost full');
  assert.deepEqual(m.groups, { time: '2026-01-15', level: 'ERROR', msg: 'disk almost full' });
  const n = compile('(a)|(b)').exec('b');
  assert.equal(n.captures[1], undefined);
  assert.equal(n.captures[2], 'b');
});

test('catastrophic patterns run in time proportional to the text', () => {
  const t0 = Date.now();
  assert.equal(compile('(a+)+$').test('a'.repeat(100000) + 'b'), false);
  assert.equal(compile('(x+x+)+y').test('x'.repeat(100000)), false);
  assert.equal(compile('(a|aa)+$').test('a'.repeat(50000) + '!'), false);
  assert.equal(compile('(.*a){20}').test('a'.repeat(30) + 'b'), true);
  assert.equal(compile('^(a?){30}a{30}$').test('a'.repeat(30)), true);
  assert.equal(compile('(a*)*b').exec('a'.repeat(3000)), null);
  assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
});

test('constructs that cannot be matched in linear time are refused with a clear message', () => {
  refuses('(?=a)', 'unsupported'); refuses('(?!a)', 'unsupported'); refuses('(?<=a)b', 'unsupported'); refuses('(?<!a)b', 'unsupported');
  refuses('(a)\\1', 'unsupported'); refuses('(?<n>a)\\k<n>', 'unsupported'); refuses('\\p{L}', 'unsupported');
  try { compile('(?=a)'); assert.fail('should throw'); } catch (e) { assert.match(e.message, /guaranteed linear time/); }
});

test('invalid patterns are refused with a message', () => {
  for (const p of ['(', ')', 'a)', '[a', '*a', 'a**', 'a{2,1}', '\\', '(?<1x>a)', '(?<n>a)(?<n>b)', 'a{1001}', '(?i)a']) refuses(p);
  assert.throws(() => compile('a'.repeat(2001)), /longer than/);
  assert.throws(() => compile('(((a{1000}){1000}){1000})'), /too large/);
  assert.throws(() => compile('('.repeat(80) + 'a' + ')'.repeat(80)), /nested/);
});

test('the lazy DFA survives a cache flush', () => {
  // many distinct states: alternatives that remember a different amount of text each
  const parts = [];
  for (let i = 0; i < 40; i++) parts.push('x' + String.fromCharCode(97 + (i % 26)) + '{3}' + i);
  const re = compile('(?:' + parts.join('|') + ')$', { maxStates: 12 });
  const rnd = G.rng(5);
  let text = '';
  for (let i = 0; i < 200000; i++) text += 'xab'[Math.floor(rnd() * 3)];
  // A cache of 12 states is far too small for this pattern, so the engine goes on without a cache; a large work limit lets the test see the answers.
  const big = { budget: 1e9 };
  assert.equal(re.test(text, big), false);
  assert.equal(re.test(text + 'xaaa0', big), true);
  assert.equal(re.test(text + 'xbbb1', big), true);
});

// A seeded random builder of patterns in the supported subset, compared with the engine of the
// JavaScript runtime on random text. Only the text (not the captures) of the leftmost match is compared.
function randomPattern(rnd, depth) {
  const atoms = ['a', 'b', 'c', '.', '[ab]', '[^a]', '\\d', '\\w', '1', ' ', '\\bb', 'ab'];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  function term(d) {
    let t;
    const r = rnd();
    if (d > 0 && r < 0.25) t = '(?:' + alt(d - 1) + ')';
    else if (d > 0 && r < 0.35) t = '(' + alt(d - 1) + ')';
    else t = pick(atoms);
    const q = rnd();
    if (q < 0.12) t += '*'; else if (q < 0.24) t += '+'; else if (q < 0.34) t += '?'; else if (q < 0.4) t += '{1,3}'; else if (q < 0.44) t += '*?'; else if (q < 0.47) t += '{2}';
    return t;
  }
  function cat(d) { let s = ''; const n = 1 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) s += term(d); return s; }
  function alt(d) { const n = 1 + (rnd() < 0.3 ? 1 : 0); const parts = []; for (let i = 0; i < n; i++) parts.push(cat(d)); return parts.join('|'); }
  let p = alt(depth);
  if (rnd() < 0.15) p = '^' + p;
  if (rnd() < 0.15) p += '$';
  return p;
}

test('differential test against the runtime engine: 6000 random patterns, 5 texts each', () => {
  const rnd = G.rng(20261112);
  const alphabet = 'aabbc1 _.';
  let compared = 0;
  for (let i = 0; i < 6000; i++) {
    const pattern = randomPattern(rnd, 2);
    let native;
    try { native = new RegExp(pattern); } catch (e) { continue; }
    const mine = compile(pattern);
    for (let k = 0; k < 5; k++) {
      let text = '';
      const len = Math.floor(rnd() * 14);
      for (let j = 0; j < len; j++) text += alphabet[Math.floor(rnd() * alphabet.length)];
      const a = native.exec(text);
      const b = mine.exec(text);
      assert.equal(mine.test(text), a !== null, 'test ' + pattern + ' on ' + JSON.stringify(text));
      assert.equal(b !== null, a !== null, 'exec found ' + pattern + ' on ' + JSON.stringify(text));
      // The span can differ only for a repeated group that can match the empty string.
      if (/\)[*+?{]/.test(pattern)) continue;
      assert.equal(b ? b.text : null, a ? a[0] : null, 'exec ' + pattern + ' on ' + JSON.stringify(text));
      if (a) assert.equal(b.index, a.index, 'index ' + pattern + ' on ' + JSON.stringify(text));
      compared++;
    }
  }
  assert.ok(compared > 10000, "compared " + compared);
});

test('case-insensitive matching and text escaping', () => {
  assert.equal(compile('error', { ignoreCase: true }).test('An ERROR occurred'), true);
  assert.equal(compile('[a-c]+x', { ignoreCase: true }).exec('zzABCx').text, 'ABCx');
  const lit = 'a.b*c(d)[e]{f}|g\\h^$+?/-';
  assert.equal(compile(escapeText(lit)).test('<' + lit + '>'), true);
  assert.equal(compile(escapeText(lit)).test('<a.b*c(d)[e]{f}|g\\h^$+?/ >'), false);
});

test('matcher: text, case, whole word, regular expression, refusal message', () => {
  const m = createMatcher({ text: 'Err', caseSensitive: false });
  assert.equal(m.test('an error'), true);
  assert.deepEqual(m.spans('Err err ERR'), [[0, 3], [4, 7], [8, 11]]);
  assert.equal(createMatcher({ text: 'err', caseSensitive: true }).test('ERR'), false);
  const w = createMatcher({ text: 'cat', wholeWord: true });
  assert.equal(w.test('concatenate'), false);
  assert.equal(w.test('the cat sat'), true);
  assert.equal(createMatcher({ text: 'a.c', regex: true, caseSensitive: true }).test('abc'), true);
  assert.equal(createMatcher({ text: 'a.c', regex: false }).test('abc'), false);
  const bad = createMatcher({ text: '(a)\\1', regex: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /not accepted/);
  assert.equal(createMatcher({ text: '', regex: true }).empty, true);
  const rw = createMatcher({ text: 'id=\\d+', regex: true, wholeWord: true, caseSensitive: true });
  assert.equal(rw.test('x id=42 y'), true);
  assert.equal(rw.test('xid=42y'), false);
  // lower-casing that changes the length falls back to the engine (U+0130)
  assert.equal(createMatcher({ text: 'x' }).test('İ X'), true);
  assert.deepEqual(createMatcher({ text: 'x' }).spans('İ X'), [[2, 3]]);
});
