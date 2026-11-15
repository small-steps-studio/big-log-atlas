'use strict';
// A read-only view of a (possibly multi-gigabyte) log file that never loads the file into memory.
//
//   * The file is read in chunks of a few megabytes; each chunk is scanned for line ends.
//   * A sparse index keeps (line number, byte offset) for roughly every 256th line or every
//     256 KiB, whichever comes first, plus both ends of every line longer than 1 MiB. Its size is
//     capped (when it is full it keeps every second entry), so memory stays small for any file size.
//   * A window of lines is read by seeking to the nearest index entry and scanning forward.
//   * Only the first `cap` bytes of a line are decoded; the rest of a very long line is skipped.
//   * Growth, truncation and replacement of the file are detected from the size, the file id and
//     a fingerprint of the first and the last scanned bytes (see refresh()).
//
// No editor API is used; everything is injectable and testable.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const E = require('./encoding');

const DEFAULTS = Object.freeze({
  chunkBytes: 4 * 1024 * 1024,
  stepLines: 256,
  stepBytes: 256 * 1024,
  hugeLineBytes: 1024 * 1024,
  maxEntries: 2000000,
  scanCapBytes: 1024 * 1024
});

const FINGERPRINT_BYTES = 4096;
const INDEX_MAGIC = 'BLA1';

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

/** Replaces control characters (other than tab) with their visible symbols (U+2400 block). */
function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, function (c) { return c === '\u007F' ? '␡' : String.fromCharCode(0x2400 + c.charCodeAt(0)); });
}

/** The number of bytes to keep of a line of which `maxChars` characters are shown. */
function headBytesFor(encoding, maxChars) {
  return Math.max(16, Math.floor(maxChars) * (encoding === 'utf8' ? 4 : encoding === 'latin1' ? 1 : 2));
}

/** Cuts a decoded head to `maxChars` without splitting a surrogate pair; { text, cut }. */
function clipText(text, maxChars) {
  if (text.length <= maxChars) return { text: text, cut: false };
  let end = maxChars;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xD800 && c <= 0xDBFF) end--;
  return { text: text.slice(0, end), cut: true };
}

/**
 * Scans the bytes [opts.start, opts.end) of an open file line by line. `onLine(buf, s, e, info)`
 * is called for every line with the first `opts.cap` bytes of the line in buf[s, e) (valid during
 * the call only) and info = { no, offset, byteLength (without the line end), capped, terminated }.
 * It returns false to stop (or a promise of that, which is awaited). `opts.firstNo` is the number of the first line scanned (0-based).
 * An unterminated last line is delivered (terminated = false) only when `opts.deliverTail` is set.
 * Resolves to { nextOffset, nextNo, stopped, aborted }; nextOffset is the start of the first line
 * not delivered. `opts.onChunk(pos)` is called after every chunk; `opts.signal` aborts between chunks.
 */
