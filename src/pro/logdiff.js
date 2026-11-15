'use strict';
// Comparison of two log excerpts (Pro). Both excerpts are normalised first (time stamps, UUIDs,
// long hexadecimal ids, memory addresses and long numbers are replaced by placeholders), then the
// lines are compared with the Myers algorithm. The comparison is bounded: when the two excerpts
// differ by more than MAX_EDITS lines it says so instead of returning a partial answer.

const MAX_LINES = 20000;
const MAX_EDITS = 2000;

const RULES = [
  { id: 'time', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?: ?(?:Z|[+-]\d{2}(?::?\d{2})?))?/g, to: '<time>' },
  { id: 'time', re: /\[\d{1,2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?\]/g, to: '<time>' },
  { id: 'time', re: /\b[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}\b/g, to: '<time>' },
  { id: 'time', re: /\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?\b/g, to: '<time>' },
  { id: 'uuid', re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, to: '<uuid>' },
  { id: 'hex', re: /\b0x[0-9a-fA-F]{4,}\b/g, to: '<hex>' },
  { id: 'hex', re: /\b[0-9a-fA-F]{12,}\b/g, to: '<hex>' },
  { id: 'number', re: /\b\d{6,}\b/g, to: '<number>' }
];

/** Replaces the parts of a line that change from run to run. `kinds` lists the rule ids to apply (default all). */
function normalize(text, kinds) {
  let s = text;
  for (const r of RULES) if (!kinds || kinds.indexOf(r.id) !== -1) s = s.replace(r.re, r.to);
  return s;
}

/**
 * Myers difference of two arrays of strings. Resolves to
 * { ok: true, ops: [{ type: 'eq'|'del'|'add', a: [from, to), b: [from, to) }], same, deleted, added }
 * or { ok: false, reason }.
 */
function diffLines(a, b, options) {
  const o = options || {};
  const maxEdits = o.maxEdits || MAX_EDITS;
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { ok: false, reason: 'Each excerpt may have at most ' + MAX_LINES + ' lines.' };
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return { ok: false, reason: 'The two excerpts differ in more than ' + maxEdits + ' lines, which is more than this comparison handles. Choose shorter excerpts.' };
  // Walk back to collect the edit script.
  const edits = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) prevK = k + 1; else prevK = k - 1;
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { edits.push({ type: 'eq', ax: x - 1, bx: y - 1 }); x--; y--; }
    edits.push({ type: x === prevX ? 'add' : 'del', ax: prevX, bx: prevY });
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { edits.push({ type: 'eq', ax: x - 1, bx: y - 1 }); x--; y--; }
  edits.reverse();
  const ops = [];
  function append(op) {
    const last = ops[ops.length - 1];
    if (last && last.type === op.type && last.a[1] === op.a[0] && last.b[1] === op.b[0]) { last.a[1] = op.a[1]; last.b[1] = op.b[1]; } else ops.push(op);
  }
  if (pre) append({ type: 'eq', a: [0, pre], b: [0, pre] });
  for (const e of edits) {
    const A0 = pre + e.ax;
    const B0 = pre + e.bx;
    if (e.type === 'eq') append({ type: 'eq', a: [A0, A0 + 1], b: [B0, B0 + 1] });
    else if (e.type === 'del') append({ type: 'del', a: [A0, A0 + 1], b: [B0, B0] });
    else append({ type: 'add', a: [A0, A0], b: [B0, B0 + 1] });
  }
  if (suf) append({ type: 'eq', a: [a.length - suf, a.length], b: [b.length - suf, b.length] });
  let same = 0;
  let deleted = 0;
  let added = 0;
  for (const op of ops) {
    if (op.type === 'eq') same += op.a[1] - op.a[0]; else if (op.type === 'del') deleted += op.a[1] - op.a[0]; else added += op.b[1] - op.b[0];
  }
  return { ok: true, ops: ops, same: same, deleted: deleted, added: added };
}

/** The two excerpts as text for a side-by-side comparison view: lines in the two outputs line up by the script. */
function sideBySide(a, b, result) {
  const left = [];
  const right = [];
  for (const op of result.ops) {
    if (op.type === 'eq') { for (let i = op.a[0]; i < op.a[1]; i++) { left.push(a[i]); right.push(b[op.b[0] + (i - op.a[0])]); } }
    else if (op.type === 'del') { for (let i = op.a[0]; i < op.a[1]; i++) left.push(a[i]); }
    else { for (let j = op.b[0]; j < op.b[1]; j++) right.push(b[j]); }
  }
  return { left: left, right: right };
}

