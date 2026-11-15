'use strict';
// Hostile anonymisation tests. 1: the exact reproductions of the re-check of the first fixes (secret keys
// with a prefix, in capitals, in camel case; the credential of an authorization header; JSON escapes;
// values of one to three characters and with spaces; e-mail addresses and addresses used as JSON keys)
// in all 8 profiles and all 4 formats. 2: a built corpus of several hundred spellings of secret
// keys, each with a unique value, in all 8 profiles and all 4 formats. In every output file, no
// original value may appear anywhere: not in the text, not in a field, not in a header.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LogFile } = require('../src/engine/lineindex');
const { FileSource } = require('../src/engine/source');
const P = require('../src/pro/profiles');
const X = require('../src/pro/exporter');
const A = require('../src/pro/anonymise');
const G = require('./helpers/gen');

const dir = G.tmpDir('anonhostile-');
const opened = [];
test.after(async () => { for (const f of opened) await f.close(); G.rmDir(dir); });

const FORMATS = ['text', 'csv', 'json', 'jsonl'];
const PROFILES = [
  { id: 'jsonl', make: () => P.createProfile('jsonl') },
  { id: 'logfmt', make: () => P.createProfile('logfmt') },
  { id: 'syslog', make: () => P.createProfile('syslog') },
  { id: 'access', make: () => P.createProfile('access') },
  { id: 'nginx-error', make: () => P.createProfile('nginx-error') },
  { id: 'apache-error', make: () => P.createProfile('apache-error') },
  { id: 'log4j', make: () => P.createProfile('log4j', { pattern: '%d{yyyy-MM-dd HH:mm:ss.SSS} [%t] %-5level %logger{36} - %msg%n' }) },
  { id: 'regex', make: () => P.createProfile('regex', { pattern: '^(?<time>\\S+) (?<level>[A-Z]+) (?<message>.*)$' }) }
];

// One line of each profile's own format, with `message` where free text goes.
function wrap(profileId, message) {
  switch (profileId) {
    case 'jsonl': return '{"time":"2026-01-15T10:00:00Z","level":"info","msg":' + JSON.stringify(message) + '}';
    case 'logfmt': return 'time=2026-01-15T10:00:00Z level=info ' + message;
    case 'syslog': return 'Jan 15 10:00:00 host app[123]: ' + message;
    case 'access': return '192.0.2.7 - - [15/Jan/2026:10:00:00 +0000] "GET /index HTTP/1.1" 200 123 "-" "' + message + '"';
    case 'nginx-error': return '2026/01/15 10:00:00 [error] 123#0: *1 ' + message + ', client: 192.0.2.9, server: example.invalid';
    case 'apache-error': return '[Wed Jan 15 10:00:00.123456 2026] [core:error] [pid 1234:tid 5678] [client 192.0.2.7:5555] ' + message;
    case 'log4j': return '2026-01-15 10:00:00.123 [main] ERROR com.example.App - ' + message;
    case 'regex': return '2026-01-15T10:00:00Z INFO ' + message;
    default: throw new Error(profileId);
  }
}

let counter = 0;
async function runExports(profile, lines, label) {
  const p = path.join(dir, 'in-' + label + '-' + (counter++) + '.log');
  G.writeLines(p, lines);
  const f = new LogFile(p, { chunkBytes: 1 << 16 });
  await f.open();
  await f.scan();
  opened.push(f);
  const source = new FileSource(f);
  const outputs = {};
  for (const format of FORMATS) {
    const an = A.createAnonymiser({ key: Buffer.alloc(32, 21) });
    const out = path.join(dir, 'out-' + label + '-' + (counter++) + '.' + format);
    const r = await X.exportLines(source, { outPath: out, format: format, pred: () => true, profile: profile.make(), timeFormat: 'iso', transform: an.apply, fieldRule: an.fieldRule });
    assert.equal(r.written, lines.length, profile.id + ' ' + format);
    outputs[format] = fs.readFileSync(out, 'utf8');
  }
  return outputs;
}

