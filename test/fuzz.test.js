'use strict';
// Seeded fuzz tests: random and hostile inputs must never hang, never throw anything but the
// documented errors, and keep the properties that can be checked cheaply. The seeds are fixed so a
// failure reproduces; set BIG_LOG_ATLAS_FUZZ_SEED to try another one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const safere = require('../src/engine/safere');
const { createMatcher } = require('../src/engine/matcher');
const levels = require('../src/engine/levels');
const T = require('../src/engine/timestamps');
const P = require('../src/pro/profiles');
const FF = require('../src/pro/fieldfilter');
const A = require('../src/pro/anonymise');
const D = require('../src/pro/logdiff');
const { pretty } = require('../src/pro/prettyjson');
const { LogFile } = require('../src/engine/lineindex');
const G = require('./helpers/gen');

const SEEDS = process.env.BIG_LOG_ATLAS_FUZZ_SEED ? [Number(process.env.BIG_LOG_ATLAS_FUZZ_SEED)] : [20261112, 7741, 31337042, 5550123];
const ROUNDS = 2000;
const dir = G.tmpDir('fuzz-');
test.after(() => G.rmDir(dir));

const PATTERN_CHARS = ['a', 'b', 'c', '.', '*', '+', '?', '|', '(', ')', '[', ']', '^', '$', '\\', '{', '}', ',', '-', '1', '2', ':', '<', '>', '=', '!', 'd', 'w', 's', 'x', 'u', ' '];
function noise(rnd, alphabet, max) { let s = ''; const n = Math.floor(rnd() * max); for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]; return s; }

for (const seed of SEEDS) {
  test('fuzz seed ' + seed + ': regular expression engine accepts or refuses cleanly and finishes', () => {
    const rnd = G.rng(seed);
    const t0 = Date.now();
    let accepted = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const pattern = noise(rnd, PATTERN_CHARS, 24);
      let re;
      try { re = safere.compile(pattern, { ignoreCase: rnd() < 0.3 }); } catch (e) { assert.ok(e instanceof safere.RegexError, 'unexpected ' + e + ' for ' + JSON.stringify(pattern)); continue; }
      accepted++;
      const text = noise(rnd, 'abc12 :.xéİ', 60);
      const mine = re.test(text);
      assert.equal(typeof mine, 'boolean');
      const m = re.exec(text, 0);
      assert.ok(m === null || (m.index >= 0 && m.end >= m.index && m.end <= text.length));
      assert.equal(mine, m !== null, 'test and exec agree for ' + JSON.stringify(pattern) + ' on ' + JSON.stringify(text));
    }
    assert.ok(accepted > 100, 'accepted ' + accepted);
    assert.ok(Date.now() - t0 < 20000, 'took ' + (Date.now() - t0) + ' ms');
  });

  test('fuzz seed ' + seed + ': levels, time stamps, profiles, filters and the anonymiser never throw on any text', () => {
    const rnd = G.rng(seed + 1);
    const alphabet = ' \t\u0000{}[]":,=<>@./\\-+_*?!0123456789abcdefABCDEFGHIJ levelERROR WARN INFO ts time é日😀';
    const an = A.createAnonymiser({ key: Buffer.alloc(32, 2) });
    const profiles = ['jsonl', 'logfmt', 'syslog', 'access', 'nginx-error', 'apache-error'].map((id) => P.createProfile(id));
    const t0 = Date.now();
    for (let i = 0; i < ROUNDS; i++) {
      const line = noise(rnd, alphabet, 120);
      const rank = levels.levelRank(line);
      assert.ok(rank >= -1 && rank <= 5);
      for (const f of T.FORMATS) { const v = T.extract(f.id, line, 0); assert.ok(typeof v === 'number'); }
      for (const p of profiles) { const r = p.parse(line); assert.ok(r === null || typeof r === 'object'); }
      assert.equal(typeof an.apply(line), 'string');
      assert.equal(typeof D.normalize(line), 'string');
      try { FF.parseFilter(line); } catch (e) { assert.ok(e instanceof Error && e.message); }
      const m = createMatcher({ text: noise(rnd, 'ab.*+?()[]|\\', 8), regex: true });
      if (m.ok) m.test(line);
    }
    assert.ok(Date.now() - t0 < 20000);
  });

  test('fuzz seed ' + seed + ': JSON lines: random valid JSON parses to the same fields; pretty printing keeps the data', () => {
    const rnd = G.rng(seed + 2);
    function value(depth) {
      const r = rnd();
      if (depth > 3 || r < 0.35) return r < 0.1 ? null : r < 0.2 ? rnd() < 0.5 : r < 0.3 ? Math.floor(rnd() * 100000) / 8 : noise(rnd, 'ab é"\\\n/\u0001', 8);
      if (r < 0.65) { const o = {}; const n = Math.floor(rnd() * 4); for (let i = 0; i < n; i++) o[noise(rnd, 'abc_', 4) || 'k'] = value(depth + 1); return o; }
      const a = []; const n = Math.floor(rnd() * 4); for (let i = 0; i < n; i++) a.push(value(depth + 1)); return a;
    }
    const prof = P.createProfile('jsonl');
    for (let i = 0; i < 400; i++) {
      const o = { id: i, v: value(0), w: value(0) };
      const text = JSON.stringify(o);
      const f = prof.parse(text);
      assert.ok(f, text);
      assert.equal(f.id, String(i));
      const pp = pretty(text);
      assert.deepEqual(JSON.parse(pp), JSON.parse(text), text);
      // damaged copies are refused or parsed, never thrown
      const cut = text.slice(0, Math.floor(rnd() * text.length));
      assert.doesNotThrow(() => { prof.parse(cut); pretty(cut); });
    }
  });
}

