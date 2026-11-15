'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogFile } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const S = require('../src/engine/search');
const P = require('../src/pro/profiles');
const FF = require('../src/pro/fieldfilter');
const { computeStats } = require('../src/pro/stats');
const { MergeSource } = require('../src/pro/merge');
const X = require('../src/pro/exporter');
const A = require('../src/pro/anonymise');
const D = require('../src/pro/logdiff');
const G = require('./helpers/gen');

const dir = G.tmpDir('pro-');
const opened = [];
test.after(async () => { for (const f of opened) await f.close(); G.rmDir(dir); });

async function open(name, lines, opts) {
  const p = path.join(dir, name);
  G.writeLines(p, lines, opts);
  const f = new LogFile(p, { chunkBytes: 2048, stepLines: 4, stepBytes: 500 });
  await f.open();
  await f.scan();
  opened.push(f);
  return f;
}

// ---- profiles -------------------------------------------------------------------------------------

test('JSON lines keep numbers exactly and flatten nested objects', () => {
  const f = P.createProfile('jsonl').parse('{"id":12345678901234567890123,"amount":10.50,"ok":true,"n":null,"a":{"b":{"c":"x\\u00e9\\n"}},"l":[1,"two"],"s":"\\ud83d\\ude00"}');
  assert.equal(f.id, '12345678901234567890123');
  assert.equal(f.amount, '10.50');
  assert.equal(f.ok, 'true');
  assert.equal(f.n, 'null');
  assert.equal(f['a.b.c'], 'xé\n');
  assert.equal(f['l.0'], '1');
  assert.equal(f['l.1'], 'two');
  assert.equal(f.s, '😀');
  assert.equal(Object.getPrototypeOf(f), null);
  for (const bad of ['', 'plain text', '{"a":', '{"a":1,}', '[1,2]', '{"a":01}', '{"a":"\\x"}', '{"a":1} trailing', '{"__proto__":{"x":1}}x']) assert.equal(P.createProfile('jsonl').parse(bad), null, bad);
  const proto = P.createProfile('jsonl').parse('{"__proto__":{"polluted":1},"x":2}');
  assert.equal(({}).polluted, undefined);
  assert.equal(proto.x, '2');
});

test('JSON lines: depth and field count limits', () => {
  let deep = '1';
  for (let i = 0; i < 30; i++) deep = '{"a":' + deep + '}';
  assert.equal(P.createProfile('jsonl').parse(deep), null);
  const many = '{' + Array.from({ length: 400 }, (_, i) => '"k' + i + '":' + i).join(',') + '}';
  assert.equal(Object.keys(P.createProfile('jsonl').parse(many)).length, 200);
});

test('logfmt', () => {
  const f = P.createProfile('logfmt').parse('ts=2026-01-15T10:00:00Z level=error msg="disk \\"full\\" now" path=/var/log empty= n=7');
  assert.equal(f.level, 'error');
  assert.equal(f.msg, 'disk "full" now');
  assert.equal(f.empty, '');
  assert.equal(f.n, '7');
  assert.equal(P.createProfile('logfmt').parse('just some words'), null);
});