function assertNoneIn(outputs, values, where) {
  for (const format of FORMATS) {
    const text = outputs[format];
    const leaked = values.filter((v) => text.includes(v));
    assert.deepEqual(leaked.slice(0, 5), [], where + ' ' + format + ': ' + leaked.length + ' values are in the output, for example ' + leaked.slice(0, 3).join(' | '));
  }
}

// ---- 1: the exact reproductions of the re-check -----------------------------------------------------------

const REPRO = [
  ['connect db_password=Dbpass9911 now', ['Dbpass9911']],
  ['DB_PASSWORD=UpperPw4455 MYSQL_ROOT_PASSWORD=RootPw6677', ['UpperPw4455', 'RootPw6677']],
  ['refresh_token=rTok55667788 id_token=idTok11223344', ['rTok55667788', 'idTok11223344']],
  ['userPassword=UsrPw1234 authToken=AuthTk5566 apiSecret=ApiSc7788', ['UsrPw1234', 'AuthTk5566', 'ApiSc7788']],
  ['pass=PlainPass77 passphrase=Phrase8899', ['PlainPass77', 'Phrase8899']],
  ['Authorization: Token tkn55aa66bb', ['tkn55aa66bb']],
  ['Authorization: Bearer brr77cc88dd and Authorization: Basic YmFzaWM5OTExOnB3', ['brr77cc88dd', 'YmFzaWM5OTExOnB3']],
  ['password="correct horse battery staple" next', ['horse battery', 'correct horse']],
  ["secret='single quoted horse7788' next", ['single quoted horse7788']],
  ['client_secret=cs9988aa private_key=pk7766bb', ['cs9988aa', 'pk7766bb']],
  ['run app --password=cli7788aa --token cli9988bb --api-key cli1122cc', ['cli7788aa', 'cli9988bb', 'cli1122cc']],
  ['<config><password>xml4455dd</password><db_token a="1">xml6677ee</db_token></config>', ['xml4455dd', 'xml6677ee']],
  ['[password=br1122ff] (secret: pr3344gg) {token=cu5566hh}', ['br1122ff', 'pr3344gg', 'cu5566hh']],
  ['postgres://app:pg7788ii@db.example.invalid/x and https://u:ht9900jj@h.example.invalid/', ['pg7788ii', 'ht9900jj']],
  ['Server=db;User Id=sa;Password=cs1234kk;Timeout=5', ['cs1234kk']],
  ['X-Api-Key: hd4455ll Set-Cookie: sid=ck6677mm; Path=/', ['hd4455ll', 'ck6677mm']]
];

for (const profile of PROFILES) {
  test('re-check reproductions: no original value in any format with the ' + profile.id + ' profile', async () => {
    const lines = REPRO.map((r) => wrap(profile.id, r[0]));
    const values = [].concat(...REPRO.map((r) => r[1]));
    const outputs = await runExports(profile, lines, 'repro-' + profile.id);
    assertNoneIn(outputs, values, profile.id);
  });
}

