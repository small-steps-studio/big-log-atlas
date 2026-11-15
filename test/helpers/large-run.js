'use strict';
// Runs the large-file measurements in its own process (so that a small heap limit can be imposed
// with --max-old-space-size) and prints one JSON object. Used by test/large.test.js.
//   node --max-old-space-size=300 test/helpers/large-run.js <file> <lines> [--keep]

const fs = require('node:fs');
const { LogFile } = require('../../src/engine/lineindex');
const { FileSource } = require('../../src/engine/source');
const S = require('../../src/engine/search');
const { createMatcher } = require('../../src/engine/matcher');
const G = require('./gen');

async function main() {
  const file = process.argv[2];
  const n = Number(process.argv[3]);
  let peakRss = 0;
  let peakHeap = 0;
  const sampler = setInterval(function () { const m = process.memoryUsage(); if (m.rss > peakRss) peakRss = m.rss; if (m.heapUsed > peakHeap) peakHeap = m.heapUsed; }, 25);
  const out = { lines: n };
  const t0 = Date.now();
  if (!fs.existsSync(file)) { const w = await G.writeStandard(file, n); out.bytes = w.bytes; out.writeMs = Date.now() - t0; } else out.bytes = fs.statSync(file).size;
  const baseRss = process.memoryUsage().rss;

  // Open: encoding detection and the first window of lines, before the file is indexed.
  const f = new LogFile(file);
  let t = Date.now();
  await f.open();
  const first = await f.readHead(40, 2000);
  out.openMs = Date.now() - t;
  out.firstWindowOk = first.length === 40 && first[0].text.indexOf('2026-01-15T08:00:00.000Z') === 0;

  t = Date.now();
  await f.scan();
  out.indexMs = Date.now() - t;
  out.indexMBps = Math.round(out.bytes / 1048576 / (out.indexMs / 1000));
  out.lineCount = f.lineCount;
  out.indexEntries = f.count;
  out.indexBytes = f.indexBytes;

  // Random lines against the formula (the part of the line before the random words).
  let ok = 0;
  const rnd = G.rng(99);
  t = Date.now();
  for (let k = 0; k < 200; k++) {
    const i = Math.floor(rnd() * n);
    const rec = await f.readLine(i);
    const expected = G.standardLine(i, null);
    const cut = expected.indexOf(' id=') + 10; // the time, the level, the service and the first six digits of the id
    if (rec && rec.no === i && rec.text.slice(0, cut) === expected.slice(0, cut)) ok++;
  }
  out.randomLinesOk = ok;
  out.randomLineMs = Math.round((Date.now() - t) / 200 * 100) / 100;

  // Jumps.
  t = Date.now();
  const line50 = await f.lineAtOffset(Math.floor(out.bytes / 2));
  out.jump50Ms = Date.now() - t;
  out.jump50Line = line50;

  // Search: plain text, case-insensitive text and a regular expression, counted over the whole file.
  const src = new FileSource(f);
  const expectedErrors = G.standardLevelCounts(n).error;
  t = Date.now();
  const plain = await S.countMatches(src, (function (m) { return function (rec) { return m.test(rec.text); }; }(createMatcher({ text: ' ERROR ', caseSensitive: true }))));
  out.searchPlainMs = Date.now() - t;
  out.searchPlainCount = plain.count;
  out.searchPlainOk = plain.count === expectedErrors;
  t = Date.now();
  const rx = createMatcher({ text: ' ERROR [a-z]+ id=1\\d{5} ', regex: true, caseSensitive: true });
  const rxc = await S.countMatches(src, function (rec) { return rx.test(rec.text); });
  out.searchRegexMs = Date.now() - t;
  out.searchRegexCount = rxc.count;
  let expectedRx = 0;
  for (let i = 0; i < Math.min(n, 100000); i++) if (i % 97 === 0) expectedRx++;
  out.searchRegexOk = rxc.count === expectedRx;
  t = Date.now();
  const nasty = createMatcher({ text: '(a+)+$|(x+x+)+y', regex: true });
  const nc = await S.countMatches(src, function (rec) { return nasty.test(rec.text); });
  out.searchNastyMs = Date.now() - t;
  out.searchNastyCount = nc.count;

  // Level filter streamed to a match list.
  t = Date.now();
  const filt = await S.runFilter(src, S.makePredicate({ levels: [4] }));
  out.filterMs = Date.now() - t;
  out.filterMatches = filt.list.length;
  out.filterOk = filt.list.length === expectedErrors;

  // Growth: append lines, only the new part is scanned.
  const extra = [];
  const r2 = G.rng(5);
  for (let i = n; i < n + 1000; i++) extra.push(G.standardLine(i, r2));
  fs.appendFileSync(file, extra.join('\n') + '\n');
  t = Date.now();
  const rf = await f.refresh();
  await f.scan();
  out.growMs = Date.now() - t;
  out.growKind = rf.kind;
  out.growLines = f.lineCount;

  clearInterval(sampler);
  const m = process.memoryUsage();
  out.peakRssMB = Math.round(Math.max(peakRss, m.rss) / 1048576);
  out.baseRssMB = Math.round(baseRss / 1048576);
  out.peakHeapMB = Math.round(Math.max(peakHeap, m.heapUsed) / 1048576);
  await f.close();
  process.stdout.write(JSON.stringify(out) + '\n');
  if (process.argv.indexOf('--keep') === -1) fs.rmSync(file, { force: true });
}

main().catch(function (e) { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