// ---- reading and comparing excerpts ------------------------------------------------------------------
//
// An excerpt is read with the scan limit (lines are read up to READ_CHARS characters) and every line is
// kept as a short comparison key: the normalised text itself when it is short, otherwise a digest of
// the whole normalised text. So two lines that differ only far out are never taken for one line, and
// memory stays small. Alongside the lines, the bytes of the whole excerpt are hashed, which is what
// decides "identical": the word is used only when every byte of the two excerpts is equal. What the
// line view cannot show (line ends, a byte order mark, the encoding, invalid characters) is reported in
// words.

const crypto = require('node:crypto');
const E = require('../engine/encoding');

const READ_CHARS = 1048576;
const DISPLAY_CHARS = 4000;
const BLOCK = 16;
const EOL_NAMES = { LF: 'LF', CRLF: 'CRLF', none: 'no line break (end of the file)' };

function hashOf(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function keyOf(text) { return text.length <= DISPLAY_CHARS ? text : '\u0001' + hashOf(text) + ':' + text.length; }
function displayOf(text) { return text.length <= DISPLAY_CHARS ? text : text.slice(0, DISPLAY_CHARS) + ' ...[' + (text.length - DISPLAY_CHARS) + ' more characters, digest ' + hashOf(text).slice(0, 8) + ']'; }

function eolOf(rec, succ, file, unit) {
  if (rec.offset === undefined) return '?';
  let n;
  if (rec.terminated === false) n = 0;
  else if (succ && succ.offset !== undefined) n = succ.offset - rec.offset - rec.byteLength;
  else if (file) n = file.readableEnd - rec.offset - rec.byteLength;
  else return '?';
  if (n === 0) return 'none';
  if (n === unit) return 'LF';
  if (n === 2 * unit) return 'CRLF';
  return '?';
}

/**
 * Reads `count` lines from line `first` (0-based) of a source. Resolves to
 * { requested, got, lines: [{ display, norm, raw, eol, cut }], longLines, encoding, bom, merged, digest, bytes },
 * or null when `opts.signal` was aborted. `digest` is the SHA-256 of the bytes of the excerpt (a
 * single file only; null for a merged view, an excerpt of more than 512 MiB or a log that is still
 * being indexed at its end).
 */
async function readExcerpt(source, first, count, opts) {
  const o = opts || {};
  const file = source && source.file ? source.file : null;
  const unit = file ? E.unitSize(file.encoding) : 1;
  const lines = [];
  let longLines = 0;
  let firstOffset = null;
  let endOffset = null;
  let pos = first;
  const stop = first + count;
  while (pos < stop) {
    if (o.signal && o.signal.aborted) return null;
    const want = Math.min(BLOCK, stop - pos);
    const recs = await source.readLines(pos, want + 1, { maxChars: READ_CHARS });
    if (!recs.length) break;
    const take = Math.min(want, recs.length);
    for (let i = 0; i < take; i++) {
      const rec = recs[i];
      const succ = i + 1 < recs.length ? recs[i + 1] : null;
      if (firstOffset === null && rec.offset !== undefined) firstOffset = rec.offset;
      const cutLine = !!rec.truncated;
      if (cutLine) longLines++;
      const suffix = cutLine ? '\u0002' + rec.byteLength : '';
      const norm = normalize(rec.text);
      lines.push({ display: displayOf(norm), norm: keyOf(norm) + suffix, raw: keyOf(rec.text) + suffix, eol: eolOf(rec, succ, file, unit), cut: cutLine });
      if (i === take - 1 && take === want && succ && succ.offset !== undefined) endOffset = succ.offset;
      if (i === take - 1 && !succ && file && file.complete) endOffset = file.readableEnd;
    }
    pos += take;
    if (take < want) break;
  }
  let digest = null;
  if (file && lines.length && firstOffset !== null && endOffset !== null) {
    digest = await file.digestRange(first === 0 ? 0 : firstOffset, endOffset, { signal: o.signal });
    if (o.signal && o.signal.aborted) return null;
  }
  return {
    requested: count, got: lines.length, lines: lines, longLines: longLines, merged: !file, digest: digest,
    bytes: digest !== null ? endOffset - (first === 0 ? 0 : firstOffset) : 0,
    encoding: file ? E.labelOf(file.encoding) : '', bom: file ? file.bom > 0 : false
  };
}

/**
 * Compares two excerpts (from readExcerpt). Resolves to { ok: false, reason } when they differ in
 * too many lines, otherwise { ok: true, identical, exact, replaced, deleted, added, diff, notes, message }.
 * `identical` is true only when the bytes of both excerpts are equal; the message never says "same"
 * or "identical" for anything else.
 */
function compareExcerpts(a, b, options) {
  const diff = diffLines(a.lines.map(function (l) { return l.norm; }), b.lines.map(function (l) { return l.norm; }), options);
  if (!diff.ok) return { ok: false, reason: diff.reason };
  let exact = 0;
  let textOnly = 0;
  let replaced = 0;
  let eolMismatch = 0;
  let eolExample = null;
  for (const op of diff.ops) {
    if (op.type !== 'eq') continue;
    for (let k = 0; k < op.a[1] - op.a[0]; k++) {
      const x = a.lines[op.a[0] + k];
      const y = b.lines[op.b[0] + k];
      const eolDiffers = x.eol !== y.eol && x.eol !== '?' && y.eol !== '?';
      if (eolDiffers) { eolMismatch++; if (!eolExample) eolExample = [x.eol, y.eol]; }
      // Exact: the same text, the same line end, read in full. A line read only in part (longer than the
      // scan limit) or with another line end matches in its text only.
      if (x.raw !== y.raw) replaced++;
      else if (eolDiffers || x.cut || y.cut) textOnly++;
      else exact++;
    }
  }
  const bothBytes = a.digest !== null && b.digest !== null;
  const identical = bothBytes && a.got > 0 && b.got > 0 && a.digest === b.digest;
  const notes = [];
  const n = function (v) { return v.toLocaleString('en-US'); };
  if (a.got < a.requested) notes.push('The first excerpt has only ' + n(a.got) + ' of the ' + n(a.requested) + ' lines asked for (the log ends there' + (a.merged ? '' : ', or is still being indexed') + ').');
  if (b.got < b.requested) notes.push('The second excerpt has only ' + n(b.got) + ' of the ' + n(b.requested) + ' lines asked for (the log ends there' + (b.merged ? '' : ', or is still being indexed') + ').');
  if (eolMismatch) notes.push(n(eolMismatch) + ' matching line(s) end differently (first excerpt: ' + EOL_NAMES[eolExample[0]] + ', second: ' + EOL_NAMES[eolExample[1]] + '); the text view does not show that.');
  if (!a.merged && !b.merged && a.encoding !== b.encoding) notes.push('The two logs are read as different encodings (first: ' + a.encoding + ', second: ' + b.encoding + ').');
  if (!a.merged && !b.merged && a.bom !== b.bom) notes.push('Only the ' + (a.bom ? 'first' : 'second') + ' log starts with a byte order mark.');
  const cut = a.longLines + b.longLines;
  if (cut) notes.push(n(cut) + ' line(s) are longer than 1,048,576 characters: they were compared by their first 1,048,576 characters and their length in bytes' + (bothBytes ? ', and the bytes of the whole excerpts were compared too.' : '.'));
  if (!bothBytes) notes.push('The bytes of the excerpts could not be compared (a merged view, more than 512 MiB, or a log still being indexed), so only the text of the lines was.');
  const linesDiffer = diff.deleted + diff.added + replaced + eolMismatch > 0 || a.got !== b.got;
  if (bothBytes && !identical && !linesDiffer && a.encoding === b.encoding && a.bom === b.bom) notes.push('The bytes differ in a way the text view cannot show (for example invalid characters that look alike once decoded).');
  let message;
  if (identical) {
    message = 'The two excerpts are identical, byte for byte (' + n(a.got) + ' lines, ' + n(a.bytes) + ' bytes).';
  } else {
    message = 'Compared ' + n(a.got) + ' lines with ' + n(b.got) + ' lines: ' + n(exact) + ' match exactly' + (textOnly ? ', ' + n(textOnly) + ' match in their text only (a different line end, or a line longer than 1,048,576 characters that was compared by a digest)' : '') + (replaced ? ', ' + n(replaced) + ' match only after times, ids and long numbers are replaced by placeholders' : '') + ', ' + n(diff.deleted) + ' only in the first excerpt, ' + n(diff.added) + ' only in the second.';
    if (bothBytes) message += ' The excerpts are not identical.';
  }
  return { ok: true, identical: identical, exact: exact, textOnly: textOnly, replaced: replaced, deleted: diff.deleted, added: diff.added, eolMismatch: eolMismatch, diff: diff, notes: notes, message: [message].concat(notes).join(' ') };
}

module.exports = { normalize, diffLines, sideBySide, readExcerpt, compareExcerpts, MAX_LINES, MAX_EDITS, READ_CHARS, DISPLAY_CHARS };
