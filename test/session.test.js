'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogSession, parseJump } = require('../src/session');
const P = require('../src/pro/profiles');
const G = require('./helpers/gen');

const dir = G.tmpDir('session-');
const sessions = [];
test.after(() => { for (const s of sessions) s.dispose(); G.rmDir(dir); });

function deps(extra) {
  const posted = [];
  const store = new Map();
  const d = {
    posted: posted, clipboardText: null, statuses: [], notes: [], gateCalls: [], allow: true,
    post: (m) => posted.push(m),
    settings: () => ({ maxLineChars: 2000, defaultEncoding: 'auto', indexCacheMB: 64, followIntervalMs: 100000, filterMaxMatches: 2000000, colourLevels: true, neutraliseFormulas: true }),
    cacheDir: '',
    state: { get: (k, fb) => (store.has(k) ? store.get(k) : fb), update: async (k, v) => { store.set(k, v); } },
    gate: async (f) => { d.gateCalls.push(f); return d.allow; },
    hasAccess: async () => d.allow,
    clipboard: async (t) => { d.clipboardText = t; },
    status: (t) => d.statuses.push(t),
    notify: (k, t) => d.notes.push([k, t]),
    now: () => Date.UTC(2026, 5, 1)
  };
  return Object.assign(d, extra || {});
}
async function open(name, lines, opts, dep) {
  const p = path.join(dir, name);
  G.writeLines(p, lines, opts);
  const d = dep || deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, { engine: { chunkBytes: 4096, stepLines: 8, stepBytes: 800 } });
  await s.scanPromise;
  return { s, d, p };
}
const last = (d, type) => { for (let i = d.posted.length - 1; i >= 0; i--) if (d.posted[i].type === type) return d.posted[i]; return null; };
const std = (n) => { const r = G.rng(1); const out = []; for (let i = 0; i < n; i++) out.push(G.standardLine(i, r)); return out; };

test('opening: init message, indexing progress, rows with levels and line numbers', async () => {
  const { s, d } = await open('basic.log', std(500));
  await s.handle({ type: 'ready' });
  const init = last(d, 'init');
  assert.equal(init.info.total, 500);
  assert.equal(init.info.encodingLabel, 'UTF-8');
  assert.ok(last(d, 'indexed'));
  await s.handle({ type: 'rows', id: 1, first: 95, count: 5 });
  const rows = last(d, 'rows');
  assert.equal(rows.id, 1);
  assert.deepEqual(rows.rows.map((r) => r.n), [96, 97, 98, 99, 100]);
  assert.equal(rows.rows[2].l, 4, 'line 98 (index 97) is an ERROR');
  assert.equal(rows.total, 500);
  assert.equal(rows.rows[0].o > 0, true);
});

test('parseJump understands lines, percentages, byte offsets and times', () => {
  assert.deepEqual(parseJump('1,234'), { kind: 'line', value: 1234 });
  assert.deepEqual(parseJump('  line 77 '), { kind: 'line', value: 77 });
  assert.deepEqual(parseJump('12.5%'), { kind: 'percent', value: 12.5 });
  assert.deepEqual(parseJump('@1048576'), { kind: 'byte', value: 1048576 });
  assert.deepEqual(parseJump('0x1F4'), { kind: 'byte', value: 500 });
  assert.deepEqual(parseJump('t:2026-01-15 10:30'), { kind: 'time', text: '2026-01-15 10:30' });
  for (const bad of ['', 'abc', '0', '-5', '101%', '1.5', '@', '12 34x']) assert.equal(parseJump(bad), null, bad);
});

