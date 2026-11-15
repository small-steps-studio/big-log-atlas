'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./helpers/vscode-mock');
const G = require('./helpers/gen');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const dir = G.tmpDir('shell-');
test.after(() => G.rmDir(dir));

function load(options) {
  const mock = M.install(options);
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
  const ext = require('../src/extension');
  const ctx = M.makeContext(mock, dir, options && options.context);
  ext.activate(ctx);
  return { mock, ctx, ext };
}
async function waitFor(fn, ms) { const end = Date.now() + (ms || 3000); while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); }

test('activation registers exactly the commands of the manifest', () => {
  const { mock, ctx } = load();
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepEqual(Array.from(mock.commands.keys()).sort(), declared);
  assert.equal(mock.output.length, 0, 'no part failed to start: ' + mock.output.join('; '));
  mock.restore();
  void ctx;
});

test('commands that need an open log say so instead of failing', async () => {
  const { mock } = load();
  for (const id of ['bigLogAtlas.goTo', 'bigLogAtlas.find', 'bigLogAtlas.filterLevels', 'bigLogAtlas.toggleFollow', 'bigLogAtlas.setEncoding', 'bigLogAtlas.toggleBookmark', 'bigLogAtlas.copyLines', 'bigLogAtlas.statistics', 'bigLogAtlas.chooseProfile', 'bigLogAtlas.exportFiltered', 'bigLogAtlas.compareExcerpts']) {
    await mock.commands.get(id)();
  }
  assert.ok(mock.warn.length >= 8);
  assert.ok(mock.warn.every((w) => /Open a log first/.test(w)), mock.warn.join(' | '));
  assert.equal(mock.error.length, 0);
  mock.restore();
});

test('opening a file shows it in a panel with a strict content security policy', async () => {
  const { mock } = load();
  const f = path.join(dir, 'a b ž.log');
  G.writeLines(f, ['one', 'two ERROR three']);
  await mock.commands.get('bigLogAtlas.openLarge')(M.Uri.file(f));
  const panel = mock.panels[0];
  assert.ok(panel, 'a panel was created');
  assert.equal(panel.opts.enableScripts, true);
  assert.equal(panel.opts.localResourceRoots.length, 1);
  assert.match(panel.opts.localResourceRoots[0].fsPath, /media[\\/]webview$/);
  const html = panel.webview.html;
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)[1];
  assert.ok(nonce.length >= 16);
  assert.ok(html.includes('<script nonce="' + nonce + '" src='));
  assert.equal((html.match(/<script/g) || []).length, 1, 'one script, loaded from a file');
  assert.doesNotMatch(html, / on[a-z]+="/, 'no inline event handler');
  assert.doesNotMatch(html, / style="/, 'no inline style');
  await waitFor(() => panel.posted.some((m) => m.type === 'indexed'));
  panel.send({ type: 'ready' });
  await waitFor(() => panel.posted.some((m) => m.type === 'init'));
  const init = panel.posted.find((m) => m.type === 'init');
  assert.equal(init.info.total, 2);
  panel.send({ type: 'rows', id: 1, first: 0, count: 10 });
  await waitFor(() => panel.posted.some((m) => m.type === 'rows'));
  assert.deepEqual(panel.posted.find((m) => m.type === 'rows').rows.map((r) => r.t), ['one', 'two ERROR three']);
  panel.dispose();
  mock.restore();
});

test('the page contains every element that the page script looks up', () => {
  const { pageHtml } = require('../src/viewer');
  const html = pageHtml('csp:', 'abc', 'main.js', 'main.css');
  const js = fs.readFileSync(path.join(ROOT, 'media', 'webview', 'main.js'), 'utf8');
  const ids = new Set(Array.from(js.matchAll(/\$\('([A-Za-z]+)'\)/g)).map((m) => m[1]));
  assert.ok(ids.size > 15);
  for (const id of ids) if (!['detailText', 'fieldsTable'].includes(id)) assert.ok(html.includes('id="' + id + '"'), 'missing element ' + id);
  const handled = new Set(Array.from(js.matchAll(/^    ([a-zA-Z]+): function/gm)).map((m) => m[1]));
  const session = fs.readFileSync(path.join(ROOT, 'src', 'session.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src', 'commands.js'), 'utf8');
  for (const m of session.matchAll(/type: '([a-zA-Z]+)'/g)) {
    const t = m[1];
    if (['ready', 'rows', 'search', 'count', 'filter', 'clearFilter', 'cancel', 'goto', 'follow', 'pause', 'bookmark', 'bookmarkJump', 'copy', 'expand', 'details', 'pretty', 'fields', 'table', 'view', 'encoding', 'encodingMenu'].includes(t) && !handled.has(t)) continue; // page to host
    assert.ok(handled.has(t) || ['ready', 'rows', 'search', 'count', 'filter', 'clearFilter', 'cancel', 'goto', 'follow', 'pause', 'bookmark', 'bookmarkJump', 'copy', 'expand', 'details', 'pretty', 'fields', 'table', 'view', 'encoding', 'encodingMenu'].includes(t), 'the page has no handler for the message ' + t);
  }
});

test('the page script never builds markup from log text and uses no dynamic code', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'webview', 'main.js'), 'utf8');
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /setTimeout\s*\(\s*['"`]/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /importScripts/]) assert.doesNotMatch(js, bad, String(bad));
  const css = fs.readFileSync(path.join(ROOT, 'media', 'webview', 'main.css'), 'utf8');
  assert.doesNotMatch(css, /url\(|@import/);
});

test('statistics page escapes every value from the log', () => {
  const { statsHtml } = require('../src/statsview');
  const r = {
    lines: 3, levels: { trace: 0, debug: 0, info: 1, warn: 0, error: 2, fatal: 0, none: 0 }, timed: 3, untimed: 0, timeFormat: 'ISO <b>', firstTime: 0, lastTime: 1000,
    histogram: { widthMs: 1000, buckets: [{ start: 0, count: 3, errors: 2 }] }, bursts: [], burstUnit: 'time', top: { '<img src=x onerror=alert(1)>': [{ value: '"><script>alert(1)</script>', count: 2 }] }, untracked: {}, distinctLimit: 200000, longLines: 0, aborted: false
  };
  const html = statsHtml(r, { title: '<script>x</script>' }, 'nonce123');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/);
});

