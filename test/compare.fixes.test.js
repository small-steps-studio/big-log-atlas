'use strict';
// Regression tests for "Compare Two Log Excerpts": the result never says "identical" when any byte
// differs, and says what it could not show (line ends, byte order mark, encoding, short excerpts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogFile } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const { MergeSource } = require('../src/pro/merge');
const D = require('../src/pro/logdiff');
const G = require('./helpers/gen');

const dir = G.tmpDir('cmp-');
const opened = [];
test.after(async () => { for (const f of opened) await f.close(); G.rmDir(dir); });

let counter = 0;
async function openBytes(bytes) {
  const p = path.join(dir, 'f' + (counter++) + '.log');
  fs.writeFileSync(p, bytes);
  const f = new LogFile(p, { chunkBytes: 4096, stepLines: 4, stepBytes: 500 });
  await f.open();
  await f.scan();
  opened.push(f);
  return new FileSource(f);
}
const utf8 = (s) => Buffer.from(s, 'utf8');

async function compare(bytesA, bytesB, a, b) {
  const sa = await openBytes(bytesA);
  const sb = await openBytes(bytesB);
  const ra = a || { from: 0, count: 200 };
  const rb = b || ra;
  const left = await D.readExcerpt(sa, ra.from, ra.count);
  const right = await D.readExcerpt(sb, rb.from, rb.count);
  return { left, right, result: D.compareExcerpts(left, right) };
}

const BASE = ['2026-01-15T10:00:00Z INFO start', '2026-01-15T10:00:01Z INFO work done', '2026-01-15T10:00:02Z WARN slow', 'last line'];

function assertNotIdentical(r, why) {
  assert.equal(r.result.ok, true, why);
  assert.equal(r.result.identical, false, why + ': ' + r.result.message);
  assert.doesNotMatch(r.result.message, /identical, byte for byte|are the same/i, why + ': ' + r.result.message);
}

test('identical bytes are reported as identical, byte for byte', async () => {
  const r = await compare(utf8(BASE.join('\n') + '\n'), utf8(BASE.join('\n') + '\n'));
  assert.equal(r.result.identical, true);
  assert.match(r.result.message, /identical, byte for byte \(4 lines, \d+ bytes\)/);
  assert.equal(r.result.exact, 4);
});

test('a line of 4,500 characters that differs only after character 4,500 is a difference (it was cut at 4,000 before)', async () => {
  const head = 'x'.repeat(4500);
  const a = ['first', head + ' status=OK', 'last'].join('\n') + '\n';
  const b = ['first', head + ' status=FAILED', 'last'].join('\n') + '\n';
  const r = await compare(utf8(a), utf8(b));
  assertNotIdentical(r, 'long line');
  assert.equal(r.result.exact, 2);
  assert.equal(r.result.deleted, 1);
  assert.equal(r.result.added, 1);
  // what the side-by-side view shows differs too, so the difference is visible there
  const sbs = D.sideBySide(r.left.lines.map((l) => l.display), r.right.lines.map((l) => l.display), r.result.diff);
  assert.notDeepEqual(sbs.left, sbs.right);
  assert.match(sbs.left[1], /more characters, digest [0-9a-f]{8}\]$/);
});

test('a line longer than the scan limit that differs only beyond it is not identical either', async () => {
  const big = 'y'.repeat(D.READ_CHARS + 5000);
  const r = await compare(utf8('a\n' + big + 'ONE\nz\n'), utf8('a\n' + big + 'TWO\nz\n'));
  assertNotIdentical(r, 'beyond the scan limit');
  assert.equal(r.left.longLines, 1);
  assert.equal(r.result.exact, 2, 'the two short lines');
  assert.equal(r.result.textOnly, 1, 'the long line matches in its text only: its end was not compared line by line');
  assert.match(r.result.message, /match in their text only/);
  assert.match(r.result.message, /longer than 1,048,576 characters/);
});

test('CRLF against LF is reported, never "the same"', async () => {
  const r = await compare(utf8(BASE.join('\r\n') + '\r\n'), utf8(BASE.join('\n') + '\n'));
  assertNotIdentical(r, 'CRLF against LF');
  assert.equal(r.result.exact, 0, 'lines that end differently do not match exactly');
  assert.equal(r.result.textOnly, 4);
  assert.equal(r.result.eolMismatch, 4);
  assert.match(r.result.message, /0 match exactly, 4 match in their text only/);
  assert.match(r.result.message, /end differently \(first excerpt: CRLF, second: LF\)/);
});

test('a byte order mark against none is reported (excerpt from the first line, and the note for the files)', async () => {
  const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8(BASE.join('\n') + '\n')]);
  const r = await compare(withBom, utf8(BASE.join('\n') + '\n'));
  assertNotIdentical(r, 'BOM');
  assert.equal(r.result.exact, 4);
  assert.match(r.result.message, /Only the first log starts with a byte order mark/);
  // an excerpt from the middle of the files holds the same bytes: then the claim "identical" is true for the excerpts, and the note still names the files
  const mid = await compare(withBom, utf8(BASE.join('\n') + '\n'), { from: 1, count: 2 });
  assert.equal(mid.result.identical, true);
  assert.match(mid.result.message, /identical, byte for byte \(2 lines/);
});

test('a missing final line break is reported', async () => {
  const r = await compare(utf8(BASE.join('\n') + '\n'), utf8(BASE.join('\n')));
  assertNotIdentical(r, 'final line break');
  assert.equal(r.result.eolMismatch, 1);
  assert.equal(r.result.exact, 3);
  assert.equal(r.result.textOnly, 1);
  assert.match(r.result.message, /LF, second: no line break \(end of the file\)|first excerpt: LF, second: no line break/);
});