test('search: next, previous, wrap-around, matches in spans, counts', async () => {
  const lines = std(400);
  const { s, d } = await open('search.log', lines);
  const hits = [];
  lines.forEach((l, i) => { if (/id=1000(?:50|99)\b|id=10025\d/.test(l)) hits.push(i); });
  await s.handle({ type: 'search', id: 1, spec: { text: 'id=10025', caseSensitive: true }, dir: 'next', from: -1, count: true });
  let f = last(d, 'found');
  assert.equal(f.row, 250);
  await s.handle({ type: 'rows', id: 2, first: 250, count: 1 });
  assert.deepEqual(last(d, 'rows').rows[0].s, [[lines[250].indexOf('id=10025'), lines[250].indexOf('id=10025') + 8]]);
  await s.handle({ type: 'search', id: 3, spec: { text: 'id=10025', caseSensitive: true }, dir: 'next', from: 259 });
  f = last(d, 'found');
  assert.equal(f.wrapped, true);
  assert.equal(f.row, 250);
  await s.handle({ type: 'search', id: 4, spec: { text: 'id=10025', caseSensitive: true }, dir: 'prev', from: 250 });
  assert.equal(last(d, 'found').row, 259);
  await new Promise((r) => setTimeout(r, 50));
  const c = last(d, 'count');
  assert.equal(c.done, true);
  assert.equal(c.matches, 10);
  await s.handle({ type: 'search', id: 5, spec: { text: 'zzz-not-there' }, dir: 'next', from: 5 });
  assert.equal(last(d, 'found').none, true);
  await s.handle({ type: 'search', id: 6, spec: { text: '(a)\\1', regex: true }, dir: 'next', from: 5 });
  assert.match(last(d, 'found').error, /not accepted/);
  await s.handle({ type: 'search', id: 7, spec: { text: '' }, dir: 'next', from: 5 });
  assert.equal(last(d, 'found').cleared, true);
});

test('filter by level keeps real line numbers; searching inside the filtered view; clearing returns to the same line', async () => {
  const { s, d } = await open('filt.log', std(1000));
  await s.handle({ type: 'filter', spec: { levels: [4] } });
  const done = last(d, 'filter');
  assert.equal(done.state, 'done');
  const expected = G.standardLevelCounts(1000).error;
  assert.equal(done.matches, expected);
  await s.handle({ type: 'rows', id: 1, first: 0, count: 400 });
  const rows = last(d, 'rows').rows;
  assert.equal(rows.length, expected);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.n), [1, 98, 195]);
  assert.ok(rows.every((r) => r.l === 4));
  // search inside the filtered view
  await s.handle({ type: 'search', id: 2, spec: { text: 'id=100194' }, dir: 'next', from: -1 });
  assert.equal(last(d, 'found').row, 2);
  // clearing keeps the line: row 2 of the filtered view is line 195 (index 194)
  await s.handle({ type: 'clearFilter', anchor: 2 });
  const cleared = last(d, 'filter');
  assert.equal(cleared.state, 'cleared');
  assert.equal(cleared.row, 194);
  assert.equal(cleared.total, 1000);
});

test('filter by text and regular expression; a refused pattern leaves the view alone', async () => {
  const { s, d } = await open('filt2.log', std(300));
  await s.handle({ type: 'filter', spec: { text: 'id=1000[0-9]0 ', regex: true } });
  assert.equal(last(d, 'filter').matches, 10, 'ids 100000, 100010 ... 100090');
  await s.handle({ type: 'filter', spec: { text: '(a)\\1', regex: true } });
  assert.equal(last(d, 'filter').state, 'error');
  assert.equal(s.filter.active, true, 'the earlier filter is still active');
});

test('go to: line, beyond the end, percentage, byte offset, filtered view', async () => {
  const { s, d, p } = await open('goto.log', std(2000));
  let r = await s.goTo('500');
  assert.deepEqual([r.ok, r.row, r.line], [true, 499, 499]);
  r = await s.goTo('999999');
  assert.equal(r.row, 1999);
  r = await s.goTo('50%');
  const size = fs.statSync(p).size;
  const expectedLine = (await s.file.lineAtOffset(Math.floor(size / 2)));
  assert.equal(r.line, expectedLine);
  assert.ok(r.line > 900 && r.line < 1100);
  r = await s.goTo('@0');
  assert.equal(r.line, 0);
  r = await s.goTo('0x' + Math.floor(size / 4).toString(16));
  assert.equal(r.line, await s.file.lineAtOffset(Math.floor(size / 4)));
  r = await s.goTo('hello');
  assert.equal(r.ok, false);
  assert.match(r.message, /Enter a line number/);
  r = await s.goTo('t:2026-01-15');
  assert.equal(r.needsPro, true);
  await s.handle({ type: 'filter', spec: { levels: [4] } });
  r = await s.goTo('100');
  assert.equal(r.exact, false, 'line 100 is not an error line');
  assert.equal(s.lineOfRow(r.row) >= 99, true);
});