const JSON_REPRO = [
  { line: '{"time":"2026-01-15T10:00:00Z","level":"info","refresh_token":"jsRef998877","client":{"db_password":"jsDb556677"}}', values: ['jsRef998877', 'jsDb556677'] },
  { line: '{"time":"2026-01-15T10:00:01Z","level":"info","email":"alice\\u0040corp-mail.com"}', values: ['alice@corp-mail.com', 'alice\\u0040corp-mail.com'] },
  { line: '{"time":"2026-01-15T10:00:02Z","level":"info","msg":"retry with password=\\"Tr0ub4dor\\" failed"}', values: ['Tr0ub4dor'] },
  { line: '{"time":"2026-01-15T10:00:03Z","level":"info","password":"abcd\\"efgh1234"}', values: ['efgh1234', 'abcd\\"efgh'] },
  { line: '{"time":"2026-01-15T10:00:04Z","level":"info","quota":{"bob.keys@corp-mail.com":5,"203.0.113.77":1}}', values: ['bob.keys@corp-mail.com', '203.0.113.77'] },
  { line: '{"time":"2026-01-15T10:00:05Z","level":"info","msg":"x\\\\\\"y password=\\"bs4455zz\\" \\u0041"}', values: ['bs4455zz'] },
  { line: '{"time":"2026-01-15T10:00:07Z","level":"info","args":["--password","ar2233nn","--token=ar4455oo"]}', values: ['ar2233nn', 'ar4455oo'] },
  { line: '{"time":"2026-01-15T10:00:08Z","level":"info","pass\\u0077ord":"es8899pp","to\\u006ben":"es1100qq"}', values: ['es8899pp', 'es1100qq'] },
  { line: '{"time":"2026-01-15T10:00:06Z","level":"info","note":"mail \\u0062ob\\u0040corp-mail.com and ip 203.0.113.\\u0037\\u0038"}', values: ['bob@corp-mail.com', '203.0.113.78'] }
];
for (const profileId of ['jsonl', 'regex', 'logfmt']) {
  const profile = PROFILES.find((p) => p.id === profileId);
  test('re-check reproductions with JSON escapes, quoted passwords and addresses as keys: nothing in clear in any format (' + profileId + ' profile)', async () => {
    const outputs = await runExports(profile, JSON_REPRO.map((r) => r.line), 'json-' + profileId);
    assertNoneIn(outputs, [].concat(...JSON_REPRO.map((r) => r.values)), profileId);
  });
}

test('short and spaced secrets: a value of one to three characters and a quoted value with spaces are replaced whole', () => {
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 2) });
  for (const [input, keep] of [['pwd=abc next', 'next'], ['pass=x next', 'next'], ['PW=12 next', 'next'], ['token=q next', 'next'], ['password="correct horse battery" tail', 'tail'], ["pin='1 2' tail", 'tail']]) {
    const out = an.apply(input);
    assert.match(out, /\[secret-[0-9a-f]{8}\]/, input + ' -> ' + out);
    assert.ok(out.endsWith(keep), input + ' -> ' + out);
    assert.doesNotMatch(out, /abc|horse|battery|=x |=12|=q/, input + ' -> ' + out);
  }
  assert.equal(an.apply('Authorization: Token tkn55aa66bb'), an.apply('Authorization: Token tkn55aa66bb'));
  assert.match(an.apply('Authorization: Token tkn55aa66bb'), /^Authorization: \[secret-[0-9a-f]{8}\]$/, 'the scheme word is replaced with the credential, never alone');
  assert.match(an.apply('Authorization: Bearer abc'), /^Authorization: \[secret-[0-9a-f]{8}\]$/);
  // an open quote is replaced up to the end of the line
  assert.match(an.apply('password="never closed and more'), /^password="\[secret-[0-9a-f]{8}\]$/);
});

test('what is not a secret key stays as it is (author, authority, passenger, bypass, compass, status, key counts)', () => {
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 2) });
  const keep = 'author=Ann authority=main passenger=3 bypass=on compass=north status=200 path=/api/items/5 keys=5 sort_key=name monkey=1 took=12ms level=info';
  assert.equal(an.apply(keep), keep);
  assert.ok(A.isSecretKey('db_password') && A.isSecretKey('DB_PASSWORD') && A.isSecretKey('MYSQL_ROOT_PASSWORD') && A.isSecretKey('userPassword') && A.isSecretKey('authToken'));
  assert.ok(A.isSecretKey('apiSecret') && A.isSecretKey('refresh_token') && A.isSecretKey('id_token') && A.isSecretKey('pass') && A.isSecretKey('passphrase') && A.isSecretKey('pwd'));
  assert.ok(A.isSecretKey('client_secret') && A.isSecretKey('private_key') && A.isSecretKey('X-Api-Key') && A.isSecretKey('apikey') && A.isSecretKey('Set-Cookie') && A.isSecretKey('PASSWORD123'));
  assert.ok(!A.isSecretKey('author') && !A.isSecretKey('status') && !A.isSecretKey('sort_key') && !A.isSecretKey('bypass') && !A.isSecretKey('passenger'));
  assert.deepEqual(A.nameWords('MYSQL_ROOT_PASSWORD'), ['mysql', 'root', 'password']);
  assert.deepEqual(A.nameWords('userPassword2'), ['user', 'password', '2']);
  assert.deepEqual(A.nameWords('X-Api-Key'), ['x', 'api', 'key']);
});