test('syslog 3164 and 5424, access logs, nginx and apache error logs', () => {
  const sys = P.createProfile('syslog');
  let f = sys.parse('<34>Oct 11 22:14:15 mymachine su[123]: failed for user');
  assert.deepEqual([f.facility, f.severity, f.host, f.app, f.pid, f.message], ['4', 'critical', 'mymachine', 'su', '123', 'failed for user']);
  f = sys.parse('<165>1 2026-01-15T10:00:00.003Z host1 myapp 4711 ID47 [exampleSDID@32473 iut="3" eventSource="App"] An application event');
  assert.deepEqual([f.facility, f.severity, f.time, f.host, f.app, f.pid, f.msgid, f.message], ['20', 'notice', '2026-01-15T10:00:00.003Z', 'host1', 'myapp', '4711', 'ID47', 'An application event']);
  assert.equal(f.structured, '[exampleSDID@32473 iut="3" eventSource="App"]');
  const acc = P.createProfile('access');
  f = acc.parse('192.0.2.7 - alice [01/May/2024:12:34:56 +0000] "GET /api/items?id=5 HTTP/1.1" 503 1234 "https://example.org/" "Agent/1.0 (x)"');
  assert.deepEqual([f.remote_addr, f.user, f.method, f.path, f.protocol, f.status, f.bytes, f.referer, f.level], ['192.0.2.7', 'alice', 'GET', '/api/items?id=5', 'HTTP/1.1', '503', '1234', 'https://example.org/', 'error']);
  f = acc.parse('192.0.2.7 - - [01/May/2024:12:34:56 +0000] "POST /x HTTP/1.0" 200 -');
  assert.equal(f.status, '200');
  assert.equal(f.referer, undefined);
  const ng = P.createProfile('nginx-error');
  f = ng.parse('2024/05/01 12:34:56 [error] 31#31: *7 connect() failed (111: Connection refused) while connecting to upstream, client: 192.0.2.7, server: example.org, request: "GET /x HTTP/1.1", upstream: "http://10.0.0.1:80/x"');
  assert.deepEqual([f.level, f.pid, f.connection, f.client, f.server, f.request], ['error', '31', '7', '192.0.2.7', 'example.org', 'GET /x HTTP/1.1']);
  const ap = P.createProfile('apache-error');
  f = ap.parse('[Wed May 01 12:34:56.123456 2024] [core:error] [pid 1234:tid 5678] [client 192.0.2.7:5555] AH00126: Invalid URI');
  assert.deepEqual([f.module, f.level, f.pid, f.tid, f.client, f.message], ['core', 'error', '1234', '5678', '192.0.2.7:5555', 'AH00126: Invalid URI']);
});

test('log4j / logback conversion patterns become regular expressions with named groups', () => {
  const p = P.createProfile('log4j', { pattern: '%d{yyyy-MM-dd HH:mm:ss.SSS} [%t] %-5level %logger{36} - %msg%n' });
  const f = p.parse('2026-01-15 10:00:00.123 [http-nio-8080-exec-1] WARN  com.example.web.OrderController - slow request: 1200 ms');
  assert.deepEqual([f.time, f.thread, f.level, f.logger, f.message], ['2026-01-15 10:00:00.123', 'http-nio-8080-exec-1', 'WARN', 'com.example.web.OrderController', 'slow request: 1200 ms']);
  assert.equal(p.parse('	at com.example.Foo.bar(Foo.java:10)'), null);
  const q = P.createProfile('log4j', { pattern: '%d{HH:mm:ss} %p %c{1}:%L - %m%n' });
  assert.equal(q.parse('10:00:01 ERROR Foo:42 - boom').line, '42');
  assert.throws(() => P.createProfile('log4j', { pattern: '%d %zzz %m' }), /not supported/);
  assert.throws(() => P.createProfile('log4j', { pattern: '' }), /Enter a conversion pattern/);
});

