'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogFile } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const S = require('../src/engine/search');
const levels = require('../src/engine/levels');
const T = require('../src/engine/timestamps');
const P = require('../src/pro/profiles');
const X = require('../src/pro/exporter');
const A = require('../src/pro/anonymise');
const { computeStats } = require('../src/pro/stats');
const { MergeSource } = require('../src/pro/merge');
const C = require('./helpers/corpus');
const G = require('./helpers/gen');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const entries = C.build();
const work = G.tmpDir('corpus-');
const opened = [];
test.after(async () => { for (const f of opened) await f.close(); G.rmDir(work); });

test('the corpus has at least 40 original files, varied, including invalid ones', () => {
  assert.ok(entries.length >= 40, 'files: ' + entries.length);
  const names = new Set(entries.map((e) => e.name));
  assert.equal(names.size, entries.length);
  const kinds = new Set(entries.map((e) => (e.expect.encoding || 'binary') + (e.expect.binary ? '+binary' : '')));
  assert.ok(kinds.size >= 6, Array.from(kinds).join(','));
  assert.ok(entries.filter((e) => e.expect.time).length >= 20, 'files with time stamps');
  assert.ok(entries.filter((e) => e.expect.profile).length >= 6, 'files with profiles');
});

test('the files on disk are exactly what the corpus module builds', () => {
  const onDisk = fs.readdirSync(CORPUS).sort();
  assert.deepEqual(onDisk, entries.map((e) => e.name).sort());
  for (const e of entries) assert.ok(fs.readFileSync(path.join(CORPUS, e.name)).equals(C.bytesOf(e)), e.name + ' differs; run node test/helpers/write-corpus.js');
});

async function openEntry(e) {
  const f = new LogFile(path.join(CORPUS, e.name), { chunkBytes: 4096, stepLines: 4, stepBytes: 600 });
  await f.open();
  await f.scan();
  opened.push(f);
  return f;
}

for (const e of entries) {
  test('corpus ' + e.name + ': lines, encoding, levels, time format, profile, exports', async () => {
    const f = await openEntry(e);
    const src = new FileSource(f);
    if (e.expect.garbage) {
      const data = fs.readFileSync(path.join(CORPUS, e.name));
      assert.equal(f.binary, true);
      assert.ok(!f.encoding.startsWith('utf16'));
      assert.equal(f.lineCount, e.expect.lfCount + (data[data.length - 1] !== 0x0A ? 1 : 0));
      const rows = await f.readLines(0, 100000, { maxChars: 50 });
      assert.equal(rows.length, f.lineCount);
      return;
    }
    assert.equal(f.lineCount, e.expect.lines, 'line count');
    assert.equal(f.encoding, e.expect.encoding, 'encoding');
    assert.equal(f.binary, e.expect.binary, 'binary flag');
    const all = await f.readLines(0, 100000, { maxChars: 1000000 });
    assert.equal(all.length, e.expect.lines);
    if (e.lines && (e.eol === '\n' || e.eol === '\r\n')) assert.deepEqual(all.map((l) => l.text), e.lines, 'round trip of the text');
    // levels
    const counts = { '-1': 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const l of all) counts[levels.levelRank(l.text)]++;
    assert.deepEqual(counts, e.expect.levels, 'lines per level');
    // time format
    const det = T.detect(all.slice(0, 300).map((l) => l.text), Date.UTC(2026, 0, 20));
    assert.equal(det ? det.id : null, e.expect.time, 'time stamp format');
    if (det) {
      const ex = T.extractor(det.id, Date.UTC(2026, 0, 20));
      let timed = 0;
      for (const l of all) if (!isNaN(ex(l.text))) timed++;
      assert.ok(timed >= 1);
    }
    // profile
    assert.equal(P.suggest(all.slice(0, 200).map((l) => l.text)), e.expect.profile, 'profile suggestion');
    if (e.expect.profile) {
      const prof = P.createProfile(e.expect.profile);
      let parsed = 0;
      for (const l of all) if (prof.parse(l.text)) parsed++;
      assert.ok(parsed >= Math.ceil(e.expect.lines / 2), 'the profile parses most lines: ' + parsed + ' of ' + e.expect.lines);
    }
    // text export reproduces the lines (with LF line ends); CSV and JSON exports are well formed
    const out = path.join(work, e.name + '.out');
    await X.exportLines(src, { outPath: out, format: 'text', pred: () => true });
    const back = fs.readFileSync(out, 'utf8');
    assert.equal(back, all.map((l) => l.text + '\n').join(''), 'text export');
    await X.exportLines(src, { outPath: out, format: 'json', pred: () => true, timeFormat: det ? det.id : undefined, reference: Date.UTC(2026, 0, 20) });
    const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(arr.length, e.expect.lines);
    await X.exportLines(src, { outPath: out, format: 'csv', pred: () => true });
    const csv = fs.readFileSync(out, 'utf8');
    assert.ok(csv.startsWith('line,time,level,text\r\n'));
    // statistics and anonymising never throw and keep the counts
    const st = await computeStats(src, { timeFormat: det ? det.id : undefined, reference: Date.UTC(2026, 0, 20) });
    assert.equal(st.lines, e.expect.lines);
    assert.equal(st.levels.error + st.levels.fatal, e.expect.levels[4] + e.expect.levels[5]);
    const an = A.createAnonymiser({ key: Buffer.alloc(32, 1) });
    for (const l of all) assert.equal(typeof an.apply(l.text), 'string');
    // a search for a word of the first line finds it
    const first = all.find((l) => /[A-Za-z]{4,}/.test(l.text));
    if (first) {
      const word = /[A-Za-z]{4,}/.exec(first.text)[0];
      const r = await S.findNext(src, (rec) => rec.text.includes(word), -1);
      assert.ok(r.line !== null && r.line <= first.no);
    }
  });
}

