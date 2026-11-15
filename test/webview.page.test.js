'use strict';
// Runs the page script (media/webview/main.js) against a very small stand-in for the browser, to test
// the exchange of messages with the extension: which rows it asks for, how it treats stale and
// missing replies, and what it puts into the page (always text, never markup).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'media', 'webview', 'main.js'), 'utf8');

class El {
  constructor(tag, doc) {
    this.tag = tag; this.doc = doc; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.parentNode = null;
    this.style = {}; this.className = ''; this.clientHeight = 570; this.clientWidth = 1000; this.scrollLeft = 0; this.scrollWidth = 1000; this.value = ''; this.disabled = false;
    const self = this;
    const classes = new Set();
    this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } };
    Object.defineProperty(this, 'firstChild', { get() { return self.children[0] || null; } });
    Object.defineProperty(this, 'textContent', { get() { return self._text + self.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join(''); }, set(v) { self.children = []; self._text = String(v); } });
  }
  appendChild(c) { if (c.isFragment) { for (const k of c.children) { k.parentNode = this; this.children.push(k); } return c; } c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  getBoundingClientRect() { return { top: 0, left: 0, height: 19, width: 100 }; }
  focus() {} select() {}
  querySelectorAll() { return []; }
}

function boot() {
  const posted = [];
  const byId = new Map();
  const doc = {
    title: '',
    body: new El('body'),
    getElementById(id) { if (!byId.has(id)) byId.set(id, new El('div', doc)); return byId.get(id); },
    createElement(tag) { return new El(tag, doc); },
    createTextNode(t) { return { textContent: String(t), isText: true }; },
    createDocumentFragment() { const f = new El('#fragment', doc); f.isFragment = true; return f; },
    querySelectorAll() { return []; }
  };
  const winListeners = {};
  const win = { addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); } };
  const timers = [];
  const ctx = vm.createContext({
    document: doc, window: win, acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, Date, Math, JSON, Array, Object, String, Number, Set, Map, isFinite
  });
  vm.runInContext(SOURCE, ctx);
  return {
    posted, byId, timers,
    send: (m) => { for (const fn of winListeners.message || []) fn({ data: m }); },
    rowsRequests: () => posted.filter((m) => m.type === 'rows')
  };
}

function rowsFor(first, count, total) {
  const rows = [];
  for (let i = first; i < Math.min(total, first + count); i++) rows.push({ i: i, n: i + 1, t: 'line ' + (i + 1) + ' <b>bold</b>', bl: 10, l: 2 });
  return rows;
}
const INFO = { title: 't.log', kind: 'file', size: 100, sizeText: '100 bytes', encoding: 'utf8', encodingLabel: 'UTF-8', binary: false, total: 192, complete: true, colour: true, pro: false, profile: '', maxLineChars: 2000, canFollow: true };

test('the page asks for the rows it shows, once, and fills the list from the reply', () => {
  const p = boot();
  assert.deepEqual(p.posted.map((m) => m.type), ['ready']);
  p.send({ type: 'init', info: INFO });
  const reqs = p.rowsRequests();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].first, 0);
  assert.ok(reqs[0].count >= 20 && reqs[0].count <= 400);
  p.send({ type: 'rows', id: reqs[0].id, first: reqs[0].first, rows: rowsFor(reqs[0].first, reqs[0].count, 192), total: 192 });
  assert.equal(p.rowsRequests().length, 1, 'no further request: everything that is shown is there');
  const rowsEl = p.byId.get('rows');
  const first = rowsEl.children[0];
  assert.match(first.textContent, /line 1 <b>bold<\/b>/, 'log text is shown as text');
  assert.equal(first.children.length, 3);
});