test('go to waits for the index when the line is not indexed yet', async () => {
  const p = path.join(dir, 'slow.log');
  await G.writeStandard(p, 60000);
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, { engine: { chunkBytes: 32768, yieldEveryChunk: true } });
  const t = await s.goTo('59000');
  assert.equal(t.ok, true);
  assert.equal(t.line, 58999);
  assert.ok(s.file.complete);
});

test('bookmarks: toggle, persist for the same file, next and previous with wrap', async () => {
  const dep = deps();
  const { s, p } = await open('bm.log', std(300), undefined, dep);
  for (const row of [10, 50, 200]) assert.equal((await s.toggleBookmark(row)).set, true);
  assert.equal((await s.toggleBookmark(50)).set, false);
  assert.deepEqual(s.nextBookmark(10, 'next'), { ok: true, row: 200, line: 200 });
  assert.equal(s.nextBookmark(200, 'next').row, 10, 'wraps');
  assert.equal(s.nextBookmark(10, 'prev').row, 200, 'wraps backwards');
  await s.handle({ type: 'rows', id: 1, first: 10, count: 1 });
  assert.equal(last(dep, 'rows').rows[0].b, 1);
  const again = new LogSession(dep);
  sessions.push(again);
  await again.openFile(p, {});
  assert.deepEqual(Array.from(again.bookmarks).sort((a, b) => a - b), [10, 200]);
  assert.equal(dep.state.get('bookmarks.x'), undefined);
});

test('copy: selected lines go to the clipboard, filtered view copies the shown lines', async () => {
  const lines = std(200);
  const { s, d } = await open('copy.log', lines);
  await s.handle({ type: 'copy', from: 5, to: 7 });
  assert.equal(d.clipboardText, lines.slice(5, 8).join('\n'));
  assert.equal(last(d, 'copied').lines, 3);
  await s.handle({ type: 'copy', from: 7, to: 5 });
  assert.equal(d.clipboardText, lines.slice(5, 8).join('\n'));
  await s.handle({ type: 'filter', spec: { levels: [4] } });
  await s.handle({ type: 'copy', from: 0, to: 1 });
  assert.equal(d.clipboardText, [lines[0], lines[97]].join('\n'));
});

test('details and expansion of a long line', async () => {
  const long = '2026-01-15T10:00:00Z INFO ' + 'x'.repeat(5000);
  const { s, d } = await open('long.log', ['short', long]);
  await s.handle({ type: 'rows', id: 1, first: 0, count: 2 });
  const rows = last(d, 'rows').rows;
  assert.equal(rows[1].t.length, 2000);
  assert.equal(rows[1].x, 1);
  await s.handle({ type: 'expand', row: 1 });
  assert.equal(last(d, 'expanded').text.length, long.length);
  await s.handle({ type: 'details', row: 1 });
  const det = last(d, 'details').d;
  assert.equal(det.n, 2);
  assert.equal(det.bl, long.length);
  assert.equal(det.level, 'info');
});

test('control characters are made visible and never reach the page as markup', async () => {
  const { s, d } = await open('ctl.log', ['a\u0000b\u001bc<script>alert(1)</script>']);
  await s.handle({ type: 'rows', id: 1, first: 0, count: 1 });
  const t = last(d, 'rows').rows[0].t;
  assert.equal(t, 'a␀b␛c<script>alert(1)</script>');
});

test('follow: new lines are indexed, the filter is extended, truncation and rotation reset the view', async () => {
  const { s, d, p } = await open('follow.log', std(50));
  s.startFollow();
  assert.equal(last(d, 'follow').on, true);
  await s.handle({ type: 'filter', spec: { levels: [4] } });
  const before = last(d, 'filter').matches;
  const more = [];
  const r = G.rng(1);
  for (let i = 50; i < 200; i++) more.push(G.standardLine(i, r));
  fs.appendFileSync(p, more.join('\n') + '\n');
  await s.poll();
  assert.equal(s.source.lineCount, 200);
  assert.equal(last(d, 'total').total, s.rowCount);
  assert.equal(s.filter.list.length, G.standardLevelCounts(200).error);
  assert.ok(s.filter.list.length > before);
  s.setPaused(true);
  assert.equal(last(d, 'follow').paused, true);
  fs.writeFileSync(p, 'fresh start\n');
  await s.poll();
  const reset = last(d, 'reset');
  assert.match(reset.message, /truncated/);
  assert.equal(s.source.lineCount, 1);
  assert.equal(s.filter.active, false);
  s.stopFollow();
  assert.equal(last(d, 'follow').on, false);
});

