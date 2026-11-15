'use strict';
// Parse profiles (Pro): turn one log line into named fields. Built in: JSON lines, logfmt, syslog
// (RFC 3164 and 5424), web server access logs (common and combined), nginx and Apache error logs,
// log4j/logback-style conversion patterns, and a user-defined regular expression with named groups.
// Values stay text: JSON numbers keep their exact digits (a 20-digit identifier is not rounded),
// and number-like values are compared as decimals, never as binary floating point.
//
// The built-in patterns are fixed, reviewed and free of nested open-ended repeats. Every pattern
// that comes from the user (log4j pattern, regex profile) runs on the engine without backtracking.

const safere = require('../engine/safere');

const MAX_FIELDS = 200;
const MAX_VALUE = 20000;
const MAX_DEPTH = 8;
const MAX_JSON_CHARS = 1024 * 1024;

const PROFILE_LIST = Object.freeze([
  { id: 'jsonl', label: 'JSON lines (one JSON object per line)' },
  { id: 'logfmt', label: 'logfmt (key=value pairs)' },
  { id: 'syslog', label: 'Syslog (RFC 3164 and RFC 5424)' },
  { id: 'access', label: 'Web server access log (common and combined)' },
  { id: 'nginx-error', label: 'nginx error log' },
  { id: 'apache-error', label: 'Apache error log' },
  { id: 'log4j', label: 'log4j / logback conversion pattern' },
  { id: 'regex', label: 'Your own regular expression with named groups' }
]);

// ---- JSON lines (exact numbers) ---------------------------------------------------------------

/** Flattens a JSON object into { 'a.b': 'text' } with number text kept exactly; null when the text is not an object. */
function parseJsonFields(text) {
  if (text.length > MAX_JSON_CHARS) return null;
  let i = 0;
  const n = text.length;
  const out = Object.create(null);
  let count = 0;
  let failed = false;
  function ws() { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } }
  function str() {
    // at the opening quote
    i++;
    let s = '';
    let start = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { s += text.slice(start, i); i++; return s; }
      if (c === 92) {
        s += text.slice(start, i);
        i++;
        const e = text[i++];
        if (e === 'n') s += '\n'; else if (e === 't') s += '\t'; else if (e === 'r') s += '\r'; else if (e === 'b') s += '\b'; else if (e === 'f') s += '\f';
        else if (e === '/' || e === '\\' || e === '"') s += e;
        else if (e === 'u') {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) { failed = true; return s; }
          s += String.fromCharCode(parseInt(h, 16)); i += 4;
        } else { failed = true; return s; }
        start = i;
      } else if (c < 32) { failed = true; return s; } else i++;
    }
    failed = true;
    return s;
  }
  function put(path, value) {
    if (count >= MAX_FIELDS) return;
    const key = path;
    if (!(key in out)) count++;
    out[key] = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
  }
  function value(path, depth) {
    ws();
    if (i >= n) { failed = true; return; }
    const c = text[i];
    if (c === '"') { put(path, str()); return; }
    if (c === '{') {
      if (depth >= MAX_DEPTH) { failed = true; return; }
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') { failed = true; return; }
        const k = str();
        if (failed) return;
        ws();
        if (text[i] !== ':') { failed = true; return; }
        i++;
        value(path ? path + '.' + k : k, depth + 1);
        if (failed) return;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        failed = true; return;
      }
    }
    if (c === '[') {
      if (depth >= MAX_DEPTH) { failed = true; return; }
      i++; ws();
      if (text[i] === ']') { i++; return; }
      let idx = 0;
      for (;;) {
        value(path + '.' + idx, depth + 1);
        idx++;
        if (failed) return;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        failed = true; return;
      }
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) { failed = true; return; }
    i += m[0].length;
    put(path, m[0]);
  }
  ws();
  if (text[i] !== '{') return null;
  value('', 0);
  if (failed) return null;
  ws();
  if (i < n) return null;
  return out;
}

// ---- logfmt ---------------------------------------------------------------------------------------