test('a stale reply does not start a chase of requests (the bug that left every row "loading...")', () => {
  const p = boot();
  p.send({ type: 'init', info: INFO });
  const a = p.rowsRequests()[0];
  // another event resets the cache while request a is in flight, and a newer request b is sent
  p.send({ type: 'reset', total: 192, message: '' });
  const reqsAfterReset = p.rowsRequests();
  const b = reqsAfterReset[reqsAfterReset.length - 1];
  assert.notEqual(b.id, a.id);
  const before = p.rowsRequests().length;
  // the reply to the old request arrives first: it must be ignored without a new request
  p.send({ type: 'rows', id: a.id, first: a.first, rows: rowsFor(a.first, a.count, 192), total: 192 });
  assert.equal(p.rowsRequests().length, before, 'a stale reply starts no request');
  // the reply to the current request fills the list and ends the exchange
  p.send({ type: 'rows', id: b.id, first: b.first, rows: rowsFor(b.first, b.count, 192), total: 192 });
  assert.equal(p.rowsRequests().length, before, 'the current reply completes the list');
  assert.match(p.byId.get('rows').children[0].textContent, /line 1 /);
});

test('many stale replies in a row never produce more than one request at a time', () => {
  const p = boot();
  p.send({ type: 'init', info: INFO });
  const ids = [p.rowsRequests()[0].id];
  for (let k = 0; k < 20; k++) {
    p.send({ type: 'reset', total: 192, message: '' });
    const reqs = p.rowsRequests();
    ids.push(reqs[reqs.length - 1].id);
  }
  const total = p.rowsRequests().length;
  for (const id of ids.slice(0, -1)) p.send({ type: 'rows', id: id, first: 0, rows: [], total: 192 });
  assert.equal(p.rowsRequests().length, total, 'stale replies cause no requests');
  const last = p.rowsRequests()[p.rowsRequests().length - 1];
  p.send({ type: 'rows', id: last.id, first: last.first, rows: rowsFor(last.first, last.count, 192), total: 192 });
  assert.equal(p.rowsRequests().length, total);
});

test('rows the extension does not return are marked as unavailable and not asked for again', () => {
  const p = boot();
  p.send({ type: 'init', info: INFO });
  const a = p.rowsRequests()[0];
  p.send({ type: 'rows', id: a.id, first: a.first, rows: rowsFor(a.first, 3, 192), total: 192 });
  assert.equal(p.rowsRequests().length, 1, 'no request loop for rows that are missing');
  const rowsEl = p.byId.get('rows');
  assert.match(rowsEl.children[5].textContent, /not available/);
});

test('hostile log text, tags and notices are inserted as text only', () => {
  const p = boot();
  p.send({ type: 'init', info: INFO });
  const a = p.rowsRequests()[0];
  const evil = '<img src=x onerror=alert(1)>';
  p.send({ type: 'rows', id: a.id, first: 0, rows: [{ i: 0, n: 1, t: evil, bl: 5, l: 4, tag: evil, s: [[0, 4]], h: [[1, 3, 2]] }], total: 192 });
  const row = p.byId.get('rows').children[0];
  assert.equal(row.children.every((c) => c.tag !== 'img'), true);
  const walk = (n) => [n].concat((n.children || []).flatMap(walk));
  assert.ok(walk(row).every((n) => n.tag !== 'img' && n.tag !== 'script'));
  assert.match(row.textContent, /<img src=x onerror=alert\(1\)>/);
  p.send({ type: 'banner', text: evil, kind: 'warn' });
  assert.equal(p.byId.get('banner').textContent, evil);
  assert.equal(p.byId.get('banner').className, 'warn');
});

test('the page announces follow, count and filter progress through its live regions', () => {
  const p = boot();
  p.send({ type: 'init', info: INFO });
  p.send({ type: 'count', done: false, matches: 12, scanned: 50, total: 100 });
  assert.match(p.byId.get('count').textContent, /at least 12 lines \(50% scanned\)/);
  p.send({ type: 'count', done: true, matches: 1 });
  assert.equal(p.byId.get('count').textContent, '1 line');
  p.send({ type: 'filter', state: 'done', matches: 3, total: 3, scanned: 10, scanTotal: 10, limited: true, limit: 3 });
  assert.match(p.byId.get('filterInfo').textContent, /3 lines match/);
  assert.match(p.byId.get('banner').textContent, /stopped at 3 matching lines/);
  p.send({ type: 'follow', on: true, paused: true });
  assert.equal(p.byId.get('followBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(p.byId.get('pauseBtn').getAttribute('aria-pressed'), 'true');
});