test('encoding: a wrong guess is corrected by hand, auto detection returns', async () => {
  const p = path.join(dir, 'enc.log');
  fs.writeFileSync(p, Buffer.from('caf\xe9 ok\nsecond\n', 'latin1'));
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, {});
  await s.scanPromise;
  assert.equal(s.file.encoding, 'latin1');
  await s.setEncoding('utf8');
  await s.scanPromise;
  assert.equal(s.file.encoding, 'utf8');
  await s.setEncoding('auto');
  await s.scanPromise;
  assert.equal(s.file.encoding, 'latin1');
  assert.equal((await s.setEncoding('klingon')).ok, false);
});

test('Pro: the gate decides; a denied gate returns nothing and does not throw', async () => {
  const { s, d } = await open('pro.log', ['{"a":1}', '{"a":2}']);
  d.allow = false;
  await s.handle({ type: 'table', first: 0 });
  assert.equal(last(d, 'table').locked, true);
  await s.handle({ type: 'pretty', row: 0 });
  assert.equal(last(d, 'pretty').locked, true);
  await s.handle({ type: 'fields', row: 0 });
  assert.equal(last(d, 'fields').locked, true);
  assert.deepEqual(d.gateCalls.length, 3);
});

test('Pro: table window with exact numeric sorting, fields and pretty JSON', async () => {
  const lines = [
    '{"id":12345678901234567890,"amount":10.5,"name":"b"}', '{"id":12345678901234567891,"amount":9.75,"name":"a"}', '{"id":12345678901234567889,"amount":100,"extra":1}', 'not json'
  ];
  const { s, d } = await open('table.log', lines);
  s.setProfile(P.createProfile('jsonl'));
  await s.handle({ type: 'table', first: 0, sort: { col: 'id', dir: 'asc' } });
  let t = last(d, 'table');
  assert.deepEqual(t.columns, ['id', 'amount', 'name', 'extra']);
  assert.deepEqual(t.rows.map((r) => r.cells[0]), ['12345678901234567889', '12345678901234567890', '12345678901234567891', '']);
  await s.handle({ type: 'table', first: 0, sort: { col: 'amount', dir: 'desc' } });
  t = last(d, 'table');
  assert.deepEqual(t.rows.map((r) => r.cells[1]), ['100', '10.5', '9.75', '']);
  await s.handle({ type: 'fields', row: 0 });
  assert.deepEqual(last(d, 'fields').fields, [['id', '12345678901234567890'], ['amount', '10.5'], ['name', 'b']]);
  await s.handle({ type: 'pretty', row: 0 });
  assert.equal(last(d, 'pretty').text, '{\n  "id": 12345678901234567890,\n  "amount": 10.5,\n  "name": "b"\n}');
  await s.handle({ type: 'pretty', row: 3 });
  assert.equal(last(d, 'pretty').ok, false);
});

test('Pro: field filter and time range through the extra part of the filter', async () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push('{"ts":"2026-01-15T10:' + String(i).padStart(2, '0') + ':00Z","status":' + (i % 10 === 0 ? 503 : 200) + ',"path":"/p' + i + '"}');
  const { s, d } = await open('extra.log', lines);
  s.setProfile(P.createProfile('jsonl'));
  await s.setExtra({ field: 'status>=500' });
  assert.equal(last(d, 'filter').matches, 6);
  await s.setExtra({ from: Date.UTC(2026, 0, 15, 10, 20, 0), to: Date.UTC(2026, 0, 15, 10, 40, 0) });
  const done = last(d, 'filter');
  assert.equal(done.matches, 3, 'status 503 at minutes 20, 30, 40');
  await s.setExtra({ field: null, from: null, to: null });
  assert.equal(s.filter.active, false);
  await s.setExtra({ field: null });
  // a field filter without a profile is refused with a message that says what to do
  s.setProfile(null);
  const r = await s.setExtra({ field: 'status=200' });
  assert.equal(r.ok, false);
  assert.match(r.error, /parse profile/);
});

