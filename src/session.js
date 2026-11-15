'use strict';
// One open log: a source (a file or several files merged by time), the view on it (all lines, or
// the lines that pass a filter), search, bookmarks, follow mode, the Pro tools that act on it, and the
// messages exchanged with the page that shows it. No editor API is used here: everything the session
// needs from the editor arrives through `deps`, which is what makes it testable.
//
// deps: post(message), settings(), cacheDir, state { get(key, fallback), update(key, value) },
//       gate(feature) -> Promise<boolean> (the Pro gate, shows its own notices), hasAccess(),
//       clipboard(text), status(text), notify(kind, text), now().

const path = require('node:path');
const crypto = require('node:crypto');
const { LogFile, sanitize } = require('./engine/lineindex');
const { FileSource } = require('./engine/source');
const S = require('./engine/search');
const { createMatcher } = require('./engine/matcher');
const safere = require('./engine/safere');
const levels = require('./engine/levels');
const T = require('./engine/timestamps');
const cache = require('./engine/indexcache');
const E = require('./engine/encoding');

const MAX_ROWS_PER_REQUEST = 400;
const COPY_MAX_ROWS = 200000;
const COPY_MAX_CHARS = 32 * 1024 * 1024;
const TABLE_ROWS = 500;
const MAX_BOOKMARKS = 5000;
const LABEL = { 0: 'trace', 1: 'debug', 2: 'info', 3: 'warning', 4: 'error', 5: 'fatal' };

