'use strict';
// Release gate: everything that must hold before a package is built.
//   node scripts/release-gate.js [--skip-tests] [--prepublish] [--allow-placeholders]
// Exits with code 1 and a list of problems when anything fails.
//
// --allow-placeholders (or the environment variable BIG_LOG_ATLAS_LOCAL_PACKAGE=1, set by
// scripts/package-local.js) accepts the placeholder product ids, for a local test package that is
// never uploaded. Every other rule still applies, and the placeholders are listed.
//
// Further checks of the shipped texts and of what may be published are kept outside this folder:
// the gate runs them from tools/big-log-atlas-private-gate.js next to the project and fails when
// that file is missing or reports a problem (an automated build, which has no such file, notes
// that they were not run).

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];
function fail(text) { problems.push(text); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function listFiles(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = (dir ? dir + '/' : '') + entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git' || rel === 'test/.tmp') continue;
    if (entry.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}

// .vscodeignore as an allow-list: the last pattern that matches decides; "!" includes.
function globRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function shippedBy(patterns, rel) {
  let ship = true;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const p = neg ? raw.slice(1) : raw;
    if (globRe(p).test(rel)) ship = neg;
  }
  return ship;
}

const argv = process.argv.slice(2);
const skipTests = argv.indexOf('--skip-tests') !== -1 || argv.indexOf('--prepublish') !== -1;
const allowPlaceholders = argv.indexOf('--allow-placeholders') !== -1 || process.env.BIG_LOG_ATLAS_LOCAL_PACKAGE === '1';
const pkg = JSON.parse(read('package.json'));

// 1. Unit tests.
if (!skipTests) {
  process.stdout.write('Running the unit suite...\n');
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tests.js')], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const summary = (r.stdout || '').split('\n').filter(function (l) { return /^ℹ (tests|pass|fail|skipped) /.test(l); }).join(', ');
  process.stdout.write('  ' + summary + '\n');
  if (r.status !== 0) fail('the unit suite failed (' + summary + ')');
}

// 2. Licence configuration and manifest.
const config = require(path.join(ROOT, 'src/licence/config'));
try { config.assertShippable(pkg, { allowPlaceholders: allowPlaceholders }); } catch (e) { fail(e.message); }
const ph = config.placeholderIds();
if (ph.length && allowPlaceholders) notes.push('NOT FOR PUBLISHING: placeholder product ids accepted for a local package: ' + ph.join(', '));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail('version is not x.y.z');
if (pkg.pricing !== 'Trial') fail('pricing must be Trial (a 14-day trial of the Pro features is offered)');
if (pkg.keywords.length > 30) fail('more than 30 keywords');
if (pkg.dependencies || pkg.devDependencies) fail('the package must have no dependencies');
if (!read('CHANGELOG.md').includes('## ' + pkg.version)) fail('CHANGELOG.md has no entry for ' + pkg.version);
if (pkg.publisher !== 'SmallStepsStudio') fail('publisher must be SmallStepsStudio');
if (pkg.homepage !== 'https://github.com/small-steps-studio/' + pkg.name + '#readme') fail('homepage does not follow the identity rules');

// 3. Documentation: every parse profile and every documentation page the README promises.
const profilesSource = require(path.join(ROOT, 'src/pro/profiles'));
const profilesDoc = fs.existsSync(path.join(ROOT, 'docs/profiles.md')) ? read('docs/profiles.md') : '';
for (const p of profilesSource.PROFILE_LIST) if (!profilesDoc.includes('`' + p.id + '`')) fail('docs/profiles.md does not document the profile ' + p.id);
const timeDoc = fs.existsSync(path.join(ROOT, 'docs/timestamps.md')) ? read('docs/timestamps.md') : '';
for (const f of require(path.join(ROOT, 'src/engine/timestamps')).FORMATS) if (!timeDoc.includes('`' + f.id + '`')) fail('docs/timestamps.md does not document the time format ' + f.id);
for (const d of ['getting-started', 'searching', 'filtering', 'follow', 'profiles', 'timestamps', 'statistics', 'merge', 'export', 'regex', 'limits', 'licence', 'accessibility', 'troubleshooting']) {
  if (!fs.existsSync(path.join(ROOT, 'docs', d + '.md'))) fail('docs/' + d + '.md is missing');
}

// 4. What would ship, secrets and private paths, line endings.
const ignore = read('.vscodeignore').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
const gitIgnore = read('.gitignore').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== '#'; });
const all = listFiles('', []);
const shipped = all.filter(function (f) { return shippedBy(ignore, f); });
// The package holds the product and nothing else: this list is the whole of it.
const PRODUCT_FILES = [/^(package\.json|README\.md|CHANGELOG\.md|LICENSE\.txt|TERMS\.md|PRIVACY\.md)$/, /^src\/.+\.js$/, /^media\/icon\.png$/, /^media\/webview\/[a-z.-]+$/, /^media\/walkthrough\/[a-z-]+\.md$/];
for (const f of shipped) {
  if (!PRODUCT_FILES.some(function (re) { return re.test(f); })) fail('would ship a file that is not part of the product: ' + f);
  if (f === 'src/licence/test-environment.js') fail('would ship the test environment module');
}
for (const required of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'TERMS.md', 'PRIVACY.md', 'src/extension.js', 'media/icon.png', 'media/webview/main.js', 'media/webview/main.css']) {
  if (shipped.indexOf(required) === -1) fail('would not ship ' + required);
}
const textFiles = all.filter(function (f) { return /\.(md|json|js|css|txt|yml|svg|log)$/.test(f); });
for (const f of textFiles) {
  if (/^test\/(\.tmp|fixtures\/corpus)\//.test(f)) continue;
  const text = read(f);
  const tooling = /^(test|scripts)\//.test(f);
  if (/(sk|pk|lk)_(live|test)_[A-Za-z0-9]{16,}/.test(text)) fail(f + ' looks like it contains a secret');
  // The package knows the live licence environment only and reads no environment variable.
  if (shippedBy(ignore, f) && /\.(js|css|json|md|txt)$/.test(f) && /test\.(checkout\.)?dodopayments\.com|process\.env/.test(text)) fail(f + ' names a test licence address or reads an environment variable');
  if (/MOCK-KEY|dodo_test_[a-z_]*key/.test(text) && !tooling) fail(f + ' refers to a test key');
  if (/[A-Za-z]:\\Users\\|\/home\/[a-z]+\/|\/Users\/[a-z]+\//.test(text) && !tooling) fail(f + ' contains a private file path');
  if (/\r\n/.test(text) && !/^test\//.test(f) && !/\.log$/.test(f)) fail(f + ' has CRLF line endings');
}
// Working notes must be kept out of the package and the repository by name pattern, whatever they
// are called, so that a new note can never ship or be pushed by accident.
for (const probe of ['QA-AUDIT-9.9.9.md', 'STATUS.md', 'MY-NOTES.md', 'X-SPEC.md', 'SPEC-LOCAL.md', 'TODO-BEFORE-PUBLISH.md', 'debug.log', 'old.vsix', 'draft.local.md']) {
  if (shippedBy(ignore, probe)) fail('.vscodeignore would let a file named ' + probe + ' into the package');
  let pushed = true;
  for (const raw of gitIgnore) { const neg = raw.startsWith('!'); const p = (neg ? raw.slice(1) : raw).replace(/^\//, '').replace(/\/$/, '/**'); if (globRe(p).test(probe) || (!p.includes('/') && globRe(p).test(probe))) pushed = neg; }
  if (pushed) fail('.gitignore would let a file named ' + probe + ' into the repository');
}

// 5. The private checks (wording, personal details, what may be pushed) are kept outside this folder.
const privateGate = path.join(ROOT, '..', 'tools', 'big-log-atlas-private-gate.js');
if (!fs.existsSync(privateGate)) {
  // A clone of the public repository has no such file. Only an automated build (CI is set by the
  // hosted runners) may go on without it; a release is never built that way.
  if (process.env.CI) notes.push('the additional release checks that live outside this repository were not run (automated build)');
  else fail('the additional release checks were not found next to the project (tools/big-log-atlas-private-gate.js); they must pass before a release');
} else {
  const pr = cp.spawnSync(process.execPath, [privateGate, ROOT], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write((pr.stdout || '').split('\n').map(function (l) { return l ? '  ' + l + '\n' : ''; }).join(''));
  if (pr.status !== 0) fail('the private checks failed (see above)');
}

// 6. README, walkthrough media, screenshots, icon, legal texts.
const readme = read('README.md');
const props = pkg.contributes.configuration.properties;
for (const c of pkg.contributes.commands) {
  const t = c.title.replace(pkg.displayName + ': ', '').replace(/ \(Pro\)$/, '');
  if (!readme.includes(t)) fail('README does not mention the command ' + t);
}
for (const k of Object.keys(props)) if (!readme.includes('`' + k + '`')) fail('README does not document the setting ' + k);
for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) if (!fs.existsSync(path.join(ROOT, s.media.markdown))) fail('walkthrough media missing: ' + s.media.markdown);
for (const m of readme.matchAll(/\]\((media\/screenshots\/[a-z0-9-]+\.png)\)/g)) {
  if (fs.existsSync(path.join(ROOT, m[1]))) continue;
  // A local test package (used to take the screenshots) may be built before they exist.
  if (allowPlaceholders) notes.push('local package: README screenshot not taken yet: ' + m[1]);
  else fail('README screenshot missing: ' + m[1]);
}
for (const m of readme.matchAll(/\]\(((?:docs\/)?[A-Za-z-]+\.(?:md|txt))\)/g)) if (!fs.existsSync(path.join(ROOT, m[1]))) fail('README links to a missing file: ' + m[1]);
const icon = fs.readFileSync(path.join(ROOT, 'media/icon.png'));
if (icon.readUInt32BE(16) !== 128 || icon.readUInt32BE(20) !== 128) fail('media/icon.png must be 128 x 128');
for (const t of ['TERMS.md', 'PRIVACY.md', 'LICENSE.txt']) if (!fs.existsSync(path.join(ROOT, t))) fail(t + ' is missing');

for (const n of notes) process.stdout.write(n + '\n');
if (problems.length) {
  process.stdout.write('RELEASE GATE FAILED\n' + problems.map(function (p) { return '  - ' + p; }).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('RELEASE GATE PASSED (' + shipped.length + ' files would ship, ' + profilesSource.PROFILE_LIST.length + ' parse profiles documented' + (allowPlaceholders && ph.length ? '; placeholder product ids accepted for a local package only' : '') + ')\n');
