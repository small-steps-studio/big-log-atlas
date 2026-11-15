'use strict';
// Large-file tests: synthetic logs of 100 MB and 1 GB are written at run time (never committed) and
// measured in a separate process whose heap is limited to 300 MB. The thresholds are generous
// ceilings, not benchmarks; the measured numbers are printed and are what the documentation quotes.
// Skip them with BIG_LOG_ATLAS_SKIP_LARGE=1; skip only the 1 GB file with BIG_LOG_ATLAS_SKIP_1GB=1.
// On an automated build (the environment variable CI is set, as the hosted runners do) they are skipped
// too, because of the time and the disk space they need; BIG_LOG_ATLAS_LARGE=1 runs them there anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const G = require('./helpers/gen');

const SKIP_ALL = process.env.BIG_LOG_ATLAS_SKIP_LARGE === '1' || (!!process.env.CI && process.env.BIG_LOG_ATLAS_LARGE !== '1');
const SKIP_1GB = SKIP_ALL || process.env.BIG_LOG_ATLAS_SKIP_1GB === '1';
const dir = G.tmpDir('large-');
test.after(() => G.rmDir(dir));

function measure(file, lines) {
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=300', path.join(__dirname, 'helpers', 'large-run.js'), file, String(lines)], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function check(m, expectedBytesMin, ceilings) {
  process.stdout.write('  measured: ' + JSON.stringify(m) + '\n');
  assert.ok(m.bytes >= expectedBytesMin, 'file size ' + m.bytes);
  assert.equal(m.lineCount, m.lines, 'every line was counted');
  assert.equal(m.firstWindowOk, true, 'the first screen of lines is right');
  assert.ok(m.openMs < ceilings.openMs, 'open ' + m.openMs + ' ms');
  assert.ok(m.indexMs < ceilings.indexMs, 'index ' + m.indexMs + ' ms');
  assert.equal(m.randomLinesOk, 200, 'random lines match the formula');
  assert.ok(m.randomLineMs < 50, 'a random line takes ' + m.randomLineMs + ' ms');
  assert.ok(m.jump50Ms < 1000, 'a jump to 50% takes ' + m.jump50Ms + ' ms');
  assert.ok(Math.abs(m.jump50Line - m.lines / 2) < m.lines * 0.02, 'the line at half the bytes is near half the lines');
  assert.equal(m.searchPlainOk, true, 'the plain search count equals the hand-derived number');
  assert.equal(m.searchRegexOk, true, 'the regular expression count equals the hand-derived number');
  assert.equal(m.searchNastyCount, 0, 'a catastrophic pattern finishes');
  assert.equal(m.filterOk, true, 'the level filter count equals the hand-derived number');
  assert.equal(m.growKind, 'grown');
  assert.equal(m.growLines, m.lines + 1000, 'growth: 1000 appended lines were found');
  assert.ok(m.growMs < 2000, 'growth took ' + m.growMs + ' ms');
  assert.ok(m.peakRssMB - m.baseRssMB < ceilings.memoryMB, 'memory grew by ' + (m.peakRssMB - m.baseRssMB) + ' MB');
  assert.ok(m.peakRssMB < 500, 'peak resident memory ' + m.peakRssMB + ' MB');
  assert.ok(m.indexBytes < 40 * 1024 * 1024, 'the index holds ' + m.indexBytes + ' bytes');
}

test('100 MB log: opens at once, indexes, searches and filters correctly within a 300 MB heap', { skip: SKIP_ALL }, async () => {
  const file = path.join(dir, 'hundred.log');
  const w = await G.writeStandard(file, 1150000);
  assert.ok(w.bytes > 90 * 1024 * 1024);
  check(measure(file, 1150000), 90 * 1024 * 1024, { openMs: 2000, indexMs: 30000, memoryMB: 200 });
  fs.rmSync(file, { force: true });
});

test('1 GB log: opens at once, indexes, searches and filters correctly within a 300 MB heap and 500 MB of memory', { skip: SKIP_1GB }, async () => {
  const file = path.join(dir, 'gig.log');
  const w = await G.writeStandard(file, 11500000);
  assert.ok(w.bytes > 900 * 1024 * 1024);
  check(measure(file, 11500000), 900 * 1024 * 1024, { openMs: 2000, indexMs: 120000, memoryMB: 400 });
  fs.rmSync(file, { force: true });
});