// A whole number from the page, or the fallback when the value is not a finite number.
function wholeNumber(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? Math.floor(n) : fallback;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' bytes';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

/** Reads what the user typed in the "go to" box: { kind: 'line'|'percent'|'byte'|'time', ... } or null. */
function parseJump(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = /^(\d{1,3}(?:[.,]\d+)?)\s*%$/.exec(t);
  if (m) { const p = Number(m[1].replace(',', '.')); return p >= 0 && p <= 100 ? { kind: 'percent', value: p } : null; }
  m = /^@\s*(\d[\d_,]*)$/.exec(t);
  if (m) return { kind: 'byte', value: Number(m[1].replace(/[_,]/g, '')) };
  m = /^0x([0-9a-f]{1,13})$/i.exec(t);
  if (m) return { kind: 'byte', value: parseInt(m[1], 16) };
  m = /^(?:t:|time\s+)\s*(.+)$/i.exec(t);
  if (m) return { kind: 'time', text: m[1].trim() };
  m = /^(?:line\s+)?(\d[\d_, ]*)$/i.exec(t);
  if (m) { const n = Number(m[1].replace(/[_, ]/g, '')); return n >= 1 && isFinite(n) ? { kind: 'line', value: n } : null; }
  return null;
}

class LogSession {
  constructor(deps) {
    this.deps = deps;
    this.kind = 'file';
    this.source = null;
    this.file = null;
    this.title = '';
    this.filter = { active: false, list: null, spec: null, running: false, ctl: null, info: null };
    this.searchSpec = null;
    this.searchMatcher = null;
    this.extra = {};
    this.lastWebSpec = {};
    this.countCtl = null;
    this.scanCtl = null;
    this.scanPromise = null;
    this.bookmarks = new Set();
    this.bookmarkKey = '';
    this.follow = { on: false, paused: false, timer: null, polling: false, missingReported: false };
    this.profile = null;
    this.profileInfo = null;
    this.highlights = [];
    this.timeFormat = '';
    this.timeChecked = false;
    this.reference = deps.now ? deps.now() : Date.now();
    this.cursor = 0;
    this.disposed = false;
    this.scanBusy = false;
    this.opNote = '';
  }

  get settings() { return this.deps.settings(); }
  get rowCount() { return this.filter.active ? this.filter.list.length : (this.source ? this.source.lineCount : 0); }
  get hasFile() { return this.kind === 'file' && !!this.file; }

  post(msg) { if (!this.disposed) this.deps.post(msg); }

  // ---- opening ---------------------------------------------------------------------------------

  async openFile(filePath, options) {
    const o = options || {};
    this.kind = 'file';
    const enc = o.encoding || this.settings.defaultEncoding || 'auto';
    const f = new LogFile(filePath, o.engine || {});
    await f.open({ encoding: enc });
    this.file = f;
    this.source = new FileSource(f);
    this.title = path.basename(filePath);
    this.reference = f.mtimeMs;
    this.bookmarkKey = 'bookmarks.' + crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 20);
    this.bookmarks = new Set((this.deps.state.get(this.bookmarkKey, []) || []).filter(function (n) { return Number.isInteger(n) && n >= 0; }));
    this.loadHighlights();
    await this.startIndexing();
    return this;
  }

  async openMerge(merge, title) {
    this.kind = 'merge';
    this.source = merge;
    this.file = null;
    this.title = title || 'Merged logs';
    this.loadHighlights();
    this.timeChecked = false;
    return this;
  }

  loadHighlights() {
    const raw = this.deps.state.get('highlights', []) || [];
    this.highlights = [];
    for (const r of raw.slice(0, 20)) {
      const m = createMatcher({ text: r.text, regex: !!r.regex, caseSensitive: !!r.caseSensitive, wholeWord: false });
      if (m.ok && !m.empty) this.highlights.push({ matcher: m, colour: (r.colour | 0) % 6, rule: r });
    }
  }

  async startIndexing() {
    const f = this.file;
    const s = this.settings;
    let key = '';
    if (s.indexCacheMB > 0 && this.deps.cacheDir && f.size >= 1024 * 1024) {
      key = cache.keyFor(f.path, f.size, f.mtimeMs);
      const buf = await cache.load(this.deps.cacheDir, key);
      if (buf && (await f.loadBuffer(buf))) { this.post({ type: 'indexed', total: this.rowCount, cached: true }); return; }
    }
    this.scanCtl = new AbortController();
    const self = this;
    this.scanBusy = true;
    this.scanPromise = f.scan(this.scanCtl.signal, function (p) {
      self.post({ type: 'progress', phase: 'index', scanned: p.scannedBytes, size: p.size, lines: p.lines, total: self.rowCount });
    }).then(async function (r) {
      if (r.complete && !self.disposed) {
        self.post({ type: 'indexed', total: self.rowCount, cached: false });
        if (key) {
          const buf = f.toBuffer();
          if (buf) { await cache.save(self.deps.cacheDir, key, buf); cache.cleanup(self.deps.cacheDir, s.indexCacheMB * 1024 * 1024); }
        }
      }
      return r;
    }, function (e) {
      if (!self.disposed) self.deps.notify('error', 'The file could not be read: ' + (e && e.message ? e.message : 'unknown error'));
      return { complete: false, aborted: true };
    }).then(function (r) { self.scanBusy = false; return r; });
  }

  async waitForIndex(signal) {
    if (!this.scanPromise || (this.file && this.file.complete)) return true;
    const abort = new Promise(function (resolve) { if (signal) signal.addEventListener('abort', function () { resolve(false); }, { once: true }); });
    const r = await Promise.race([this.scanPromise.then(function (x) { return x.complete; }), abort]);
    return r === true;
  }

  // ---- rows ------------------------------------------------------------------------------------

  async readScattered(numbers) {
    const out = new Map();
    const maxChars = this.settings.maxLineChars;
    let i = 0;
    while (i < numbers.length) {
      let j = i;
      while (j + 1 < numbers.length && numbers[j + 1] - numbers[j] < 128 && numbers[j + 1] - numbers[i] < 512) j++;
      const recs = await this.source.readLines(numbers[i], numbers[j] - numbers[i] + 1, { maxChars: maxChars });
      for (const r of recs) out.set(r.no, r);
      i = j + 1;
    }
    return out;
  }

  rowOf(rec, rowIndex, meter) {
    const raw = rec.text;
    const row = { i: rowIndex, n: rec.no + 1, t: sanitize(raw), bl: rec.byteLength };
    if (rec.truncated) row.x = 1;
    if (this.kind === 'file') row.o = rec.offset;
    if (rec.tag) row.tag = rec.tag;
    if (this.settings.colourLevels) { const r = levels.levelRank(raw); if (r >= 0) row.l = r; }
    if (this.bookmarks.has(rec.no)) row.b = 1;
    if (this.searchMatcher && !this.searchMatcher.empty) { const sp = this.searchMatcher.spans(raw, 40, meter); if (sp.length) row.s = sp; }
    if (this.highlights.length) {
      const h = [];
      for (const r of this.highlights) for (const sp of r.matcher.spans(raw, 20, meter)) h.push([sp[0], sp[1], r.colour]);
      if (h.length) row.h = h;
    }
    return row;
  }

  async makeRows(first, count) {
    const total = this.rowCount;
    const f = Math.max(0, Math.floor(first));
    const c = Math.max(0, Math.min(MAX_ROWS_PER_REQUEST, Math.floor(count), total - f));
    if (c <= 0) return [];
    // One work limit for the highlighting of the whole batch of rows: a pattern that is too costly
    // for these lines cannot hold the editor for more than a fraction of a second per request.
    const meter = safere.createMeter();
    const matchers = this.highlightMatchers();
    for (const m of matchers) m.tooCostly = false;
    let rows;
    if (!this.filter.active) {
      const recs = await this.source.readLines(f, c, { maxChars: this.settings.maxLineChars });
      rows = recs.map((rec, k) => this.rowOf(rec, f + k, meter));
    } else {
      const nums = [];
      for (let i = f; i < f + c; i++) nums.push(this.filter.list.get(i));
      const map = await this.readScattered(nums);
      rows = [];
      nums.forEach((n, k) => { const rec = map.get(n); if (rec) rows.push(this.rowOf(rec, f + k, meter)); });
    }
    if (matchers.some(function (m) { return m.tooCostly; })) {
      this.post({ type: 'banner', kind: 'warn', text: 'Highlighting was skipped for some lines: the pattern needs too much work for them (a work limit keeps the editor responsive). Simplify the pattern to see its highlights.' });
    }
    return rows;
  }

  /** The matchers that colour parts of a row: the search and the highlight rules. */
  highlightMatchers() {
    const list = this.highlights.map(function (h) { return h.matcher; });
    if (this.searchMatcher && !this.searchMatcher.empty) list.push(this.searchMatcher);
    return list;
  }

  /** The line (0-based) shown in a view row, or -1. */
  lineOfRow(row) {
    if (row < 0 || row >= this.rowCount) return -1;
    return this.filter.active ? this.filter.list.get(row) : row;
  }

  /** The first view row whose line is at or after the line (0-based). */
  rowOfLine(line) {
    if (!this.filter.active) return Math.max(0, Math.min(line, Math.max(0, this.source.lineCount - 1)));
    return Math.min(this.filter.list.lowerBound(line), Math.max(0, this.filter.list.length - 1));
  }

  // ---- time ------------------------------------------------------------------------------------

  async ensureTimeFormat() {
    if (this.timeChecked) return this.timeFormat;
    if (this.source.lineCount === 0) return '';
    this.timeChecked = true;
    const recs = await this.source.readLines(0, 300, { maxChars: 600 });
    const det = T.detect(recs.map(function (r) { return r.text; }), this.reference);
    this.timeFormat = det ? det.id : '';
    return this.timeFormat;
  }

  // ---- predicates and filters ------------------------------------------------------------------

  /** Builds a fresh predicate for a filter spec; { pred } or { error }. */
  async buildPredicate(spec) {
    const s = spec || {};
    const matcher = createMatcher({ text: s.text || '', regex: !!s.regex, caseSensitive: !!s.caseSensitive, wholeWord: !!s.wholeWord });
    if (!matcher.ok) return { error: matcher.error.message };
    let extra = null;
    if (s.field) {
      if (!this.profile) return { error: 'Choose a parse profile first (Big Log Atlas: Choose Parse Profile), then the field filter can use its fields.' };
      let terms;
      try { terms = require('./pro/fieldfilter').parseFilter(s.field); } catch (e) { return { error: e.message }; }
      const profile = this.profile;
      const FF = require('./pro/fieldfilter');
      extra = function (rec) { return FF.matches(terms, profile.parse(rec.text) || {}); };
    }
    const timed = typeof s.from === 'number' || typeof s.to === 'number';
    const fmt = timed ? await this.ensureTimeFormat() : await this.ensureTimeFormat();
    if (timed && !fmt) return { error: 'No time stamps were recognised in this log, so a time range cannot be applied. See docs/timestamps.md for the supported formats.' };
    const pred = S.makePredicate({
      matcher: matcher, levels: s.levels && s.levels.length ? s.levels : null, keepContinuation: s.keepContinuation !== false,
      timeFormat: fmt || undefined, reference: this.reference, from: s.from, to: s.to, extra: extra
    });
    return { pred: pred, active: !matcher.empty || !!(s.levels && s.levels.length) || !!s.field || timed };
  }

  async applyFilter(webSpec) {
    this.cancelFilter();
    // The page may only send what its own boxes hold (text, options, levels). The field filter and
    // the time range are Pro features set by the gated commands (this.extra); a message from the
    // page cannot add them.
    const fromPage = Object.assign({}, webSpec || {});
    delete fromPage.field; delete fromPage.from; delete fromPage.to;
    this.lastWebSpec = fromPage;
    const spec = Object.assign({}, fromPage, this.extra);
    const built = await this.buildPredicate(spec);
    if (built.error) { this.post({ type: 'filter', state: 'error', message: built.error }); return { ok: false, error: built.error }; }
    if (!built.active) return this.clearFilter();
    const ctl = new AbortController();
    const list = new S.MatchList(this.settings.filterMaxMatches);
    this.filter = { active: true, list: list, spec: spec, running: true, ctl: ctl, info: { scanned: 0, longLines: 0, limited: false } };
    this.post({ type: 'filter', state: 'running', matches: 0, total: 0 });
    const self = this;
    const state = this.filter;
    if (this.hasFile && !this.source.complete && this.scanPromise) {
      // The lines that are not indexed yet cannot be filtered: wait for the index, so that the result covers the whole log.
      this.post({ type: 'filter', state: 'running', matches: 0, total: 0, waiting: true });
      const indexed = await this.waitForIndex(ctl.signal);
      if (this.filter !== state) return { ok: false, superseded: true };
      if (!indexed) { this.clearFilter(); return { ok: false, cancelled: true }; }
    }
    const totalLines = this.source.lineCount;
    const res = await S.runFilter(this.source, built.pred, {
      signal: ctl.signal, list: list, limit: this.settings.filterMaxMatches,
      onProgress: function (p) { if (self.filter === state) self.post({ type: 'filter', state: 'running', matches: p.matches, scanned: p.scanned, scanTotal: totalLines, total: list.length }); }
    });
    if (this.filter !== state) return { ok: false, superseded: true };
    if (res.error) {
      // The work limit of the regular expression engine stopped the pass: a partial list would look complete.
      this.clearFilter();
      this.post({ type: 'filter', state: 'error', message: res.error });
      return { ok: false, error: res.error };
    }
    state.running = false;
    state.info = { scanned: res.scanned, longLines: res.longLines, limited: res.limited, aborted: res.aborted };
    this.post({ type: 'filter', state: res.aborted ? 'cancelled' : 'done', matches: list.length, scanned: res.scanned, scanTotal: totalLines, total: list.length, limited: res.limited, limit: this.settings.filterMaxMatches, longLines: res.longLines });
    return { ok: true, matches: list.length, limited: res.limited, longLines: res.longLines };
  }

  cancelFilter() {
    if (this.filter.ctl) this.filter.ctl.abort();
  }

  /** Adds or removes the parts of the filter that the page has no box for (field filter, time range) and applies the filter again. */
  async setExtra(extra) {
    for (const k of Object.keys(extra)) { if (extra[k] === null || extra[k] === undefined) delete this.extra[k]; else this.extra[k] = extra[k]; }
    return this.applyFilter(this.lastWebSpec);
  }

  /** Applies a complete spec (a saved filter): the parts of the page and the extra parts. */
  async applySpec(spec) {
    const s = Object.assign({}, spec || {});
    this.extra = {};
    for (const k of ['field', 'from', 'to']) { if (s[k] !== undefined && s[k] !== null && s[k] !== '') this.extra[k] = s[k]; delete s[k]; }
    this.post({ type: 'filterSpec', spec: s });
    return this.applyFilter(s);
  }

  refreshInfo() { this.post({ type: 'info', info: this.info() }); }
  cmd(name) { this.post({ type: 'cmd', name: name }); }

  clearFilter(anchorRow) {
    this.extra = {};
    this.lastWebSpec = {};
    const line = anchorRow === undefined ? -1 : this.lineOfRow(anchorRow);
    this.cancelFilter();
    this.filter = { active: false, list: null, spec: null, running: false, ctl: null, info: null };
    this.post({ type: 'filter', state: 'cleared', total: this.rowCount, row: line >= 0 ? this.rowOfLine(line) : undefined });
    return { ok: true };
  }

  /** The spec of the filter that is active now (for saving), or null. */
  currentFilterSpec() { return this.filter.active ? Object.assign({}, this.filter.spec) : null; }

  // ---- search ----------------------------------------------------------------------------------

  setSearch(spec) {
    if (!spec || !spec.text) { this.searchSpec = null; this.searchMatcher = null; return { ok: true, empty: true }; }
    const m = createMatcher(spec);
    if (!m.ok) { this.searchSpec = null; this.searchMatcher = null; return { ok: false, error: m.error.message }; }
    this.searchSpec = spec;
    this.searchMatcher = m;
    return { ok: true };
  }

  // Looks for the next row (dir 'next') or the previous row (dir 'prev') with a match, starting after/before `fromRow`.
  async findRow(dir, fromRow, signal) {
    const m = this.searchMatcher;
    const pred = function (rec) { return m.test(rec.text); };
    const total = this.rowCount;
    if (!total) return { row: null };
    const search = async (lo, hi) => (dir === 'next' ? this.findInRows(pred, lo, hi, signal) : this.findInRowsBackward(pred, lo, hi, signal));
    let r;
    if (dir === 'next') {
      r = await search(Math.max(-1, fromRow) + 1, total);
      if (r.row === null && !r.aborted && !r.error && fromRow >= 0) { r = await search(0, Math.min(total, fromRow + 1)); if (r.row !== null) r.wrapped = true; }
    } else {
      r = await search(0, Math.min(total, Math.max(0, fromRow)));
      if (r.row === null && !r.aborted && !r.error) { r = await search(Math.min(total, Math.max(0, fromRow)), total); if (r.row !== null) r.wrapped = true; }
    }
    return r;
  }

  async findInRows(pred, lo, hi, signal) {
    let longLines = 0;
    try {
      if (!this.filter.active) {
        let found = null;
        const pace = S.pacer(signal);
        const res = await this.source.forEachText(lo, function (rec) {
          if (rec.no >= hi) return false;
          if (rec.capped) longLines++;
          if (pred(rec)) { found = rec.no; return false; }
          return pace() || true;
        }, { signal: signal });
        return { row: found, aborted: res.aborted || pace.stopped, longLines: longLines };
      }
      for (let i = lo; i < hi; i += 256) {
        if (signal && signal.aborted) return { row: null, aborted: true, longLines: longLines };
        const end = Math.min(hi, i + 256);
        const nums = [];
        for (let k = i; k < end; k++) nums.push(this.filter.list.get(k));
        const map = await this.readScattered(nums);
        for (let k = i; k < end; k++) { const rec = map.get(this.filter.list.get(k)); if (rec && pred(rec)) return { row: k, aborted: false, longLines: longLines }; }
      }
    } catch (e) {
      const m = S.budgetMessage(e);
      if (!m) throw e;
      return { row: null, aborted: false, longLines: longLines, error: m };
    }
    return { row: null, aborted: false, longLines: longLines };
  }

  async findInRowsBackward(pred, lo, hi, signal) {
    let end = hi;
    try {
      while (end > lo) {
        if (signal && signal.aborted) return { row: null, aborted: true, longLines: 0 };
        const start = Math.max(lo, end - 64);
        if (!this.filter.active) {
          const recs = await this.source.readLines(start, end - start, { maxChars: 262144 });
          for (let k = recs.length - 1; k >= 0; k--) if (pred(recs[k])) return { row: recs[k].no, aborted: false, longLines: 0 };
        } else {
          const nums = [];
          for (let k = start; k < end; k++) nums.push(this.filter.list.get(k));
          const map = await this.readScattered(nums);
          for (let k = end - 1; k >= start; k--) { const rec = map.get(this.filter.list.get(k)); if (rec && pred(rec)) return { row: k, aborted: false, longLines: 0 }; }
        }
        end = start;
      }
    } catch (e) {
      const m = S.budgetMessage(e);
      if (!m) throw e;
      return { row: null, aborted: false, longLines: 0, error: m };
    }
    return { row: null, aborted: false, longLines: 0 };
  }

  async countMatches() {
    if (this.countCtl) this.countCtl.abort();
    if (!this.searchMatcher) { this.post({ type: 'count', done: true, matches: 0, empty: true }); return; }
    const ctl = new AbortController();
    this.countCtl = ctl;
    const m = this.searchMatcher;
    const pred = function (rec) { return m.test(rec.text); };
    const self = this;
    let res;
    if (!this.filter.active) {
      res = await S.countMatches(this.source, pred, { signal: ctl.signal, onProgress: function (p) { if (self.countCtl === ctl) self.post({ type: 'count', done: false, matches: p.count, scanned: p.scanned, total: p.total }); } });
    } else {
      let count = 0;
      let scanned = 0;
      const n = this.filter.list.length;
      let error = '';
      try {
        for (let i = 0; i < n && !ctl.signal.aborted; i += 256) {
          const end = Math.min(n, i + 256);
          const nums = [];
          for (let k = i; k < end; k++) nums.push(this.filter.list.get(k));
          const map = await this.readScattered(nums);
          for (const rec of map.values()) { scanned++; if (pred(rec)) count++; }
          if (this.countCtl === ctl) this.post({ type: 'count', done: false, matches: count, scanned: scanned, total: n });
        }
      } catch (e) {
        error = S.budgetMessage(e);
        if (!error) throw e;
      }
      res = { count: count, scanned: scanned, longLines: 0, aborted: ctl.signal.aborted, error: error };
    }
    if (this.countCtl !== ctl) return;
    this.countCtl = null;
    if (res.error) { this.post({ type: 'count', done: true, empty: true, error: res.error }); return; }
    if (!res.aborted) this.post({ type: 'count', done: true, matches: res.count, scanned: res.scanned, longLines: res.longLines, complete: this.source.complete !== false });
  }

  // ---- go to -----------------------------------------------------------------------------------

  async goTo(text, signal) {
    const j = parseJump(text);
    if (!j) return { ok: false, message: 'Enter a line number (1234), a percentage (50%), a byte offset (@1048576 or 0x1F4000) or a time (t:2026-01-15 10:30, Pro).' };
    if (j.kind === 'time') return { ok: false, needsPro: true, time: j.text };
    let line;
    if (j.kind === 'line') {
      line = j.value - 1;
      if (line >= this.source.lineCount && this.scanPromise && !this.source.complete) {
        this.post({ type: 'banner', text: 'Waiting for the line index to reach line ' + j.value.toLocaleString('en-US') + '...' });
        const ok = await this.waitForIndex(signal);
        this.post({ type: 'banner', text: '' });
        if (!ok) return { ok: false, message: 'Cancelled.' };
      }
      if (this.source.lineCount === 0) return { ok: false, message: 'The log has no lines.' };
      line = Math.min(line, this.source.lineCount - 1);
    } else if (j.kind === 'percent') {
      if (this.kind === 'merge') line = Math.floor((this.source.lineCount - 1) * j.value / 100);
      else {
        const byte = Math.min(this.file.size - 1, Math.floor(this.file.size * j.value / 100));
        let l = await this.file.lineAtOffset(byte);
        if (l === null) {
          this.post({ type: 'banner', text: 'Waiting for the line index to reach ' + j.value + '%...' });
          const ok = await this.waitForIndex(signal);
          this.post({ type: 'banner', text: '' });
          if (!ok) return { ok: false, message: 'Cancelled.' };
          l = await this.file.lineAtOffset(byte);
        }
        line = l === null ? this.source.lineCount - 1 : l;
      }
    } else {
      if (this.kind === 'merge') return { ok: false, message: 'A byte offset needs a single file; this view merges several files.' };
      let l = await this.file.lineAtOffset(j.value);
      if (l === null) {
        this.post({ type: 'banner', text: 'Waiting for the line index to reach byte ' + j.value.toLocaleString('en-US') + '...' });
        const ok = await this.waitForIndex(signal);
        this.post({ type: 'banner', text: '' });
        if (!ok) return { ok: false, message: 'Cancelled.' };
        l = await this.file.lineAtOffset(j.value);
      }
      line = l === null ? this.source.lineCount - 1 : l;
    }
    if (line < 0) line = 0;
    const row = this.rowOfLine(line);
    const exact = !this.filter.active || (this.filter.list.length > row && this.filter.list.get(row) === line);
    return { ok: true, row: row, line: line, exact: exact };
  }

  /** Finds the first line at or after a time (Pro). Bisection on the sparse index when the file is time-ordered, verified at the landing point; otherwise one streaming pass. */
  async lineAtTime(ms, signal) {
    const fmt = await this.ensureTimeFormat();
    if (!fmt) return { ok: false, message: 'No time stamps were recognised in this log, so a time cannot be found. See docs/timestamps.md.' };
    const ex = T.extractor(fmt, this.reference);
    const src = this.source;
    const total = src.lineCount;
    // Time stamp of the first timestamped line at or after `line` (within 2000 lines), as { line, ts }.
    async function probe(line) {
      const recs = await src.readLines(line, 64, { maxChars: 400 });
      for (const r of recs) { const t = ex(r.text); if (!isNaN(t)) return { line: r.no, ts: t }; }
      return null;
    }
    if (this.file && this.file.complete && total > 2000) {
      let lo = 0;
      let hi = total - 1;
      let ok = true;
      while (hi - lo > 256) {
        const mid = Math.floor((lo + hi) / 2);
        const p = await probe(mid);
        if (!p) { ok = false; break; }
        if (p.ts < ms) lo = p.line; else hi = Math.max(lo, mid);
      }
      if (ok) {
        // Verify: scan the narrowed range for the first line at or after the time, and check that the line before the range is earlier.
        const before = lo > 0 ? await probe(Math.max(0, lo - 1)) : null;
        let found = -1;
        const recs = await src.readLines(Math.max(0, lo), hi - lo + 300, { maxChars: 400 });
        for (const r of recs) { const t = ex(r.text); if (!isNaN(t) && t >= ms) { found = r.no; break; } }
        if (found >= 0 && (!before || before.ts < ms || lo === 0)) return { ok: true, line: found, method: 'bisection' };
      }
    }
    let found = -1;
    let seen = false;
    const res = await src.forEachText(0, function (rec) {
      const t = ex(rec.text);
      if (!isNaN(t)) { seen = true; if (t >= ms) { found = rec.no; return false; } }
      return true;
    }, { signal: signal });
    if (res.aborted) return { ok: false, message: 'Cancelled.' };
    if (found < 0) return { ok: false, message: seen ? 'Every time stamp in this log is earlier than the time you entered.' : 'No time stamps were found.' };
    return { ok: true, line: found, method: 'scan' };
  }

  /** Time jump (Pro): reads the time, finds the first line at or after it and tells the page to show it. */
  async jumpToTime(text, signal) {
    if (!(await this.deps.gate('Jump to a time'))) return { ok: false };
    if (this.scanPromise && this.source.complete === false) {
      this.post({ type: 'banner', text: 'Waiting for the line index...' });
      const indexed = await this.waitForIndex(signal);
      this.post({ type: 'banner', text: '' });
      if (!indexed) return { ok: false };
    }
    const ms = T.parseUserTime(text, this.reference);
    if (isNaN(ms)) { this.post({ type: 'goto', ok: false, message: 'The time was not understood. Use 2026-01-15 10:30:00, 2026-01-15T10:30:00Z or a time of day such as 10:30.' }); return { ok: false }; }
    const r = await this.lineAtTime(ms, signal);
    if (!r.ok) { this.post({ type: 'goto', ok: false, message: r.message }); return r; }
    const row = this.rowOfLine(r.line);
    this.post({ type: 'goto', ok: true, row: row, line: r.line, exact: !this.filter.active || this.filter.list.get(row) === r.line });
    return { ok: true, row: row, line: r.line, method: r.method };
  }

  // ---- bookmarks -------------------------------------------------------------------------------

  async toggleBookmark(row) {
    const line = this.lineOfRow(row);
    if (line < 0) return { ok: false };
    if (this.bookmarks.has(line)) this.bookmarks.delete(line);
    else {
      if (this.bookmarks.size >= MAX_BOOKMARKS) return { ok: false, message: 'At most ' + MAX_BOOKMARKS + ' bookmarks are kept for one log.' };
      this.bookmarks.add(line);
    }
    if (this.bookmarkKey) await this.deps.state.update(this.bookmarkKey, Array.from(this.bookmarks).sort(function (a, b) { return a - b; }));
    return { ok: true, set: this.bookmarks.has(line), line: line };
  }

  nextBookmark(row, dir) {
    const line = this.lineOfRow(row);
    const sorted = Array.from(this.bookmarks).sort(function (a, b) { return a - b; });
    if (!sorted.length) return { ok: false, message: 'This log has no bookmarks. Toggle one on the current line first.' };
    let pick;
    if (dir === 'next') { pick = sorted.find(function (n) { return n > line; }); if (pick === undefined) pick = sorted[0]; }
    else { for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < line) { pick = sorted[i]; break; } if (pick === undefined) pick = sorted[sorted.length - 1]; }
    return { ok: true, row: this.rowOfLine(pick), line: pick };
  }

  // ---- copy, details, expand -------------------------------------------------------------------

  async copyText(fromRow, toRow) {
    const a = Math.max(0, Math.min(fromRow, toRow));
    const b = Math.min(this.rowCount - 1, Math.max(fromRow, toRow));
    if (b < a) return { ok: false, message: 'Nothing is selected.' };
    let count = b - a + 1;
    let limited = false;
    if (count > COPY_MAX_ROWS) { count = COPY_MAX_ROWS; limited = true; }
    const parts = [];
    let chars = 0;
    for (let i = a; i < a + count && chars < COPY_MAX_CHARS; i += 400) {
      const n = Math.min(400, a + count - i);
      const nums = [];
      for (let k = i; k < i + n; k++) nums.push(this.lineOfRow(k));
      const map = this.filter.active ? await this.readScattered(nums) : null;
      const recs = this.filter.active ? nums.map(function (x) { return map.get(x); }).filter(Boolean) : await this.source.readLines(i, n, { maxChars: 100000 });
      for (const r of recs) { parts.push(r.tag ? '[' + r.tag + '] ' + r.text : r.text); chars += r.text.length + 1; if (chars >= COPY_MAX_CHARS) { limited = true; break; } }
    }
    await this.deps.clipboard(parts.join('\n'));
    return { ok: true, lines: parts.length, limited: limited };
  }

  async expand(row) {
    const line = this.lineOfRow(row);
    if (line < 0) return null;
    const recs = await this.source.readLines(line, 1, { maxChars: 1024 * 1024 });
    return recs[0] ? { row: row, text: sanitize(recs[0].text), truncated: !!recs[0].truncated, bl: recs[0].byteLength } : null;
  }

  async details(row) {
    const line = this.lineOfRow(row);
    if (line < 0) return null;
    const recs = await this.source.readLines(line, 1, { maxChars: 65536 });
    const rec = recs[0];
    if (!rec) return null;
    const rank = levels.levelRank(rec.text);
    const t = this.timeFormat ? T.extract(this.timeFormat, rec.text, this.reference) : NaN;
    return {
      row: row, n: rec.no + 1, text: sanitize(rec.text), truncated: !!rec.truncated, bl: rec.byteLength, o: this.kind === 'file' ? rec.offset : undefined,
      level: rank >= 0 ? LABEL[rank] : '', time: isNaN(t) ? '' : T.toIso(t), tag: rec.tag || '', canProfile: !!this.profile, looksJson: /^\s*\{/.test(rec.text)
    };
  }

  // ---- Pro: profile, table, pretty print --------------------------------------------------------

  setProfile(profile, info) { this.profile = profile; this.profileInfo = info || null; }

  async prettyJson(row) {
    const line = this.lineOfRow(row);
    const recs = await this.source.readLines(line, 1, { maxChars: 1024 * 1024 });
    if (!recs[0]) return { ok: false, message: 'The line could not be read.' };
    let text = recs[0].text.trim();
    // A line inside a prefix: the JSON object starts at the first "{" (for example "2026-01-15 INFO {...}").
    const brace = text.indexOf('{');
    if (brace > 0 && !text.startsWith('{')) text = text.slice(brace);
    try {
      const pretty = require('./pro/prettyjson').pretty(text);
      if (pretty === null) return { ok: false, message: 'This line does not contain a complete JSON object.' };
      return { ok: true, text: pretty };
    } catch (e) { return { ok: false, message: 'This line does not contain a complete JSON object.' }; }
  }

  async fieldsOf(row) {
    if (!this.profile) return { ok: false, message: 'Choose a parse profile first.' };
    const line = this.lineOfRow(row);
    const recs = await this.source.readLines(line, 1, { maxChars: 65536 });
    const f = recs[0] ? this.profile.parse(recs[0].text) : null;
    if (!f) return { ok: true, fields: [], message: 'The profile "' + this.profile.label + '" does not parse this line.' };
    return { ok: true, fields: Object.keys(f).slice(0, 200).map(function (k) { return [k, String(f[k]).slice(0, 2000)]; }) };
  }

  /** A bounded window of parsed rows (Pro): { columns, rows: [{ n, cells }], sorted }. */
  async table(firstRow, sort) {
    if (!this.profile) return { ok: false, message: 'Choose a parse profile first.' };
    const P = require('./pro/profiles');
    const count = Math.min(TABLE_ROWS, Math.max(0, this.rowCount - firstRow));
    const rows = [];
    const cols = [];
    const seen = new Set();
    // The rows of one window share one work limit (a profile pattern that is costly for these lines is
    // stopped with a message, not after minutes), and the loop gives the event loop a turn every few
    // milliseconds, so that a costly profile never holds the editor.
    const ctx = { meter: safere.createMeter(safere.BATCH_LIMIT) };
    const pace = S.pacer();
    try {
      for (let i = firstRow; i < firstRow + count; i += 250) {
        const n = Math.min(250, firstRow + count - i);
        const nums = [];
        for (let k = i; k < i + n; k++) nums.push(this.lineOfRow(k));
        const map = await this.readScattered(nums);
        for (const num of nums) {
          const rec = map.get(num);
          if (!rec) continue;
          const f = this.profile.parse(rec.text, ctx);
          if (f) for (const k of Object.keys(f)) if (!seen.has(k) && cols.length < 30) { seen.add(k); cols.push(k); }
          rows.push({ n: rec.no + 1, f: f });
          const turn = pace();
          if (turn) await turn;
        }
      }
    } catch (e) {
      const message = S.budgetMessage(e);
      if (!message) throw e;
      return { ok: false, message: 'The table could not be built: ' + message };
    }
    if (sort && sort.col && cols.indexOf(sort.col) !== -1) {
      const dir = sort.dir === 'desc' ? -1 : 1;
      const c = sort.col;
      rows.sort(function (x, y) {
        const a = x.f && x.f[c] !== undefined ? x.f[c] : undefined;
        const b = y.f && y.f[c] !== undefined ? y.f[c] : undefined;
        if (a === undefined && b === undefined) return x.n - y.n;
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        return dir * P.compareValues(a, b) || x.n - y.n;
      });
    }
    return { ok: true, first: firstRow, window: rows.length, total: this.rowCount, columns: cols, rows: rows.map(function (r) { return { n: r.n, cells: cols.map(function (c) { return r.f && r.f[c] !== undefined ? String(r.f[c]).slice(0, 300) : ''; }) }; }), sorted: sort && sort.col ? sort : null };
  }

  // ---- follow ----------------------------------------------------------------------------------

  startFollow() {
    if (!this.hasFile || this.follow.on) return;
    this.follow.on = true;
    this.follow.paused = false;
    const self = this;
    this.follow.timer = setInterval(function () { self.poll(); }, this.settings.followIntervalMs);
    this.post({ type: 'follow', on: true, paused: false });
  }

  stopFollow() {
    this.follow.on = false;
    this.follow.paused = false;
    if (this.follow.timer) clearInterval(this.follow.timer);
    this.follow.timer = null;
    this.post({ type: 'follow', on: false, paused: false });
  }

  setPaused(paused) {
    if (!this.follow.on) return;
    this.follow.paused = !!paused;
    this.post({ type: 'follow', on: true, paused: this.follow.paused });
  }

  async poll() {
    if (this.follow.polling || this.disposed || !this.hasFile || this.scanBusy) return { kind: 'busy' };
    this.follow.polling = true;
    try {
      const before = this.file.lineCount;
      const r = await this.file.refresh();
      if (r.kind === 'missing') {
        if (!this.follow.missingReported) { this.follow.missingReported = true; this.post({ type: 'banner', text: 'The file is not there at the moment (it may be rotating). Waiting for it to come back.' }); }
        return r;
      }
      if (this.follow.missingReported && r.kind !== 'missing') { this.follow.missingReported = false; this.post({ type: 'banner', text: '' }); }
      if (r.kind === 'grown') {
        if (r.reset) await this.resetViews('The file started to fill; it was read again from the start.');
        this.scanBusy = true;
        try { await this.file.scan(); } finally { this.scanBusy = false; }
        await this.extendFilter(before);
        this.post({ type: 'total', total: this.rowCount, follow: this.follow.on, paused: this.follow.paused, added: this.file.lineCount - before });
      } else if (r.kind === 'truncated' || r.kind === 'rotated' || r.kind === 'modified') {
        await this.resetViews(r.kind === 'truncated' ? 'The file was truncated; it was read again from the start.' : r.kind === 'rotated' ? 'The file was replaced (log rotation); the new file is shown from the start.' : 'The start of the file changed; it was read again from the start.');
        this.scanBusy = true;
        try { await this.file.scan(); } finally { this.scanBusy = false; }
        this.post({ type: 'reset', total: this.rowCount, message: this.opNote });
      }
      return r;
    } catch (e) {
      this.post({ type: 'banner', text: 'Follow mode could not read the file: ' + (e && e.message ? e.message : 'unknown error') });
      return { kind: 'error' };
    } finally { this.follow.polling = false; }
  }

  async resetViews(note) {
    this.cancelFilter();
    if (this.countCtl) this.countCtl.abort();
    this.filter = { active: false, list: null, spec: null, running: false, ctl: null, info: null };
    this.bookmarks = new Set();
    this.timeChecked = false;
    this.opNote = note;
  }

  // Applies the active filter to the lines that were added (follow mode).
  async extendFilter(oldLineCount) {
    if (!this.filter.active || this.filter.running) return;
    const built = await this.buildPredicate(this.filter.spec);
    if (!built.pred) return;
    const lastLine = oldLineCount;
    const res = await S.runFilter(this.source, built.pred, { start: lastLine, list: this.filter.list, limit: this.settings.filterMaxMatches });
    if (res.error) this.post({ type: 'banner', kind: 'warn', text: 'The new lines were not filtered: ' + res.error });
  }

  async setEncoding(encoding) {
    if (!this.hasFile) return { ok: false, message: 'The encoding can only be changed for a single file.' };
    if (encoding !== 'auto' && E.ENCODINGS.indexOf(encoding) === -1) return { ok: false, message: 'Unknown encoding.' };
    if (this.scanCtl) this.scanCtl.abort();
    if (this.scanPromise) await this.scanPromise.catch(function () { /* ended */ });
    await this.resetViews('');
    if (encoding === 'auto') { this.file.encodingForced = false; await this.file.reopen(); } else await this.file.setEncoding(encoding);
    await this.startIndexing();
    this.post({ type: 'reset', total: this.rowCount, message: 'The file is now read as ' + E.labelOf(this.file.encoding) + '.' });
    this.post({ type: 'init', info: this.info() });
    return { ok: true };
  }

  // ---- information -----------------------------------------------------------------------------

  info() {
    const f = this.file;
    return {
      title: this.title, kind: this.kind, size: this.source ? this.source.size : 0, sizeText: fmtBytes(this.source ? this.source.size : 0),
      encoding: f ? f.encoding : 'utf8', encodingLabel: f ? E.labelOf(f.encoding) : 'UTF-8', binary: f ? f.binary : false, encodingReason: f ? f.encodingReason : '',
      total: this.rowCount, complete: this.source ? this.source.complete !== false : true, colour: this.settings.colourLevels, pro: !!this.profile,
      profile: this.profile ? this.profile.label : '', maxLineChars: this.settings.maxLineChars, canFollow: this.hasFile
    };
  }

  statusText(row) {
    if (!this.source) return '';
    const total = this.rowCount;
    const line = this.lineOfRow(row);
    if (line < 0) return '';
    const pct = total > 1 ? Math.round(row / (total - 1) * 100) : 100;
    let text = 'Ln ' + (line + 1).toLocaleString('en-US') + ' of ' + this.source.lineCount.toLocaleString('en-US') + (this.source.complete === false ? '+' : '');
    if (this.filter.active) text += ' (row ' + (row + 1).toLocaleString('en-US') + ' of ' + total.toLocaleString('en-US') + ' shown)';
    text += '  ' + pct + '%  ' + fmtBytes(this.source.size);
    if (this.file) text += '  ' + E.labelOf(this.file.encoding);
    return text;
  }

  // ---- messages from the page ------------------------------------------------------------------

  async handle(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'ready': this.post({ type: 'init', info: this.info(), bookmarks: Array.from(this.bookmarks).length }); break;
        case 'rows': {
          const first = Math.max(0, wholeNumber(msg.first, 0));
          const rows = await this.makeRows(first, wholeNumber(msg.count, 0));
          this.post({ type: 'rows', id: msg.id, first: first, rows: rows, total: this.rowCount });
          break;
        }
        case 'search': {
          const set = this.setSearch(msg.spec);
          if (!set.ok) { this.post({ type: 'found', id: msg.id, error: set.error }); break; }
          if (set.empty) { this.post({ type: 'found', id: msg.id, cleared: true }); this.post({ type: 'count', done: true, matches: 0, empty: true }); break; }
          if (this.findCtl) this.findCtl.abort();
          const ctl = new AbortController();
          this.findCtl = ctl;
          const r = await this.findRow(msg.dir === 'prev' ? 'prev' : 'next', wholeNumber(msg.from, -1), ctl.signal);
          if (this.findCtl === ctl) this.findCtl = null;
          if (r.aborted) break;
          if (r.error) { this.post({ type: 'found', id: msg.id, error: r.error }); break; }
          this.post({ type: 'found', id: msg.id, row: r.row, wrapped: !!r.wrapped, longLines: r.longLines || 0, none: r.row === null, partial: r.row === null && this.source.complete === false });
          if (msg.count) this.countMatches();
          break;
        }
        case 'count': this.countMatches(); break;
        case 'filter': await this.applyFilter(msg.spec); break;
        case 'clearFilter': this.clearFilter(msg.anchor); break;
        case 'cancel':
          if (this.findCtl) this.findCtl.abort();
          if (this.countCtl) this.countCtl.abort();
          if (this.goCtl) this.goCtl.abort();
          if (this.filter.running) this.cancelFilter();
          break;
        case 'goto': {
          if (this.goCtl) this.goCtl.abort();
          const ctl = new AbortController();
          this.goCtl = ctl;
          const r = await this.goTo(msg.text, ctl.signal);
          if (this.goCtl === ctl) this.goCtl = null;
          if (r.needsPro) { await this.jumpToTime(r.time, ctl.signal); break; }
          this.post({ type: 'goto', ok: r.ok, row: r.row, line: r.line, exact: r.exact, message: r.message });
          break;
        }
        case 'follow': if (msg.on) this.startFollow(); else this.stopFollow(); break;
        case 'pause': this.setPaused(!!msg.on); break;
        case 'bookmark': {
          const r = await this.toggleBookmark(wholeNumber(msg.row, -1));
          this.post({ type: 'bookmark', ok: r.ok, set: r.set, row: msg.row, message: r.message, count: this.bookmarks.size });
          break;
        }
        case 'bookmarkJump': { const r = this.nextBookmark(wholeNumber(msg.row, 0), msg.dir === 'prev' ? 'prev' : 'next'); this.post({ type: 'goto', ok: r.ok, row: r.row, line: r.line, exact: true, message: r.message }); break; }
        case 'copy': {
          const r = await this.copyText(wholeNumber(msg.from, 0), wholeNumber(msg.to, 0));
          this.post({ type: 'copied', ok: r.ok, lines: r.lines, limited: r.limited, message: r.message });
          break;
        }
        case 'expand': { const r = await this.expand(wholeNumber(msg.row, -1)); if (r) this.post({ type: 'expanded', row: r.row, text: r.text, truncated: r.truncated, bl: r.bl }); break; }
        case 'details': { const row = wholeNumber(msg.row, -1); const d = await this.details(row); this.post({ type: 'details', row: row, d: d }); break; }
        case 'pretty': {
          if (!(await this.deps.gate('Pretty-printed JSON in the details pane'))) { this.post({ type: 'pretty', row: msg.row, ok: false, locked: true }); break; }
          const r = await this.prettyJson(wholeNumber(msg.row, -1));
          this.post({ type: 'pretty', row: msg.row, ok: r.ok, text: r.text, message: r.message });
          break;
        }
        case 'fields': {
          if (!(await this.deps.gate('Parsed fields in the details pane'))) { this.post({ type: 'fields', row: msg.row, ok: false, locked: true }); break; }
          const r = await this.fieldsOf(wholeNumber(msg.row, -1));
          this.post({ type: 'fields', row: msg.row, ok: r.ok, fields: r.fields, message: r.message });
          break;
        }
        case 'table': {
          if (!(await this.deps.gate('Parse profile columns'))) { this.post({ type: 'table', ok: false, locked: true }); break; }
          const r = await this.table(Math.max(0, wholeNumber(msg.first, 0)), msg.sort && typeof msg.sort === 'object' ? { col: String(msg.sort.col || ''), dir: msg.sort.dir === 'desc' ? 'desc' : 'asc' } : null);
          this.post(Object.assign({ type: 'table' }, r));
          break;
        }
        case 'view': {
          this.cursor = Math.max(0, wholeNumber(msg.cursor, 0));
          this.deps.status(this.statusText(this.cursor));
          break;
        }
        case 'encoding': await this.setEncoding(msg.value); break;
        default: break;
      }
    } catch (e) {
      this.post({ type: 'error', message: e && e.message ? e.message : 'The request could not be completed.' });
    }
  }

  dispose() {
    this.disposed = true;
    for (const c of [this.scanCtl, this.countCtl, this.findCtl, this.goCtl, this.filter.ctl]) if (c) c.abort();
    this.stopFollow();
    if (this.file) this.file.close();
  }
}

module.exports = { LogSession, parseJump, fmtBytes };