test('an address used as a JSON key is replaced in the header and in the keys of the fields too, and the counts are not doubled', async () => {
  const lines = ['{"time":"2026-01-15T10:00:00Z","quota":{"bob.keys@corp-mail.com":5,"203.0.113.77":1}}', '{"time":"2026-01-15T10:00:01Z","quota":{"bob.keys@corp-mail.com":7}}'];
  const p = path.join(dir, 'keys.log');
  G.writeLines(p, lines);
  const f = new LogFile(p, { chunkBytes: 1 << 16 });
  await f.open(); await f.scan(); opened.push(f);
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 8) });
  const csv = path.join(dir, 'keys.csv');
  await X.exportLines(new FileSource(f), { outPath: csv, format: 'csv', pred: () => true, profile: P.createProfile('jsonl'), transform: an.apply, fieldRule: an.fieldRule });
  const text = fs.readFileSync(csv, 'utf8');
  assert.ok(!text.includes('bob.keys@corp-mail.com') && !text.includes('203.0.113.77'), text);
  const header = text.split('\r\n')[0];
  assert.match(header, /^line,time,level,time,quota\.user-[0-9a-f]{12}@example\.invalid,quota\.10\.\d+\.\d+\.\d+,text$|quota\.user-[0-9a-f]{12}@example\.invalid/);
  assert.equal(an.counts().email, 2, 'one e-mail address in each of the two lines; finding the column names counts nothing');
  assert.equal(an.counts().ipv4, 1);
});

// ---- 2: the built corpus ----------------------------------------------------------------------------------

const BASE_WORDS = ['password', 'passwd', 'pass', 'passphrase', 'pwd', 'pw', 'secret', 'token', 'api_key', 'apikey', 'api-key', 'access_token', 'refresh_token', 'id_token', 'auth_token',
  'client_secret', 'private_key', 'secret_key', 'session', 'session_id', 'sid', 'cookie', 'authorization', 'credential', 'credentials', 'cvv', 'otp', 'pin', 'jwt', 'signature',
  'csrf_token', 'encryption_key', 'ssh_key', 'bearer_token'];
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
function spellings(word) {
  const parts = word.split(/[_-]/);
  const camel = parts.map((p, i) => (i === 0 ? p : cap(p))).join('');
  const pascal = parts.map(cap).join('');
  return [word, word.toUpperCase(), 'user' + pascal, camel, pascal, 'db_' + word.replace(/-/g, '_'), 'DB_' + word.toUpperCase().replace(/-/g, '_'), 'MYSQL_ROOT_' + word.toUpperCase().replace(/-/g, '_'),
    word + '_value', word + '2', 'app.' + word, 'x-' + word.replace(/_/g, '-')];
}
const LETTERS = 'ghijklmnopqrstuvwxyz';
const enc = (i) => LETTERS[i % 20] + LETTERS[Math.floor(i / 20) % 20] + (Math.floor(i / 400) % 10) + LETTERS[Math.floor(i / 4000) % 20];

function hostileLines() {
  const entries = []; // { message, values }
  let i = 0;
  for (const word of BASE_WORDS) {
    for (const key of spellings(word)) {
      for (let kind = 0; kind < 3; kind++) {
        const e = enc(i);
        const value = kind === 0 ? 'Zq' + e + 'kw' : kind === 1 ? LETTERS[i % 20] + (i % 10) + LETTERS[(i * 7) % 20] : 'Qv' + e + ' correct horse battery';
        const form = kind === 2 ? 2 : (i + kind) % 4;
        const message = form === 0 ? key + '=' + value : form === 1 ? key + ': ' + value : form === 2 ? key + '="' + value + '"' : '"' + key + '":"' + value + '"';
        // a value of two or three characters cannot be searched for as text in the output (it would match anything), so it is checked through its unique neighbour
        entries.push({ message: message + ' tail' + e, values: kind === 1 ? [] : [value], short: kind === 1 ? { key: key, value: value, form: form } : null });
        i++;
      }
    }
  }
  return entries;
}
const HOSTILE = hostileLines();