function parseLogfmt(text) {
  const out = Object.create(null);
  let i = 0;
  const n = text.length;
  let count = 0;
  while (i < n && count < MAX_FIELDS) {
    while (i < n && text.charCodeAt(i) <= 32) i++;
    const ks = i;
    while (i < n) { const c = text.charCodeAt(i); if (c <= 32 || c === 61 || c === 34) break; i++; }
    if (i === ks) { if (i < n && text[i] === '"') { i++; while (i < n && text[i] !== '"') i++; i++; continue; } i++; continue; }
    const key = text.slice(ks, i);
    if (text[i] !== '=') continue; // a word without a value is not a field
    i++;
    let val;
    if (text[i] === '"') {
      i++;
      let s = '';
      let start = i;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { s += text.slice(start, i); i++; const e = text[i]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i++; start = i; } else i++;
      }
      s += text.slice(start, i);
      i++;
      val = s;
    } else {
      const vs = i;
      while (i < n && text.charCodeAt(i) > 32) i++;
      val = text.slice(vs, i);
    }
    if (!(key in out)) count++;
    out[key] = val.length > MAX_VALUE ? val.slice(0, MAX_VALUE) : val;
  }
  return count >= 1 && (count >= 2 || 'level' in out || 'msg' in out || 'time' in out) ? out : null;
}

// ---- fixed patterns -------------------------------------------------------------------------------

const SYSLOG_SEVERITY = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const RE_SYSLOG3164 = /^(?:<(\d{1,3})>)?([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}) (\S+) ([^\s:[]+)(?:\[(\d+)\])?: ?(.*)$/;
const RE_SYSLOG5424 = /^<(\d{1,3})>(\d{1,2}) (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[(?:[^\]\\]|\\.)*\])+) ?(.*)$/;
const RE_ACCESS = /^(\S+) (\S+) (\S+) \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}|-) (\S+)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?/;
const RE_NGINX_ERROR = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (\d+)#(\d+): (?:\*(\d+) )?(.*)$/;
const RE_APACHE_ERROR = /^\[([^\]]+)\] \[([^\]]+)\](?: \[pid (\d+)(?::tid (\d+))?\])?(?: \[client ([^\]]+)\])? (.*)$/;

function parseSyslog(line) {
  let m = RE_SYSLOG5424.exec(line);
  if (m) {
    const pri = Number(m[1]);
    return { facility: String(pri >> 3), severity: SYSLOG_SEVERITY[pri & 7], level: SYSLOG_SEVERITY[pri & 7], time: m[3], host: m[4], app: m[5], pid: m[6], msgid: m[7], structured: m[8], message: m[9] };
  }
  m = RE_SYSLOG3164.exec(line);
  if (m) {
    const out = { time: m[2], host: m[3], app: m[4], message: m[6] };
    if (m[5]) out.pid = m[5];
    if (m[1]) { const pri = Number(m[1]); out.facility = String(pri >> 3); out.severity = SYSLOG_SEVERITY[pri & 7]; out.level = SYSLOG_SEVERITY[pri & 7]; }
    return out;
  }
  return null;
}

function parseAccess(line) {
  const m = RE_ACCESS.exec(line);
  if (!m) return null;
  const out = { remote_addr: m[1], ident: m[2], user: m[3], time: m[4], request: m[5], status: m[6], bytes: m[7] };
  const parts = m[5].split(' ');
  if (parts.length >= 2) { out.method = parts[0]; out.path = parts[1]; if (parts[2]) out.protocol = parts[2]; }
  if (m[8] !== undefined) { out.referer = m[8]; out.user_agent = m[9]; }
  const s = Number(m[6]);
  out.level = s >= 500 ? 'error' : s >= 400 ? 'warn' : 'info';
  return out;
}

function parseNginxError(line) {
  const m = RE_NGINX_ERROR.exec(line);
  if (!m) return null;
  const out = { time: m[1], level: m[2], pid: m[3], tid: m[4], message: m[6] };
  if (m[5]) out.connection = m[5];
  const rest = m[6];
  const re = /, (client|server|request|upstream|host|referrer): ("[^"]*"|[^,]*)/g;
  let k;
  let guard = 0;
  while ((k = re.exec(rest)) !== null && guard++ < 20) out[k[1]] = k[2].replace(/^"|"$/g, '');
  return out;
}

function parseApacheError(line) {
  const m = RE_APACHE_ERROR.exec(line);
  if (!m) return null;
  const mod = m[2].split(':');
  const out = { time: m[1], module: mod.length > 1 ? mod[0] : '', level: mod.length > 1 ? mod[1] : mod[0], message: m[6] };
  if (m[3]) out.pid = m[3];
  if (m[4]) out.tid = m[4];
  if (m[5]) out.client = m[5];
  return out;
}

// ---- log4j / logback conversion patterns --------------------------------------------------------

