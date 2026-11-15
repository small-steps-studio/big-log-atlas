'use strict';
// Pretty printing of one JSON value (Pro) that keeps every number exactly as written: a 20-digit
// identifier or an amount such as 10.50 is not rounded or reformatted. Returns the formatted text,
// or null when the text is not one complete, valid JSON value. Nesting is limited to 64 levels and
// the text to 1 MiB, so that a hostile line cannot exhaust the stack or memory.

const MAX_DEPTH = 64;
const MAX_CHARS = 1024 * 1024;

function pretty(text, indent) {
  if (typeof text !== 'string' || text.length > MAX_CHARS) return null;
  const unit = indent === undefined ? '  ' : indent;
  let i = 0;
  const n = text.length;
  let bad = false;
  function ws() { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } }
  function string() {
    const start = i;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return text.slice(start, i); }
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { bad = true; return ''; } i += 6; } else if ('"\\/bfnrt'.indexOf(e) !== -1 && e !== undefined) i += 2; else { bad = true; return ''; }
      } else if (c < 32) { bad = true; return ''; } else i++;
    }
    bad = true;
    return '';
  }
  function value(depth, pad) {
    ws();
    if (i >= n) { bad = true; return ''; }
    const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      if (depth >= MAX_DEPTH) { bad = true; return ''; }
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) { i++; return c + close; }
      const inner = pad + unit;
      const parts = [];
      for (;;) {
        ws();
        let item;
        if (c === '{') {
          if (text[i] !== '"') { bad = true; return ''; }
          const k = string();
          if (bad) return '';
          ws();
          if (text[i] !== ':') { bad = true; return ''; }
          i++;
          item = k + ': ' + value(depth + 1, inner);
        } else item = value(depth + 1, inner);
        if (bad) return '';
        parts.push(inner + item);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; break; }
        bad = true; return '';
      }
      return c + '\n' + parts.join(',\n') + '\n' + pad + close;
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) { bad = true; return ''; }
    i += m[0].length;
    return m[0];
  }
  const out = value(0, '');
  if (bad) return null;
  ws();
  if (i < n) return null;
  return out;
}

module.exports = { pretty };