test('user-defined regular expression profile: named groups, refusals', () => {
  const p = P.createProfile('regex', { pattern: '^(?<time>\\S+) (?<level>[A-Z]+) (?<msg>.*)$' });
  assert.deepEqual(Object.assign({}, p.parse('t1 ERROR it broke')), { time: 't1', level: 'ERROR', msg: 'it broke' });
  assert.equal(p.parse('lower case'), null);
  assert.throws(() => P.createProfile('regex', { pattern: '(a)\\1' }), /not accepted/);
  assert.throws(() => P.createProfile('regex', { pattern: 'a(b)' }), /no named group/);
  const evil = P.createProfile('regex', { pattern: '^(?<x>(a+)+)$' });
  const t0 = Date.now();
  assert.equal(evil.parse('a'.repeat(20000) + 'b'), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('profile suggestion', () => {
  assert.equal(P.suggest(['{"a":1}', '{"a":2}', '{"a":3}']), 'jsonl');
  assert.equal(P.suggest(['a=1 b=2', 'a=3 b=4']), 'logfmt');
  assert.equal(P.suggest(['free text', 'more text']), null);
});

test('exact decimal comparison: no binary floating point', () => {
  const c = P.compareDecimal;
  assert.equal(c('12345678901234567890123', '12345678901234567890124'), -1);
  assert.equal(c('0.1', '0.10'), 0);
  assert.equal(c('-0', '0'), 0);
  assert.equal(c('9007199254740993', '9007199254740992'), 1);
  assert.equal(c('0.30000000000000004', '0.3'), 1);
  assert.equal(c('-5', '3'), -1);
  assert.equal(c('-5', '-3'), -1);
  assert.equal(c('1e3', '1000'), 0, 'an exponent is read as an exact decimal');
  assert.equal(P.compareValues('10', '9'), 1);
  assert.equal(P.compareValues('abc', 'abd'), -1);
  assert.equal(P.compareValues('10', 'abc'), -1, 'mixed values compare as text');
});

// ---- field filters --------------------------------------------------------------------------------

test('field filters: operators, quoting, exact numbers, absent fields', () => {
  const t = (expr) => FF.parseFilter(expr);
  const row = { status: '503', amount: '12345678901234567890.5', path: '/api/items', level: 'error', name: 'Ann Lee' };
  assert.equal(FF.matches(t('status>=500'), row), true);
  assert.equal(FF.matches(t('status>=500 status<504 level=error'), row), true);
  assert.equal(FF.matches(t('status>503'), row), false);
  assert.equal(FF.matches(t('amount>12345678901234567890.4'), row), true);
  assert.equal(FF.matches(t('amount>12345678901234567890.5'), row), false);
  assert.equal(FF.matches(t('path~^/api/'), row), true);
  assert.equal(FF.matches(t('path!~^/api/'), row), false);
  assert.equal(FF.matches(t('name="Ann Lee"'), row), true);
  assert.equal(FF.matches(t('name=Ann'), row), false);
  assert.equal(FF.matches(t('missing=1'), row), false);
  assert.equal(FF.matches(t('missing!=1'), row), true);
  assert.equal(FF.matches(t('status=0503'), row), false, '= compares text');
  assert.deepEqual(t(''), []);
  assert.throws(() => t('nonsense'), /not a field filter/);
  assert.throws(() => t('a="open'), /not closed/);
  assert.throws(() => t('a~(x)\\1'), /not accepted/);
});

// ---- statistics -----------------------------------------------------------------------------------

test('statistics: hand-computed counts, histogram, top values and bursts', async () => {
  const lines = [];
  // minute 0: 3 info; minute 1: 6 errors in 5 seconds, then silence; minute 5: 1 warn, 2 info
  for (let i = 0; i < 3; i++) lines.push('2026-01-15T10:00:0' + i + 'Z INFO ok ' + i + ' user=ann');
  for (let i = 0; i < 6; i++) lines.push('2026-01-15T10:01:0' + i + 'Z ERROR failed ' + i + ' user=' + (i < 4 ? 'bob' : 'cid'));
  lines.push('2026-01-15T10:05:00Z WARN slow user=ann');
  lines.push('\tat stack frame');
  lines.push('2026-01-15T10:05:30Z INFO ok user=ann', '2026-01-15T10:05:31Z INFO ok user=dan');
  lines.push('2026-01-15T10:30:00Z ERROR lonely user=bob');
  const f = await open('stats.log', lines);
  const s = new FileSource(f);
  const prof = P.createProfile('regex', { pattern: 'user=(?<user>\\w+)' });
  const r = await computeStats(s, { profile: prof, topFields: ['user'], timeFormat: 'iso', maxBars: 40 });
  assert.equal(r.lines, 14);
  assert.deepEqual(r.levels, { trace: 0, debug: 0, info: 5, warn: 1, error: 7, fatal: 0, none: 1 });
  assert.equal(r.timed, 13);
  assert.equal(r.untimed, 1);
  assert.equal(r.firstTime, Date.UTC(2026, 0, 15, 10, 0, 0));
  assert.equal(r.lastTime, Date.UTC(2026, 0, 15, 10, 30, 0));
  assert.deepEqual(r.top.user, [{ value: 'ann', count: 5 }, { value: 'bob', count: 5 }, { value: 'cid', count: 2 }, { value: 'dan', count: 1 }]);
  assert.equal(r.bursts.length, 1);
  assert.deepEqual([r.bursts[0].count, r.bursts[0].startLine, r.bursts[0].endLine], [6, 3, 8]);
  const total = r.histogram.buckets.reduce((n, b) => n + b.count, 0);
  const errors = r.histogram.buckets.reduce((n, b) => n + b.errors, 0);
  assert.equal(total, 13);
  assert.equal(errors, 7);
  assert.equal(r.untracked.user, 0);
});

test('statistics without time stamps measure bursts in lines', async () => {
  const lines = ['INFO a'];
  for (let i = 0; i < 7; i++) lines.push('ERROR e' + i);
  for (let i = 0; i < 40; i++) lines.push('INFO fine');
  lines.push('ERROR alone');
  const f = await open('stats2.log', lines);
  const r = await computeStats(new FileSource(f), {});
  assert.equal(r.burstUnit, 'lines');
  assert.deepEqual(r.bursts.map((b) => [b.count, b.startLine, b.endLine]), [[7, 1, 7]]);
  assert.equal(r.firstTime, null);
});

test('statistics tell how many distinct values were not tracked', async () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push('k=' + i);
  const f = await open('stats3.log', lines);
  const prof = P.createProfile('regex', { pattern: 'k=(?<k>\\d+)' });
  const r = await computeStats(new FileSource(f), { profile: prof, topFields: ['k'], topN: 3 });
  assert.equal(r.top.k.length, 3);
  assert.equal(r.untracked.k, 0);
});

// ---- merge ----------------------------------------------------------------------------------------

test('merge by time: order, tags, continuation lines, ties, files without time stamps', async () => {
  const a = await open('m-a.log', ['2026-01-15T10:00:00Z a1', '2026-01-15T10:00:02Z a2', '\tcontinued a2', '2026-01-15T10:00:04Z a3']);
  const b = await open('m-b.log', ['2026-01-15T10:00:01Z b1', '2026-01-15T10:00:02Z b2', '2026-01-15T10:00:03Z b3']);
  const c = await open('m-c.log', ['2026-01-15T09:59:59Z c0 first']);
  const m = new MergeSource([{ file: a, name: 'x/app.log' }, { file: b, name: 'y/app.log' }, { file: c, name: 'other.log' }], { step: 2 });
  const r = await m.prepare();
  assert.equal(r.aborted, false);
  assert.equal(m.lineCount, 8);
  assert.deepEqual(m.tags, ['app.log (1)', 'app.log (2)', 'other.log']);
  const all = await m.readLines(0, 20);
  assert.deepEqual(all.map((l) => l.text), ['2026-01-15T09:59:59Z c0 first', '2026-01-15T10:00:00Z a1', '2026-01-15T10:00:01Z b1', '2026-01-15T10:00:02Z a2', '\tcontinued a2', '2026-01-15T10:00:02Z b2', '2026-01-15T10:00:03Z b3', '2026-01-15T10:00:04Z a3']);
  assert.deepEqual(all.map((l) => l.tag), ['other.log', 'app.log (1)', 'app.log (2)', 'app.log (1)', 'app.log (1)', 'app.log (2)', 'app.log (2)', 'app.log (1)']);
  // a window from the middle equals the same part of the whole
  for (const start of [0, 1, 3, 5, 7]) {
    const part = await m.readLines(start, 3);
    assert.deepEqual(part.map((l) => l.text), all.slice(start, start + 3).map((l) => l.text), 'start ' + start);
    assert.deepEqual(part.map((l) => l.no), all.slice(start, start + 3).map((l) => l.no));
  }
  const streamed = [];
  await m.forEachText(2, (rec) => { streamed.push(rec.text); return true; });
  assert.deepEqual(streamed, all.slice(2).map((l) => l.text));
  assert.deepEqual(m.outOfOrder, [0, 0, 0]);
});

test('merge: a file whose time stamps go backwards is reported', async () => {
  const a = await open('m-d.log', ['2026-01-15T10:00:05Z d1', '2026-01-15T10:00:01Z d2 earlier', '2026-01-15T10:00:07Z d3']);
  const b = await open('m-e.log', ['2026-01-15T10:00:00Z e1']);
  const m = new MergeSource([{ file: a, name: 'd.log' }, { file: b, name: 'e.log' }]);
  await m.prepare();
  assert.equal(m.lineCount, 4);
  assert.deepEqual(m.outOfOrder, [1, 0]);
});

test('merge of 8 files with 3000 lines each keeps global order', async () => {
  const files = [];
  const rnd = G.rng(4);
  for (let k = 0; k < 8; k++) {
    const lines = [];
    let t = Date.UTC(2026, 0, 15) + k * 5;
    for (let i = 0; i < 3000; i++) { t += 1 + Math.floor(rnd() * 20); lines.push(new Date(t).toISOString() + ' f' + k + ' n' + i); }
    files.push({ file: await open('mm' + k + '.log', lines), name: 'mm' + k + '.log' });
  }
  const m = new MergeSource(files, { step: 64 });
  await m.prepare();
  assert.equal(m.lineCount, 24000);
  let last = -1;
  let n = 0;
  await m.forEachText(0, (rec) => { const t = Date.parse(rec.text.slice(0, 24)); assert.ok(t >= last, 'order at ' + rec.no); last = t; n++; return true; });
  assert.equal(n, 24000);
  const mid = await m.readLines(12345, 5);
  assert.deepEqual(mid.map((l) => l.no), [12345, 12346, 12347, 12348, 12349]);
  const again = [];
  await m.forEachText(12345, (rec) => { again.push(rec.text); return again.length < 5; });
  assert.deepEqual(mid.map((l) => l.text), again);
});

// ---- export ---------------------------------------------------------------------------------------

test('export: text, CSV with formula neutralising and quoting, JSON, JSON lines; filter applies', async () => {
  const lines = [
    '2026-01-15T10:00:00Z INFO plain', '2026-01-15T10:00:01Z ERROR =HYPERLINK("http://x","y")', '=cmd|calc', '+1 and, comma', '-5 "quoted"', '@sum', '\tindented', 'multi "q" line'
  ];
  const f = await open('exp.log', lines);
  const s = new FileSource(f);
  const out = path.join(dir, 'out.csv');
  let r = await X.exportLines(s, { outPath: out, format: 'csv', pred: () => true, timeFormat: 'iso', neutralise: true });
  assert.equal(r.written, 8);
  const csv = fs.readFileSync(out, 'utf8').split('\r\n');
  assert.equal(csv[0], 'line,time,level,text');
  assert.equal(csv[1], '1,2026-01-15T10:00:00.000Z,info,2026-01-15T10:00:00Z INFO plain');
  for (const row of csv.slice(1, 9)) {
    const cells = row.startsWith('"') || row.includes('"') ? row : row;
    void cells;
  }
  assert.ok(csv[3].endsWith(",\"'=cmd|calc\"") || csv[3].endsWith(",'=cmd|calc"), csv[3]);
  assert.ok(csv.some((l) => l.includes("\"'+1 and, comma\"")), 'comma cell quoted and neutralised');
  assert.ok(csv.some((l) => l.includes("\"'-5 \"\"quoted\"\"\"")));
  assert.ok(csv.some((l) => l.endsWith(",'@sum")));
  assert.ok(csv.some((l) => l.includes("\"'\tindented\"")) || csv.some((l) => l.includes("'\tindented")));
  assert.ok(!csv.some((l) => /,[=+\-@]/.test(l.replace(/^[^,]*,[^,]*,[^,]*,/, ''))), 'no text cell starts with a formula character');
  // opt-out keeps the exact values
  r = await X.exportLines(s, { outPath: out, format: 'csv', pred: () => true, neutralise: false });
  assert.ok(fs.readFileSync(out, 'utf8').includes(',=cmd|calc'));
  // a filter
  r = await X.exportLines(s, { outPath: out, format: 'text', pred: S.makePredicate({ levels: [4], keepContinuation: false }) });
  assert.equal(fs.readFileSync(out, 'utf8'), '2026-01-15T10:00:01Z ERROR =HYPERLINK("http://x","y")\n');
  r = await X.exportLines(s, { outPath: out, format: 'json', pred: () => true });
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(arr.length, 8);
  assert.equal(arr[2].text, '=cmd|calc');
  assert.equal(arr[0].line, 1);
  r = await X.exportLines(s, { outPath: out, format: 'jsonl', pred: () => false });
  assert.equal(fs.readFileSync(out, 'utf8'), '');
  r = await X.exportLines(s, { outPath: out, format: 'json', pred: () => false });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), []);
});

