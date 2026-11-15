'use strict';
// The shape of the product as shipped and as published: manifest, identity, documents, what the
// package would hold, links, images and the legal texts. (Word scans for the delivered files are
// kept outside this folder.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = (dir ? dir + '/' : '') + e.name;
    if (e.name === 'node_modules' || e.name === '.git' || rel === 'test/.tmp') continue;
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}
const all = walk('', []);

function globRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; } else if (c === '*') re += '[^/]*'; else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function shipped(rel) {
  let ship = true;
  for (const raw of read('.vscodeignore').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const neg = raw.startsWith('!');
    if (globRe(neg ? raw.slice(1) : raw).test(rel)) ship = neg;
  }
  return ship;
}

test('manifest: identity, pricing label, engine, no dependencies, honest keywords', () => {
  assert.equal(pkg.name, 'big-log-atlas');
  assert.equal(pkg.displayName, 'Big Log Atlas');
  assert.equal(pkg.publisher, 'SmallStepsStudio');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.pricing, 'Trial');
  assert.equal(pkg.homepage, 'https://github.com/small-steps-studio/big-log-atlas#readme');
  assert.equal(pkg.repository.url, 'https://github.com/small-steps-studio/big-log-atlas');
  assert.equal(pkg.bugs.url, 'https://github.com/small-steps-studio/big-log-atlas/issues');
  assert.equal(pkg.engines.vscode, '^1.82.0');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.ok(pkg.keywords.length <= 30);
  assert.ok(!pkg.keywords.some((k) => /compli|certif|secure|gdpr|hipaa|soc ?2|best|#1|free/i.test(k)), pkg.keywords.join(','));
  assert.ok(!/free|bestseller|#1/i.test(pkg.displayName));
  assert.ok(!/^(the|a|an)\s/i.test(pkg.displayName));
  assert.equal(pkg.main, './src/extension.js');
  assert.ok(pkg.description.length <= 300);
});

test('manifest: every command has the product prefix, a title in the palette form and an entry in the README', () => {
  const readme = read('README.md');
  const ids = new Set();
  for (const c of pkg.contributes.commands) {
    assert.match(c.command, /^bigLogAtlas\.[a-zA-Z]+$/);
    assert.ok(!ids.has(c.command));
    ids.add(c.command);
    assert.ok(c.title.startsWith('Big Log Atlas: '), c.title);
    assert.ok(readme.includes(c.title.replace('Big Log Atlas: ', '').replace(/ \(Pro\)$/, '')), 'README lacks ' + c.title);
    assert.ok(!/ \(Pro\)$/.test(c.title) || /Pro/.test(c.title));
  }
  const proTitles = pkg.contributes.commands.filter((c) => / \(Pro\)$/.test(c.title)).length;
  assert.ok(proTitles >= 12);
  // every command of the walkthrough exists
  for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) for (const m of s.description.matchAll(/command:([A-Za-z.]+)/g)) assert.ok(ids.has(m[1]) || m[1].startsWith('workbench.'), m[1]);
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(readme.includes('`' + k + '`'), k);
  assert.equal(pkg.contributes.walkthroughs[0].steps.length, 5);
  for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) assert.ok(fs.existsSync(path.join(ROOT, s.media.markdown)), s.media.markdown);
});