const CONVERSIONS = {
  d: 'time', date: 'time', p: 'level', level: 'level', t: 'thread', thread: 'thread', c: 'logger', logger: 'logger', C: 'class', class: 'class',
  m: 'message', msg: 'message', message: 'message', M: 'method', method: 'method', L: 'line', line: 'line', F: 'file', file: 'file',
  r: 'elapsed', relative: 'elapsed', i: 'pid', pid: 'pid', l: 'location', X: 'mdc', mdc: 'mdc', x: 'ndc', ndc: 'ndc', marker: 'marker', n: ''
};

/** Converts a log4j/logback conversion pattern into a regular expression text with named groups. */
function conversionToRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('Enter a conversion pattern such as %d{yyyy-MM-dd HH:mm:ss} [%t] %-5level %logger{36} - %msg%n');
  if (pattern.length > 500) throw new Error('The conversion pattern is longer than 500 characters.');
  let out = '^';
  const used = new Set();
  let i = 0;
  let lastWasMessage = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c !== '%') {
      const next = pattern.indexOf('%', i);
      const lit = pattern.slice(i, next < 0 ? pattern.length : next);
      out += safere.escapeText(lit);
      i += lit.length;
      lastWasMessage = false;
      continue;
    }
    if (pattern[i + 1] === '%') { out += '%'; i += 2; continue; }
    const m = /^%(-?)(\d*)(?:\.(\d+))?([A-Za-z]+)(\{[^}]*\})?/.exec(pattern.slice(i, i + 80));
    if (!m) throw new Error('The conversion pattern has a "%" that is not followed by a conversion word (at position ' + (i + 1) + ').');
    let word = m[4];
    // %n has no padding; a run of letters such as "msgn" is split into the known word and the rest
    if (!(word in CONVERSIONS)) {
      const known = Object.keys(CONVERSIONS).filter(function (k) { return word.startsWith(k) && k.length > 0; }).sort(function (a, b) { return b.length - a.length; })[0];
      if (!known) throw new Error('The conversion word %' + word + ' is not supported. Supported: %d %p %level %t %thread %c %logger %C %class %m %msg %message %M %L %F %r %i %l %X %x %n.');
      word = known;
      const consumed = '%' + m[1] + m[2] + (m[3] ? '.' + m[3] : '') + word;
      const rest = m[0].slice(consumed.length - 0);
      void rest;
      i += consumed.length;
    } else i += m[0].length;
    const name = CONVERSIONS[word];
    if (word === 'n') { out += '\\s*'; continue; }
    let group = name;
    for (let k = 2; used.has(group); k++) group = name + k;
    used.add(group);
    let body;
    if (name === 'time') {
      const spec = m[5] || '';
      body = /y/.test(spec) || !spec ? '\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?' : '\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?';
    } else if (name === 'level') body = '[A-Za-z]+';
    else if (name === 'message') body = '.*';
    else if (name === 'line' || name === 'elapsed' || name === 'pid') body = '\\d+';
    else if (name === 'thread' || name === 'mdc' || name === 'ndc' || name === 'marker') body = '.*?';
    else body = '\\S+';
    out += '(?<' + group + '>' + body + ')';
    if (m[2]) out += '\\s*'; // padded to a minimum width: the padding spaces
    lastWasMessage = name === 'message';
  }
  void lastWasMessage;
  return out;
}

// ---- profiles -------------------------------------------------------------------------------------

/**
 * Creates a profile: { id, label, parse(line) -> fields | null, error? }. `options.pattern` is the
 * conversion pattern (log4j) or the regular expression (regex). Throws an Error with a message for
 * the user when the pattern is not valid.
 */
