'use strict';
// Regression tests for the anonymised export: no secret in the field columns of any format, no two
// values with one replacement, honest counts, source tags, rules that are too costly, and no
// source of randomness that is not cryptographic.
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

const dir = G.tmpDir('anon-');
const opened = [];
test.after(async () => { for (const f of opened) await f.close(); G.rmDir(dir); });

async function open(name, lines) {
  const p = path.join(dir, name);
  G.writeLines(p, lines);
  const f = new LogFile(p, { chunkBytes: 4096, stepLines: 4, stepBytes: 500 });
  await f.open();
  await f.scan();
  opened.push(f);
  return new FileSource(f);
}

const KEY = Buffer.alloc(32, 11);

// ---- defect 1: secrets in the field columns -------------------------------------------------------

const LOGFMT_LINES = [
  '2026-01-15T10:00:00Z level=info user=demo password=hunter2xyz token=abcd1234efgh msg="login ok"',
  '2026-01-15T10:00:02Z level=warn user=ann api_key=k-998877 session=sess-4455667788 msg="retry"'
];
const JSONL_LINES = [
  '{"time":"2026-01-15T10:00:01Z","level":"info","password":"s3cretpass","api_key":"k-998877","note":"Bearer abcdefghijkl"}',
  '{"time":"2026-01-15T10:00:03Z","level":"error","user":{"email":"ann.lee@example.org","token":"tok-123456789"},"ip":"192.0.2.77"}'
];
const PLANTED = ['hunter2xyz', 'abcd1234efgh', 's3cretpass', 'k-998877', 'abcdefghijkl', 'sess-4455667788', 'tok-123456789', 'ann.lee@example.org', '192.0.2.77'];

for (const [profileId, lines] of [['logfmt', LOGFMT_LINES], ['jsonl', JSONL_LINES]]) {
  for (const format of ['csv', 'json', 'jsonl', 'text']) {
    test('anonymised ' + format + ' export with the ' + profileId + ' profile holds no planted secret anywhere, fields included', async () => {
      const src = await open('leak-' + profileId + '-' + format + '.log', lines);
      const an = A.createAnonymiser({ key: KEY });
      const out = path.join(dir, 'leak-' + profileId + '.' + format);
      const r = await X.exportLines(src, { outPath: out, format: format, pred: () => true, profile: P.createProfile(profileId), timeFormat: 'iso', transform: an.apply, fieldRule: an.fieldRule });
      assert.equal(r.written, 2);
      const text = fs.readFileSync(out, 'utf8');
      for (const secret of PLANTED) assert.ok(!text.includes(secret), secret + ' is in the ' + format + ' export:\n' + text);
      if (format === 'csv' && profileId === 'logfmt') {
        const row = text.split('\r\n')[1];
        assert.match(row, /\[secret-[0-9a-f]{8}\]/, 'the password and token cells hold replacements: ' + row);
      }
    });
  }
}

test('a field whose name says "secret" is replaced in full even when the text rules left it alone', async () => {
  // "abc" has only three characters: the pattern for key=value pairs asks for four, so the text keeps it.
  const src = await open('shortsecret.log', ['{"user":"demo","password":"abc","pwd":"xy","count":3}']);
  const an = A.createAnonymiser({ key: KEY });
  const out = path.join(dir, 'shortsecret.jsonl');
  await X.exportLines(src, { outPath: out, format: 'jsonl', pred: () => true, profile: P.createProfile('jsonl'), transform: an.apply, fieldRule: an.fieldRule });
  const obj = JSON.parse(fs.readFileSync(out, 'utf8').trim());
  assert.match(obj.fields.password, /^\[secret-[0-9a-f]{8}\]$/);
  assert.match(obj.fields.pwd, /^\[secret-[0-9a-f]{8}\]$/);
  assert.equal(obj.fields.user, 'demo');
  assert.equal(obj.fields.count, '3');
});

test('the field values and the text of an anonymised row agree: the same replacement in both', async () => {
  const src = await open('agree.log', ['2026-01-15T10:00:00Z level=info client=203.0.113.9 owner=ann@example.org password=hunter2xyz']);
  const an = A.createAnonymiser({ key: KEY });
  const out = path.join(dir, 'agree.jsonl');
  await X.exportLines(src, { outPath: out, format: 'jsonl', pred: () => true, profile: P.createProfile('logfmt'), transform: an.apply, fieldRule: an.fieldRule });
  const obj = JSON.parse(fs.readFileSync(out, 'utf8').trim());
  for (const name of ['client', 'owner', 'password']) assert.ok(obj.text.includes(obj.fields[name]), name + ': ' + obj.fields[name] + ' in ' + obj.text);
});