test('the package would hold the product and nothing else, and not the test environment', () => {
  const list = all.filter(shipped);
  const allow = [/^(package\.json|README\.md|CHANGELOG\.md|LICENSE\.txt|TERMS\.md|PRIVACY\.md)$/, /^src\/.+\.js$/, /^media\/icon\.png$/, /^media\/webview\/[a-z.-]+$/, /^media\/walkthrough\/[a-z-]+\.md$/];
  for (const f of list) assert.ok(allow.some((re) => re.test(f)), 'would ship ' + f);
  assert.ok(!list.includes('src/licence/test-environment.js'));
  for (const must of ['src/extension.js', 'src/engine/safere.js', 'src/engine/lineindex.js', 'src/pro/anonymise.js', 'media/webview/main.js', 'media/webview/main.css', 'media/icon.png']) assert.ok(list.includes(must), must);
  assert.ok(list.length < 70, 'files: ' + list.length);
  // working notes and the audit of the sister products are never shipped, whatever they are called
  for (const note of ['STATUS.md', 'SPEC-LOCAL.md', 'TODO-BEFORE-PUBLISH.md', 'QA-AUDIT-0.1.0.md', 'x.local.md', 'big-log-atlas-0.1.0.vsix', 'test/smoke/run.js', 'docs/limits.md']) assert.equal(shipped(note), false, note);
});

test('the repository rules keep notes, packages and the smoke harness out', () => {
  const rules = read('.gitignore').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  for (const needed of ['*.vsix', 'test/smoke/', 'node_modules/', '*.local.md', '/*.md']) assert.ok(rules.includes(needed), needed);
  for (const publicDoc of ['!/README.md', '!/CHANGELOG.md', '!/TERMS.md', '!/PRIVACY.md']) assert.ok(rules.includes(publicDoc), publicDoc);
  assert.match(read('.gitattributes'), /eol=lf/);
});

test('documents: relative links resolve, and each document of the gate exists', () => {
  const docs = ['README.md', 'CHANGELOG.md', 'TERMS.md', 'PRIVACY.md'].concat(all.filter((f) => /^docs\/.*\.md$/.test(f)));
  assert.ok(docs.length >= 17);
  for (const f of docs) {
    const base = path.dirname(f);
    for (const m of read(f).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      assert.ok(fs.existsSync(path.join(ROOT, base, target)), f + ' links to a missing file: ' + target);
    }
  }
  for (const d of ['getting-started', 'searching', 'filtering', 'follow', 'profiles', 'timestamps', 'statistics', 'merge', 'export', 'regex', 'limits', 'licence', 'accessibility', 'troubleshooting']) assert.ok(fs.existsSync(path.join(ROOT, 'docs', d + '.md')), d);
  // every parse profile and every time stamp format is documented
  const P = require('../src/pro/profiles');
  const T = require('../src/engine/timestamps');
  for (const p of P.PROFILE_LIST) assert.ok(read('docs/profiles.md').includes('`' + p.id + '`'), p.id);
  for (const f of T.FORMATS) assert.ok(read('docs/timestamps.md').includes('`' + f.id + '`'), f.id);
});

test('legal texts: publisher, merchant-of-record wording, no refund promise, a lawyer note', () => {
  for (const f of ['LICENSE.txt', 'TERMS.md', 'PRIVACY.md']) assert.match(read(f), /Small Steps Studio/, f);
  assert.match(read('LICENSE.txt'), /Copyright \(c\) 2026 Small Steps Studio/);
  const terms = read('TERMS.md') + read('LICENSE.txt') + read('README.md');
  assert.match(terms, /merchant of record/i);
  assert.doesNotMatch(terms, /no refunds?|non-refundable|money[- ]back|refund guarantee|\d+[- ]day refund/i);
  assert.match(read('TERMS.md'), /not been reviewed by a lawyer/);
  assert.match(read('README.md'), /not been reviewed by a lawyer/);
  assert.match(read('PRIVACY.md'), /live\.dodopayments\.com/);
  assert.match(read('PRIVACY.md'), /no telemetry/i);
});