test('UTF-16 against UTF-8 of the same text is reported with both encodings', async () => {
  const text = BASE.join('\n') + '\n';
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  const r = await compare(utf16, utf8(text));
  assertNotIdentical(r, 'UTF-16 against UTF-8');
  assert.equal(r.result.exact, 4);
  assert.match(r.result.message, /different encodings \(first: UTF-16 LE, second: UTF-8\)/);
  assert.match(r.result.message, /byte order mark/);
});

test('whitespace, blank lines, tabs and trailing spaces are differences', async () => {
  const base = utf8(BASE.join('\n') + '\n');
  for (const [name, other] of [
    ['trailing space', BASE.map((l, i) => (i === 1 ? l + ' ' : l)).join('\n') + '\n'],
    ['extra blank line', BASE.slice(0, 2).concat([''], BASE.slice(2)).join('\n') + '\n'],
    ['tab for space', BASE.map((l, i) => (i === 0 ? l.replace('INFO start', 'INFO\tstart') : l)).join('\n') + '\n'],
    ['blank line at the end', BASE.join('\n') + '\n\n'],
    ['double space', BASE.map((l, i) => (i === 2 ? l.replace('WARN slow', 'WARN  slow') : l)).join('\n') + '\n']
  ]) {
    const r = await compare(base, utf8(other));
    assertNotIdentical(r, name);
    assert.ok(r.result.deleted + r.result.added > 0 || r.result.replaced > 0, name + ' shows in the lines');
  }
});

test('times and ids that the comparison replaces are counted apart from exact matches and the result is not "identical"', async () => {
  const a = ['2026-01-15T10:00:00Z INFO job 11112222333344445555 ok', 'static line'].join('\n') + '\n';
  const b = ['2026-02-20T11:11:11Z INFO job 99998888777766665555 ok', 'static line'].join('\n') + '\n';
  const r = await compare(utf8(a), utf8(b));
  assertNotIdentical(r, 'replaced values');
  assert.equal(r.result.exact, 1);
  assert.equal(r.result.replaced, 1);
  assert.match(r.result.message, /1 match exactly, 1 match only after times, ids and long numbers are replaced/);
});

test('invalid byte sequences are a byte difference, whether or not the decoded text looks alike', async () => {
  const a = Buffer.concat([utf8('start\nbad '), Buffer.from([0xFF]), utf8(' end\n')]);
  const b = Buffer.concat([utf8('start\nbad '), Buffer.from([0xFE]), utf8(' end\n')]);
  const r = await compare(a, b);
  assertNotIdentical(r, 'invalid bytes');
  // When the text view shows nothing at all (same lines, same line ends, same encoding) but the bytes differ, the result says that.
  const same = await compare(utf8(BASE.join('\n') + '\n'), utf8(BASE.join('\n') + '\n'));
  same.right.digest = 'f'.repeat(64);
  const forced = D.compareExcerpts(same.left, same.right);
  assert.equal(forced.identical, false);
  assert.match(forced.message, /differ in a way the text view cannot show/);
  assert.doesNotMatch(forced.message, /identical, byte for byte/);
});

test('an excerpt shorter than asked says so, and an excerpt past the end is empty', async () => {
  const lines = Array.from({ length: 37 }, (_, i) => 'line ' + i).join('\n') + '\n';
  const r = await compare(utf8(lines), utf8(lines), { from: 0, count: 200 });
  assert.equal(r.left.got, 37);
  assert.match(r.result.message, /first excerpt has only 37 of the 200 lines asked for/);
  assert.match(r.result.message, /second excerpt has only 37 of the 200 lines asked for/);
  const past = await compare(utf8(lines), utf8(lines), { from: 100, count: 50 });
  assert.equal(past.left.got, 0);
  assert.equal(past.result.identical, false);
});

test('a merged view has no bytes to compare: the text is compared and the result says that the bytes were not', async () => {
  const fa = await openBytes(utf8('2026-01-15T10:00:00Z a one\n2026-01-15T10:00:02Z a two\n'));
  const fb = await openBytes(utf8('2026-01-15T10:00:01Z b one\n2026-01-15T10:00:03Z b two\n'));
  const merge = new MergeSource([{ file: fa.file, name: 'a.log' }, { file: fb.file, name: 'b.log' }], { reference: Date.UTC(2026, 0, 15) });
  await merge.prepare();
  const left = await D.readExcerpt(merge, 0, 4);
  const right = await D.readExcerpt(merge, 0, 4);
  const result = D.compareExcerpts(left, right);
  assert.equal(left.digest, null);
  assert.equal(result.identical, false);
  assert.doesNotMatch(result.message, /identical, byte for byte/);
  assert.match(result.message, /bytes of the excerpts could not be compared/);
});

test('a comparison that differs in more than the limit says so instead of guessing', async () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n') + '\n';
  const b = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n') + '\n';
  const r = await compare(utf8(a), utf8(b), { from: 0, count: 3000 });
  assert.equal(r.result.ok, false);
  assert.match(r.result.reason, /differ in more than/);
});

test('large excerpts are read in blocks and compared by digest: 20,000 lines with a long line every 1,000th', async () => {
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(i % 1000 === 0 ? 'long ' + i + ' ' + 'z'.repeat(6000) : 'line ' + i);
  const text = lines.join('\n') + '\n';
  const t0 = Date.now();
  const r = await compare(utf8(text), utf8(text), { from: 0, count: 20000 });
  assert.equal(r.result.identical, true);
  assert.equal(r.left.got, 20000);
  assert.ok(Date.now() - t0 < 60000, 'took ' + (Date.now() - t0) + ' ms');
});
