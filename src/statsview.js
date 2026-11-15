'use strict';
// The page that shows the statistics (Pro): counts by level, the rate over time as a bar chart with a
// table behind it, error bursts and the top values of chosen fields. Every value from the log is
// escaped; the page has no script and a content security policy that allows only its own style.

const T = require('./engine/timestamps');

function esc(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function fmt(n) { return Number(n).toLocaleString('en-US'); }
function when(ms) { return ms === null || ms === undefined ? '' : T.toIso(ms).replace('.000Z', 'Z'); }
function span(ms) {
  if (ms >= 86400000) return (ms / 86400000) + ' day' + (ms === 86400000 ? '' : 's');
  if (ms >= 3600000) return (ms / 3600000) + ' hour' + (ms === 3600000 ? '' : 's');
  if (ms >= 60000) return (ms / 60000) + ' minute' + (ms === 60000 ? '' : 's');
  return (ms / 1000) + ' second' + (ms === 1000 ? '' : 's');
}

/** The complete HTML of the statistics page for a result of computeStats(). `meta` has title and profile. */
function statsHtml(r, meta, nonce) {
  const m = meta || {};
  const out = [];
  out.push('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + esc(nonce) + '\'; img-src data:;">');
  out.push('<title>Statistics</title><style nonce="' + esc(nonce) + '">body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:12px 20px;max-width:1000px}h1{font-size:1.4em}h2{font-size:1.1em;margin-top:1.6em}table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));padding:2px 10px;text-align:left}td.n{text-align:right}caption{text-align:left;color:var(--vscode-descriptionForeground);padding-bottom:3px}.note{color:var(--vscode-descriptionForeground)}.warn{color:var(--vscode-editorWarning-foreground)}svg{width:100%;height:180px}.bar{fill:var(--vscode-charts-blue,#3794ff)}.err{fill:var(--vscode-charts-red,#f14c4c)}.axis{stroke:var(--vscode-editor-foreground);stroke-opacity:.5}text{fill:var(--vscode-editor-foreground);font-size:10px}</style></head><body>');
  out.push('<h1>Statistics: ' + esc(m.title || 'log') + '</h1>');
  out.push('<p>' + fmt(r.lines) + ' lines' + (r.firstTime !== null ? ', from ' + esc(when(r.firstTime)) + ' to ' + esc(when(r.lastTime)) : ', no time stamps recognised') + '. ' + fmt(r.timed) + ' lines carry a time stamp (' + fmt(r.untimed) + ' do not, for example the lines of a stack trace).' + (r.timeFormat ? ' Time format: ' + esc(r.timeFormat) + '.' : '') + '</p>');
  if (r.aborted) out.push('<p class="warn">The count was cancelled, so these numbers cover only the part of the log that was read.</p>');
  if (r.longLines) out.push('<p class="warn">' + fmt(r.longLines) + ' line(s) are longer than 1,048,576 characters and were read only up to that length.</p>');
  out.push('<h2>Lines by level</h2><table><caption>Level of every line (a line without a recognised level is counted as "none")</caption><tr><th scope="col">Level</th><th scope="col">Lines</th><th scope="col">Share</th></tr>');
  const order = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'none'];
  for (const k of order) out.push('<tr><th scope="row">' + esc(k) + '</th><td class="n">' + fmt(r.levels[k]) + '</td><td class="n">' + (r.lines ? (r.levels[k] / r.lines * 100).toFixed(1) : '0.0') + '%</td></tr>');
  out.push('</table>');
  const b = r.histogram.buckets;
  out.push('<h2>Lines over time</h2>');
  if (!b.length) out.push('<p class="note">No time stamps were recognised, so there is no chart. See docs/timestamps.md for the supported formats.</p>');
  else {
    const max = Math.max.apply(null, b.map(function (x) { return x.count; })) || 1;
    const w = 1000;
    const h = 150;
    const bw = w / b.length;
    out.push('<svg viewBox="0 0 ' + w + ' ' + (h + 25) + '" role="img" aria-label="' + esc('Bar chart: lines per ' + span(r.histogram.widthMs) + ' from ' + when(b[0].start) + ', highest bar ' + fmt(max) + ' lines. The same numbers are in the table below.') + '" preserveAspectRatio="none">');
    b.forEach(function (x, i) {
      const bh = Math.max(x.count ? 1 : 0, Math.round(x.count / max * h));
      const eh = x.count ? Math.round(x.errors / max * h) : 0;
      out.push('<g><title>' + esc(when(x.start) + ': ' + fmt(x.count) + ' lines, ' + fmt(x.errors) + ' errors') + '</title><rect class="bar" x="' + (i * bw + 1).toFixed(1) + '" y="' + (h - bh) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + bh + '"/>' + (eh ? '<rect class="err" x="' + (i * bw + 1).toFixed(1) + '" y="' + (h - eh) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + eh + '"/>' : '') + '</g>');
    });
    out.push('<line class="axis" x1="0" y1="' + h + '" x2="' + w + '" y2="' + h + '"/></svg>');
    out.push('<p class="note">Each bar is ' + esc(span(r.histogram.widthMs)) + '. The red part of a bar is the lines at error level or above.</p>');
    out.push('<table><caption>The numbers behind the chart</caption><tr><th scope="col">From</th><th scope="col">Lines</th><th scope="col">Errors and above</th></tr>');
    for (const x of b) out.push('<tr><td>' + esc(when(x.start)) + '</td><td class="n">' + fmt(x.count) + '</td><td class="n">' + fmt(x.errors) + '</td></tr>');
    out.push('</table>');
  }
  out.push('<h2>Error bursts</h2>');
  if (!r.bursts.length) out.push('<p class="note">No burst of five or more error lines close together was found.</p>');
  else {
    out.push('<table><caption>Runs of error lines (fatal or error) ' + (r.burstUnit === 'time' ? 'with gaps of at most 10 seconds' : 'with gaps of at most 25 lines, because the log has no time stamps') + '</caption><tr><th scope="col">Lines</th><th scope="col">First line</th><th scope="col">Last line</th><th scope="col">From</th><th scope="col">To</th></tr>');
    for (const x of r.bursts) out.push('<tr><td class="n">' + fmt(x.count) + '</td><td class="n">' + fmt(x.startLine + 1) + '</td><td class="n">' + fmt(x.endLine + 1) + '</td><td>' + esc(when(x.startTime)) + '</td><td>' + esc(when(x.endTime)) + '</td></tr>');
    out.push('</table>');
  }
  for (const f of Object.keys(r.top)) {
    out.push('<h2>Most frequent values of ' + esc(f) + '</h2><table><tr><th scope="col">Value</th><th scope="col">Lines</th></tr>');
    for (const v of r.top[f]) out.push('<tr><td>' + esc(String(v.value).slice(0, 300)) + '</td><td class="n">' + fmt(v.count) + '</td></tr>');
    out.push('</table>');
    if (r.untracked[f]) out.push('<p class="warn">The log has more than ' + fmt(r.distinctLimit) + ' different values of ' + esc(f) + '. The counts above are exact for the first ' + fmt(r.distinctLimit) + ' values seen; ' + fmt(r.untracked[f]) + ' lines with later new values were not counted.</p>');
  }
  out.push('</body></html>');
  return out.join('\n');
}

module.exports = { statsHtml, esc };
