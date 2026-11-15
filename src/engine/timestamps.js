'use strict';
// Timestamp detection for common log formats. Times are returned as milliseconds since the Unix
// epoch (UTC). A time without a zone is read as UTC, so that the order of lines does not depend on
// the time zone of the computer; times of day without a date count from 1970-01-01. No local-time
// Date method is used anywhere. The patterns are bounded and without nested repeats (linear time).

const MONTHS = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });

function utc(y, mo, d, h, mi, s, ms) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return NaN;
  const t = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59), ms || 0);
  if (new Date(t).getUTCDate() !== d) return NaN; // 31 February and similar
  return t;
}

function fraction(text) {
  if (!text) return 0;
  return Math.floor(Number('0.' + text.slice(0, 9).padEnd(3, '0')) * 1000 + 1e-9);
}

function offsetMs(text) {
  if (!text || text === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(text);
  if (!m) return 0;
  const v = (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
  return m[1] === '-' ? -v : v;
}

// The year of a record without one: the year of the reference time (the file's modification time),
// or the year before when the record's month lies well after the reference month.
function yearFor(month, ref) {
  const r = new Date(ref);
  const year = r.getUTCFullYear();
  return month > r.getUTCMonth() + 2 ? year - 1 : year;
}

const FORMATS = [
  {
    id: 'iso', label: 'ISO 8601 (2024-05-01T12:34:56.789Z, 2024-05-01 12:34:56,789 +02:00)',
    re: /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?: ?(Z|[+-]\d{2}(?::?\d{2})?))?/,
    ms: function (m) { return utc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], fraction(m[7])) - offsetMs(m[8]); }
  },
  {
    id: 'slash', label: 'Year/month/day (2024/05/01 12:34:56)',
    re: /(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/,
    ms: function (m) { return utc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], 0); }
  },
  {
    id: 'clf', label: 'Web server access log ([01/May/2024:12:34:56 +0000])',
    re: /\[(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?: ([+-]\d{4}))?\]/,
    ms: function (m) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? utc(+m[3], mo, +m[1], +m[4], +m[5], +m[6], 0) - offsetMs(m[7]) : NaN; }
  },
  {
    id: 'apache-error', label: 'Web server error log ([Wed May 01 12:34:56.123 2024])',
    re: /\[[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? (\d{4})\]/,
    ms: function (m) { const mo = MONTHS[m[1].toLowerCase()]; return mo ? utc(+m[6], mo, +m[2], +m[3], +m[4], +m[5], 0) : NaN; }
  },
  {
    id: 'syslog', label: 'Syslog (May  1 12:34:56, no year)',
    re: /^(?:<\d{1,3}>\d? ?)?([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})/,
    needsYear: true,
    ms: function (m, ref) { const mo = MONTHS[m[1].toLowerCase()]; return mo ? utc(yearFor(mo, ref), mo, +m[2], +m[3], +m[4], +m[5], 0) : NaN; }
  },
  {
    id: 'logcat', label: 'Month-day (05-01 12:34:56.789, no year)',
    re: /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/,
    needsYear: true,
    ms: function (m, ref) { return utc(yearFor(+m[1], ref), +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]); }
  },
  {
    id: 'epoch', label: 'Unix time in a "ts", "time" or "timestamp" field',
    re: /(?:"(?:ts|time|timestamp|@timestamp|t|unixtime|time_unix)"\s*:\s*|\b(?:ts|time|timestamp)=)"?(\d{9,13})(?:\.(\d{1,9}))?/,
    ms: function (m) {
      const digits = m[1].length;
      if (digits >= 12) return Number(m[1]);
      return Number(m[1]) * 1000 + fraction(m[2]);
    }
  },
  {
    id: 'time-of-day', label: 'Time of day only (12:34:56.789)',
    re: /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/,
    ms: function (m) { return m[1] > 23 || m[2] > 59 || m[3] > 59 ? NaN : (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + fraction(m[4]); }
  }
];

const BY_ID = Object.freeze(FORMATS.reduce(function (acc, f) { acc[f.id] = f; return acc; }, {}));
const SEARCH_CHARS = 320;

/** Milliseconds for the first timestamp of the given format in a line, or NaN. */
function extract(formatId, line, reference) {
  const f = BY_ID[formatId];
  if (!f) return NaN;
  const head = line.length > SEARCH_CHARS ? line.slice(0, SEARCH_CHARS) : line;
  const m = f.re.exec(head);
  if (!m) return NaN;
  return f.ms(m, reference === undefined ? Date.now() : reference);
}

/** A function line -> milliseconds (NaN when the line has none) for one format. */
function extractor(formatId, reference) {
  const f = BY_ID[formatId];
  if (!f) return function () { return NaN; };
  const ref = reference === undefined ? Date.now() : reference;
  return function (line) {
    const head = line.length > SEARCH_CHARS ? line.slice(0, SEARCH_CHARS) : line;
    const m = f.re.exec(head);
    return m ? f.ms(m, ref) : NaN;
  };
}

/**
 * Finds the format used by most of the given sample lines. Result: { id, label, hits, total } or
 * null when fewer than a fifth of the non-empty lines (and fewer than 3) carry a timestamp.
 */
function detect(lines, reference) {
  const ref = reference === undefined ? Date.now() : reference;
  const counts = new Array(FORMATS.length).fill(0);
  let total = 0;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    total++;
    for (let i = 0; i < FORMATS.length; i++) {
      const f = FORMATS[i];
      const m = f.re.exec(line.length > SEARCH_CHARS ? line.slice(0, SEARCH_CHARS) : line);
      if (m && !isNaN(f.ms(m, ref))) counts[i]++;
    }
  }
  let best = -1;
  for (let i = 0; i < FORMATS.length; i++) if (counts[i] > 0 && (best < 0 || counts[i] > counts[best])) best = i;
  if (best < 0) return null;
  if (counts[best] < 3 && counts[best] < total) return null;
  if (counts[best] * 5 < total) return null;
  return { id: FORMATS[best].id, label: FORMATS[best].label, hits: counts[best], total: total };
}

/** ISO text of a time in milliseconds (UTC, with milliseconds). */
function toIso(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

/**
 * Reads a time typed by the user: an ISO date or date-time (read as UTC when it has no zone), a
 * time of day, or a number of milliseconds / seconds since the epoch. Returns NaN when not understood.
 */
function parseUserTime(text, reference) {
  const t = String(text || '').trim();
  if (!t) return NaN;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?(?: ?(Z|[+-]\d{2}(?::?\d{2})?))?$/.exec(t);
  if (iso) return utc(+iso[1], +iso[2], +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0), fraction(iso[7])) - offsetMs(iso[8]);
  const tod = /^(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?$/.exec(t);
  if (tod) {
    if (+tod[1] > 23 || +tod[2] > 59 || +(tod[3] || 0) > 59) return NaN;
    const base = reference === undefined ? 0 : Math.floor(reference / 86400000) * 86400000;
    return base + (+tod[1] * 3600 + +tod[2] * 60 + +(tod[3] || 0)) * 1000 + fraction(tod[4]);
  }
  if (/^\d{9,13}(?:\.\d+)?$/.test(t)) return t.replace('.', '').length >= 12 && !t.includes('.') ? Number(t) : Math.round(Number(t) * 1000);
  return NaN;
}

module.exports = { FORMATS, extract, extractor, detect, toIso, parseUserTime, utc };
