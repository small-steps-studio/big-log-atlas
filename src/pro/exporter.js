'use strict';
// Streaming export of the lines of a source that satisfy a predicate (Pro): plain text, CSV, JSON
// or JSON lines. The output is written in blocks as the lines are read, so a multi-gigabyte log can
// be exported with a small, constant amount of memory. CSV cells that a spreadsheet would run as a
// formula (a leading = + - @ tab or carriage return) get a leading apostrophe unless the user turned
// that off. Lines read only in part (longer than the scan limit) are counted in the result.

const fsp = require('node:fs/promises');
const levels = require('../engine/levels');
const T = require('../engine/timestamps');
const { throttled, pacer } = require('../engine/search');

const FLUSH_BYTES = 1024 * 1024;
const DISCOVER_LINES = 2000;
const MAX_COLUMNS = 30;

/** One CSV cell: quoted when needed, doubled quotes, and neutralised when it would start a formula. */
function csvCell(value, neutralise) {
  let s = value === undefined || value === null ? '' : String(value);
  if (neutralise !== false && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s) || s !== s.trim()) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * The column names for the export: the first fields of the matching lines. With `transform` (an
 * anonymised export) the names are read from the anonymised text, so a name that holds an e-mail
 * address or an IP address (a JSON key) is replaced in the header as it is in the lines. The pass
 * gives the event loop a turn every few milliseconds and stops when the signal is aborted.
 */
async function discoverFields(source, pred, profile, signal, transform) {
  const seen = new Map();
  let n = 0;
  const pace = pacer(signal);
  const res = await source.forEachText(0, function (rec) {
    if (!pred(rec)) return pace() || true;
    const f = profile.parse(transform ? transform(rec.text) : rec.text);
    if (f) for (const k of Object.keys(f)) if (!seen.has(k)) seen.set(k, seen.size);
    n++;
    if (!(n < DISCOVER_LINES && seen.size < MAX_COLUMNS * 4)) return false;
    return pace() || true;
  }, { signal: signal });
  void res;
  return Array.from(seen.keys()).slice(0, MAX_COLUMNS);
}

/**
 * Options: outPath, format ('text'|'csv'|'json'|'jsonl'), pred (rec -> bool; a fresh predicate),
 * profile, timeFormat, reference, neutralise (default true), transform (text -> text, for
 * anonymisation), discoverTransform (the same without counting, used to find the column names;
 * default: transform.quiet, a function that does not count, or transform), fieldRule (the anonymiser's rules for fields), includeTag, signal, onProgress.
 *
 * With a transform, the text of a line is anonymised first and the fields are parsed from the
 * anonymised text, so a field can never hold a value that the text column has replaced (a value
 * on its own, such as a bare password, would not be recognised by the rules, which need the
 * context of the line). The source tag of a merged view goes through the transform as well.
 * Resolves to { written, scanned, longLines, aborted, columns }. When a line cannot be processed
 * (the transform refuses it, for example because a rule needs too much work) the output file is
 * removed and the error is thrown: an incomplete copy is never left behind.
 */