test('without a transform nothing changes: the fields are the original values', async () => {
  const src = await open('plain.log', LOGFMT_LINES);
  const out = path.join(dir, 'plain.jsonl');
  await X.exportLines(src, { outPath: out, format: 'jsonl', pred: () => true, profile: P.createProfile('logfmt') });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8').split('\n')[0]).fields.password, 'hunter2xyz');
});

test('the source tag of a merged view goes through the transform', async () => {
  const recs = [{ no: 0, offset: 0, text: 'hello ann@example.org', byteLength: 20, capped: false, tag: 'ann@example.org.log' }];
  const fake = { kind: 'merge', lineCount: 1, complete: true, forEachText: async (start, cb) => { for (const r of recs) if (cb(r) === false) break; return { aborted: false, longLines: 0 }; } };
  const an = A.createAnonymiser({ key: KEY });
  const out = path.join(dir, 'tag.csv');
  await X.exportLines(fake, { outPath: out, format: 'csv', pred: () => true, transform: an.apply });
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(!text.includes('ann@example.org'), text);
  assert.match(text.split('\r\n')[1], /^1,,,user-[0-9a-f]{12}@example\.invalid,hello user-[0-9a-f]{12}@example\.invalid$/);
});

// ---- defect 9: counts ---------------------------------------------------------------------------

test('the counts of an anonymised export with a profile count each replaced value once', async () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push('{"user":"u' + i + '@example.org","ip":"10.9.8.' + i + '","msg":"hello u' + i + '@example.org from 10.9.8.' + i + '"}');
  const src = await open('counts.log', lines);
  const an = A.createAnonymiser({ key: KEY });
  await X.exportLines(src, { outPath: path.join(dir, 'counts.csv'), format: 'csv', pred: () => true, profile: P.createProfile('jsonl'), transform: an.apply, fieldRule: an.fieldRule });
  // Per line the text holds the address and the e-mail address twice (in the field values and in the message).
  assert.equal(an.counts().email, 100);
  assert.equal(an.counts().ipv4, 100);
  const plain = A.createAnonymiser({ key: KEY });
  for (const l of lines) plain.apply(l);
  assert.deepEqual(an.counts(), plain.counts(), 'the export counts what a plain pass over the text counts, nothing twice');
});

// ---- defect 3: replacements never collide -----------------------------------------------------------

function dotted(i) { const n = Math.imul(i + 1, 2654435761) >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }

test('200,000 distinct IPv4 addresses get 200,000 distinct replacements (the 24-bit space collides without handling)', () => {
  const an = A.createAnonymiser({ key: KEY });
  const seen = new Map();
  const inputs = new Set();
  for (let i = 0; i < 200000; i++) {
    const ip = dotted(i);
    if (inputs.has(ip) || ip === '0.0.0.0') continue;
    inputs.add(ip);
    const out = an.apply('from ' + ip + ' ok');
    const m = /from (10\.\d+\.\d+\.\d+) ok/.exec(out);
    assert.ok(m, out);
    assert.ok(!seen.has(m[1]), 'collision: ' + ip + ' and ' + seen.get(m[1]) + ' both became ' + m[1]);
    seen.set(m[1], ip);
  }
  assert.ok(inputs.size >= 199990);
  assert.equal(seen.size, inputs.size);
  assert.ok(an.collisions() > 100, 'the 24-bit space did collide ' + an.collisions() + ' times and every one was resolved');
  // the same address, again: the same replacement as before
  const again = an.apply('from ' + dotted(77) + ' ok');
  assert.equal(seen.get(/from (10\.\d+\.\d+\.\d+) ok/.exec(again)[1]), dotted(77));
});

