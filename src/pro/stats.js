'use strict';
// Statistics (Pro) in one streaming pass: counts by level, rate histogram over time, top values of
// chosen fields and error bursts. Memory is bounded: the histogram merges neighbouring buckets when
// it grows past MAX_BUCKETS, and the value counters stop tracking new distinct values at
// MAX_DISTINCT (the result says how many values were not tracked, so a count is never silently
// wrong).

const levels = require('../engine/levels');
const T = require('../engine/timestamps');
const { throttled, pacer } = require('../engine/search');

const MAX_BUCKETS = 2048;
const MAX_DISTINCT = 200000;
const KEEP_BURSTS = 10;

/**
 * Options: profile (from profiles.js, optional), topFields (names), topN (10), timeFormat,
 * reference, burst { minCount (5), gapMs (10000), minRank (4) }, signal, onProgress.
 */
async function computeStats(source, options) {
  const o = options || {};
  const topN = o.topN || 10;
  const timeOf = o.timeFormat ? T.extractor(o.timeFormat, o.reference) : null;
  const profile = o.profile || null;
  const topFields = profile ? (o.topFields || []) : [];
  const counters = {};
  const untracked = {};
  for (const f of topFields) { counters[f] = new Map(); untracked[f] = 0; }
  const levelCounts = [0, 0, 0, 0, 0, 0];
  let noLevel = 0;
  let lines = 0;
  let timed = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let width = 1000;
  let hist = new Map();
  const burstMin = (o.burst && o.burst.minCount) || 5;
  const burstGap = (o.burst && o.burst.gapMs) || 10000;
  const burstRank = (o.burst && o.burst.minRank) || 4;
  const lineGap = 25;
  let current = null;
  const bursts = [];
  let lastLineTs = NaN;
  let lastRank = -1;
  const report = o.onProgress ? throttled(o.onProgress, 150) : null;
  const total = source.lineCount;

  function closeBurst() {
    if (current && current.count >= burstMin) {
      bursts.push(current);
      bursts.sort(function (a, b) { return b.count - a.count || a.startLine - b.startLine; });
      if (bursts.length > KEEP_BURSTS) bursts.length = KEEP_BURSTS;
    }
    current = null;
  }
  function rebin() {
    width *= 2;
    const next = new Map();
    for (const [k, v] of hist) {
      const nk = Math.floor(k / width) * width;
      const e = next.get(nk);
      if (e) { e.n += v.n; e.err += v.err; } else next.set(nk, { n: v.n, err: v.err });
    }
    hist = next;
  }

  const pace = pacer(o.signal);
  const res = await source.forEachText(0, function (rec) {
    lines++;
    const text = rec.text;
    let rank = levels.levelRank(text);
    let fields = null;
    if (profile && (topFields.length || rank < 0)) {
      fields = profile.parse(text);
      if (fields && rank < 0 && fields.level) rank = levels.rankOfWord(fields.level);
    }
    if (rank >= 0) { levelCounts[rank]++; lastRank = rank; } else noLevel++;
    let ts = timeOf ? timeOf(text) : NaN;
    if (!isNaN(ts)) {
      timed++;
      lastLineTs = ts;
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
      const key = Math.floor(ts / width) * width;
      let e = hist.get(key);
      if (!e) { e = { n: 0, err: 0 }; hist.set(key, e); }
      e.n++;
      if (rank >= burstRank) e.err++;
      if (hist.size > MAX_BUCKETS) rebin();
    } else if (!timeOf) ts = lines; // without time stamps, bursts are measured in lines
    else ts = lastLineTs;
    if (rank >= burstRank) {
      const unit = timeOf ? burstGap : lineGap;
      const when = timeOf ? ts : lines;
      if (current && !isNaN(when) && when - current.lastWhen <= unit && when - current.lastWhen >= -unit) {
        current.count++; current.endLine = rec.no; current.lastWhen = when; current.endTs = timeOf ? ts : NaN;
      } else {
        closeBurst();
        current = { startLine: rec.no, endLine: rec.no, count: 1, lastWhen: when, startTs: timeOf ? ts : NaN, endTs: timeOf ? ts : NaN };
      }
    }
    if (fields) {
      for (const f of topFields) {
        const v = fields[f];
        if (v === undefined) continue;
        const m = counters[f];
        const c = m.get(v);
        if (c !== undefined) m.set(v, c + 1);
        else if (m.size < MAX_DISTINCT) m.set(v, 1);
        else untracked[f]++;
      }
    }
    if (report && (lines & 1023) === 0) report({ scanned: lines, total: total });
    return pace() || true;
  }, { signal: o.signal });
  if (pace.stopped) res.aborted = true;
  closeBurst();
  void lastRank;
  if (report) report({ scanned: lines, total: total }, true);

  // The histogram as a sorted list, merged to at most `maxBuckets` bars.
  const maxBars = o.maxBars || 60;
  let w = width;
  let map = hist;
  const keys = Array.from(map.keys()).sort(function (a, b) { return a - b; });
  while (keys.length && (keys[keys.length - 1] - keys[0]) / w + 1 > maxBars) {
    w *= 2;
    const next = new Map();
    for (const [k, v] of map) {
      const nk = Math.floor(k / w) * w;
      const e = next.get(nk);
      if (e) { e.n += v.n; e.err += v.err; } else next.set(nk, { n: v.n, err: v.err });
    }
    map = next;
    keys.length = 0;
    for (const k of map.keys()) keys.push(k);
    keys.sort(function (a, b) { return a - b; });
  }
  const buckets = [];
  if (keys.length) for (let k = keys[0]; k <= keys[keys.length - 1]; k += w) { const e = map.get(k); buckets.push({ start: k, count: e ? e.n : 0, errors: e ? e.err : 0 }); }

  const top = {};
  for (const f of topFields) {
    const arr = Array.from(counters[f].entries()).sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }).slice(0, topN);
    top[f] = arr.map(function (p) { return { value: p[0], count: p[1] }; });
  }
  const lv = {};
  levels.LEVELS.forEach(function (l, i) { lv[l.id] = levelCounts[i]; });
  lv.none = noLevel;
  return {
    lines: lines, levels: lv, timed: timed, untimed: lines - timed, timeFormat: o.timeFormat || '',
    firstTime: isFinite(firstTs) ? firstTs : null, lastTime: isFinite(lastTs) ? lastTs : null,
    histogram: { widthMs: w, buckets: buckets }, bursts: bursts.map(function (b) { return { startLine: b.startLine, endLine: b.endLine, count: b.count, startTime: isNaN(b.startTs) ? null : b.startTs, endTime: isNaN(b.endTs) ? null : b.endTs }; }),
    burstUnit: timeOf ? 'time' : 'lines', top: top, untracked: untracked, distinctLimit: MAX_DISTINCT, longLines: res.longLines, aborted: res.aborted
  };
}

module.exports = { computeStats, MAX_DISTINCT };