function createProfile(id, options) {
  const o = options || {};
  const meta = PROFILE_LIST.find(function (p) { return p.id === id; });
  if (!meta) throw new Error('Unknown parse profile.');
  const profile = { id: id, label: meta.label };
  switch (id) {
    case 'jsonl':
      profile.parse = function (line) { const t = line.trimStart(); return t.charCodeAt(0) === 123 ? parseJsonFields(t) : null; };
      break;
    case 'logfmt': profile.parse = parseLogfmt; break;
    case 'syslog': profile.parse = parseSyslog; break;
    case 'access': profile.parse = parseAccess; break;
    case 'nginx-error': profile.parse = parseNginxError; break;
    case 'apache-error': profile.parse = parseApacheError; break;
    case 'log4j':
    case 'regex': {
      const text = id === 'log4j' ? conversionToRegex(o.pattern) : String(o.pattern || '');
      if (!text.trim()) throw new Error('Enter a regular expression with named groups, for example ^(?<time>\\S+) (?<level>[A-Z]+) (?<message>.*)$');
      let re;
      try { re = safere.compile(text, { ignoreCase: false }); } catch (e) {
        if (e instanceof safere.RegexError) throw new Error('The pattern was not accepted: ' + e.message);
        throw e;
      }
      if (!re.groupNames.length) throw new Error('The pattern has no named group. Name the parts you want as columns with (?<name>...).');
      profile.pattern = text;
      // `ctx.meter` (safere.createMeter) lets a loop share one work limit between the rows it parses.
      profile.parse = function (line, ctx) {
        const opts = ctx && ctx.meter ? { meter: ctx.meter } : undefined;
        if (!re.test(line, opts)) return null;
        const m = re.exec(line, 0, opts);
        if (!m) return null;
        const out = Object.create(null);
        for (const k of Object.keys(m.groups)) if (m.groups[k] !== undefined) out[k] = m.groups[k];
        return out;
      };
      break;
    }
    default: throw new Error('Unknown parse profile.');
  }
  return profile;
}

/** Guesses the built-in profile that fits most of the sample lines, or null. */
function suggest(lines) {
  const ids = ['jsonl', 'logfmt', 'access', 'nginx-error', 'apache-error', 'syslog'];
  let best = null;
  let bestHits = 0;
  const sample = lines.filter(function (l) { return l && l.trim(); }).slice(0, 200);
  for (const id of ids) {
    const p = createProfile(id);
    let hits = 0;
    for (const l of sample) if (p.parse(l)) hits++;
    if (hits > bestHits) { best = id; bestHits = hits; }
  }
  return best && bestHits * 2 >= sample.length && bestHits > 0 ? best : null;
}

// ---- exact value comparison -----------------------------------------------------------------------

// A number as the JSON and logfmt profiles carry it: an optional sign, digits with an optional
// fraction, and an optional exponent (1.5e3, 2E-7). The exponent has at most 6 digits.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,6})?$/;

/**
 * Compares two decimal strings exactly (no floating point). A value is held as its sign, its
 * significant digits (no leading or trailing zeros) and the position of its decimal point, so a large
 * exponent never builds a long string.
 */
function compareDecimal(a, b) {
  const pa = splitDecimal(a);
  const pb = splitDecimal(b);
  if (pa.zero && pb.zero) return 0;
  if (pa.zero) return pb.neg ? 1 : -1;
  if (pb.zero) return pa.neg ? -1 : 1;
  if (pa.neg !== pb.neg) return pa.neg ? -1 : 1;
  let c;
  if (pa.point !== pb.point) c = pa.point < pb.point ? -1 : 1;
  else {
    const len = Math.max(pa.digits.length, pb.digits.length);
    const da = pa.digits.padEnd(len, '0');
    const db = pb.digits.padEnd(len, '0');
    c = da === db ? 0 : da < db ? -1 : 1;
  }
  return pa.neg ? -c : c;
}

// value = 0.<digits> x 10^point
function splitDecimal(s) {
  const neg = s[0] === '-';
  let body = s.replace(/^[+-]/, '');
  let exp = 0;
  const e = body.search(/[eE]/);
  if (e >= 0) { exp = Number(body.slice(e + 1)); body = body.slice(0, e); }
  const dot = body.indexOf('.');
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? '' : body.slice(dot + 1);
  const all = intPart + fracPart;
  const lead = all.length - all.replace(/^0+/, '').length;
  const digits = all.slice(lead).replace(/0+$/, '');
  if (digits === '') return { neg: false, zero: true, digits: '', point: 0 };
  return { neg: neg, zero: false, digits: digits, point: intPart.length - lead + exp };
}

function isNumberText(s) { return typeof s === 'string' && NUMBER_RE.test(s) && s.length <= 400; }

/** Compares two field values: as exact decimals when both are numbers, otherwise as text by code point. */
function compareValues(a, b) {
  const x = a === undefined ? '' : String(a);
  const y = b === undefined ? '' : String(b);
  if (isNumberText(x) && isNumberText(y)) return compareDecimal(x, y);
  return x === y ? 0 : x < y ? -1 : 1;
}

module.exports = { PROFILE_LIST, createProfile, suggest, parseJsonFields, parseLogfmt, conversionToRegex, compareDecimal, compareValues, isNumberText };
