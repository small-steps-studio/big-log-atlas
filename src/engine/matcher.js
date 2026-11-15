'use strict';
// Text and regular expression matchers for the search and the filters.
//
// createMatcher({ text, regex, caseSensitive, wholeWord }) resolves to
//   { ok: true, empty, test(line), spans(line, max) }  or  { ok: false, error: { code, message } }.
// Regular expressions run on the engine without backtracking (see safere.js); a pattern that engine
// cannot match in guaranteed linear time (back-references, look-around) is refused with a clear message,
// and a call that needs more work than the work limit allows is stopped (RegexError, code "budget").

const safere = require('./safere');

function isWordChar(code) { return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122) || code > 127 && /[\p{L}\p{N}]/u.test(String.fromCharCode(code)); }

function boundaryOk(line, start, end) {
  const before = start > 0 ? line.charCodeAt(start - 1) : -1;
  const after = end < line.length ? line.charCodeAt(end) : -1;
  return !(before >= 0 && isWordChar(before)) && !(after >= 0 && isWordChar(after));
}

function createMatcher(spec) {
  const s = spec || {};
  const text = typeof s.text === 'string' ? s.text : '';
  if (!text) return { ok: true, empty: true, test: function () { return true; }, spans: function () { return []; } };
  const caseSensitive = s.caseSensitive === true;
  const wholeWord = s.wholeWord === true;
  if (s.regex) {
    let re;
    try {
      re = safere.compile(wholeWord ? '\\b(?:' + text + ')\\b' : text, { ignoreCase: !caseSensitive });
    } catch (e) {
      if (e instanceof safere.RegexError) return { ok: false, error: { code: e.code, message: 'The regular expression was not accepted: ' + e.message } };
      throw e;
    }
    const matcher = {
      ok: true, empty: false, regex: re,
      // Throws a RegexError with code "budget" when the pattern needs more work than the limit allows
      // for this line (see safere.js); the passes that call it stop and tell the user.
      test: function (line) { return re.test(line); },
      // Spans for highlighting. `meter` (safere.createMeter) lets a screen of rows share one work
      // limit. A line that needs more work than allowed gets no highlight and sets `tooCostly`
      // (the caller resets it and tells the user).
      spans: function (line, max, meter) {
        if (meter && meter.used >= meter.limit) { matcher.tooCostly = true; return []; }
        let found;
        try { found = re.findAll(line, max || 200, meter ? { meter: meter } : undefined); } catch (e) {
          if (e instanceof safere.RegexError && e.code === 'budget') { matcher.tooCostly = true; return []; }
          throw e;
        }
        return found.filter(function (m) { return m.end > m.index; }).map(function (m) { return [m.index, m.end]; });
      },
      tooCostly: false
    };
    return matcher;
  }
  const needle = caseSensitive ? text : text.toLowerCase();
  // Case-insensitive search of text: lower-casing keeps the length for almost all text; a line where
  // it does not is searched by the regular expression engine instead.
  let fallback = null;
  function viaEngine(line, max) {
    if (!fallback) fallback = safere.compile(safere.escapeText(text), { ignoreCase: true });
    return fallback.findAll(line, max || 200).filter(function (m) { return !wholeWord || boundaryOk(line, m.index, m.end); }).map(function (m) { return [m.index, m.end]; });
  }
  function spans(line, max) {
    const hay = caseSensitive ? line : line.toLowerCase();
    if (!caseSensitive && hay.length !== line.length) return viaEngine(line, max);
    const out = [];
    let from = 0;
    const limit = max || 200;
    while (out.length < limit) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      if (!wholeWord || boundaryOk(line, i, i + needle.length)) out.push([i, i + needle.length]);
      from = i + Math.max(1, needle.length);
    }
    return out;
  }
  return {
    ok: true, empty: false,
    test: function (line) {
      const hay = caseSensitive ? line : line.toLowerCase();
      if (!caseSensitive && hay.length !== line.length) return viaEngine(line, 1).length > 0;
      if (!wholeWord) return hay.indexOf(needle) !== -1;
      let from = 0;
      for (;;) {
        const i = hay.indexOf(needle, from);
        if (i < 0) return false;
        if (boundaryOk(line, i, i + needle.length)) return true;
        from = i + 1;
      }
    },
    spans: spans
  };
}

module.exports = { createMatcher, isWordChar };