test('Pro gate: a message from the page cannot add a field filter or a time range (only the gated commands can)', async () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push('{"ts":"2026-01-15T10:' + String(i).padStart(2, '0') + ':00Z","status":' + (i % 10 === 0 ? 503 : 200) + ',"path":"/p' + i + '"}');
  const { s, d } = await open('forged.log', lines);
  s.setProfile(P.createProfile('jsonl'));
  // what a forged page message could carry
  const forged = await s.applyFilter({ text: 'path', field: 'status>=500', from: Date.UTC(2026, 0, 15, 10, 20, 0), to: Date.UTC(2026, 0, 15, 10, 40, 0) });
  assert.equal(forged.ok, true);
  assert.equal(last(d, 'filter').matches, 60, 'the text filter alone: every line has "path"; the field filter and the range were dropped');
  assert.deepEqual(s.extra, {});
  assert.equal(s.filter.spec.field, undefined);
  assert.equal(s.filter.spec.from, undefined);
  // the gated command path still works
  await s.setExtra({ field: 'status>=500' });
  assert.equal(last(d, 'filter').matches, 6);
});

test('Pro: time jump by bisection on a time-ordered file and by one pass when the file is not ordered', async () => {
  const ordered = [];
  for (let i = 0; i < 9000; i++) ordered.push(new Date(Date.UTC(2026, 0, 15, 0, 0, 0) + i * 10000).toISOString() + ' INFO line ' + i);
  const { s, d } = await open('time1.log', ordered);
  let r = await s.lineAtTime(Date.UTC(2026, 0, 15, 12, 0, 0));
  assert.deepEqual([r.ok, r.line, r.method], [true, 4320, 'bisection']);
  r = await s.lineAtTime(Date.UTC(2026, 0, 14));
  assert.equal(r.line, 0);
  r = await s.lineAtTime(Date.UTC(2030, 0, 1));
  assert.equal(r.ok, false);
  assert.match(r.message, /earlier/);
  await s.jumpToTime('2026-01-15 12:00:00');
  assert.equal(last(d, 'goto').row, 4320);
  await s.jumpToTime('yesterday-ish');
  assert.match(last(d, 'goto').message, /not understood/);
  // not ordered: the answer must still be the first line at or after the time
  const messy = ordered.slice(0, 3000).concat(ordered.slice(3000).reverse());
  const m = await open('time2.log', messy);
  const target = Date.UTC(2026, 0, 15, 5, 0, 0);
  const t = await m.s.lineAtTime(target);
  let expected = -1;
  for (let i = 0; i < messy.length; i++) if (Date.parse(messy[i].slice(0, 24)) >= target) { expected = i; break; }
  assert.equal(t.line, expected);
});

test('cancel stops a running search and a wait', async () => {
  const p = path.join(dir, 'cancel.log');
  await G.writeStandard(p, 80000);
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, {});
  await s.scanPromise;
  const run = s.handle({ type: 'search', id: 1, spec: { text: 'this text is nowhere' }, dir: 'next', from: -1 });
  await s.handle({ type: 'cancel' });
  await run;
  assert.equal(d.posted.filter((m) => m.type === 'found').length, 0, 'no result is reported for a cancelled search');
});

test('a missing file during follow is reported without an error', async () => {
  const { s, d, p } = await open('gone.log', std(10));
  s.startFollow();
  fs.rmSync(p);
  const r = await s.poll();
  assert.equal(r.kind, 'missing');
  assert.match(last(d, 'banner').text, /not there/);
  s.stopFollow();
});