test('fuzz: random bytes as a log file (every encoding choice) never throw and give consistent counts', async () => {
  const rnd = G.rng(424242);
  for (let i = 0; i < 40; i++) {
    const n = Math.floor(rnd() * 20000);
    const buf = Buffer.alloc(n);
    const mode = i % 4;
    for (let k = 0; k < n; k++) buf[k] = mode === 0 ? Math.floor(rnd() * 256) : mode === 1 ? (rnd() < 0.1 ? 10 : 32 + Math.floor(rnd() * 90)) : mode === 2 ? (rnd() < 0.08 ? 10 : rnd() < 0.5 ? 0 : 65 + Math.floor(rnd() * 20)) : (rnd() < 0.05 ? 13 : rnd() < 0.05 ? 10 : 97);
    const p = path.join(dir, 'fz' + i + '.bin');
    fs.writeFileSync(p, buf);
    for (const enc of [undefined, 'utf8', 'utf16le', 'utf16be', 'latin1']) {
      const f = new LogFile(p, { chunkBytes: 64 + Math.floor(rnd() * 1000) * 2, stepLines: 1 + Math.floor(rnd() * 9), stepBytes: 200 });
      await f.open({ encoding: enc });
      await f.scan();
      const all = await f.readLines(0, f.lineCount + 5, { maxChars: 100000 });
      assert.equal(all.length, f.lineCount, 'count ' + i + ' ' + enc);
      for (let k = 0; k < all.length; k++) assert.equal(all[k].no, k);
      if (all.length) { const mid = Math.floor(all.length / 2); const one = await f.readLine(mid); assert.equal(one.text, all[mid].text); assert.equal(await f.lineAtOffset(all[mid].offset), mid); }
      if (f.encoding === 'latin1' || f.encoding === 'utf8') {
        let lf = 0; for (let k = f.bom; k < n; k++) if (buf[k] === 10) lf++;
        assert.equal(f.lineCount, lf + (n > f.bom && buf[n - 1] !== 10 ? 1 : 0), 'lines ' + i + ' ' + enc);
      }
      await f.close();
    }
  }
});

test('fuzz: the anonymiser removes every planted value wherever it stands in random text', () => {
  const rnd = G.rng(99);
  const an = A.createAnonymiser();
  const plants = ['jo.doe@example.invalid', '192.0.2.201', '2001:db8:85a3:0:0:8a2e:370:7334', 'password=correcthorsebattery', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', '4111 1111 1111 1111'];
  const secrets = ['jo.doe@example.invalid', '192.0.2.201', '2001:db8:85a3:0:0:8a2e:370:7334', 'correcthorsebattery', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGciOiJIUzI1NiJ9', '4111 1111 1111 1111'];
  for (let i = 0; i < 2000; i++) {
    const k = Math.floor(rnd() * plants.length);
    const line = noise(rnd, 'abc xyz,;:()[]{}"\'=', 30) + ' ' + plants[k] + ' ' + noise(rnd, 'abc xyz,;:()[]{}"\'=', 30);
    const out = an.apply(line);
    assert.ok(!out.includes(secrets[k]), 'left ' + secrets[k] + ' in ' + out);
  }
});

test('fuzz: excerpt comparison agrees with the minimal edit count on random inputs', () => {
  const rnd = G.rng(5);
  for (let t = 0; t < 300; t++) {
    const n = Math.floor(rnd() * 25);
    const m = Math.floor(rnd() * 25);
    const a = Array.from({ length: n }, () => 'l' + Math.floor(rnd() * 5));
    const b = Array.from({ length: m }, () => 'l' + Math.floor(rnd() * 5));
    const r = D.diffLines(a, b);
    assert.equal(r.ok, true);
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    assert.equal(r.same, dp[n][m]);
    assert.equal(r.deleted, n - dp[n][m]);
    assert.equal(r.added, m - dp[n][m]);
  }
});