test('export with a profile adds a column per field; anonymising transform is applied to cells', async () => {
  const f = await open('exp2.log', ['{"user":"ann@example.org","n":5}', '{"user":"bob@example.org","n":6,"extra":"x"}', 'not json']);
  const s = new FileSource(f);
  const prof = P.createProfile('jsonl');
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 7) });
  const out = path.join(dir, 'out2.csv');
  const r = await X.exportLines(s, { outPath: out, format: 'csv', pred: () => true, profile: prof, transform: an.apply });
  assert.deepEqual(r.columns, ['user', 'n', 'extra']);
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(!text.includes('example.org') || text.includes('example.invalid'));
  assert.ok(!/ann@example\.org|bob@example\.org/.test(text));
  assert.equal(text.split('\r\n')[0], 'line,time,level,user,n,extra,text');
});

test('export streams a large selection with a small buffer', async () => {
  const p = path.join(dir, 'bigexp.log');
  await G.writeStandard(p, 60000);
  const f = new LogFile(p, { chunkBytes: 1 << 20 }); await f.open(); await f.scan(); opened.push(f);
  const out = path.join(dir, 'bigexp.out');
  const r = await X.exportLines(new FileSource(f), { outPath: out, format: 'text', pred: S.makePredicate({ levels: [4] }) });
  assert.equal(r.written, G.standardLevelCounts(60000).error);
  assert.equal(fs.readFileSync(out, 'utf8').split('\n').length - 1, r.written);
});

