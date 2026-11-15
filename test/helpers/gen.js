'use strict';
// Deterministic synthetic logs for the tests. Everything is invented; nothing here is read from a
// real system. Large files are written in blocks at run time and never committed.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SERVICES = ['auth', 'billing', 'catalog', 'gateway', 'inventory', 'mailer', 'orders', 'search'];
const WORDS = ['request', 'handled', 'cache', 'miss', 'timeout', 'retry', 'connection', 'closed', 'user', 'session', 'started', 'stopped', 'queue', 'depth', 'flushed', 'batch', 'accepted'];
const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

/** The i-th line of the standard synthetic log: ISO time, level, service, a few words. Levels cycle by a fixed rule. */
function standardLine(i, rnd) {
  const t = Date.UTC(2026, 0, 15, 8, 0, 0) + i * 137;
  const level = i % 97 === 0 ? 'ERROR' : i % 31 === 0 ? 'WARN' : i % 11 === 0 ? 'DEBUG' : 'INFO';
  const svc = SERVICES[i % SERVICES.length];
  const r = rnd || (() => 0.5);
  let msg = '';
  const n = 3 + Math.floor(r() * 5);
  for (let k = 0; k < n; k++) msg += (k ? ' ' : '') + WORDS[Math.floor(r() * WORDS.length)];
  return new Date(t).toISOString() + ' ' + level.padEnd(5) + ' ' + svc + ' id=' + (100000 + i) + ' ' + msg;
}

/** Counts the lines by level that standardLine produces for 0 <= i < n (a hand-derived formula, not a scan). */
function standardLevelCounts(n) {
  let error = 0; let warn = 0; let debug = 0;
  for (let i = 0; i < n; i++) { if (i % 97 === 0) error++; else if (i % 31 === 0) warn++; else if (i % 11 === 0) debug++; }
  return { error: error, warn: warn, debug: debug, info: n - error - warn - debug };
}

/** Writes a log of `n` standard lines to filePath in blocks; resolves to { bytes, lines }. */
async function writeStandard(filePath, n, options) {
  const o = options || {};
  const eol = o.eol || '\n';
  const rnd = rng(o.seed || 1);
  const fh = await fsp.open(filePath, 'w');
  let bytes = 0;
  let block = [];
  let blockLen = 0;
  for (let i = 0; i < n; i++) {
    const line = standardLine(i, rnd) + eol;
    block.push(line);
    blockLen += line.length;
    if (blockLen >= 4 * 1024 * 1024) {
      const b = Buffer.from(block.join(''), 'latin1');
      await fh.write(b); bytes += b.length; block = []; blockLen = 0;
    }
  }
  if (block.length) { const b = Buffer.from(block.join(''), 'latin1'); await fh.write(b); bytes += b.length; }
  await fh.close();
  return { bytes: bytes, lines: n };
}

/** Writes lines (array of strings) with an end-of-line text and an encoding. */
function writeLines(filePath, lines, options) {
  const o = options || {};
  const eol = o.eol === undefined ? '\n' : o.eol;
  let text = lines.join(eol);
  if (o.finalEol !== false && lines.length) text += eol;
  let buf;
  switch (o.encoding) {
    case 'utf16le': buf = Buffer.from(text, 'utf16le'); if (o.bom !== false) buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), buf]); break;
    case 'utf16be': { const b = Buffer.from(text, 'utf16le'); b.swap16(); buf = o.bom !== false ? Buffer.concat([Buffer.from([0xFE, 0xFF]), b]) : b; break; }
    case 'latin1': buf = Buffer.from(text, 'latin1'); break;
    default: buf = Buffer.from(text, 'utf8'); if (o.bom) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  }
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'bla-') + 'sp ž é ')); }
function rmDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

module.exports = { rng, standardLine, standardLevelCounts, writeStandard, writeLines, tmpDir, rmDir, SERVICES, LEVEL_NAMES };
