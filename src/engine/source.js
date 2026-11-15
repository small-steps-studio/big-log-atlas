'use strict';
// A "source" is anything that can show lines: one log file (FileSource) or several files merged by
// time (see ../pro/merge.js). The search, filter, statistics and export code only uses this small
// interface:
//   lineCount, complete            how many lines can be shown now, and whether the scan is finished
//   readLines(first, count, opts)  -> [{ no, text, byteLength, truncated, tag? }]
//   forEachText(start, cb, opts)   streams { no, text, byteLength, capped, tag? }; cb returns false to stop
// Lines longer than SCAN_CHARS characters are searched, filtered and exported only up to that
// length; every streaming pass counts them (`longLines` in its result) so that nothing is hidden.

const E = require('./encoding');
const { headBytesFor, clipText } = require('./lineindex');

const SCAN_CHARS = 1024 * 1024;

class FileSource {
  constructor(logFile) {
    this.kind = 'file';
    this.file = logFile;
    this.tag = '';
  }
  get lineCount() { return this.file.lineCount; }
  get complete() { return this.file.complete; }
  get size() { return this.file.size; }
  get encoding() { return this.file.encoding; }
  get name() { return this.file.path; }

  readLines(first, count, opts) { return this.file.readLines(first, count, opts); }

  async forEachText(start, cb, opts) {
    const o = opts || {};
    const f = this.file;
    const enc = f.encoding;
    const cap = headBytesFor(enc, o.maxChars || SCAN_CHARS);
    let longLines = 0;
    const res = await f.forEach(start, function (hb, hs, he, info) {
      const cut = E.safeCut(hb, hs, he, enc);
      let text = E.decode(hb, hs, cut, enc);
      let capped = info.capped || cut < he;
      if (text.length > (o.maxChars || SCAN_CHARS)) { text = clipText(text, o.maxChars || SCAN_CHARS).text; capped = true; }
      if (capped) longLines++;
      return cb({ no: info.no, offset: info.offset, text: text, byteLength: info.byteLength, capped: capped, tag: '' });
    }, { signal: o.signal, cap: cap, onChunk: o.onChunk, endLine: o.endLine });
    return { aborted: res.aborted, stopped: res.stopped, longLines: longLines };
  }
}

module.exports = { FileSource, SCAN_CHARS };