// ---- anonymise ------------------------------------------------------------------------------------

test('anonymise: built-in rules replace sensitive values; same value, same replacement; no original survives', () => {
  const key = Buffer.alloc(32, 9);
  const an = A.createAnonymiser({ key });
  const line = 'user ann.lee@example.org from 192.0.2.77 and 2001:db8:85a3:0:0:8a2e:370:7334 token=abcd1234efgh Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk key AKIAIOSFODNN7EXAMPLE card 4111 1111 1111 1111 id 0123456789abcdef0123456789abcdef01 ann.lee@example.org';
  const out = an.apply(line);
  for (const secret of ['ann.lee@example.org', '192.0.2.77', '2001:db8:85a3:0:0:8a2e:370:7334', 'abcd1234efgh', 'eyJhbGciOiJIUzI1NiJ9', 'AKIAIOSFODNN7EXAMPLE', '4111 1111 1111 1111', '0123456789abcdef0123456789abcdef01']) assert.ok(!out.includes(secret), secret + ' in ' + out);
  const emails = out.match(/user-[0-9a-f]{12}@example\.invalid/g);
  assert.equal(emails.length, 2);
  assert.equal(emails[0], emails[1]);
  assert.match(out, /token=\[secret-[0-9a-f]{8}\]/);
  assert.match(out, /10\.\d+\.\d+\.\d+/);
  assert.ok(an.counts().email === 2 && an.counts().ipv4 === 1 && an.counts().card === 1);
  // another key gives other replacements; a run key is random by default
  const other = A.createAnonymiser({ key: Buffer.alloc(32, 1) }).apply('x@y.org');
  assert.notEqual(other, an.apply('x@y.org'));
  assert.notEqual(A.createAnonymiser().apply('x@y.org'), A.createAnonymiser().apply('x@y.org'));
});