test('the built corpus is large and its values are unique', () => {
  assert.ok(HOSTILE.length >= 1000, 'built ' + HOSTILE.length + ' lines');
  const all = [].concat(...HOSTILE.map((h) => h.values));
  assert.equal(new Set(all).size, all.length);
  assert.ok(new Set(HOSTILE.map((h) => h.message.split(/[=:"]/).filter(Boolean)[0])).size >= 300, 'several hundred spellings of keys');
});

for (const profile of PROFILES) {
  test('built corpus: ' + HOSTILE.length + ' secret spellings with unique values, all 4 formats, ' + profile.id + ' profile: no original value anywhere', async () => {
    const extra = [];
    if (profile.id === 'jsonl') {
      // JSON-native shapes: a top-level key, a nested key and a number
      HOSTILE.filter((h, k) => k % 3 === 0 && h.values.length).slice(0, 200).forEach((h, k) => {
        const key = h.message.replace(/^"/, '').split(/["=:]/)[0];
        const v = h.values[0];
        extra.push({ line: '{"time":"2026-01-15T10:00:00Z","level":"info",' + JSON.stringify(key) + ':' + JSON.stringify(v) + '}', values: [v] });
        extra.push({ line: '{"time":"2026-01-15T10:00:00Z","level":"info","client":{"inner":{' + JSON.stringify(key) + ':' + JSON.stringify(v) + '}}}', values: [v] });
        extra.push({ line: '{"time":"2026-01-15T10:00:00Z","level":"info",' + JSON.stringify(key) + ':' + (9000000 + k) + '}', values: [String(9000000 + k)] });
      });
    }
    const lines = HOSTILE.map((h) => wrap(profile.id, h.message)).concat(extra.map((x) => x.line));
    const values = [].concat(...HOSTILE.map((h) => h.values), ...extra.map((x) => x.values));
    const outputs = await runExports(profile, lines, 'gen-' + profile.id);
    assertNoneIn(outputs, values, profile.id);
    // the short values (one letter, a digit and a letter) sit right behind their key: no "key=<value> tail" is left in the text
    for (const h of HOSTILE.filter((x) => x.short)) {
      const { key, value, form } = h.short;
      const left = form === 0 ? key + '=' + value + ' tail' : form === 1 ? key + ': ' + value + ' tail' : form === 2 ? key + '="' + value + '" tail' : '"' + key + '":"' + value + '" tail';
      const shown = profile.id === 'jsonl' ? JSON.stringify(left).slice(1, -1) : left;
      assert.ok(!outputs.text.includes(shown), 'short value left in the text: ' + left);
    }
  });
}

test('a field decoded from an escape shows the same replacement as the text column (nothing is replaced twice)', async () => {
  const BS = String.fromCharCode(92);
  const line = '{"time":"2026-01-15T10:00:02Z","level":"info","msg":"retry with password=' + BS + '"Tr0ub4dor' + BS + '" for mail alice' + BS + 'u0040corp-mail.com"}';
  const p = path.join(dir, 'agree-escape.log');
  G.writeLines(p, [line]);
  const f = new LogFile(p, { chunkBytes: 1 << 16 });
  await f.open(); await f.scan(); opened.push(f);
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 5) });
  const out = path.join(dir, 'agree-escape.jsonl');
  await X.exportLines(new FileSource(f), { outPath: out, format: 'jsonl', pred: () => true, profile: P.createProfile('jsonl'), transform: an.apply, fieldRule: an.fieldRule });
  const obj = JSON.parse(fs.readFileSync(out, 'utf8').trim());
  const token = /\[secret-[0-9a-f]{8}\]/.exec(obj.fields.msg)[0];
  const email = /user-[0-9a-f]{12}@example\.invalid/.exec(obj.fields.msg)[0];
  assert.ok(obj.text.includes(token) && obj.text.includes(email), 'the same replacements in the text: ' + obj.text);
  assert.equal(obj.fields.msg, 'retry with password="' + token + '" for mail ' + email);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /Tr0ub4dor|corp-mail/);
});
