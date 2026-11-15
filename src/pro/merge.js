'use strict';
// Several log files shown as one stream ordered by time stamp (Pro). Every line carries a tag with
// the name of its file. A line without a time stamp (a stack trace line, for example) stays behind
// the line above it; lines before the first time stamp of a file take that first time stamp.
// Equal times keep the order of the files, then the order of the lines.
//
// The merge is a k-way merge of the files' lines. Checkpoints (the next line of every file) are
// recorded every STEP merged lines, so a window of the merged stream is read by restoring the
// nearest checkpoint and merging forward. A file whose time stamps are not in order is reported
// (`outOfOrder`), because the merged order is then only as good as the files' own order.

const path = require('node:path');
const T = require('../engine/timestamps');
const { SCAN_CHARS } = require('../engine/source');

const MAX_FILES = 16;
const BLOCK = 256;

class Cursor {
  constructor(file, index, tag, extract, firstTs) {
    this.file = file;
    this.index = index;
    this.tag = tag;
    this.extract = extract;
    this.firstTs = firstTs;
    this.next = 0;      // next line number to read
    this.lastTs = NaN;  // time stamp carried by the last line taken
    this.buf = [];
    this.pos = 0;
    this.head = null;   // the next record: { text, ts, srcNo, byteLength, truncated }
    this.maxChars = SCAN_CHARS;
    this.ownLast = -Infinity;
    this.outOfOrder = 0;
  }
  restore(next, lastTs) { this.next = next; this.lastTs = lastTs; this.buf = []; this.pos = 0; this.head = null; }
  async fill() {
    if (this.pos < this.buf.length) return;
    if (this.next >= this.file.lineCount) { this.buf = []; this.pos = 0; return; }
    this.buf = await this.file.readLines(this.next, BLOCK, { maxChars: this.maxChars });
    this.pos = 0;
  }
  async peek() {
    if (this.head) return this.head;
    await this.fill();
    if (this.pos >= this.buf.length) return null;
    const l = this.buf[this.pos++];
    this.next = l.no + 1;
    let ts = this.extract(l.text);
    if (isNaN(ts)) ts = isNaN(this.lastTs) ? this.firstTs : this.lastTs; else this.lastTs = ts;
    this.head = { text: l.text, ts: ts, srcNo: l.no, byteLength: l.byteLength, truncated: l.truncated, own: !isNaN(this.extract(l.text)) };
    return this.head;
  }
  take() { const h = this.head; this.head = null; return h; }
}

class MergeSource {
  /** files: [{ file (LogFile), name }]. Options: timeFormats (per file, optional), reference, step. */
  constructor(files, options) {
    const o = options || {};
    if (!files.length || files.length > MAX_FILES) throw new Error('Choose between 1 and ' + MAX_FILES + ' log files to merge.');
    this.kind = 'merge';
    this.files = files;
    this.step = o.step || 256;
    this.reference = o.reference;
    this.tags = [];
    const seen = new Map();
    for (const f of files) {
      let base = path.basename(f.name);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      this.tags.push(n === 1 ? base : base + ' (' + n + ')');
    }
    // A tag used twice in total: number the first one as well.
    for (let i = 0; i < this.tags.length; i++) if (seen.get(path.basename(files[i].name)) > 1 && !/\(\d+\)$/.test(this.tags[i])) this.tags[i] += ' (1)';
    this.formats = [];
    this.total = 0;
    this.complete = false;
    this.cpNext = [];  // per checkpoint: next line number of each file
    this.cpTs = [];    // per checkpoint: carried time stamp of each file
    this.outOfOrder = this.files.map(function () { return 0; });
    this.untimedFiles = [];
  }

  get lineCount() { return this.total; }
  get size() { return this.files.reduce(function (s, f) { return s + f.file.size; }, 0); }
  get name() { return this.tags.join(', '); }

  newCursors() {
    return this.files.map((f, i) => {
      const fmt = this.formats[i];
      const ext = fmt ? T.extractor(fmt.id, this.reference) : function () { return NaN; };
      return new Cursor(f.file, i, this.tags[i], ext, fmt ? fmt.first : 0);
    });
  }

  // Takes the next record in time order from the cursors; null at the end.
  async pull(cursors) {
    let best = null;
    for (const c of cursors) {
      const h = await c.peek();
      if (h && (best === null || h.ts < best.head.ts)) best = { c: c, head: h };
    }
    if (!best) return null;
    const rec = best.c.take();
    if (rec.own) {
      if (rec.ts < best.c.ownLast) best.c.outOfOrder++;
      else best.c.ownLast = rec.ts;
    }
    return { file: best.c.index, tag: best.c.tag, rec: rec };
  }