test('merged view: rows carry the file tag; filtering and searching work on the merged stream', async () => {
  const { LogFile } = require('../src/engine/lineindex');
  const { MergeSource } = require('../src/pro/merge');
  const a = path.join(dir, 'ma.log');
  const b = path.join(dir, 'mb.log');
  G.writeLines(a, ['2026-01-15T10:00:00Z INFO a1', '2026-01-15T10:00:02Z ERROR a2 boom']);
  G.writeLines(b, ['2026-01-15T10:00:01Z INFO b1', '2026-01-15T10:00:03Z ERROR b2 boom']);
  const fa = new LogFile(a); await fa.open(); const fb = new LogFile(b); await fb.open();
  const m = new MergeSource([{ file: fa, name: a }, { file: fb, name: b }]);
  await m.prepare();
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openMerge(m, 'Merged');
  await s.handle({ type: 'rows', id: 1, first: 0, count: 4 });
  const rows = last(d, 'rows').rows;
  assert.deepEqual(rows.map((r) => r.tag), ['ma.log', 'mb.log', 'ma.log', 'mb.log']);
  await s.handle({ type: 'filter', spec: { levels: [4] } });
  assert.equal(last(d, 'filter').matches, 2);
  await s.handle({ type: 'search', id: 2, spec: { text: 'b2' }, dir: 'next', from: -1 });
  assert.equal(last(d, 'found').row, 1);
  const g = await s.goTo('@10');
  assert.equal(g.ok, false);
  await fa.close(); await fb.close();
});

test('the status text names the line, the share and the size', async () => {
  const { s } = await open('status.log', std(1000));
  const t = s.statusText(499);
  assert.match(t, /^Ln 500 of 1,000/);
  assert.match(t, /50%/);
  assert.match(t, /UTF-8/);
});

test('messages from the page with unusable numbers are answered, never thrown', async () => {
  const { s, d } = await open('garbage-msgs.log', std(50));
  for (const bad of [NaN, 'abc', undefined, null, {}, [], -5, Infinity, 1e300]) {
    await s.handle({ type: 'rows', id: 1, first: bad, count: bad });
    await s.handle({ type: 'copy', from: bad, to: bad });
    await s.handle({ type: 'bookmark', row: bad });
    await s.handle({ type: 'bookmarkJump', row: bad, dir: 'next' });
    await s.handle({ type: 'details', row: bad });
    await s.handle({ type: 'expand', row: bad });
    await s.handle({ type: 'view', cursor: bad });
    await s.handle({ type: 'table', first: bad, sort: bad });
    await s.handle({ type: 'search', id: 1, spec: { text: 'x' }, dir: 'next', from: bad });
  }
  assert.equal(d.posted.filter((m) => m.type === 'error').length, 0, JSON.stringify(d.posted.filter((m) => m.type === 'error')));
  await s.handle(null);
  await s.handle({ type: 'no-such-message' });
  await s.handle({ type: 42 });
});

test('follow does not run beside an index scan, and a closed log ends its scan quietly', async () => {
  const p = path.join(dir, 'busy.log');
  await G.writeStandard(p, 60000);
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, { engine: { chunkBytes: 32768, yieldEveryChunk: true } });
  assert.equal(s.scanBusy, true);
  assert.equal((await s.poll()).kind, 'busy');
  s.dispose();
  await s.scanPromise;
  assert.equal(d.notes.length, 0, 'no error notice after the log was closed: ' + JSON.stringify(d.notes));
});

test('a filter on a log that is still being indexed waits for the index and then covers the whole log', async () => {
  const p = path.join(dir, 'indexing.log');
  await G.writeStandard(p, 60000);
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, { engine: { chunkBytes: 32768, yieldEveryChunk: true } });
  assert.equal(s.source.complete, false);
  await s.handle({ type: 'filter', spec: { levels: [4] } });
  const done = last(d, 'filter');
  assert.equal(done.state, 'done');
  assert.equal(done.matches, G.standardLevelCounts(60000).error, 'every error line of the whole log, not only the part that was indexed when the filter started');
  assert.ok(d.posted.some((m) => m.type === 'filter' && m.waiting), 'the page was told that the filter waits');
});

test('a search that finds nothing in the part indexed so far says that it may find more later', async () => {
  const p = path.join(dir, 'indexing2.log');
  await G.writeStandard(p, 60000);
  const d = deps();
  const s = new LogSession(d);
  sessions.push(s);
  await s.openFile(p, { engine: { chunkBytes: 32768, yieldEveryChunk: true } });
  await s.handle({ type: 'search', id: 1, spec: { text: 'zzz-nothing-like-this' }, dir: 'next', from: -1 });
  const f = last(d, 'found');
  if (s.source.complete === false) assert.equal(f.partial, true);
  assert.equal(f.none, true);
});
