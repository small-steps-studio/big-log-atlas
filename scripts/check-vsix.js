'use strict';
// Checks the packaged .vsix: lists its files, refuses tests, scripts, secrets, screenshots, working
// notes and development files inside it, scans every text entry for keys and private paths, and
// confirms the manifest inside (version, pricing, engine). The wording checks are kept outside this
// folder (see scripts/release-gate.js).
//   node scripts/check-vsix.js [path/to/big-log-atlas-x.y.z.vsix]
// A .vsix is a zip file; the central directory is read and entries are inflated with Node's zlib.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const file = process.argv[2] || path.join(ROOT, pkg.name + '-' + pkg.version + '.vsix');
const problems = [];
function fail(t) { problems.push(t); }

function readZip(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(eocd + 10);
  let pos = b.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central directory');
    const method = b.readUInt16LE(pos + 10);
    const compressedSize = b.readUInt32LE(pos + 20);
    const nameLength = b.readUInt16LE(pos + 28);
    const extraLength = b.readUInt16LE(pos + 30);
    const commentLength = b.readUInt16LE(pos + 32);
    const localOffset = b.readUInt32LE(pos + 42);
    const name = b.toString('utf8', pos + 46, pos + 46 + nameLength);
    const dataStart = localOffset + 30 + b.readUInt16LE(localOffset + 26) + b.readUInt16LE(localOffset + 28);
    const raw = b.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : null;
    if (data === null) throw new Error('unsupported compression for ' + name);
    entries.push({ name: name, data: data });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const buf = fs.readFileSync(file);
const entries = readZip(buf);
const names = entries.map(function (e) { return e.name; });
process.stdout.write(names.map(function (n) { return '  ' + n; }).join('\n') + '\n');

// The package holds the product and nothing else: this list is the whole of it.
const PRODUCT_ENTRIES = [/^extension\/(package\.json|readme\.md|changelog\.md|LICENSE\.txt|TERMS\.md|PRIVACY\.md)$/i, /^extension\/src\/.+\.js$/,
  /^extension\/media\/icon\.png$/, /^extension\/media\/webview\/[a-z.-]+$/, /^extension\/media\/walkthrough\/[a-z-]+\.md$/, /^extension\.vsixmanifest$/, /^\[Content_Types\]\.xml$/];
for (const n of names) if (!PRODUCT_ENTRIES.some(function (re) { return re.test(n); })) fail('the package contains a file that is not part of the product: ' + n);
if (names.some(function (n) { return /test-environment/.test(n); })) fail('the package contains the test environment module');

const required = ['extension/package.json', 'extension/readme.md', 'extension/changelog.md', 'extension/LICENSE.txt', 'extension/TERMS.md', 'extension/PRIVACY.md',
  'extension/media/icon.png', 'extension/media/webview/main.js', 'extension/media/webview/main.css', 'extension/src/extension.js', 'extension/src/engine/lineindex.js',
  'extension/src/engine/safere.js', 'extension/media/walkthrough/open-sample.md', 'extension.vsixmanifest'];
const lower = names.map(function (n) { return n.toLowerCase(); });
for (const r of required) if (lower.indexOf(r.toLowerCase()) === -1) fail('the package lacks ' + r);
if (new Set(lower).size !== lower.length) fail('the package holds two entries whose names differ only in case');

let scanned = 0;
for (const e of entries) {
  if (/\.(png|ico)$/.test(e.name)) continue;
  scanned++;
  const text = e.data.toString('utf8');
  if (/MOCK-KEY|[A-Za-z]:\\Users\\|\/home\/[a-z]+\//.test(text)) fail(e.name + ' contains a test key or a private path');
  if (/(sk|pk|lk)_(live|test)_[A-Za-z0-9]{16,}/.test(text)) fail(e.name + ' looks like it contains a secret');
  if (/test\.(checkout\.)?dodopayments\.com|process\.env/.test(text)) fail(e.name + ' names a test licence address or reads an environment variable');
}

const inner = entries.find(function (e) { return e.name === 'extension/package.json'; });
if (inner) {
  const manifest = JSON.parse(inner.data.toString('utf8'));
  if (manifest.version !== pkg.version) fail('version inside the package is ' + manifest.version);
  if (manifest.pricing !== 'Trial') fail('pricing inside the package is ' + manifest.pricing);
  if (manifest.engines.vscode !== '^1.82.0') fail('engine inside the package is ' + manifest.engines.vscode);
}
const vsixmanifest = entries.find(function (e) { return e.name === 'extension.vsixmanifest'; });
if (vsixmanifest) {
  const xml = vsixmanifest.data.toString('utf8');
  if (!/Pricing" Value="Trial"/.test(xml)) fail('extension.vsixmanifest does not carry Pricing=Trial');
  if (!/Microsoft\.VisualStudio\.Code\.ExecutesCode" Value="true"/.test(xml)) fail('ExecutesCode flag missing');
  // The identity in the manifest of the package is the one in package.json.
  const identity = /<Identity\b[^>]*>/.exec(xml);
  const attr = function (tag, name) { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag || ''); return m ? m[1] : null; };
  if (!identity) fail('extension.vsixmanifest has no Identity');
  else {
    if (attr(identity[0], 'Id') !== pkg.name) fail('the package identity Id is ' + attr(identity[0], 'Id') + ', package.json says ' + pkg.name);
    if (attr(identity[0], 'Publisher') !== pkg.publisher) fail('the package identity Publisher is ' + attr(identity[0], 'Publisher') + ', package.json says ' + pkg.publisher);
    if (attr(identity[0], 'Version') !== pkg.version) fail('the package identity Version is ' + attr(identity[0], 'Version') + ', package.json says ' + pkg.version);
  }
  const display = /<DisplayName>([^<]*)<\/DisplayName>/.exec(xml);
  if (!display || display[1] !== pkg.displayName) fail('the package display name is ' + (display ? display[1] : 'missing') + ', package.json says ' + pkg.displayName);
}

// Every file in the package is the file of the source folder, byte for byte. The packaging tool
// rewrites the relative links of the two Markdown pages that the store shows (to the repository's
// blob/raw addresses), so those two are compared after undoing exactly that rewriting.
const REWRITE = /https:\/\/github\.com\/small-steps-studio\/[a-z-]+\/(?:blob|raw)\/HEAD\//g;
let compared = 0;
for (const e of entries) {
  if (!e.name.startsWith('extension/') || e.name === 'extension/') continue;
  const rel = e.name.slice('extension/'.length);
  const lowerPages = { 'readme.md': 'README.md', 'changelog.md': 'CHANGELOG.md' };
  const sourceRel = lowerPages[rel] || rel;
  const sourceFile = path.join(ROOT, sourceRel);
  if (!fs.existsSync(sourceFile)) { fail('the package holds ' + e.name + ', which has no file in the source folder'); continue; }
  const source = fs.readFileSync(sourceFile);
  compared++;
  if (lowerPages[rel]) {
    const a = e.data.toString('utf8').replace(REWRITE, '');
    const b = source.toString('utf8').replace(REWRITE, '');
    if (a !== b) fail(e.name + ' differs from ' + sourceRel + ' by more than the rewriting of its links');
  } else if (!e.data.equals(source)) fail(e.name + ' differs from ' + sourceRel + ' in the source folder');
}
if (compared < 20) fail('only ' + compared + ' package files could be compared with the source folder');

process.stdout.write(names.length + ' entries (' + scanned + ' text entries scanned for keys and private paths), ' + Math.round(buf.length / 1024) + ' KB\n');
if (buf.length > 2 * 1024 * 1024) fail('the package is larger than 2 MB');
if (problems.length) {
  process.stdout.write('VSIX CHECK FAILED\n' + problems.map(function (p) { return '  - ' + p; }).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('VSIX CHECK PASSED: ' + path.basename(file) + '\n');