test('the Pro gate: the first Pro command starts the trial, the next ones use it, and an ended trial shows the notice', async () => {
  const { mock, ctx } = load({ quickPicks: ['No profile (plain text)', 'No profile (plain text)'] });
  const f = path.join(dir, 'pro.log');
  G.writeLines(f, ['x']);
  await mock.commands.get('bigLogAtlas.openLarge')(M.Uri.file(f));
  assert.equal(ctx.globalMap.get('trial.startedAt'), undefined, 'opening a log starts nothing');
  await mock.commands.get('bigLogAtlas.chooseProfile')();
  assert.ok(typeof ctx.globalMap.get('trial.startedAt') === 'number', 'the trial started');
  assert.ok(mock.info.some((t) => /trial of Big Log Atlas Pro has started/.test(t)));
  // after the end of the trial
  ctx.globalMap.set('trial.startedAt', Date.now() - 30 * 86400000);
  ctx.globalMap.set('trial.lastSeenAt', Date.now() - 20 * 86400000);
  ctx.globalMap.delete('trial.expiredAt');
  mock.info.length = 0;
  await mock.commands.get('bigLogAtlas.chooseProfile')();
  assert.ok(mock.info.some((t) => /Parse profiles is an Big Log Atlas Pro feature|is an Big Log Atlas Pro feature/.test(t)), mock.info.join(' | '));
  mock.panels.forEach((p) => p.dispose());
  mock.restore();
});

test('settings are clamped to their ranges and unknown values fall back', async () => {
  const { mock } = load({ config: { maxLineChars: 5, 'indexCache.maxMB': 99999, 'follow.intervalMs': 'x', defaultEncoding: 'klingon', 'filter.maxMatches': -1, colourLevels: 'yes' } });
  await mock.commands.get('bigLogAtlas.reportProblem')();
  const block = mock.clipboard;
  assert.match(block, /maxLineChars = 200\b/);
  assert.match(block, /indexCache\.maxMB = 2048/);
  assert.match(block, /follow\.intervalMs = 500/);
  assert.match(block, /defaultEncoding = "auto"/);
  assert.match(block, /filter\.maxMatches = 1000\b/);
  mock.restore();
});

