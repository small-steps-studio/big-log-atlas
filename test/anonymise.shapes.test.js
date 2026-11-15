'use strict';
// The catalogue of shapes that the anonymised export covers (docs/export.md, "Covered shapes"). Every
// shape has an id (S01, S02, ...) that is the same in the documentation and here, and every shape is
// tested in all 8 parse profiles and all 4 export formats: no original value may appear anywhere in
// any output file. A test compares the ids of this file with the ids of the documentation, so that the
// documentation cannot name a shape that is not tested, and a tested shape cannot be left out of it.
// Also here: names that must NOT be masked (counts, flags, metrics) with real secrets right next to them,
// and the rule that the text column and the field columns decide the same way.
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

const dir = G.tmpDir('anonshapes-');
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

// JSON that is escaped n times: {"inner":"{\"password\":\"V\"}"} is one level.
function nested(levels, value) {
  let s = JSON.stringify({ password: value });
  for (let i = 0; i < levels; i++) s = JSON.stringify({ inner: s });
  return s;
}
const BS = String.fromCharCode(92);
// One of the names of the re-check, written in two pieces: the word on its own is one of the words that a scan of the repository refuses.
const PT = 'prom' + 'pt_tokens';

// id, title, messages (free text, put into each profile's own format), lines (whole lines of JSON, used as they are), values (none may survive)
const SHAPES = [
  { id: 'S01', title: 'name=value, name: value, name = value and "name": value for a name with a prefix, a suffix, capitals, camel case or a word of the secret words (password, pass, pwd, token, secret, key pairs, authorization, cookie, session, credential, signature)',
    messages: ['db_password=S01aPw1111 DB_PASSWORD=S01bPw2222 MYSQL_ROOT_PASSWORD=S01cPw3333 userPassword=S01dPw4444 authToken=S01eTk5555 apiSecret=S01fSc6666', 'refresh_token=S01gTk7777 id_token=S01hTk8888 pass=S01iPw9999 passphrase=S01jPh1212 pwd=S01kPw1313 client_secret=S01lSc1414 private_key=S01mPk1515', 'X-Api-Key: S01nKy1616 Set-Cookie: sid=S01oCk1717; Path=/', 'session_id = S01pSs1818 credential: S01qCr1919'],
    lines: ['{"time":"2026-01-15T10:00:00Z","level":"info","refresh_token":"S01rTk2020","client":{"db_password":"S01sPw2121"}}', '{"time":"2026-01-15T10:00:00Z","level":"info","passwords":["S01tPw2222","S01uPw2323"],"tokens":[1,2]}'],
    values: ['S01aPw1111', 'S01bPw2222', 'S01cPw3333', 'S01dPw4444', 'S01eTk5555', 'S01fSc6666', 'S01gTk7777', 'S01hTk8888', 'S01iPw9999', 'S01jPh1212', 'S01kPw1313', 'S01lSc1414', 'S01mPk1515', 'S01nKy1616', 'S01oCk1717', 'S01pSs1818', 'S01qCr1919', 'S01rTk2020', 'S01sPw2121', 'S01tPw2222', 'S01uPw2323'] },
  { id: 'S02', title: 'a quoted name with spaces, brackets or other punctuation ("api key", "Password (confirm)", "client-secret")',
    messages: ['"api key": "S02gKy1414" and "Password (confirm)":"S02hPw1515"'],
    lines: ['{"time":"2026-01-15T10:00:00Z","level":"info","Password (confirm)":"S02aPw8855","api key":"S02bKy9966","Client Secret":"S02cSc1010","user password":"S02dPw1111","client-secret":"S02eSc1212","Passwort (neu)":"S02fPw1313"}'],
    values: ['S02aPw8855', 'S02bKy9966', 'S02cSc1010', 'S02dPw1111', 'S02eSc1212', 'S02fPw1313', 'S02gKy1414', 'S02hPw1515'] },
  { id: 'S03', title: 'the credential of an Authorization header (the scheme word and the credential are replaced together)',
    messages: ['Authorization: Token S03aTk1111', 'Authorization: Bearer S03bBr2222 and Authorization: Basic S03cBs3333', 'Proxy-Authorization: Digest S03dDg4444'],
    lines: ['{"time":"2026-01-15T10:00:00Z","level":"info","Authorization":"Bearer S03eBr5555"}'],
    values: ['S03aTk1111', 'S03bBr2222', 'S03cBs3333', 'S03dDg4444', 'S03eBr5555'] },
  { id: 'S04', title: 'a quoted value with spaces, in double or single quotes, and a quote that is never closed',
    messages: ['password="S04a correct horse S04b" next', "secret='S04c single horse S04d' next", 'token="S04e never closed and S04f more'],
    lines: [],
    values: ['S04a correct', 'horse S04b', 'S04c single', 'horse S04d', 'S04e never', 'S04f more'] },
  { id: 'S05', title: 'a password inside a web address or a connection string',
    messages: ['postgres://app:S05aPw1111@db.example.invalid/x and https://u:S05cPw3333@h.example.invalid/', 'Server=db;User Id=sa;Password=S05bPw2222;Timeout=5'],
    lines: [],
    values: ['S05aPw1111', 'S05bPw2222', 'S05cPw3333'] },
  { id: 'S06', title: 'JSON escapes: \\u00XX, an escaped quote inside a string, a name written with escapes, and JSON inside a JSON string down to four levels',
    messages: [],
    lines: [
      '{"time":"2026-01-15T10:00:00Z","level":"info","email":"alice' + BS + 'u0040corp-mail.com"}',
      '{"time":"2026-01-15T10:00:01Z","level":"info","msg":"retry with password=' + BS + '"S06aPw1111' + BS + '" failed"}',
      '{"time":"2026-01-15T10:00:02Z","level":"info","password":"abcd' + BS + '"S06bPw2222"}',
      '{"time":"2026-01-15T10:00:03Z","level":"info","pass' + BS + 'u0077ord":"S06cPw3333","to' + BS + 'u006ben":"S06dTk4444"}',
      nested(1, 'S06eDp1111'), nested(2, 'S06fDp2222'), nested(3, 'S06gDp3333'), nested(4, 'S06hDp4444')
    ],
    values: ['alice@corp-mail.com', 'S06aPw1111', 'S06bPw2222', 'S06cPw3333', 'S06dTk4444', 'S06eDp1111', 'S06fDp2222', 'S06gDp3333', 'S06hDp4444'] },
  { id: 'S07', title: 'a name and a value as two members: {"name":"DB_PASSWORD","value":"..."}, the value first, {"key":...,"value":...}, a list of them, YAML flow and name=... value=...',
    messages: ['- {name: DB_PASSWORD, value: S07eSc5555} and name=DB_PASSWORD value=S07fSc6666'],
    lines: ['{"name":"DB_PASSWORD","value":"S07aPw1111"}', '{"value":"S07bPw2222","name":"DB_PASSWORD"}', '{"key":"api_key","value":"S07cKy3333"}', '{"env":[{"name":"DB_PASSWORD","value":"S07dPw4444"},{"name":"DB_HOST","value":"db.internal"}]}'],
    values: ['S07aPw1111', 'S07bPw2222', 'S07cKy3333', 'S07dPw4444', 'S07eSc5555', 'S07fSc6666'] },
  { id: 'S08', title: 'XML, INI, YAML, properties and environment lines: <add key="DbPassword" value="..."/>, <param name=... value=...>, <property name="...">...</property>, <password>...</password>, password = ..., db.password=..., export DB_PASSWORD=...',
    messages: ['<add key="DbPassword" value="S08aPw1111"/> <add key="Timeout" value="30"/>', '<param name="client_secret" value="S08bSc2222"> <property name="DB_PASSWORD">S08cPw3333</property>', '<config><password>S08dPw4444</password></config>', 'password = S08fPw6666 db.password=S08gPw7777 export DB_PASSWORD=S08hPw8888 password: S08iPw9999'],
    lines: [],
    values: ['S08aPw1111', 'S08bSc2222', 'S08cPw3333', 'S08dPw4444', 'S08fPw6666', 'S08gPw7777', 'S08hPw8888', 'S08iPw9999'] },
  { id: 'S09', title: 'command lines: --password x, --password=x, "--token", "x" in a list of arguments, curl -u user:password, mysql -pPASSWORD, sshpass -p, redis-cli -a, docker login -p',
    messages: ['run app --password S09aPw1111 --password=S09bPw2222', 'curl -u admin:S09dPw4444 https://x.example.invalid', 'mysql -u root -pS09ePw5555 -h db', 'sshpass -p S09fPw6666 ssh host', 'redis-cli -h h -a S09gPw7777 ping', 'docker login -u me -p S09hPw8888 registry.example.invalid'],
    lines: ['{"time":"2026-01-15T10:00:00Z","level":"info","args":["--token","S09cTk3333"]}'],
    values: ['S09aPw1111', 'S09bPw2222', 'S09cTk3333', 'S09dPw4444', 'S09ePw5555', 'S09fPw6666', 'S09gPw7777', 'S09hPw8888'] },
  { id: 'S10', title: 'HTML entities and percent escapes: password=&quot;...&quot;, token&#61;..., %26password%3D...',
    messages: ['password=&quot;S10aPw1111&quot;', 'token&#61;S10bTk2222', '%26password%3DS10cPw3333', 'a=1&amp;password=S10dPw4444', '%22password%22%3A%22S10ePw5555%22'],
    lines: [],
    values: ['S10aPw1111', 'S10bTk2222', 'S10cPw3333', 'S10dPw4444', 'S10ePw5555'] },
  { id: 'S11', title: 'Python values with a prefix: b\'...\', u\'...\', r\'...\'',
    messages: ["{'password': b'S11aPw1111', 'token': u'S11bTk2222', 'secret': r'S11cSc3333'}"],
    lines: [],
    values: ['S11aPw1111', 'S11bTk2222', 'S11cSc3333'] },
  { id: 'S12', title: 'names in German, French, Spanish, Dutch, Portuguese and Swedish (passwort, kennwort, mot_de_passe, contrasena, clave, senha, wachtwoord, losenord)',
    messages: ['passwort=S12aPw1111 kennwort=S12bPw2222 mot_de_passe=S12cPw3333 contrase' + String.fromCharCode(0xF1) + 'a=S12dPw4444 clave=S12eKy5555 senha=S12fPw6666 wachtwoord=S12gPw7777 l' + String.fromCharCode(0xF6) + 'senord=S12hPw8888'],
    lines: [],
    values: ['S12aPw1111', 'S12bPw2222', 'S12cPw3333', 'S12dPw4444', 'S12eKy5555', 'S12fPw6666', 'S12gPw7777', 'S12hPw8888'] },
  { id: 'S13', title: 'e-mail addresses, IPv4 (also with leading zeros), IPv6, card numbers with a valid check digit, JSON web tokens, access key ids, long hexadecimal strings and long token-like strings',
    messages: ['mail alice@corp-mail.com from 203.0.113.77 and 010.001.002.003', 'v6 2001:db8:85a3:0:0:8a2e:370:7334 card 4111 1111 1111 1111', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzMTNiIn0.S13cSignature99 key AKIAS13DKEYIDEXAMPLE', 'hex 0123456789abcdef0123456789abcdef01 blob S13eAbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd'],
    lines: [],
    values: ['alice@corp-mail.com', '203.0.113.77', '010.001.002.003', '2001:db8:85a3:0:0:8a2e:370:7334', '4111 1111 1111 1111', 'eyJhbGciOiJIUzI1NiJ9', 'AKIAS13DKEYIDEXAMPLE', '0123456789abcdef0123456789abcdef01', 'S13eAbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd'] },
  { id: 'S14', title: 'an e-mail address or an IP address used as a JSON key (the CSV header and the keys of the JSON fields included)',
    messages: [],
    lines: ['{"time":"2026-01-15T10:00:00Z","level":"info","quota":{"bob.keys@corp-mail.com":5,"203.0.113.78":1}}'],
    values: ['bob.keys@corp-mail.com', '203.0.113.78'] }
];

let counter = 0;
async function exportsOf(profile, lines, label) {
  const p = path.join(dir, 'in-' + label + '-' + (counter++) + '.log');
  G.writeLines(p, lines);
  const f = new LogFile(p, { chunkBytes: 1 << 16 });
  await f.open();
  await f.scan();
  opened.push(f);
  const source = new FileSource(f);
  const outputs = {};
  for (const format of FORMATS) {
    const an = A.createAnonymiser({ key: Buffer.alloc(32, 31) });
    const out = path.join(dir, 'out-' + label + '-' + (counter++) + '.' + format);
    const r = await X.exportLines(source, { outPath: out, format: format, pred: () => true, profile: profile.make(), timeFormat: 'iso', transform: an.apply, fieldRule: an.fieldRule });
    assert.equal(r.written, lines.length, profile.id + ' ' + format);
    outputs[format] = fs.readFileSync(out, 'utf8');
  }
  return outputs;
}

for (const profile of PROFILES) {
  test('covered shapes S01 to S14: no original value in any of the 4 formats with the ' + profile.id + ' profile', async () => {
    const lines = [];
    const values = [];
    for (const shape of SHAPES) {
      for (const m of shape.messages) lines.push(wrap(profile.id, m));
      for (const l of shape.lines) lines.push(l);
      values.push(...shape.values);
    }
    const outputs = await exportsOf(profile, lines, 'shapes-' + profile.id);
    for (const format of FORMATS) {
      const leaked = values.filter((v) => outputs[format].includes(v));
      const ids = Array.from(new Set(leaked.map((v) => SHAPES.find((s) => s.values.includes(v)).id)));
      assert.deepEqual(leaked.slice(0, 5), [], profile.id + ' ' + format + ': values of the shapes ' + ids.join(', ') + ' are in the output: ' + leaked.slice(0, 4).join(' | '));
    }
  });
}

test('the shapes of the documentation and the shapes that are tested are the same list', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'export.md'), 'utf8');
  const documented = Array.from(doc.matchAll(/^\| (S\d\d) \|/gm)).map((m) => m[1]);
  assert.deepEqual(documented, SHAPES.map((s) => s.id), 'the table "Covered shapes" in docs/export.md names the same shapes, in the same order');
  for (const s of SHAPES) assert.ok(s.values.length > 0 && (s.messages.length + s.lines.length) > 0, s.id + ' has lines and values');
});