async function scanLines(fh, opts, onLine) {
  const enc = opts.encoding;
  const unit = E.unitSize(enc);
  const cap = Math.max(1, opts.cap || DEFAULTS.scanCapBytes);
  const chunkSize = Math.max(64, (opts.chunkBytes || DEFAULTS.chunkBytes) & ~1);
  const end = opts.end;
  const signal = opts.signal;
  const chunk = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(64, end - opts.start + 2)));
  let pos = opts.start;
  let no = opts.firstNo || 0;
  let lineStart = pos;
  let carry = null;     // pieces of the line in progress (at most cap bytes)
  let carryLen = 0;     // bytes held in carry
  let carryTotal = 0;   // bytes of the line in progress, held or not
  let carryCr = false;  // the line in progress so far ends with a CR
  while (pos < end) {
    if (signal && signal.aborted) return { nextOffset: lineStart, nextNo: no, stopped: false, aborted: true };
    let want = Math.min(chunk.length, end - pos);
    if (unit === 2) want &= ~1;
    if (want <= 0) break;
    const { bytesRead } = await fh.read(chunk, 0, want, pos);
    let n = bytesRead;
    if (unit === 2) n &= ~1;
    if (n <= 0) break;
    const view = chunk.subarray(0, n);
    let p = 0;
    for (;;) {
      const q = E.indexOfLf(view, p, enc);
      if (q < 0) break;
      let lineEnd = q;
      if (q - p >= unit && E.isCrAt(view, q - unit, enc)) lineEnd = q - unit;
      let hb;
      let hs;
      let he;
      let byteLength;
      if (carry) {
        const inChunk = lineEnd - p;
        const crInCarry = q === p && carryCr;
        byteLength = carryTotal + inChunk - (crInCarry ? unit : 0);
        const room = cap - carryLen;
        if (room > 0 && inChunk > 0) {
          const take = Math.min(room, inChunk);
          carry.push(Buffer.from(view.subarray(p, p + take)));
          carryLen += take;
        }
        hb = Buffer.concat(carry, carryLen);
        let headLen = hb.length;
        if (crInCarry && carryLen >= carryTotal) headLen -= unit;
        hs = 0; he = Math.min(Math.max(0, headLen), cap);
      } else {
        byteLength = lineEnd - p;
        hb = view; hs = p; he = Math.min(lineEnd, p + cap);
      }
      const info = { no: no, offset: lineStart, byteLength: Math.max(0, byteLength), capped: byteLength > he - hs, terminated: true };
      carry = null; carryLen = 0; carryTotal = 0; carryCr = false;
      no++;
      lineStart = pos + q + unit;
      p = q + unit;
      let keep = onLine(hb, hs, he, info);
      // A callback may return a promise (for example to wait for a file write); it is awaited here.
      if (keep !== undefined && keep !== true && keep !== false && keep && typeof keep.then === 'function') keep = await keep;
      if (keep === false) return { nextOffset: lineStart, nextNo: no, stopped: true, aborted: false };
    }
    if (p < n) {
      if (!carry) { carry = []; carryLen = 0; carryTotal = 0; }
      const take = Math.min(n - p, cap - carryLen);
      if (take > 0) { carry.push(Buffer.from(view.subarray(p, p + take))); carryLen += take; }
      carryTotal += n - p;
      carryCr = n - p >= unit && E.isCrAt(view, n - unit, enc);
    }
    pos += n;
    if (opts.onChunk) opts.onChunk(pos);
  }
  if (carry && carryTotal > 0 && opts.deliverTail) {
    const hb = Buffer.concat(carry, carryLen);
    const info = { no: no, offset: lineStart, byteLength: carryTotal, capped: carryTotal > hb.length, terminated: false };
    no++;
    onLine(hb, 0, hb.length, info);
    return { nextOffset: end, nextNo: no, stopped: false, aborted: false };
  }
  return { nextOffset: lineStart, nextNo: no, stopped: false, aborted: false };
}

class LogFile {
  constructor(filePath, options) {
    this.path = filePath;
    this.opt = Object.assign({}, DEFAULTS, options || {});
    this.fh = null;
    this.size = 0;
    this.mtimeMs = 0;
    this.ino = 0;
    this.encoding = 'utf8';
    this.bom = 0;
    this.binary = false;
    this.encodingReason = '';
    this.encodingForced = false;
    this.headLen = 0;
    this.resetIndex();
  }

  resetIndex() {
    this.capacity = 1024;
    this.lineNos = new Float64Array(this.capacity);
    this.offsets = new Float64Array(this.capacity);
    this.count = 0;
    this.stepLines = this.opt.stepLines;
    this.stepBytes = this.opt.stepBytes;
    this.completeLines = 0;
    this.tailOffset = this.bom;
    this.scannedBytes = this.bom;
    this.complete = false;
    this.tailHash = '';
    this.tailStart = this.bom;
    this.addEntry(0, this.bom);
  }

  addEntry(lineNo, offset) {
    if (this.count > 0 && this.lineNos[this.count - 1] === lineNo) return;
    if (this.count >= this.opt.maxEntries) this.thin();
    if (this.count === this.capacity) {
      {
        this.capacity *= 2;
        const a = new Float64Array(this.capacity); a.set(this.lineNos.subarray(0, this.count)); this.lineNos = a;
        const b = new Float64Array(this.capacity); b.set(this.offsets.subarray(0, this.count)); this.offsets = b;
      }
    }
    this.lineNos[this.count] = lineNo;
    this.offsets[this.count] = offset;
    this.count++;
  }

  // Keeps every second entry and doubles the spacing, so that the index never exceeds maxEntries.
  thin() {
    let j = 1;
    for (let i = 2; i < this.count; i += 2) { this.lineNos[j] = this.lineNos[i]; this.offsets[j] = this.offsets[i]; j++; }
    this.count = j;
    this.stepLines *= 2;
    this.stepBytes *= 2;
  }