  /** Scans the files, detects the time stamp format of each and records the checkpoints. */
  async prepare(signal, onProgress) {
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i].file;
      if (!f.complete) { const r = await f.scan(signal, onProgress); if (r.aborted) return { aborted: true }; }
      const sample = await f.readLines(0, 200, { maxChars: 600 });
      const det = T.detect(sample.map(function (l) { return l.text; }), this.reference);
      let first = 0;
      if (det) {
        const ex = T.extractor(det.id, this.reference);
        const lines = await f.readLines(0, 2000, { maxChars: 600 });
        for (const l of lines) { const t = ex(l.text); if (!isNaN(t)) { first = t; break; } }
      } else this.untimedFiles.push(this.tags[i]);
      this.formats.push(det ? { id: det.id, label: det.label, first: first } : null);
    }
    const cursors = this.newCursors();
    this.cpNext = []; this.cpTs = [];
    let count = 0;
    let step = this.step;
    for (;;) {
      if (signal && signal.aborted) return { aborted: true };
      if (count % step === 0) {
        if (this.cpNext.length >= 500000) {
          // Thin: keep every second checkpoint and double the spacing.
          this.cpNext = this.cpNext.filter(function (_, i) { return i % 2 === 0; });
          this.cpTs = this.cpTs.filter(function (_, i) { return i % 2 === 0; });
          step *= 2;
          this.step = step;
        }
        if (count % step === 0) {
          this.cpNext.push(cursors.map(function (c) { return c.head ? c.head.srcNo : c.next; }));
          this.cpTs.push(cursors.map(function (c) { return c.head ? (c.head.own ? NaN : c.lastTs) : c.lastTs; }));
        }
      }
      const r = await this.pull(cursors);
      if (!r) break;
      count++;
      if (onProgress && (count & 8191) === 0) onProgress({ merged: count });
    }
    this.total = count;
    this.outOfOrder = cursors.map(function (c) { return c.outOfOrder; });
    this.complete = true;
    return { aborted: false };
  }

  restoreCursors(lineNo) {
    const cursors = this.newCursors();
    const cp = Math.min(this.cpNext.length - 1, Math.floor(lineNo / this.step));
    const next = this.cpNext[cp];
    const ts = this.cpTs[cp];
    cursors.forEach(function (c, i) { c.restore(next[i], ts[i]); });
    return { cursors: cursors, no: cp * this.step };
  }

  async readLines(first, count, opts) {
    const o = opts || {};
    const out = [];
    if (first >= this.total || count <= 0) return out;
    const r = this.restoreCursors(first);
    let no = r.no;
    const maxChars = o.maxChars || 2000;
    for (const c of r.cursors) c.maxChars = Math.max(maxChars, 64);
    while (out.length < count) {
      const p = await this.pull(r.cursors);
      if (!p) break;
      if (no >= first) {
        let text = p.rec.text;
        let truncated = p.rec.truncated;
        if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
        out.push({ no: no, offset: 0, text: text, byteLength: p.rec.byteLength, truncated: truncated, terminated: true, tag: p.tag, file: p.file, srcNo: p.rec.srcNo });
      }
      no++;
    }
    return out;
  }

  async forEachText(start, cb, opts) {
    const o = opts || {};
    const r = this.restoreCursors(Math.max(0, start));
    let no = r.no;
    let longLines = 0;
    for (const c of r.cursors) c.maxChars = SCAN_CHARS;
    for (;;) {
      if (o.signal && o.signal.aborted) return { aborted: true, stopped: false, longLines: longLines };
      const p = await this.pull(r.cursors);
      if (!p) break;
      if (no >= start) {
        if (p.rec.truncated) longLines++;
        let keep = cb({ no: no, offset: 0, text: p.rec.text, byteLength: p.rec.byteLength, capped: p.rec.truncated, tag: p.tag, file: p.file, srcNo: p.rec.srcNo });
        if (keep && typeof keep.then === 'function') keep = await keep;
        if (keep === false) return { aborted: false, stopped: true, longLines: longLines };
      }
      no++;
      if (o.onChunk && (no & 4095) === 0) o.onChunk(no);
    }
    return { aborted: false, stopped: false, longLines: longLines };
  }
}

module.exports = { MergeSource, MAX_FILES };