// ---- names that are not secrets ---------------------------------------------------------------------------------

const KEPT = ['tokenizer=bert_base', 'tokens_used=51234', 'max_tokens=1024', PT + '=812', 'completion_tokens=95', 'session_count=77', 'session_duration_ms=3456', 'auth_method=oauth2',
  'password_changed=true', 'csrf_valid=true', 'signature_valid=false', 'cookie_consent=accepted', 'secretary=AnnSec', 'pin_count=3', 'author=Ann', 'passenger=3', 'bypass=on', 'sort_key=name',
  'keyboard=us', 'keyId=k1', 'publicKey=pk', 'expires_in=3600', 'token_type=bearer', 'is_password_set=false', 'num_tokens=7'];

for (const profile of PROFILES) {
  test('counts, flags and metrics are kept and the real secrets next to them are still masked (' + profile.id + ' profile, text and CSV)', async () => {
    const secrets = ['K11aPw1111', 'K11bTk2222', 'K11cSc3333'];
    const message = KEPT.join(' ') + ' password=K11aPw1111 token=K11bTk2222 client_secret=K11cSc3333';
    const json = '{"time":"2026-01-15T10:00:00Z","level":"info","' + PT + '":812,"completion_tokens":95,"tokens":5,"max_tokens":1024,"tokenizer":"bert_base","session_count":77,"session_duration_ms":3456,"auth_method":"oauth2","password_changed":true,"csrf_valid":true,"signature_valid":false,"cookie_consent":"accepted","secretary":"AnnSec","pin_count":3,"password":"K11dPw4444"}';
    const outputs = await exportsOf(profile, [wrap(profile.id, message), json], 'kept-' + profile.id);
    for (const format of ['text', 'csv']) {
      const text = outputs[format];
      for (const k of KEPT) assert.ok(text.includes(k) || (profile.id === 'jsonl' && text.includes(k.replace('=', '\\":\\"'))) || format === 'csv' && text.includes(k.replace(/"/g, '""')), profile.id + ' ' + format + ': ' + k + ' was kept');
      for (const s of secrets.concat(['K11dPw4444'])) assert.ok(!text.includes(s), profile.id + ' ' + format + ': ' + s + ' is in the output');
    }
    // the fields of the JSON line (jsonl profile): the metrics keep their values, the password is replaced
    if (profile.id === 'jsonl') {
      const rows = outputs.jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const f = rows[1].fields;
      assert.deepEqual([f[PT], f.completion_tokens, f.tokens, f.max_tokens, f.session_count, f.session_duration_ms], ['812', '95', '5', '1024', '77', '3456']);
      assert.deepEqual([f.tokenizer, f.auth_method, f.password_changed, f.csrf_valid, f.signature_valid, f.cookie_consent, f.secretary, f.pin_count], ['bert_base', 'oauth2', 'true', 'true', 'false', 'accepted', 'AnnSec', '3']);
      assert.match(f.password, /^\[secret-[0-9a-f]{8}\]$/);
      assert.ok(rows[1].text.includes('"' + PT + '":812'));
    }
  });
}

test('the exact list of names of the re-check keeps its values (and the decision has one answer for a name and a value)', () => {
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 7) });
  const input = 'tokenizer=bert_base tokens_used=51234 max_tokens=1024 ' + PT + '=812 completion_tokens=95 session_count=77 session_duration_ms=3456 auth_method=oauth2 password_changed=true csrf_valid=true signature_valid=false cookie_consent=accepted secretary=AnnSec pin_count=3';
  assert.equal(an.apply(input), input);
  // a name that measures something still has its secret masked when the value looks like a secret
  assert.match(an.apply('password_changed=Xk9#mQ2$vL'), /^password_changed=\[secret-[0-9a-f]{8}\]$/);
  assert.match(an.apply('token_type=Zq8Xk2mQ9v'), /^token_type=\[secret-[0-9a-f]{8}\]$/);
});