test('anonymise: what must stay is untouched; a card-like number that fails the check digit stays', () => {
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 3) });
  const keep = '2026-01-15 10:30:45.123 INFO order 1234567890 took 12ms version 1.2.3 path /a/b/c';
  assert.equal(an.apply(keep), keep);
  assert.equal(an.apply('card 4111 1111 1111 1112'), 'card 4111 1111 1111 1112');
});

test('anonymise: rule file with the linear-time engine; bad rules are reported', () => {
  const parsed = A.parseRuleFile(JSON.stringify({ rules: [{ name: 'customer', pattern: 'CUST-[0-9]{6}', replace: 'hash' }, { name: 'plan', pattern: 'plan=(?:gold|silver)', replace: 'mask' }, { name: 'lit', pattern: 'SECRET', replace: '<removed>' }, { name: 'bad', pattern: '(a)\\1' }, { name: 'nopattern' }, { name: 'evil', pattern: '(a+)+$' }] }));
  assert.equal(parsed.rules.length, 4);
  assert.equal(parsed.errors.length, 2);
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 5), rules: parsed.rules, builtins: [] });
  const out = an.apply('CUST-123456 bought plan=gold SECRET');
  assert.match(out, /^\[customer-[0-9a-f]{8}\] bought \*{9} <removed>$/);
  const t0 = Date.now();
  an.apply('a'.repeat(30000) + 'b');
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(A.parseRuleFile('{nope').rules, []);
  assert.match(A.parseRuleFile('{"x":1}').errors[0], /list of rules/);
});

