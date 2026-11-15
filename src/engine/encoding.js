'use strict';
// Text encodings of log files: detection (byte order mark, UTF-16 without mark, UTF-8, Latin-1),
// decoding of byte ranges, and the byte patterns of line ends. No editor API is used.
//
// Line ends: a line ends at LF; a CR directly before the LF belongs to the line end. A CR on its
// own is not a line end (documented limit). UTF-16 files are read with two-byte units.

const ENCODINGS = Object.freeze(['utf8', 'utf16le', 'utf16be', 'latin1']);
const LABELS = Object.freeze({ utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', latin1: 'Latin-1' });

function labelOf(encoding) { return LABELS[encoding] || String(encoding); }

/** Bytes per code unit of the encoding. */
function unitSize(encoding) { return encoding === 'utf16le' || encoding === 'utf16be' ? 2 : 1; }

/** True when the bytes [0, n) are valid UTF-8; a sequence cut off at the very end is accepted. */
function validUtf8(buf, n, atEnd) {
  let i = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let need;
    let min;
    if (b >= 0xC2 && b <= 0xDF) { need = 1; min = 0x80; }
    else if (b >= 0xE0 && b <= 0xEF) { need = 2; min = 0x800; }
    else if (b >= 0xF0 && b <= 0xF4) { need = 3; min = 0x10000; }
    else return false;
    if (i + need >= n) {
      // The sequence is cut off by the end of the sample: fine when the sample is only a part of the file.
      if (atEnd) return false;
      for (let k = i + 1; k < n; k++) if ((buf[k] & 0xC0) !== 0x80) return false;
      return true;
    }
    let cp = b & (0x3F >> need);
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      if ((c & 0xC0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += need + 1;
  }
  return true;
}

/**
 * Detects the encoding from the first bytes of a file (`buf` holds up to 64 KiB, `atEnd` says the
 * buffer is the whole file). Result: { encoding, bom (bytes to skip), binary, reason }.
 * `binary` is true when the sample holds NUL bytes that are not explained by UTF-16.
 */
function detect(buf, atEnd) {
  const n = buf.length;
  if (n >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { encoding: 'utf8', bom: 3, binary: false, reason: 'byte order mark' };
  if (n >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { encoding: 'utf16le', bom: 2, binary: false, reason: 'byte order mark' };
  if (n >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { encoding: 'utf16be', bom: 2, binary: false, reason: 'byte order mark' };
  if (n === 0) return { encoding: 'utf8', bom: 0, binary: false, reason: 'empty file' };
  let nulEven = 0;
  let nulOdd = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) { if (i & 1) nulOdd++; else nulEven++; }
  const nul = nulEven + nulOdd;
  const pairs = Math.max(1, n >> 1);
  if (nul > 0) {
    // ASCII-heavy text in UTF-16 has a NUL in every second byte.
    if (nulOdd >= pairs * 0.3 && nulEven <= nulOdd * 0.1) return { encoding: 'utf16le', bom: 0, binary: false, reason: 'NUL bytes in odd positions' };
    if (nulEven >= pairs * 0.3 && nulOdd <= nulEven * 0.1) return { encoding: 'utf16be', bom: 0, binary: false, reason: 'NUL bytes in even positions' };
  }
  const binary = nul > 0;
  if (validUtf8(buf, n, atEnd === true)) return { encoding: 'utf8', bom: 0, binary: binary, reason: 'valid UTF-8' };
  return { encoding: 'latin1', bom: 0, binary: binary, reason: 'not valid UTF-8' };
}

/** Decodes buf[start, end) to a string (no BOM handling, no line end handling). */
function decode(buf, start, end, encoding) {
  if (end <= start) return '';
  switch (encoding) {
    case 'utf16le': return buf.toString('utf16le', start, start + ((end - start) & ~1));
    case 'utf16be': {
      const len = (end - start) & ~1;
      const copy = Buffer.from(buf.subarray(start, start + len));
      copy.swap16();
      return copy.toString('utf16le');
    }
    case 'latin1': return buf.toString('latin1', start, end);
    default: return buf.toString('utf8', start, end);
  }
}

/** The byte sequence of a string in the encoding (for searching raw bytes). */
function encode(text, encoding) {
  switch (encoding) {
    case 'utf16le': return Buffer.from(text, 'utf16le');
    case 'utf16be': { const b = Buffer.from(text, 'utf16le'); b.swap16(); return b; }
    case 'latin1': return Buffer.from(text, 'latin1');
    default: return Buffer.from(text, 'utf8');
  }
}

/**
 * Index of the next LF at or after `from` in buf (a unit-aligned position), or -1. For UTF-16 the
 * position is relative to the start of buf, which must start on a unit boundary.
 */
function indexOfLf(buf, from, encoding) {
  if (encoding === 'utf16le') {
    let p = from;
    for (;;) {
      p = buf.indexOf(0x0A, p);
      if (p === -1) return -1;
      if ((p & 1) === 0 && p + 1 < buf.length && buf[p + 1] === 0) return p;
      p++;
    }
  }
  if (encoding === 'utf16be') {
    let p = from + 1;
    for (;;) {
      p = buf.indexOf(0x0A, p);
      if (p === -1) return -1;
      if ((p & 1) === 1 && buf[p - 1] === 0) return p - 1;
      p++;
    }
  }
  return buf.indexOf(0x0A, from);
}

/** True when buf[pos] (a unit start) is a CR. */
function isCrAt(buf, pos, encoding) {
  if (pos < 0 || pos >= buf.length) return false;
  if (encoding === 'utf16le') return buf[pos] === 0x0D && pos + 1 < buf.length && buf[pos + 1] === 0;
  if (encoding === 'utf16be') return buf[pos] === 0 && pos + 1 < buf.length && buf[pos + 1] === 0x0D;
  return buf[pos] === 0x0D;
}

/**
 * Where a decoded range of at most `maxBytes` ends so that no character is cut in half: for UTF-8
 * the end moves back over continuation bytes, for UTF-16 to a unit boundary (and not between the
 * two halves of a surrogate pair).
 */
function safeCut(buf, start, end, encoding) {
  if (encoding === 'utf8') {
    let e = end;
    let back = 0;
    while (e > start && back < 4 && (buf[e - 1] & 0xC0) === 0x80) { e--; back++; }
    if (e > start && back < 4 && buf[e - 1] >= 0xC0) {
      // e-1 is a lead byte whose sequence is incomplete when the range ends before its last byte.
      const lead = buf[e - 1];
      const len = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
      if (e - 1 + len > end) return e - 1;
    }
    return end;
  }
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    let e = start + (((end - start) >> 1) << 1);
    if (e - start >= 2) {
      const hi = encoding === 'utf16le' ? buf[e - 1] : buf[e - 2];
      if (hi >= 0xD8 && hi <= 0xDB) e -= 2;
    }
    return e;
  }
  return end;
}

module.exports = { ENCODINGS, LABELS, labelOf, unitSize, detect, decode, encode, indexOfLf, isCrAt, safeCut, validUtf8 };