test('Report A Problem: no file name, path or content in the block', async () => {
  const { mock } = load();
  const f = path.join(dir, 'customer-ž-secret.log');
  G.writeLines(f, ['password=hunter2 and more']);
  await mock.commands.get('bigLogAtlas.openLarge')(M.Uri.file(f));
  await waitFor(() => mock.panels[mock.panels.length - 1].posted.some((m) => m.type === 'indexed'));
  await mock.commands.get('bigLogAtlas.reportProblem')();
  const block = mock.clipboard;
  assert.doesNotMatch(block, /customer|secret|hunter2|ž|[A-Za-z]:\\|\/home\/|\/Users\//);
  assert.match(block, /Open log: file, \d+ bytes, 1 lines/);
  assert.match(block, /Licence: Free \(trial not started\)/);
  assert.ok(mock.opened.some((u) => /small-steps-studio\/big-log-atlas\/issues/.test(u)));
  mock.panels.forEach((p) => p.dispose());
  mock.restore();
});

test('opening something that is not a readable file is reported, not thrown', async () => {
  const { mock } = load();
  await mock.commands.get('bigLogAtlas.openLarge')(M.Uri.file(path.join(dir, 'missing.log')));
  assert.match(mock.warn[0], /does not exist/);
  await mock.commands.get('bigLogAtlas.openLarge')(M.Uri.file(dir));
  assert.match(mock.warn[1], /not a file/);
  await mock.commands.get('bigLogAtlas.openLarge')(new M.Uri('vscode-vfs', '/x'));
  assert.match(mock.warn[2], /Only files on this computer/);
  assert.equal(mock.error.length, 0);
  mock.restore();
});

test('sample logs open in the viewer and are invented data', async () => {
  const { mock } = load();
  await mock.commands.get('bigLogAtlas.openSampleLog')();
  await mock.commands.get('bigLogAtlas.openSampleJson')();
  assert.equal(mock.panels.length, 2);
  const samples = require('../src/samples');
  assert.ok(samples.appLog().split('\n').length > 150);
  assert.ok(samples.jsonLog().split('\n').length > 150);
  assert.equal(samples.appLog(), samples.appLog(), 'the same text every time');
  mock.panels.forEach((p) => p.dispose());
  mock.restore();
});

test('licence environment: an installed copy always uses the live service, a development host of a checkout uses the test one', () => {
  const mock = M.install();
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
  const ext = require('../src/extension');
  const modes = { Production: 1, Development: 2, Test: 3 };
  assert.equal(ext.licenceModeFor({ extensionMode: 1 }, modes)(), 'live');
  assert.equal(ext.licenceModeFor({ extensionMode: 3 }, modes)(), 'live');
  assert.equal(ext.licenceModeFor({ extensionMode: 2 }, modes)(), 'test');
  assert.equal(ext.licenceModeFor({}, modes)(), 'live');
  assert.equal(ext.licenceModeFor({ extensionMode: 2 }, undefined)(), 'live');
  mock.restore();
});

test('the contributed settings and commands offer no way to the licence environment', () => {
  const config = require('../src/licence/config');
  assert.deepEqual(config.environmentSwitches(pkg), []);
  const text = JSON.stringify(pkg.contributes);
  assert.doesNotMatch(text, /licen[cs]e.?(mode|env)|test\.dodopayments|sandbox/i);
  // and a manifest that did offer one is recognised
  const bad = JSON.parse(JSON.stringify(pkg));
  bad.contributes.configuration.properties['bigLogAtlas.licenceMode'] = { type: 'string' };
  assert.equal(config.environmentSwitches(bad).length, 1);
});

test('no shipped source reads an environment variable, names the test host or uses the network except the licence check', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p); } })(path.join(ROOT, 'src'));
  for (const f of files) {
    if (f.endsWith('test-environment.js')) continue;
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /process\.env/, f);
    assert.doesNotMatch(t, /test\.(checkout\.)?dodopayments/, f);
    assert.doesNotMatch(t, /require\('node:(http|https|net|tls|dgram|dns|child_process|worker_threads)'\)|require\('(http|https|net|child_process)'\)/, f);
    if (!/licence[\\/]licence\.js$/.test(f)) assert.doesNotMatch(t, /\bfetch\(/, f);
  }
});

test('commands still act on the last log when the focus has moved away from its panel', async () => {
  const { mock } = load({ inputs: ['2'] });
  const f = path.join(dir, 'focus.log');
  G.writeLines(f, ['one', 'two', 'three']);
  await mock.commands.get('bigLogAtlas.openLarge')(M.Uri.file(f));
  const panel = mock.panels[mock.panels.length - 1];
  await waitFor(() => panel.posted.some((m) => m.type === 'indexed'));
  panel.handlers.view({ webviewPanel: { active: false } });
  await mock.commands.get('bigLogAtlas.goTo')();
  assert.equal(mock.warn.length, 0, mock.warn.join(' | '));
  await waitFor(() => panel.posted.some((m) => m.type === 'goto'));
  assert.deepEqual(panel.posted.filter((m) => m.type === 'goto').map((m) => [m.ok, m.row]), [[true, 1]]);
  panel.dispose();
  mock.restore();
});