test('corpus: PII sample is anonymised completely (no original value survives) with stable replacements', async () => {
  const e = entries.find((x) => x.name === 'pii-sample.log');
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 4) });
  const out = e.lines.map((l) => an.apply(l)).join('\n');
  for (const secret of ['ann.lee@example.invalid', 'bob.ray@example.invalid', '192.0.2.44', '192.0.2.45', '9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'abcdEFGH12345678ijkl', '2001:db8:85a3:0:0:8a2e:370:7334', '4111 1111 1111 1111', 'sk-demo-1234567890abcdef']) assert.ok(!out.includes(secret), secret);
  assert.equal(out.match(/user-[0-9a-f]{12}@example\.invalid/g).length, 3);
  assert.equal(new Set(out.match(/user-[0-9a-f]{12}@example\.invalid/g)).size, 2);
  assert.ok(out.includes('CUST-482913'), 'a customer number is not recognised by the built-in rules (documented)');
  const parsed = A.parseRuleFile(JSON.stringify({ rules: [{ name: 'customer', pattern: 'CUST-[0-9]{6}' }] }));
  const an2 = A.createAnonymiser({ key: Buffer.alloc(32, 4), rules: parsed.rules });
  assert.ok(!e.lines.map((l) => an2.apply(l)).join('\n').includes('CUST-482913'));
});

test('corpus: the three service logs merge in time order with tags', async () => {
  const names = ['merge-a-gateway.log', 'merge-b-billing.log', 'merge-c-mailer.log'];
  const files = [];
  for (const n of names) { const f = new LogFile(path.join(CORPUS, n)); await f.open(); opened.push(f); files.push({ file: f, name: n }); }
  const m = new MergeSource(files, { step: 4 });
  await m.prepare();
  assert.equal(m.lineCount, 30);
  const rows = await m.readLines(0, 100);
  const times = rows.map((r) => Date.parse(r.text.slice(0, 24)));
  assert.deepEqual(times, times.slice().sort((a, b) => a - b));
  assert.deepEqual(rows.slice(0, 4).map((r) => r.tag), ['merge-a-gateway.log', 'merge-b-billing.log', 'merge-c-mailer.log', 'merge-a-gateway.log']);
  assert.equal(rows.filter((r) => r.tag === 'merge-b-billing.log').length, 10);
});

test('corpus: the two excerpts differ only in the lines that really differ after normalising', () => {
  const D = require('../src/pro/logdiff');
  const a = entries.find((x) => x.name === 'excerpt-run-1.log').lines.map((l) => D.normalize(l));
  const b = entries.find((x) => x.name === 'excerpt-run-2.log').lines.map((l) => D.normalize(l));
  const r = D.diffLines(a, b);
  assert.equal(r.ok, true);
  assert.deepEqual([r.same, r.deleted, r.added], [3, 1, 1], 'same: start, step one, done; different: the warning and the error');
});

test('every logfmt, JSON and syslog line of the corpus survives a profile table without exceptions', async () => {
  const { LogSession } = require('../src/session');
  for (const [name, prof] of [['jsonl-flat.jsonl', 'jsonl'], ['logfmt-service.log', 'logfmt'], ['syslog-3164.log', 'syslog'], ['nginx-access.log', 'access']]) {
    const posted = [];
    const s = new LogSession({ post: (m) => posted.push(m), settings: () => ({ maxLineChars: 2000, defaultEncoding: 'auto', indexCacheMB: 0, followIntervalMs: 1000, filterMaxMatches: 1000, colourLevels: true }), cacheDir: '', state: { get: (k, d) => d, update: async () => {} }, gate: async () => true, hasAccess: async () => true, clipboard: async () => {}, status: () => {}, notify: () => {} });
    await s.openFile(path.join(CORPUS, name), {});
    await s.scanPromise;
    s.setProfile(P.createProfile(prof));
    const t = await s.table(0, null);
    assert.equal(t.ok, true, name);
    assert.ok(t.columns.length >= 3, name + ' columns: ' + t.columns.join(','));
    assert.equal(t.rows.length, s.rowCount);
    s.dispose();
  }
});