  /** The size without a stray last byte (a UTF-16 file of an odd size). */
  get usableSize() { return E.unitSize(this.encoding) === 2 ? this.size - (this.size & 1) : this.size; }

  /** End of the bytes that are indexed and may be read: the file size once the scan is complete. */
  get readableEnd() { return this.complete ? this.usableSize : this.tailOffset; }

  /** Number of lines that can be shown now: the terminated lines plus an unterminated last line. */
  get lineCount() { return this.completeLines + (this.complete && this.usableSize > this.tailOffset ? 1 : 0); }

  /** Bytes of memory held by the index. */
  get indexBytes() { return this.count * 16; }

  async open(options) {
    const o = options || {};
    this.fh = await fsp.open(this.path, 'r');
    try {
      const st = await this.fh.stat();
      if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
      this.size = st.size; this.mtimeMs = st.mtimeMs; this.ino = st.ino || 0;
      await this.detectEncoding(o.encoding);
    } catch (e) { await this.close(); throw e; }
    this.resetIndex();
    this.headLen = Math.min(FINGERPRINT_BYTES, this.size);
    this.headHash = await this.fingerprint(0, this.headLen);
    return this;
  }

  async detectEncoding(forced) {
    const sample = Buffer.allocUnsafe(Math.min(65536, this.size));
    if (sample.length) await this.fh.read(sample, 0, sample.length, 0);
    const d = E.detect(sample, this.size <= sample.length);
    this.binary = d.binary;
    if (forced && forced !== 'auto' && E.ENCODINGS.indexOf(forced) !== -1) {
      this.encoding = forced; this.encodingForced = true;
      this.bom = d.bom && d.encoding === forced ? d.bom : 0;
      this.encodingReason = 'chosen by the user';
    } else {
      this.encoding = d.encoding; this.bom = d.bom; this.encodingReason = d.reason; this.encodingForced = false;
    }
  }

  async close() {
    if (this.fh) { const fh = this.fh; this.fh = null; await fh.close().catch(function () {}); }
  }

  async fingerprint(start, end) {
    if (end <= start) return '';
    const b = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await this.fh.read(b, 0, b.length, start);
    return sha1(b.subarray(0, bytesRead));
  }

  /**
   * SHA-256 (hex) of the bytes [start, end) of the file, read in blocks. Resolves to null when the
   * range is larger than `opts.maxBytes` (default 512 MiB), the file is shorter than the range, or
   * `opts.signal` was aborted.
   */
  async digestRange(start, end, opts) {
    const o = opts || {};
    const max = o.maxBytes > 0 ? o.maxBytes : 512 * 1024 * 1024;
    if (!(end >= start) || end - start > max || !this.fh) return null;
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = start;
    while (pos < end) {
      if (o.signal && o.signal.aborted) return null;
      const { bytesRead } = await this.fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead <= 0) return null;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return hash.digest('hex');
  }

  /** Changes the encoding and starts the index again (the caller scans again). */
  async setEncoding(encoding) {
    if (E.ENCODINGS.indexOf(encoding) === -1) throw new Error('unknown encoding');
    await this.detectEncoding(encoding);
    this.resetIndex();
  }

