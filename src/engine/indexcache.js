'use strict';
// Saved line indexes: one small file per log in the extension's storage folder, named by a hash of
// the path, the size and the modification time, so that a log that has not changed opens without
// scanning it again. The cache is optional: every function swallows errors, never throws, and an
// index is only used after LogFile.loadBuffer() has checked it against the file. The folder is
// trimmed to a size cap (oldest files first) and files older than 60 days are removed.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_AGE_MS = 60 * 24 * 3600 * 1000;

/** The cache key of a file: depends on the path, the size and the modification time. */
function keyFor(filePath, size, mtimeMs) {
  return crypto.createHash('sha1').update(filePath + '\u0000' + size + '\u0000' + Math.floor(mtimeMs)).digest('hex') + '.idx';
}

async function load(dir, key) {
  try { return await fsp.readFile(path.join(dir, key)); } catch (e) { return null; }
}

async function save(dir, key, buffer) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, key);
    const tmp = target + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, target);
    return true;
  } catch (e) { return false; }
}

/** Removes old and surplus files; resolves to the number of files removed. */
async function cleanup(dir, maxBytes, now) {
  let removed = 0;
  try {
    const t = now === undefined ? Date.now() : now;
    const names = (await fsp.readdir(dir)).filter(function (n) { return /\.(idx|tmp)$/.test(n); });
    const info = [];
    for (const n of names) {
      try { const st = await fsp.stat(path.join(dir, n)); info.push({ name: n, size: st.size, mtime: st.mtimeMs }); } catch (e) { /* gone */ }
    }
    info.sort(function (a, b) { return b.mtime - a.mtime; });
    let total = 0;
    for (const f of info) {
      total += f.size;
      if (t - f.mtime > MAX_AGE_MS || total > maxBytes || /\.tmp$/.test(f.name)) {
        try { await fsp.rm(path.join(dir, f.name)); removed++; total -= f.size; } catch (e) { /* in use */ }
      }
    }
  } catch (e) { /* no folder yet */ }
  return removed;
}

module.exports = { keyFor, load, save, cleanup };
