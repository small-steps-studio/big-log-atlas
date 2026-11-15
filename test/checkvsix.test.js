'use strict';
// scripts/check-vsix.js must compare the package with the source folder and with package.json, byte for
// byte. These tests build a package from the product files (a plain zip, stored entries), check that it
// passes, and check that a changed file, a foreign file and a changed identity are each refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(deflated.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(deflated.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([centralBuf, end]));
}

function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir + '/' + e.name;
    return e.isDirectory() ? walk(rel) : [rel];
  });
}

function productFiles() {
  const out = [];
  for (const f of ['package.json', 'LICENSE.txt', 'TERMS.md', 'PRIVACY.md']) out.push(['extension/' + f, fs.readFileSync(path.join(ROOT, f))]);
  // the two pages that the store shows are stored under lower-case names, with their relative links made absolute
  const base = 'https://github.com/small-steps-studio/big-log-atlas/blob/HEAD/';
  out.push(['extension/readme.md', Buffer.from(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\]\((docs\/[A-Za-z-]+\.md)\)/g, '](' + base + '$1)'))]);
  out.push(['extension/changelog.md', fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'))]);
  for (const f of walk('src').filter((x) => x.endsWith('.js') && !/test-environment/.test(x))) out.push(['extension/' + f, fs.readFileSync(path.join(ROOT, f))]);
  out.push(['extension/media/icon.png', fs.readFileSync(path.join(ROOT, 'media/icon.png'))]);
  for (const f of walk('media/webview')) out.push(['extension/' + f, fs.readFileSync(path.join(ROOT, f))]);
  for (const f of walk('media/walkthrough')) out.push(['extension/' + f, fs.readFileSync(path.join(ROOT, f))]);
  return out;
}

function manifest(overrides) {
  const o = Object.assign({ id: pkg.name, publisher: pkg.publisher, version: pkg.version, name: pkg.displayName }, overrides || {});
  return Buffer.from('<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0"><Metadata><Identity Language="en-US" Id="' + o.id + '" Version="' + o.version + '" Publisher="' + o.publisher + '" /><DisplayName>' + o.name + '</DisplayName><Properties><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" /><Property Id="Microsoft.VisualStudio.Services.GalleryFlags" Value="Public" /><Property Id="Pricing" Value="Trial" /></Properties></Metadata></PackageManifest>');
}

function check(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biglogatlas-vsix-'));
  try {
    const file = path.join(dir, 'x.vsix');
    fs.writeFileSync(file, zip(files));
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-vsix.js'), file], { encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function base(extra) { return productFiles().concat([['extension.vsixmanifest', manifest(extra)], ['[Content_Types].xml', Buffer.from('<Types />')]]); }

test('check-vsix: a package made of the source files passes', () => {
  const r = check(base());
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /VSIX CHECK PASSED/);
});

test('check-vsix: a changed source file inside the package is refused', () => {
  const files = base();
  const i = files.findIndex((f) => f[0] === 'extension/src/pro/exporter.js');
  files[i] = [files[i][0], Buffer.concat([files[i][1], Buffer.from('\n// changed\n')])];
  const r = check(files);
  assert.equal(r.status, 1);
  assert.match(r.out, /extension\/src\/pro\/exporter\.js differs from src\/pro\/exporter\.js/);
});

test('check-vsix: a changed README text is refused, only the rewriting of its links is allowed', () => {
  const files = base();
  const i = files.findIndex((f) => f[0] === 'extension/readme.md');
  files[i] = [files[i][0], Buffer.from(files[i][1].toString('utf8') + '\nAn added sentence.\n')];
  const r = check(files);
  assert.equal(r.status, 1);
  assert.match(r.out, /readme\.md differs from README\.md by more than the rewriting of its links/);
});

test('check-vsix: a file with no source is refused', () => {
  const r = check(base().concat([['extension/src/extra.js', Buffer.from('module.exports = 1;\n')]]));
  assert.equal(r.status, 1);
  assert.match(r.out, /extra\.js, which has no file in the source folder/);
});

test('check-vsix: a package identity or display name that differs from package.json is refused', () => {
  for (const [override, pattern] of [[{ publisher: 'SomeoneElse' }, /Publisher is SomeoneElse/], [{ id: 'other-extension' }, /Id is other-extension/], [{ version: '9.9.9' }, /Version is 9\.9\.9/], [{ name: 'Another Name' }, /display name is Another Name/]]) {
    const r = check(base(override));
    assert.equal(r.status, 1, JSON.stringify(override));
    assert.match(r.out, pattern);
  }
});