  /**
   * Scans the file from the end of the indexed part to the end of the file and extends the index.
   * Resolves to { complete, aborted }; call again after an abort to continue.
   */
  async scan(signal, onProgress) {
    const enc = this.encoding;
    const unit = E.unitSize(enc);
    const size = this.size;
    const huge = this.opt.hugeLineBytes;
    let pos = this.tailOffset;
    let lineNo = this.completeLines;
    let lineStart = this.tailOffset;
    let lastEntryLine = this.lineNos[this.count - 1];
    let lastEntryOff = this.offsets[this.count - 1];
    let lastReport = 0;
    const chunk = Buffer.allocUnsafe(Math.max(64, Math.min(this.opt.chunkBytes & ~1, Math.max(64, size - pos + 2))));
    while (pos < size) {
      if (signal && signal.aborted) return { complete: false, aborted: true };
      let want = Math.min(chunk.length, size - pos);
      if (unit === 2) want &= ~1;
      if (want <= 0) break;
      const { bytesRead } = await this.fh.read(chunk, 0, want, pos);
      let n = bytesRead;
      if (unit === 2) n &= ~1;
      if (n <= 0) break;
      const view = chunk.subarray(0, n);
      let p = 0;
      for (;;) {
        const q = E.indexOfLf(view, p, enc);
        if (q < 0) break;
        const after = pos + q + unit;
        lineNo++;
        if (after - lineStart >= huge) {
          this.addEntry(lineNo - 1, lineStart);
          this.addEntry(lineNo, after);
          lastEntryLine = lineNo; lastEntryOff = after;
        } else if (lineNo - lastEntryLine >= this.stepLines || after - lastEntryOff >= this.stepBytes) {
          this.addEntry(lineNo, after);
          lastEntryLine = lineNo; lastEntryOff = after;
        }
        lineStart = after;
        p = q + unit;
      }
      pos += n;
      this.completeLines = lineNo; this.tailOffset = lineStart; this.scannedBytes = pos;
      if (onProgress) {
        const now = Date.now();
        if (now - lastReport >= 100) { lastReport = now; onProgress({ scannedBytes: pos, size: size, lines: lineNo }); }
      }
      // Let other work (the editor's own, other requests) run between chunks.
      if (this.opt.yieldEveryChunk) await new Promise(function (r) { setImmediate(r); });
    }
    this.scannedBytes = size;
    this.complete = true;
    this.tailStart = Math.max(this.bom, this.tailOffset - FINGERPRINT_BYTES);
    this.tailHash = await this.fingerprint(this.tailStart, this.tailOffset);
    if (onProgress) onProgress({ scannedBytes: size, size: size, lines: this.completeLines, done: true });
    return { complete: true, aborted: false };
  }

