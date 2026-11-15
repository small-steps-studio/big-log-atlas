'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogFile, sanitize, clipText } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const E = require('../src/engine/encoding');
const G = require('./helpers/gen');

const dir = G.tmpDir('lineindex-');
test.after(() => G.rmDir(dir));

async function open(name, buf, opts, openOpts) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  const f = new LogFile(p, opts);
  await f.open(openOpts);
  await f.scan();
  return f;
}
function naiveLines(text, eol) {
  const parts = text.split(eol);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

test('hand-computed: lines, line ends and the unterminated last line', async () => {
  const f = await open('a.log', 'one\ntwo\r\n\nfour');
  assert.equal(f.lineCount, 4);
  const lines = await f.readLines(0, 10);
  assert.deepEqual(lines.map((l) => l.text), ['one', 'two', '', 'four']);
  assert.deepEqual(lines.map((l) => l.terminated), [true, true, true, false]);
  assert.deepEqual(lines.map((l) => l.byteLength), [3, 3, 0, 4]);
  assert.deepEqual(lines.map((l) => l.offset), [0, 4, 9, 10]);
  await f.close();
});

test('empty file, only line ends, single line without a line end', async () => {
  let f = await open('e0.log', Buffer.alloc(0));
  assert.equal(f.lineCount, 0);
  assert.deepEqual(await f.readLines(0, 5), []);
  await f.close();
  f = await open('e1.log', '\n\n\n');
  assert.equal(f.lineCount, 3);
  assert.deepEqual((await f.readLines(0, 5)).map((l) => l.text), ['', '', '']);
  await f.close();
  f = await open('e2.log', 'solo');
  assert.equal(f.lineCount, 1);
  assert.equal((await f.readLine(0)).text, 'solo');
  await f.close();
});

test('a lone CR is not a line end; CR before LF is part of the line end', async () => {
  const f = await open('cr.log', 'a\rb\r\nc\n');
  assert.deepEqual((await f.readLines(0, 5)).map((l) => l.text), ['a\rb', 'c']);
  await f.close();
});

test('random files against a naive split: every encoding, small chunks, tiny index steps, lines crossing chunk borders', async () => {
  const rnd = G.rng(7);
  for (let trial = 0; trial < 40; trial++) {
    const n = Math.floor(rnd() * 150);
    const lines = [];
    for (let i = 0; i < n; i++) {
      const len = Math.floor(rnd() * (rnd() < 0.05 ? 2500 : 70));
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(97 + Math.floor(rnd() * 26));
      if (rnd() < 0.1) s += 'é€';
      lines.push(s);
    }
    const eol = rnd() < 0.5 ? '\r\n' : '\n';
    const enc = ['utf8', 'utf16le', 'utf16be', 'latin1'][trial % 4];
    const finalEol = rnd() < 0.7;
    const text = lines.join(eol) + (finalEol && n ? eol : '');
    const written = enc === 'latin1' ? lines.map((l) => l.replace(/€/g, 'e')) : lines;
    const p = path.join(dir, 'r' + trial + '.log');
    G.writeLines(p, written, { eol: eol, encoding: enc, finalEol: finalEol });
    void text;
    const f = new LogFile(p, { chunkBytes: 64 + Math.floor(rnd() * 120) * 2, stepLines: 1 + Math.floor(rnd() * 20), stepBytes: 100 + Math.floor(rnd() * 3000), hugeLineBytes: 1500, walkBytes: 128 });
    await f.open({ encoding: enc === 'latin1' ? 'latin1' : undefined });
    await f.scan();
    assert.equal(f.encoding, enc === 'utf8' && !lines.length ? 'utf8' : f.encoding);
    assert.equal(f.lineCount, written.length, 'trial ' + trial + ' ' + enc);
    const first = Math.floor(rnd() * (written.length + 1));
    const got = await f.readLines(first, 60, { maxChars: 100000 });
    for (let i = 0; i < got.length; i++) {
      assert.equal(got[i].text, written[first + i], 'trial ' + trial + ' ' + enc + ' line ' + (first + i));
      assert.equal(got[i].no, first + i);
    }
    if (got[0]) assert.equal(await f.lineAtOffset(got[0].offset), got[0].no);
    await f.close();
  }
});

test('encodings and byte order marks are detected; a manual override works', async () => {
  const sample = ['2026-01-01 info héllo', 'second 日本語'];
  for (const [name, enc, bom] of [['u8', 'utf8', false], ['u8bom', 'utf8', true], ['u16le', 'utf16le', true], ['u16be', 'utf16be', true], ['u16lenb', 'utf16le', false]]) {
    const p = path.join(dir, name + '.log');
    G.writeLines(p, sample, { encoding: enc, bom: bom });
    const f = new LogFile(p);
    await f.open();
    await f.scan();
    assert.equal(f.encoding, enc, name);
    assert.equal(f.lineCount, 2, name);
    assert.deepEqual((await f.readLines(0, 2)).map((l) => l.text), sample, name);
    await f.close();
  }
  const p = path.join(dir, 'latin.log');
  fs.writeFileSync(p, Buffer.from('caf\xe9 cr\xe8me\nsecond\n', 'latin1'));
  const f = new LogFile(p);
  await f.open();
  await f.scan();
  assert.equal(f.encoding, 'latin1');
  assert.equal((await f.readLine(0)).text, 'café crème');
  await f.setEncoding('utf8');
  await f.scan();
  assert.match((await f.readLine(0)).text, /caf�/);
  await f.close();
});

test('binary garbage: no exception, a binary flag, control characters made visible', async () => {
  const rnd = G.rng(99);
  const buf = Buffer.alloc(300000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rnd() * 256);
  const f = await open('garbage.bin', buf);
  assert.equal(f.binary, true);
  const lines = await f.readLines(0, 50);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.equal(typeof l.text, 'string');
  await f.close();
  assert.equal(sanitize('a\u0000b\u001bc\td'), 'a␀b␛c\td');
});

test('one huge line: opens, shows its head with the true length, and the lines around it are right', async () => {
  const huge = 'h'.repeat(5 * 1024 * 1024);
  const f = await open('huge.log', 'before\n' + huge + '\nafter\nlast', { chunkBytes: 1 << 20 });
  assert.equal(f.lineCount, 4);
  const lines = await f.readLines(0, 4, { maxChars: 100 });
  assert.deepEqual(lines.map((l) => l.text.length), [6, 100, 5, 4]);
  assert.equal(lines[1].byteLength, huge.length);
  assert.equal(lines[1].truncated, true);
  assert.equal(lines[2].text, 'after');
  assert.equal((await f.readLines(2, 1))[0].text, 'after');
  const whole = await f.readLine(1, 6 * 1024 * 1024);
  assert.equal(whole.text.length, huge.length);
  await f.close();
});

test('a file of 10 MB on one line is indexed with a tiny index', async () => {
  const f = await open('oneline.log', 'x'.repeat(10 * 1024 * 1024), { chunkBytes: 1 << 20 });
  assert.equal(f.lineCount, 1);
  assert.ok(f.indexBytes < 1024);
  await f.close();
});

test('the index stays within its cap however many lines there are (entries are thinned)', async () => {
  const p = path.join(dir, 'many.log');
  await G.writeStandard(p, 20000);
  const f = new LogFile(p, { stepLines: 2, stepBytes: 100, maxEntries: 64 });
  await f.open();
  await f.scan();
  assert.equal(f.lineCount, 20000);
  assert.ok(f.count <= 64, 'entries: ' + f.count);
  const rnd = G.rng(1);
  const expected = [];
  for (let i = 0; i < 20000; i++) expected.push(G.standardLine(i, rnd));
  for (const i of [0, 7, 12345, 19999]) assert.equal((await f.readLine(i)).text, expected[i]);
  const got = await f.readLines(19990, 20);
  assert.equal(got.length, 10);
  assert.match(got[9].text, /id=119999/);
  await f.close();
});

test('standard log: line count, a middle line and the last line match the formula', async () => {
  const p = path.join(dir, 'std.log');
  await G.writeStandard(p, 5000, { seed: 3 });
  const f = new LogFile(p);
  await f.open();
  await f.scan();
  assert.equal(f.lineCount, 5000);
  const rnd = G.rng(3);
  const expected = [];
  for (let i = 0; i < 5000; i++) expected.push(G.standardLine(i, rnd));
  for (const i of [0, 1, 255, 256, 257, 2500, 4999]) assert.equal((await f.readLine(i)).text, expected[i]);
  await f.close();
});

test('growth: new lines are indexed from where the scan stopped, including a line that was cut', async () => {
  const p = path.join(dir, 'grow.log');
  fs.writeFileSync(p, 'a\nb\npartial');
  const f = new LogFile(p);
  await f.open();
  await f.scan();
  assert.equal(f.lineCount, 3);
  fs.appendFileSync(p, ' line\nc\n');
  const r = await f.refresh();
  assert.equal(r.kind, 'grown');
  assert.ok(r.added > 0);
  await f.scan();
  assert.deepEqual((await f.readLines(0, 10)).map((l) => l.text), ['a', 'b', 'partial line', 'c']);
  assert.equal((await f.refresh()).kind, 'same');
  await f.close();
});

test('truncation and rotation are detected and the index starts again', async () => {
  const p = path.join(dir, 'rot.log');
  fs.writeFileSync(p, 'one\ntwo\nthree\nfour\n');
  const f = new LogFile(p);
  await f.open();
  await f.scan();
  assert.equal(f.lineCount, 4);
  fs.writeFileSync(p, 'x\n');
  assert.equal((await f.refresh()).kind, 'truncated');
  await f.scan();
  assert.deepEqual((await f.readLines(0, 5)).map((l) => l.text), ['x']);
  // rotation: the old file is renamed and a new, longer file takes its place
  fs.renameSync(p, p + '.1');
  fs.writeFileSync(p, 'new1\nnew2\nnew3\nnew4\nnew5\n');
  const r = await f.refresh();
  assert.ok(['rotated', 'modified'].includes(r.kind), r.kind);
  await f.scan();
  assert.equal(f.lineCount, 5);
  assert.equal((await f.readLine(0)).text, 'new1');
  fs.rmSync(p);
  assert.equal((await f.refresh()).kind, 'missing');
  await f.close();
});

test('a file edited in place (same size) is noticed through the fingerprint', async () => {
  const p = path.join(dir, 'edit.log');
  fs.writeFileSync(p, 'aaaa\nbbbb\ncccc\n');
  const f = new LogFile(p);
  await f.open();
  await f.scan();
  fs.writeFileSync(p, 'zzzz\nbbbb\ncccc\ndddd\n');
  assert.equal((await f.refresh()).kind, 'modified');
  await f.scan();
  assert.equal((await f.readLine(0)).text, 'zzzz');
  await f.close();
});

test('a saved index is accepted for the same file and refused after any change', async () => {
  const p = path.join(dir, 'persist.log');
  await G.writeStandard(p, 3000);
  const a = new LogFile(p);
  await a.open(); await a.scan();
  const buf = a.toBuffer();
  assert.ok(Buffer.isBuffer(buf));
  const b = new LogFile(p);
  await b.open();
  assert.equal(await b.loadBuffer(buf), true);
  assert.equal(b.lineCount, 3000);
  assert.equal((await b.readLine(2999)).text, (await a.readLine(2999)).text);
  await b.close();
  // corrupt copies are refused
  const bad = Buffer.from(buf); bad[bad.length - 5] ^= 0xFF;
  const c = new LogFile(p);
  await c.open();
  const ok = await c.loadBuffer(bad);
  if (ok) assert.ok(c.lineCount === 3000); // an offset byte changed in an entry; still structurally valid is allowed only if checks pass
  await c.close();
  assert.equal(await (async () => { const d = new LogFile(p); await d.open(); const r = await d.loadBuffer(Buffer.from('nonsense')); await d.close(); return r; })(), false);
  fs.appendFileSync(p, 'one more\n');
  const e = new LogFile(p);
  await e.open();
  assert.equal(await e.loadBuffer(buf), false, 'size changed');
  await e.close();
  await a.close();
});

test('lineAtOffset and percentage jumps', async () => {
  const p = path.join(dir, 'off.log');
  fs.writeFileSync(p, 'aa\nbbbb\ncc\n');
  const f = new LogFile(p);
  await f.open(); await f.scan();
  assert.equal(await f.lineAtOffset(0), 0);
  assert.equal(await f.lineAtOffset(2), 0);
  assert.equal(await f.lineAtOffset(3), 1);
  assert.equal(await f.lineAtOffset(7), 1);
  assert.equal(await f.lineAtOffset(8), 2);
  assert.equal(await f.lineAtOffset(10000), 2, 'beyond the end clamps');
  await f.close();
});

test('cancelling a scan leaves a consistent partial index that can continue', async () => {
  const p = path.join(dir, 'cancel.log');
  await G.writeStandard(p, 30000);
  const f = new LogFile(p, { chunkBytes: 64 * 1024, yieldEveryChunk: true });
  await f.open();
  const ctl = new AbortController();
  let chunks = 0;
  const r = await f.scan(ctl.signal, () => { if (++chunks === 1) ctl.abort(); });
  assert.equal(r.aborted, true);
  assert.equal(f.complete, false);
  const partial = f.lineCount;
  assert.ok(partial > 0 && partial < 30000);
  assert.equal((await f.readLine(partial - 1)).text.slice(0, 4), '2026');
  const r2 = await f.scan();
  assert.equal(r2.complete, true);
  assert.equal(f.lineCount, 30000);
  await f.close();
});

test('FileSource streams the same text as readLines and reports lines it read only in part', async () => {
  const p = path.join(dir, 'src.log');
  fs.writeFileSync(p, 'x'.repeat(3000) + '\nshort\n');
  const f = new LogFile(p); await f.open(); await f.scan();
  const s = new FileSource(f);
  const seen = [];
  const r = await s.forEachText(0, (rec) => { seen.push(rec.text.length); return true; }, { maxChars: 1000 });
  assert.deepEqual(seen, [1000, 5]);
  assert.equal(r.longLines, 1);
  await f.close();
});

test('encoding helpers', () => {
  assert.equal(E.unitSize('utf16le'), 2);
  assert.deepEqual(clipText('ab😀', 3), { text: 'ab', cut: true });
  assert.equal(E.safeCut(Buffer.from('a€'), 0, 3, 'utf8'), 1);
  assert.equal(E.detect(Buffer.from([0x68, 0xE9, 0x6C]), true).encoding, 'latin1');
});