async function exportLines(source, options) {
  const o = options || {};
  const format = o.format || 'text';
  const pred = o.pred || function () { return true; };
  const profile = o.profile || null;
  const timeOf = o.timeFormat ? T.extractor(o.timeFormat, o.reference) : null;
  const transform = o.transform || null;
  const fieldRule = o.fieldRule || null;
  const withTag = o.includeTag === true || source.kind === 'merge';
  let columns = [];
  if (profile && (format === 'csv' || format === 'json' || format === 'jsonl')) {
    columns = await discoverFields(source, o.freshPred ? o.freshPred() : pred, profile, o.signal, o.discoverTransform || (transform && transform.quiet) || transform);
  }
  const fh = await fsp.open(o.outPath, 'w');
  let pending = [];
  let pendingBytes = 0;
  async function flush() {
    if (!pendingBytes) return;
    const data = Buffer.from(pending.join(''), 'utf8');
    pending = []; pendingBytes = 0;
    await fh.write(data);
  }
  async function emit(text) { pending.push(text); pendingBytes += text.length; if (pendingBytes >= FLUSH_BYTES) await flush(); }

  let written = 0;
  let scanned = 0;
  const total = source.lineCount;
  const report = o.onProgress ? throttled(o.onProgress, 200) : null;
  const head = ['line', 'time', 'level'].concat(withTag ? ['source'] : []).concat(columns.filter(function (c) { return ['line', 'time', 'level', 'source', 'text'].indexOf(c) === -1; })).concat(['text']);
  const fieldCols = columns.filter(function (c) { return ['line', 'time', 'level', 'source', 'text'].indexOf(c) === -1; });
  if (format === 'csv') await emit(head.map(function (h) { return csvCell(h, o.neutralise); }).join(',') + '\r\n');
  if (format === 'json') await emit('[');

  // One line of output per matching line; the callback stays synchronous and returns a promise only
  // when a block has to be written (which keeps memory constant for any file size).
  // The place of a value in the text that a field rule has replaced: after a colon or an equals sign
  // (and an opening quote). The value is replaced there, so that the text column and the field column
  // agree; a value of 8 or more characters that is not found there is replaced wherever it is.
  function carry(text, before, after) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(before, from);
      if (i < 0) break;
      let k = i - 1;
      while (k >= 0 && (text[k] === ' ' || text[k] === '"' || text[k] === "'")) k--;
      if (k >= 0 && (text[k] === ':' || text[k] === '=')) return text.slice(0, i) + after + text.slice(i + before.length);
      from = i + 1;
    }
    return before.length >= 8 ? text.split(before).join(after) : text;
  }
  // The fields of a line and its text. The fields are parsed from the text as it is written, so a
  // field never holds what the text column replaced; a field whose name says secret (with its value:
  // the same decision as for the text) is replaced in full and the value is replaced in the text too.
  function fieldsOf(rec, text) {
    if (!fieldCols.length) return { fields: null, text: text };
    const fields = profile.parse(text) || {};
    let t = text;
    if (fieldRule) {
      // A value that a reader decoded from an escape is not in the text as it is written: it goes
      // through the rules once more.
      const escaped = text.indexOf('\\') !== -1;
      for (const c of fieldCols) {
        const v = fields[c];
        if (v === undefined) continue;
        if (fieldRule.needs(c, v)) {
          const r = fieldRule.apply(c, v);
          if (r !== v) { fields[c] = r; t = carry(t, String(v), r); }
        } else if (escaped && typeof v === 'string' && text.indexOf(v) === -1) fields[c] = fieldRule.scan(v);
      }
    }
    return { fields: fields, text: t };
  }
  function format1(rec) {
    let text = transform ? transform(rec.text) : rec.text;
    if (format === 'text') return text + '\n';
    const t = timeOf ? timeOf(rec.text) : NaN;
    const rank = levels.levelRank(rec.text);
    const timeText = isNaN(t) ? '' : T.toIso(t);
    const levelText = rank < 0 ? '' : levels.LEVELS[rank].id;
    const parsed = fieldsOf(rec, text);
    const fields = parsed.fields;
    text = parsed.text;
    const tag = withTag ? (transform ? transform(rec.tag || '') : rec.tag || '') : '';
    if (format === 'csv') {
      const cells = [String(rec.no + 1), timeText, levelText];
      if (withTag) cells.push(tag);
      for (const c of fieldCols) cells.push(fields && fields[c] !== undefined ? fields[c] : '');
      cells.push(text);
      return cells.map(function (c) { return csvCell(c, o.neutralise); }).join(',') + '\r\n';
    }
    const obj = { line: rec.no + 1 };
    if (timeText) obj.time = timeText;
    if (levelText) obj.level = levelText;
    if (withTag) obj.source = tag;
    if (fields) { obj.fields = {}; for (const c of fieldCols) if (fields[c] !== undefined) obj.fields[c] = fields[c]; }
    obj.text = text;
    const json = JSON.stringify(obj);
    if (format === 'jsonl') return json + '\n';
    return (written === 0 ? '\n  ' : ',\n  ') + json;
  }

  let res;
  let failed = false;
  const pace = pacer(o.signal);
  try {
    res = await source.forEachText(0, function (rec) {
      scanned++;
      if (pred(rec)) {
        pending.push(format1(rec));
        pendingBytes += pending[pending.length - 1].length;
        written++;
      }
      if (report && (scanned & 1023) === 0) report({ scanned: scanned, total: total, written: written });
      if (pendingBytes >= FLUSH_BYTES) return flush().then(function () { return pace() || true; });
      return pace() || true;
    }, { signal: o.signal });
    if (pace.stopped) res.aborted = true;
    if (format === 'json') pending.push(written ? '\n]\n' : ']\n');
    await flush();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    await fh.close();
    if (failed) { try { await fsp.rm(o.outPath, { force: true }); } catch (e2) { /* the partial file stays */ } }
  }
  if (report) report({ scanned: scanned, total: total, written: written }, true);
  return { written: written, scanned: scanned, longLines: res.longLines, aborted: res.aborted, columns: fieldCols };
}

module.exports = { exportLines, csvCell, discoverFields };