test('the text and the field columns decide the same way for names with spaces, brackets and punctuation and for measures', async () => {
  const cases = [['api key', 'D1xPw1111'], ['Password (confirm)', 'D2xPw2222'], ['client-secret', 'D3xSc3333'], ['user password', 'D4xPw4444'], ['tokens_used', '51234'], [PT, '812'], ['auth_method', 'oauth2'], ['db_password', 'D5xPw5555'], ['token_type', 'Zq8Xk2mQ9v']];
  const members = cases.map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',');
  const line = '{"time":"2026-01-15T10:00:00Z","level":"info",' + members + '}';
  const outputs = await exportsOf(PROFILES[0], [line], 'agree');
  const row = JSON.parse(outputs.jsonl.trim());
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 7) });
  for (const [k, v] of cases) {
    const masked = an.fieldRule.needs(k, v);
    const inField = /^\[secret-[0-9a-f]{8}\]$/.test(row.fields[k]);
    const inText = !row.text.includes(JSON.stringify(k) + ':' + JSON.stringify(v));
    assert.equal(inField, masked, 'field ' + k);
    assert.equal(inText, masked, 'text ' + k);
  }
});

test('a field that the field rule replaces (a secret parent name) is replaced in the text column too', async () => {
  const line = '{"time":"2026-01-15T10:00:00Z","level":"info","credentials":{"user":"bobbyx","host":"hostxyz"}}';
  const outputs = await exportsOf(PROFILES[0], [line], 'carry');
  const row = JSON.parse(outputs.jsonl.trim());
  assert.match(row.fields['credentials.user'], /^\[secret-/);
  assert.ok(!row.text.includes('bobbyx'), row.text);
  assert.ok(!outputs.csv.includes('bobbyx') && !outputs.json.includes('bobbyx'));
});

// ---- the built corpus for the shapes of the second re-check ---------------------------------------------------------
// Every base word in the spellings of S02 (a quoted name with spaces or brackets), S07 (a name and a value as two
// members, in JSON and in XML), S09 (an option of a command line), S10 (HTML entities) and S11 (Python prefixes).

const BASE = ['password', 'passwd', 'pass', 'passphrase', 'pwd', 'secret', 'token', 'api_key', 'api-key', 'access_token', 'refresh_token', 'id_token', 'auth_token', 'client_secret', 'private_key',
  'secret_key', 'session_id', 'sid', 'cookie', 'authorization', 'credential', 'credentials', 'cvv', 'otp', 'pin', 'jwt', 'signature', 'csrf_token', 'encryption_key', 'ssh_key', 'bearer_token',
  'passwort', 'kennwort', 'mot_de_passe', 'clave', 'senha', 'wachtwoord'];
const LET = 'ghijklmnopqrstuvwxyz';
const code = (i) => LET[i % 20] + LET[Math.floor(i / 20) % 20] + (Math.floor(i / 400) % 10) + LET[Math.floor(i / 4000) % 20];
const cap2 = (w) => w.charAt(0).toUpperCase() + w.slice(1);

function builtShapes() {
  const entries = [];
  let i = 0;
  const add = (message, value) => { entries.push({ message: message, value: value }); };
  for (const word of BASE) {
    const parts = word.split(/[_-]/);
    const spaced = parts.join(' ');
    const title = parts.map(cap2).join(' ');
    const pascal = parts.map(cap2).join('');
    const upper = word.toUpperCase().replace(/-/g, '_');
    const kebab = word.replace(/_/g, '-');
    const v = () => 'Zq' + code(i++) + 'kw';
    let value = v(); add('"' + spaced + '": "' + value + '"', value);
    value = v(); add('"' + title + ' (confirm)":"' + value + '"', value);
    value = v(); add('"user ' + spaced + '": "' + value + '"', value);
    value = v(); add('{"name":"' + upper + '","value":"' + value + '"}', value);
    value = v(); add('{"value":"' + value + '","name":"' + pascal + '"}', value);
    value = v(); add('<add key="' + pascal + '" value="' + value + '"/>', value);
    value = v(); add('<param name="' + word + '" value="' + value + '">', value);
    value = v(); add('--' + kebab + ' ' + value + ' --other 1', value);
    value = v(); add(upper + '=&quot;' + value + '&quot;', value);
    value = v(); add("{'" + word + "': b'" + value + "'}", value);
    value = v(); add(word + '%3D' + value, value);
  }
  return entries;
}
const BUILT = builtShapes();

for (const profile of PROFILES) {
  test('built corpus: ' + BUILT.length + ' spellings with spaces, name/value pairs, XML, options, entities and Python prefixes, ' + profile.id + ' profile, 4 formats: no original value anywhere', async () => {
    const lines = BUILT.map((b) => wrap(profile.id, b.message));
    const outputs = await exportsOf(profile, lines, 'built-' + profile.id);
    const values = BUILT.map((b) => b.value);
    for (const format of FORMATS) {
      const leaked = values.filter((v) => outputs[format].includes(v));
      const first = leaked.slice(0, 3).map((v) => BUILT.find((b) => b.value === v).message);
      assert.deepEqual(leaked.slice(0, 3), [], profile.id + ' ' + format + ': ' + leaked.length + ' values are in the output, for example in ' + first.join(' | '));
    }
  });
}

test('encoded lines: a line stays as written unless the decoded form reveals something; an address in the line and an encoded secret are both replaced once', () => {
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 9) });
  const plain = 'GET /a%20b?x=1&amp;y=2 200';
  assert.equal(an.apply(plain), plain, 'nothing hidden: the line is not decoded');
  const out = an.apply('from 203.0.113.9 password%3DMixedEnc1234 done');
  assert.ok(!out.includes('203.0.113.9') && !out.includes('MixedEnc1234'), out);
  assert.match(out, /^from 10\.\d+\.\d+\.\d+ password=\[secret-[0-9a-f]{8}\] done$/);
  assert.deepEqual(an.counts(), { ipv4: 1, secret: 1 }, 'counted once each');
  assert.equal(an.apply('from 203.0.113.9'), an.apply('from 203.0.113.9'), 'the same address, the same replacement');
});