test('Luhn-valid card numbers and session ids never share a replacement', () => {
  const an = A.createAnonymiser({ key: KEY });
  const cards = new Set();
  const out = new Set();
  for (let i = 0; cards.size < 30000; i++) {
    const body = '4' + String(100000000000 + i * 7).slice(0, 14).padStart(14, '0');
    let sum = 0;
    for (let k = 0; k < body.length; k++) { let d = body.charCodeAt(body.length - 1 - k) - 48; if (k % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    const card = body + ((10 - (sum % 10)) % 10);
    if (cards.has(card)) continue;
    cards.add(card);
    const r = an.apply('card ' + card + ' end');
    assert.match(r, /^card \[card-[0-9a-f]{8}\] end$/);
    out.add(r);
  }
  assert.equal(out.size, 30000);
  const secrets = new Set();
  for (let i = 0; i < 100000; i++) secrets.add(an.apply('session=sid' + i + 'abcdef'));
  assert.equal(secrets.size, 100000);
});

test('a collision is resolved by the next candidate, the same value always gets the same answer, and the cap stops with a message', () => {
  // A one-byte space for IPv4 cannot be forced, so the same effect is made with many values and a
  // check that every replacement has exactly one owner.
  const an = A.createAnonymiser({ key: Buffer.alloc(32, 3) });
  const byRepl = new Map();
  for (let i = 0; i < 60000; i++) {
    const ip = dotted(i + 5);
    const r = /(10\.\d+\.\d+\.\d+)/.exec(an.apply(ip))[1];
    if (byRepl.has(r)) assert.equal(byRepl.get(r), ip, 'two values share ' + r);
    byRepl.set(r, ip);
  }
  assert.equal(byRepl.size, 60000);
  assert.equal(an.size(), 60000);
  const small = A.createAnonymiser({ key: KEY, maxValues: 50 });
  for (let i = 0; i < 50; i++) small.apply('u' + i + '@example.org');
  assert.equal(small.apply('u7@example.org') !== undefined, true, 'a value that is already held still works');
  assert.throws(() => small.apply('another@example.org'), (e) => e.name === 'AnonymiseError' && e.code === 'too-many-values' && /more than 50 different/.test(e.message));
});

test('the keyed hash is HMAC-SHA256: identical to the runtime\'s own HMAC for short, block-sized and long keys and texts', () => {
  const crypto = require('node:crypto');
  const rnd = G.rng(99);
  for (const keyLen of [1, 32, 64, 65, 200]) {
    const key = crypto.randomBytes(keyLen);
    const mac = A.hmacSha256(key);
    for (let i = 0; i < 40; i++) {
      let text = '';
      const n = Math.floor(rnd() * 300);
      for (let k = 0; k < n; k++) text += String.fromCharCode(1 + Math.floor(rnd() * 3000));
      assert.equal(mac(text).toString('hex'), crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex'));
    }
  }
});

test('the key is random for every run and no weak source of randomness is used anywhere in the sources', () => {
  const a = A.createAnonymiser().apply('who@example.org');
  const b = A.createAnonymiser().apply('who@example.org');
  assert.notEqual(a, b);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(__dirname, '..', 'src')).filter((x) => x.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /Math\.random/, f);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'pro', 'anonymise.js'), 'utf8'), /crypto\.randomBytes\(32\)/);
});

// ---- rule files that are too costly or match very often ---------------------------------------------------

test('a rule that matches thousands of times in one line replaces every match, not the first 500', () => {
  const parsed = A.parseRuleFile(JSON.stringify([{ name: 'tag', pattern: 'CUST-[0-9]{4}', replace: 'hash' }]));
  assert.equal(parsed.errors.length, 0);
  const an = A.createAnonymiser({ key: KEY, rules: parsed.rules, builtins: [] });
  let line = '';
  for (let i = 0; i < 2000; i++) line += 'CUST-' + String(1000 + i) + ' ';
  const out = an.apply(line);
  assert.doesNotMatch(out, /CUST-/);
  assert.equal(an.counts()['rule-1'], 2000);
});

test('a rule that needs too much work stops the copy with its name; no incomplete file is left behind', async () => {
  const parsed = A.parseRuleFile(JSON.stringify([{ name: 'greedy', pattern: 'a.*b|a', replace: 'mask' }]));
  const an = A.createAnonymiser({ key: KEY, rules: parsed.rules, builtins: [] });
  const t0 = Date.now();
  assert.throws(() => an.apply('a'.repeat(300000)), (e) => e.name === 'AnonymiseError' && e.code === 'budget' && /greedy/.test(e.message));
  assert.ok(Date.now() - t0 < 2000, 'refused in ' + (Date.now() - t0) + ' ms');
  const src = await open('costly.log', ['fine line', 'a'.repeat(300000), 'another fine line']);
  const out = path.join(dir, 'costly.log.out');
  await assert.rejects(() => X.exportLines(src, { outPath: out, format: 'text', pred: () => true, transform: an.apply }), (e) => e.name === 'AnonymiseError');
  assert.equal(fs.existsSync(out), false, 'the incomplete file was removed');
});

test('anonymising 5,000 lines with built-in rules stays fast (cheap checks skip the patterns that cannot match)', () => {
  const an = A.createAnonymiser({ key: KEY });
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push('2026-01-15T10:00:00Z INFO request ' + i + ' handled in ' + (i % 90) + 'ms status=200 path=/api/items/' + i);
  const t0 = Date.now();
  for (const l of lines) an.apply(l);
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
});
