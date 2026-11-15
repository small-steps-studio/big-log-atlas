'use strict';
// Search and filter passes over a source. Every pass streams (no file is held in memory), can be
// cancelled with an AbortSignal and reports its progress. Nothing is dropped silently: a pass
// reports the lines it could only read in part (`longLines`) and says when a result list was cut at
// its limit (`limited`).

const levels = require('./levels');
const T = require('./timestamps');

const BACK_BLOCK = 64;
const BACK_CHARS = 262144;
// A pass gives the event loop a turn at least this often (milliseconds of work between turns).
const YIELD_MS = 15;

function throttled(fn, ms) {
  let last = 0;
  return function (v, force) { const now = Date.now(); if (force || now - last >= ms) { last = now; fn(v); } };
}

/**
 * Cooperative yielding for the per-line callbacks of a pass. Call the result after every line:
 * it returns undefined while less than YIELD_MS have passed, and otherwise a promise that resolves
 * on the next turn of the event loop to false when the signal was aborted meanwhile (so the pass
 * stops) and to true otherwise. With the work limit of the regular expression engine (one call
 * never needs more than a fraction of a second) this keeps the extension host responsive.
 */
function pacer(signal) {
  let last = Date.now();
  const pace = function () {
    const now = Date.now();
    if (now - last < YIELD_MS) return undefined;
    return new Promise(function (resolve) {
      setImmediate(function () {
        last = Date.now();
        const go = !(signal && signal.aborted);
        if (!go) pace.stopped = true;
        resolve(go);
      });
    });
  };
  pace.stopped = false;
  return pace;
}

/** The message of a regular expression call that was stopped by the work limit, or '' for any other error. */
function budgetMessage(e) { return e && e.name === 'RegexError' && e.code === 'budget' ? e.message : ''; }

/** Next line after `after` (exclusive) that satisfies pred(rec); resolves to { line, longLines } (line null when none). */
async function findNext(source, pred, after, opts) {
  const o = opts || {};
  let found = null;
  const pace = pacer(o.signal);
  let r;
  try {
    r = await source.forEachText(Math.max(0, after + 1), function (rec) {
      if (pred(rec)) { found = rec.no; return false; }
      return pace() || true;
    }, { signal: o.signal, onChunk: o.onChunk });
  } catch (e) {
    const m = budgetMessage(e);
    if (!m) throw e;
    return { line: null, aborted: false, longLines: 0, error: m };
  }
  return { line: found, aborted: r.aborted || pace.stopped, longLines: r.longLines };
}

/** Previous line before `before` (exclusive) that satisfies pred(rec); lines are read in blocks, backwards. */
async function findPrevious(source, pred, before, opts) {
  const o = opts || {};
  let end = Math.min(before, source.lineCount);
  let longLines = 0;
  while (end > 0) {
    if (o.signal && o.signal.aborted) return { line: null, aborted: true, longLines: longLines };
    const first = Math.max(0, end - BACK_BLOCK);
    const lines = await source.readLines(first, end - first, { maxChars: BACK_CHARS });
    try {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].truncated) longLines++;
        if (pred(lines[i])) return { line: lines[i].no, aborted: false, longLines: longLines };
      }
    } catch (e) {
      const m = budgetMessage(e);
      if (!m) throw e;
      return { line: null, aborted: false, longLines: longLines, error: m };
    }
    end = first;
    if (o.onChunk) o.onChunk(end);
  }
  return { line: null, aborted: false, longLines: longLines };
}

/** Counts the lines that satisfy pred; resolves to { count, scanned, longLines, aborted }. */
async function countMatches(source, pred, opts) {
  const o = opts || {};
  let count = 0;
  let scanned = 0;
  const total = source.lineCount;
  const report = o.onProgress ? throttled(o.onProgress, 120) : null;
  const pace = pacer(o.signal);
  let r;
  try {
    r = await source.forEachText(0, function (rec) {
      scanned++;
      if (pred(rec)) count++;
      if (report && (scanned & 1023) === 0) report({ scanned: scanned, total: total, count: count });
      return pace() || true;
    }, { signal: o.signal });
  } catch (e) {
    const m = budgetMessage(e);
    if (!m) throw e;
    return { count: count, scanned: scanned, longLines: 0, aborted: false, error: m };
  }
  if (report) report({ scanned: scanned, total: total, count: count }, true);
  return { count: count, scanned: scanned, longLines: r.longLines, aborted: r.aborted || pace.stopped };
}