  findEntry(lineNo) {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineNos[mid] <= lineNo) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  findEntryByOffset(offset) {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Reads `count` lines from line `first` (0-based). Resolves to an array of
   * { no, offset, text, byteLength, truncated, terminated }, shorter at the end of the file.
   * `opts.maxChars` limits the characters kept per line (default 2000).
   */
  async readLines(first, count, opts) {
    const o = opts || {};
    const maxChars = o.maxChars || 2000;
    const total = this.lineCount;
    let f = Math.max(0, Math.floor(first));
    if (f >= total || count <= 0) return [];
    const want = Math.min(Math.floor(count), total - f);
    const enc = this.encoding;
    const unit = E.unitSize(enc);
    const cap = headBytesFor(enc, maxChars);
    const out = [];
    const self = this;
    let ei = this.findEntry(f);
    const end = this.readableEnd;
    while (out.length < want) {
      const curNo = this.lineNos[ei];
      const curOff = this.offsets[ei];
      const hasNext = ei + 1 < this.count;
      const segEnd = hasNext ? Math.min(this.offsets[ei + 1], end) : end;
      const segLines = hasNext ? this.lineNos[ei + 1] - curNo : Infinity;
      if (segLines === 1 && segEnd - curOff > this.opt.hugeLineBytes) {
        // One very long line: read only its head and the bytes of its line end.
        if (curNo >= f) {
          const tail = Buffer.allocUnsafe(Math.min(4, segEnd - curOff));
          await this.fh.read(tail, 0, tail.length, segEnd - tail.length);
          let term = unit;
          if (tail.length >= 2 * unit && E.isCrAt(tail, tail.length - 2 * unit, enc)) term = 2 * unit;
          const byteLength = segEnd - curOff - term;
          const len = Math.max(0, Math.min(cap, byteLength));
          const hb = Buffer.allocUnsafe(len);
          const { bytesRead } = len ? await this.fh.read(hb, 0, len, curOff) : { bytesRead: 0 };
          const cut = E.safeCut(hb, 0, bytesRead, enc);
          const clipped = clipText(E.decode(hb, 0, cut, enc), maxChars);
          out.push({ no: curNo, offset: curOff, text: clipped.text, byteLength: byteLength, truncated: byteLength > cut || clipped.cut, terminated: true });
        }
      } else if (segEnd > curOff) {
        const stopAt = f + want;
        await scanLines(this.fh, { encoding: enc, start: curOff, end: segEnd, firstNo: curNo, cap: cap, chunkBytes: this.opt.walkBytes || 262144, deliverTail: !hasNext && this.complete }, function (hb, hs, he, info) {
          if (info.no < f) return true;
          if (info.no >= stopAt) return false;
          const cut = E.safeCut(hb, hs, he, enc);
          const clipped = clipText(E.decode(hb, hs, cut, enc), maxChars);
          out.push({ no: info.no, offset: info.offset, text: clipped.text, byteLength: info.byteLength, truncated: info.capped || clipped.cut || cut < he, terminated: info.terminated });
          return out.length < want;
        });
      }
      if (!hasNext || out.length >= want) break;
      ei++;
      if (self.lineNos[ei] > f + want) break;
    }
    return out;
  }

  /** The first `count` lines, read without an index (at most the first MiB of the file is looked at); what the viewer shows before the scan has produced anything. */
  async readHead(count, maxChars) {
    const enc = this.encoding;
    const mc = maxChars || 2000;
    const cap = headBytesFor(enc, mc);
    const out = [];
    const limit = Math.min(this.size, 1024 * 1024);
    await scanLines(this.fh, { encoding: enc, start: this.bom, end: limit, firstNo: 0, cap: cap, chunkBytes: 65536, deliverTail: this.size <= limit }, function (hb, hs, he, info) {
      const cut = E.safeCut(hb, hs, he, enc);
      const clipped = clipText(E.decode(hb, hs, cut, enc), mc);
      out.push({ no: info.no, offset: info.offset, text: clipped.text, byteLength: info.byteLength, truncated: info.capped || clipped.cut || cut < he, terminated: info.terminated });
      return out.length < count;
    });
    return out;
  }

  async readLine(no, maxChars) {
    const r = await this.readLines(no, 1, { maxChars: maxChars || 1024 * 1024 });
    return r[0] || null;
  }

  /** The 0-based number of the line that contains the byte at `offset`; null when it is not indexed yet. */
  async lineAtOffset(offset) {
    const end = this.readableEnd;
    if (this.size === 0) return 0;
    let off = Math.max(this.bom, Math.min(Math.floor(offset), this.size - 1));
    if (off >= end) return null;
    const enc = this.encoding;
    const unit = E.unitSize(enc);
    if (unit === 2) off &= ~1;
    const ei = this.findEntryByOffset(off);
    let lineNo = this.lineNos[ei];
    let pos = this.offsets[ei];
    const buf = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(64, off - pos + 2)));
    while (pos < off) {
      let want = Math.min(buf.length, off - pos);
      if (unit === 2) want &= ~1;
      if (want <= 0) break;
      const { bytesRead } = await this.fh.read(buf, 0, want, pos);
      let n = bytesRead;
      if (unit === 2) n &= ~1;
      if (n <= 0) break;
      const view = buf.subarray(0, n);
      let p = 0;
      for (;;) {
        const q = E.indexOfLf(view, p, enc);
        if (q < 0) break;
        lineNo++;
        p = q + unit;
      }
      pos += n;
    }
    return lineNo;
  }

  /** Streams from line `startLine` on; onLine as in scanLines (lines before startLine are skipped). */
  async forEach(startLine, onLine, opts) {
    const o = opts || {};
    const total = this.lineCount;
    if (startLine >= total) return { aborted: false, stopped: false };
    const ei = this.findEntry(Math.max(0, startLine));
    const from = Math.max(0, Math.floor(startLine));
    const lastLine = o.endLine === undefined ? Infinity : o.endLine;
    return scanLines(this.fh, {
      encoding: this.encoding, start: this.offsets[ei], end: this.readableEnd, firstNo: this.lineNos[ei], cap: o.cap || this.opt.scanCapBytes,
      chunkBytes: this.opt.chunkBytes, signal: o.signal, deliverTail: this.complete, onChunk: o.onChunk
    }, function (hb, hs, he, info) {
      if (info.no < from) return true;
      if (info.no >= lastLine) return false;
      return onLine(hb, hs, he, info);
    });
  }

  /**
   * Looks at the file again (follow mode, or before a read). Resolves to { kind, added? } with kind
   * same | grown | truncated | rotated | modified | missing. For every kind but same, missing and
   * grown the index has been reset and must be scanned again; for grown call scan() to continue.
   */
  async refresh() {
    let st;
    try { st = await fsp.stat(this.path); } catch (e) { return { kind: 'missing' }; }
    const sameFile = !(this.ino && st.ino && st.ino !== this.ino);
    if (!sameFile) { await this.reopen(); return { kind: 'rotated' }; }
    if (st.size < this.size || st.size < this.tailOffset) { await this.reopen(); return { kind: 'truncated' }; }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs) return { kind: 'same' };
    let ok = true;
    if (this.headLen > 0 && this.size >= this.headLen) ok = (await this.fingerprint(0, this.headLen)) === this.headHash;
    if (ok && this.tailHash && this.tailOffset > this.tailStart) ok = (await this.fingerprint(this.tailStart, this.tailOffset)) === this.tailHash;
    if (!ok) { await this.reopen(); return { kind: 'modified' }; }
    // A file that was almost empty when it was opened may have been given its real encoding since.
    if (this.size < 64 && !this.encodingForced) { await this.reopen(); return { kind: 'grown', added: st.size, reset: true }; }
    const added = st.size - this.size;
    this.size = st.size; this.mtimeMs = st.mtimeMs;
    this.complete = false;
    return { kind: 'grown', added: added };
  }

  async reopen() {
    // The new handle is in place before the old one is closed, so a read that is still running on the old one ends cleanly.
    const old = this.fh;
    const forced = this.encodingForced ? this.encoding : undefined;
    this.fh = null;
    try { await this.open({ encoding: forced }); } finally { if (old) await old.close().catch(function () { /* already closed */ }); }
  }

  // ---- persisted index ---------------------------------------------------------------------

  /** The index as a buffer (only for a complete index), or null. */
  toBuffer() {
    if (!this.complete) return null;
    const header = Buffer.from(JSON.stringify({
      v: 1, size: this.size, mtimeMs: this.mtimeMs, encoding: this.encoding, bom: this.bom, binary: this.binary, forced: this.encodingForced, reason: this.encodingReason,
      completeLines: this.completeLines, tailOffset: this.tailOffset, count: this.count, stepLines: this.stepLines, stepBytes: this.stepBytes,
      headLen: this.headLen, headHash: this.headHash, tailStart: this.tailStart, tailHash: this.tailHash
    }), 'utf8');
    const pad = (8 - ((8 + header.length) % 8)) % 8;
    const head = Buffer.alloc(8 + header.length + pad);
    head.write(INDEX_MAGIC, 0, 'ascii');
    head.writeUInt32LE(header.length + pad, 4);
    header.copy(head, 8);
    return Buffer.concat([head, Buffer.from(this.lineNos.buffer, this.lineNos.byteOffset, this.count * 8), Buffer.from(this.offsets.buffer, this.offsets.byteOffset, this.count * 8)]);
  }

  /** Loads an index written by toBuffer() when it still describes this file; true when it did. */
  async loadBuffer(buf) {
    try {
      if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.toString('ascii', 0, 4) !== INDEX_MAGIC) return false;
      const hl = buf.readUInt32LE(4);
      const h = JSON.parse(buf.toString('utf8', 8, 8 + hl).replace(/\0+$/, ''));
      if (h.v !== 1 || h.size !== this.size || h.mtimeMs !== this.mtimeMs || h.encoding !== this.encoding || h.bom !== this.bom) return false;
      if (!(h.count >= 1) || buf.length !== 8 + hl + h.count * 16) return false;
      if (h.headLen !== this.headLen || h.headHash !== this.headHash) return false;
      const lineNos = new Float64Array(h.count);
      const offsets = new Float64Array(h.count);
      Buffer.from(lineNos.buffer).set(buf.subarray(8 + hl, 8 + hl + h.count * 8));
      Buffer.from(offsets.buffer).set(buf.subarray(8 + hl + h.count * 8));
      if (h.tailOffset > this.size || lineNos[0] !== 0) return false;
      for (let i = 1; i < h.count; i++) if (!(lineNos[i] > lineNos[i - 1] && offsets[i] >= offsets[i - 1] && offsets[i] <= this.size)) return false;
      if (h.tailHash && (await this.fingerprint(h.tailStart, h.tailOffset)) !== h.tailHash) return false;
      this.lineNos = lineNos; this.offsets = offsets; this.count = h.count; this.capacity = h.count;
      this.stepLines = h.stepLines; this.stepBytes = h.stepBytes;
      this.completeLines = h.completeLines; this.tailOffset = h.tailOffset; this.scannedBytes = this.size; this.complete = true;
      this.tailStart = h.tailStart; this.tailHash = h.tailHash;
      return true;
    } catch (e) { return false; }
  }
}

module.exports = { LogFile, scanLines, sanitize, clipText, headBytesFor, DEFAULTS, FINGERPRINT_BYTES, INDEX_MAGIC, sha1 };