test('anonymise: 10,000 distinct values give 10,000 distinct replacements and nothing can be reversed from a small seed space', () => {
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 8) });
  const seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(an.apply('acct' + i + '@example.org'));
  assert.equal(seen.size, 10000);
  const keyed = A.createAnonymiser().apply('who@example.org');
  assert.doesNotMatch(keyed, /who/);
});

// ---- compare excerpts -----------------------------------------------------------------------------

test('log comparison normalises times, ids and long numbers', () => {
  const a = '2026-01-15T10:00:00.123Z INFO req 550e8400-e29b-41d4-a716-446655440000 took 12ms from 10.0.0.1 session 0x7fff5fbff8a0 order 99887766';
  const b = '2026-02-20 11:11:11,999 INFO req 123e4567-e89b-12d3-a456-426614174000 took 12ms from 10.0.0.1 session 0x1234abcd order 11223344';
  assert.equal(D.normalize(a), D.normalize(b));
  assert.equal(D.normalize('took 12ms'), 'took 12ms');
  assert.equal(D.normalize('a 2026-01-15T10:00:00Z b', ['uuid']), 'a 2026-01-15T10:00:00Z b');
});

test('log comparison: Myers script is minimal and complete, and bounded', () => {
  const a = ['x', 'a', 'b', 'c', 'y'];
  const b = ['x', 'b', 'c', 'd', 'y'];
  const r = D.diffLines(a, b);
  assert.equal(r.ok, true);
  assert.deepEqual([r.same, r.deleted, r.added], [4, 1, 1]);
  const sbs = D.sideBySide(a, b, r);
  assert.deepEqual(sbs.left, ['x', 'a', 'b', 'c', 'y']);
  assert.deepEqual(sbs.right, ['x', 'b', 'c', 'd', 'y']);
  assert.equal(D.diffLines([], []).same, 0);
  assert.equal(D.diffLines(['a'], []).deleted, 1);
  const many = Array.from({ length: 5000 }, (_, i) => 'l' + i);
  const other = Array.from({ length: 5000 }, (_, i) => 'm' + i);
  const big = D.diffLines(many, other);
  assert.equal(big.ok, false);
  assert.match(big.reason, /differ in more than/);
  assert.equal(D.diffLines(new Array(20001).fill('a'), []).ok, false);
});