/** A growable list of line numbers (the result of a filter), capped at `limit` entries. */
class MatchList {
  constructor(limit) {
    this.limit = limit || 2000000;
    this.cap = 1024;
    this.a = new Float64Array(this.cap);
    this.length = 0;
    this.limited = false;
  }
  push(no) {
    if (this.length >= this.limit) { this.limited = true; return false; }
    if (this.length === this.cap) { this.cap *= 2; const b = new Float64Array(this.cap); b.set(this.a); this.a = b; }
    this.a[this.length++] = no;
    return true;
  }
  get(i) { return this.a[i]; }
  /** Index of the first entry whose line number is >= no (the length when there is none). */
  lowerBound(no) {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.a[mid] < no) lo = mid + 1; else hi = mid; }
    return lo;
  }
}

/**
 * Builds the predicate of a view filter. Options: matcher (text or regular expression),
 * levels (array of ranks to keep; null or empty = all), keepContinuation (lines without a level or
 * a time stamp follow the record above them, default true), timeFormat/reference/from/to
 * (milliseconds; Pro), extra (a function rec -> boolean, for example field filters; Pro).
 * The predicate keeps state (the record above), so use one predicate per pass, in line order.
 */
function makePredicate(options) {
  const o = options || {};
  const matcher = o.matcher && !o.matcher.empty ? o.matcher : null;
  const keep = o.levels && o.levels.length ? new Set(o.levels) : null;
  const keepCont = o.keepContinuation !== false;
  const time = o.timeFormat ? T.extractor(o.timeFormat, o.reference) : null;
  const from = typeof o.from === 'number' && !isNaN(o.from) ? o.from : -Infinity;
  const to = typeof o.to === 'number' && !isNaN(o.to) ? o.to : Infinity;
  const timed = time && (from > -Infinity || to < Infinity);
  const extra = typeof o.extra === 'function' ? o.extra : null;
  let lastRank = -1;
  let lastTimeOk = true;
  return function (rec) {
    const text = rec.text;
    let ok = true;
    if (keep) {
      let r = levels.levelRank(text);
      if (r >= 0) lastRank = r;
      else if (keepCont) {
        // A line without a level of its own belongs to the record above (a stack trace line, for
        // example) unless it starts a new record, which is recognised by its time stamp.
        if (time && !isNaN(time(text))) lastRank = -1;
        r = lastRank;
      }
      ok = r >= 0 && keep.has(r);
    }
    if (ok && timed) {
      const t = time(text);
      if (!isNaN(t)) lastTimeOk = t >= from && t <= to;
      ok = lastTimeOk;
    }
    if (ok && matcher) ok = matcher.test(text);
    if (ok && extra) ok = extra(rec);
    return ok;
  };
}

/** Runs a filter pass and collects the matching line numbers. Resolves to { list, scanned, longLines, aborted, limited }. */
async function runFilter(source, pred, opts) {
  const o = opts || {};
  const list = o.list || new MatchList(o.limit);
  let scanned = 0;
  const total = source.lineCount;
  const report = o.onProgress ? throttled(o.onProgress, 150) : null;
  const pace = pacer(o.signal);
  let r;
  try {
    r = await source.forEachText(Math.max(0, o.start || 0), function (rec) {
      scanned++;
      if (pred(rec) && !list.push(rec.no)) { if (o.onLimit) o.onLimit(); return false; }
      if (report && (scanned & 1023) === 0) report({ scanned: scanned, total: total, matches: list.length });
      return pace() || true;
    }, { signal: o.signal });
  } catch (e) {
    const m = budgetMessage(e);
    if (!m) throw e;
    return { list: list, scanned: scanned, longLines: 0, aborted: false, limited: list.limited, error: m };
  }
  if (report) report({ scanned: scanned, total: total, matches: list.length }, true);
  return { list: list, scanned: scanned, longLines: r.longLines, aborted: r.aborted || pace.stopped, limited: list.limited };
}

module.exports = { findNext, findPrevious, countMatches, makePredicate, runFilter, MatchList, throttled, pacer, budgetMessage, YIELD_MS };