test('texts make no compliance, sales or install claims', () => {
  for (const f of ['README.md', 'CHANGELOG.md', 'TERMS.md', 'PRIVACY.md'].concat(all.filter((x) => /^docs\/.*\.md$/.test(x)))) {
    const t = read(f);
    assert.doesNotMatch(t, /compliant|certified|certification|bestseller|best[- ]selling|#1\b|number one|\d[\d,]* (installs|downloads|users|customers|sales)|trusted by|award/i, f);
  }
  // the CI workflow is prepared but has not run: no text says that it passed
  assert.doesNotMatch(read('README.md') + read('CHANGELOG.md'), /(passes|passed|green) (on|in) (CI|GitHub)|CI (passes|passed)|badge/i);
  assert.match(read('CHANGELOG.md'), /has not been run/);
});

test('images: the icon is 128 x 128 and every PNG holds only image data chunks', () => {
  const pngs = all.filter((f) => /\.png$/.test(f));
  assert.ok(pngs.includes('media/icon.png'));
  const icon = fs.readFileSync(path.join(ROOT, 'media/icon.png'));
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
  for (const f of pngs) {
    const b = fs.readFileSync(path.join(ROOT, f));
    assert.deepEqual(Array.from(b.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10], f);
    let pos = 8;
    const kinds = [];
    while (pos + 8 <= b.length) { kinds.push(b.toString('ascii', pos + 4, pos + 8)); pos += 12 + b.readUInt32BE(pos); }
    for (const k of kinds) assert.ok(['IHDR', 'IDAT', 'IEND'].includes(k), f + ' has the chunk ' + k);
  }
  for (const m of read('README.md').matchAll(/\]\((media\/screenshots\/[a-z0-9-]+\.png)\)/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), 'README screenshot ' + m[1]);
});

test('the prepared workflow runs unit tests only, on three systems and Node 22 and 24, with current actions and no network need', () => {
  const y = read('.github/workflows/ci.yml');
  assert.match(y, /ubuntu-latest, windows-latest, macos-latest/);
  assert.match(y, /node: \[22, 24\]/);
  assert.match(y, /BIG_LOG_ATLAS_SKIP_LARGE: '1'/);
  assert.match(y, /Pacific\/Auckland/);
  assert.match(y, /America\/St_Johns/);
  const uses = Array.from(y.matchAll(/uses: (actions\/[a-z-]+)@(v\d+)/g));
  assert.ok(uses.length >= 4, 'checkout, setup-node and upload-artifact are used');
  for (const u of uses) assert.equal(u[2], 'v7', u[1] + ' is at v7');
  assert.deepEqual(Array.from(new Set(uses.map((u) => u[1]))).sort(), ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']);
  assert.match(y, /node-version: 24/);
  assert.doesNotMatch(y, /secrets\.|publish|vsce publish|ovsx|@v4|@v5|@v6/);
});

test('scripts: the gate has no placeholder left to fail on; the local package script still accepts one and says it is not for publishing', () => {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-gate.js'), '--skip-tests'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const lines = r.stdout.split('\n').filter((l) => /^  - /.test(l));
  assert.doesNotMatch(r.stdout, /placeholder/, 'no placeholder is reported: ' + lines.join(' | '));
  // The additional checks outside the repository exist only next to the project, so a clone may stop on them alone.
  const outside = fs.existsSync(path.join(ROOT, '..', 'tools', 'big-log-atlas-private-gate.js'));
  if (outside || process.env.CI) assert.equal(r.status, 0, r.stdout);
  else assert.ok(lines.every((l) => /additional release checks/.test(l)), 'a clone may fail only on the checks that live outside it: ' + lines.join(' | '));
});

test('the suite is time-zone independent: the same results in three zones (the engine and the session tests)', () => {
  for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata']) {
    const r = cp.spawnSync(process.execPath, ['--test', path.join(ROOT, 'test', 'engine.search.test.js'), path.join(ROOT, 'test', 'pro.engine.test.js')], { cwd: ROOT, env: Object.assign({}, process.env, { TZ: tz, BIG_LOG_ATLAS_SKIP_LARGE: '1' }), encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(r.status, 0, tz + '\n' + (r.stdout || '').split('\n').filter((l) => /^✖|fail/.test(l)).join('\n'));
  }
});
