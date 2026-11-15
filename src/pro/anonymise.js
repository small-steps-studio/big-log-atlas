'use strict';
// Anonymisation of log text (Pro): e-mail addresses, IP addresses, token-like strings, card-like
// numbers, the values of secret names and the rules of a rule file are replaced before a log is shared.
// docs/export.md lists the shapes that are covered; every one of them is tested in
// test/anonymise.hostile.test.js, and what is not covered is listed there too.
//
//   * The replacement of a value is derived with HMAC-SHA256 from a 256-bit key drawn from the
//     system's random source for every run; the key is never stored, shown or logged. The same
//     value gets the same replacement within one run (so a user can still be followed through a
//     log), and the copy cannot be turned back without the key.
//   * Two different values never get the same replacement within one run. While a run is going,
//     the anonymiser holds in memory (never written anywhere, freed with the run) which value
//     digest owns which replacement; when a replacement is already owned by another value, the
//     next candidate derived from the same value is taken. No table of original values exists:
//     only replacements and 128-bit digests of the values. A run stops with a clear message when
//     it would have to keep apart more than MAX_VALUES different values.
//   * Secret names (secretnames.js): the value after a name that says "secret" is replaced whole,
//     in pairs (name=value, name: value, "name": value, quoted names with spaces and brackets),
//     in name/value pairs ({"name":"DB_PASSWORD","value":...}, <add key="..." value="..."/>),
//     in options of a command line and in a few well-known commands (curl -u, mysql -p, sshpass,
//     redis-cli -a, docker login -p), in XML elements and in web addresses (user:password@host).
//   * Encodings. A string in quotes that holds an escape is decoded (up to MAX_DEPTH levels, so
//     escaped JSON inside escaped JSON is seen), the rules run on the decoded text, and a string
//     that changed is written back encoded again. A line with HTML entities (&quot; &#61;) or
//     percent escapes (%3D) is read decoded too; when that reveals something, the line is written
//     decoded, with the replacements in it.
//   * The built-in patterns are fixed and reviewed. The patterns of a rule file run on the
//     regular expression engine without backtracking, with a work limit per line, so a rule file
//     cannot freeze the editor: a rule that needs too much work for a line stops the run with a
//     message that names the rule.
//   * A key can be passed in only by tests (`options.key`); no command or setting reaches it.

const crypto = require('node:crypto');
const safere = require('../engine/safere');
const names = require('./secretnames');

const isSecretName = names.isSecretName;
const isSecretKey = names.isSecretKey;
const MAX_VALUES = 2000000;
const FORWARD_CACHE = 50000;
const MAX_DEPTH = 4;

class AnonymiseError extends Error {
  constructor(message, code) { super(message); this.name = 'AnonymiseError'; this.code = code; }
}

/**
 * HMAC-SHA256 (RFC 2104) of a text under `key`, as a function of the text. It is built from the
 * SHA-256 hash of the runtime because creating a keyed hash object for every value is several
 * times slower than two hashes, and an export asks for millions of them. The result is the same
 * as crypto.createHmac('sha256', key) (the tests compare them).
 */
function hmacSha256(key) {
  const block = 64;
  const k = key.length > block ? crypto.createHash('sha256').update(key).digest() : key;
  const ipad = Buffer.alloc(block, 0x36);
  const opad = Buffer.alloc(block, 0x5c);
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
  return function (text) {
    const inner = crypto.createHash('sha256').update(ipad).update(text, 'utf8').digest();
    return crypto.createHash('sha256').update(opad).update(inner).digest();
  };
}

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---- where names and values are ------------------------------------------------------------------

// A name, its closing quote when it has one (a JSON key), and the sign that joins it to its value.
const KEY_RE = /(?<![\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_.\-]{0,79})(["']?)(\s*(?:=>|[:=])\s*)/gu;
// A quoted name of any characters ("api key", "Password (confirm)"), then the sign.
const QUOTED_KEY_RE = /(["'])((?:[^"'\\\r\n]|\\.){1,80}?)\1(\s*(?:=>|:|=)\s*)/g;
// A command line option and its value: --name value, and "--name", "value" in a list of arguments.
const CLI_SPACE_RE = /(?<![\w.\-])--([A-Za-z][\w.\-]{0,79})[ \t]+(?=[^\s\-])/g;
const CLI_ARRAY_RE = /(?<![\w.\-])--([A-Za-z][\w.\-]{0,79})["']\s*,\s*(?=["'\w])/g;
// <name attributes>content</name>
const XML_RE = /<([A-Za-z_][\w.\-:]{0,79})(?:\s[^<>]{0,200})?>([^<>]{1,2000})<\/\1\s*>/g;
// Name/value pairs: {"name": "DB_PASSWORD", "value": "..."}, {key: X, value: Y}, name=X value=Y.
const NAME_REF_RE = /(?<![\w.])["']?(?:name|key|id|property|setting|variable|var|param|parameter|option|field|label)["']?\s*[:=]\s*(?:"((?:[^"\\\n]|\\.){1,80})"|'([^'\\\n]{1,80})'|([\w.\-]{1,80}))/gi;
const VALUE_AFTER_RE = /\s*[,;]?\s*["']?(?:value|val|data|content)["']?\s*[:=]\s*/iy;
const VALUE_THEN_NAME_RE = /(?<![\w.])["']?(?:value|val|data|content)["']?\s*[:=]\s*("(?:[^"\\\n]|\\.){0,2000}"|'[^'\n]{0,2000}'|[^\s,;}\]'"]{1,2000})\s*[,;]\s*["']?(?:name|key|id|property|setting|variable|var|param|parameter|option|field|label)["']?\s*[:=]\s*(?:"((?:[^"\\\n]|\\.){1,80})"|'([^'\\\n]{1,80})'|([\w.\-]{1,80}))/dgi;
// <add key="DbPassword" value="..."/>, <param name="x" value="y">, <property name="x">content</property>
const TAG_RE = /<[A-Za-z_][\w:.\-]*(?:\s[^<>]{1,800})?\/?>/g;
const ATTR_RE = /([\w:.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/dg;
const ATTR_NAME = new Set(['name', 'key', 'id', 'property', 'setting', 'variable', 'var', 'param', 'parameter', 'option', 'field', 'label']);
const ATTR_VALUE = new Set(['value', 'val', 'data', 'content']);
// Well-known commands that take a password.
const CURL_USER_RE = /(?<![\w-])(?:-u|--user|--proxy-user)[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/g;
const MYSQL_P_RE = /(?<![\w-])-p(?!assword)([^\s-]\S*)/g;
const SSHPASS_RE = /\bsshpass\s+(?:-[a-zA-Z]+\s+)*-p\s*(\S+)/g;
const REDIS_A_RE = /\bredis-cli\b[^\n]*?\s-a\s+(\S+)/g;
const DOCKER_P_RE = /\bdocker\s+login\b[^\n]*?\s-p\s+(\S+)/g;
const SECRET_HINT = /pass|pwd|pw|secret|token|cred|auth|session|sid|cookie|key|jwt|bearer|otp|pin|cvv|cvc|ssn|signature|csrf|xsrf|kennw|contra|clave|senha|wacht|losen|haslo|secre|segre|geheim|jeton|mdp|motdepasse|chiave|schluessel|curl|mysql|sshpass|redis|docker|name|value/i;
const SCHEMES = new Set(['bearer', 'basic', 'token', 'digest', 'negotiate', 'ntlm', 'oauth', 'apikey', 'splunk', 'hawk', 'aws4-hmac-sha256', 'mutual', 'hoba', 'jwt']);

// The end of a value that is not in quotes: the first white space, quote, comma, semicolon or &
// (and, behind a JSON key, a closing bracket). A backslash keeps the next character with the value.
function bareEnd(s, i, jsonish, so, sc) {
  const n = s.length;
  let j = i;
  for (; j < n; j++) {
    const d = s.charCodeAt(j);
    if (d === 92) { j++; continue; }
    if (d <= 32 || d === 34 || d === 39 || d === 44 || d === 59 || d === 38) break;
    if (so && (s[j] === so || s[j] === sc)) break;
    if (jsonish && (d === 125 || d === 93)) break;
  }
  return Math.min(j, n);
}

/**
 * The value that starts at s[i]: { start, end, inner, q, closeQ, closed }, or null when there is none.
 * A quoted value may have a prefix (b'..', u'..', r'..', f'..' of Python).
 */
function readValue(s, i, jsonish, so, sc) {
  const n = s.length;
  const c = s[i];
  if (c === undefined) return null;
  if (jsonish && (c === '{' || c === '[')) return null; // behind a JSON name: an object or a list holds other members, which have their own names
  if (so && c === so) {
    // A string that the escape pass has already rewritten: the whole of it is the value.
    const e = s.indexOf(sc, i + 1);
    const end = e < 0 ? n : e + 1;
    const body = s.slice(i + 1, e < 0 ? n : e);
    return { start: i, end: end, inner: body.replace(/^"|"$/g, ''), q: '"', closeQ: '"', closed: true };
  }
  let p = 0;
  if ((c === 'b' || c === 'B' || c === 'u' || c === 'U' || c === 'r' || c === 'R' || c === 'f' || c === 'F') && (s[i + 1] === '"' || s[i + 1] === "'")) p = 1;
  else if (/^[bBrRuUfF]{2}$/.test(s.slice(i, i + 2)) && (s[i + 2] === '"' || s[i + 2] === "'")) p = 2;
  const qc = s[i + p];
  if (qc === '"' || qc === "'") {
    let j = i + p + 1;
    while (j < n && s[j] !== qc) j += s[j] === '\\' ? 2 : 1;
    const q = s.slice(i, i + p + 1);
    if (j >= n) return { start: i, end: n, inner: s.slice(i + p + 1), q: q, closeQ: qc, closed: false };
    return { start: i, end: j + 1, inner: s.slice(i + p + 1, j), q: q, closeQ: qc, closed: true };
  }
  let end = bareEnd(s, i, jsonish, so, sc);
  if (end === i) return null;
  if (SCHEMES.has(s.slice(i, end).toLowerCase()) && (s[end] === ' ' || s[end] === '\t')) {
    let k = end;
    while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
    const e2 = bareEnd(s, k, jsonish, so, sc);
    // the next word is the credential, unless it is the name of another pair (token_type=bearer expires_in=3600)
    if (e2 > k && !/^[\w.\-]+[=:]/.test(s.slice(k, e2))) end = e2;
  }
  return { start: i, end: end, inner: s.slice(i, end), q: '', closeQ: '', closed: true };
}

// ---- escapes and encodings ----------------------------------------------------------------------

/** The characters a reader of JSON (or of a quoted logfmt value) would see for the escapes in a string. */
function decodeEscapes(t) {
  return t.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, function (m, c) {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    if (c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return c;
    }
  });
}
function encodeEscapes(t) { return JSON.stringify(t).slice(1, -1); }

const HAS_ENCODING = /&(?:quot|apos|amp|lt|gt|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});|%[0-9A-Fa-f]{2}/;
const ENTITY_RE = /&(?:(quot|apos|amp|lt|gt)|#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6}));/g;
const ENTITY_NAMES = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
/** HTML entities and percent escapes replaced by the characters they stand for. */
function decodeEncoded(s) {
  const t = s.replace(ENTITY_RE, function (m, name, dec, hex) {
    if (name) return ENTITY_NAMES[name];
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
  });
  return t.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (seq) { try { return decodeURIComponent(seq); } catch (e) { return seq; } });
}

/** Two private-use characters that do not occur in the text; they mark the strings that were rewritten. */
function pickMarks(text) {
  let code = 0xE000;
  const found = [];
  while (found.length < 2 && code < 0xF8FF) {
    const ch = String.fromCharCode(code++);
    if (text.indexOf(ch) === -1) found.push(ch);
  }
  return found.length === 2 ? found : null;
}

function markedRanges(s, so, sc) {
  if (!so) return null;
  const out = [];
  let i = s.indexOf(so);
  while (i !== -1) {
    const e = s.indexOf(sc, i + 1);
    out.push(i, e < 0 ? s.length : e);
    i = e < 0 ? -1 : s.indexOf(so, e + 1);
  }
  return out.length ? out : null;
}
function inRanges(r, pos) {
  for (let k = 0; k < r.length; k += 2) if (pos >= r[k] && pos < r[k + 1]) return true;
  return false;
}

// `pre` is a cheap test that must be true for a line to hold a match at all (it only saves time).
// The first entry is not a pattern: it is the search for secret names (maskSecrets below).
const BUILTIN = [
  { id: 'secret', label: 'value of a secret name (password, token, key, authorization, session, ...)', mask: true },
  { id: 'urlcred', label: 'password inside a web address', re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@\/"']{0,80}:)([^\s@\/"']{1,200})(@)/gi, pre: function (s) { return s.indexOf('://') !== -1 && s.indexOf('@') !== -1; } },
  { id: 'email', label: 'e-mail address', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g, pre: function (s) { return s.indexOf('@') !== -1; } },
  { id: 'ipv4', label: 'IPv4 address', re: /\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}\b/g, pre: function (s) { return s.indexOf('.') !== -1 && s.length >= 7; } },
  { id: 'ipv6', label: 'IPv6 address', re: /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4})?(?::[0-9A-Fa-f]{1,4}){0,5}\b|(?<![0-9A-Fa-f:])::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b/g, pre: function (s) { return s.indexOf('::') !== -1 || s.split(':').length > 7; } },
  { id: 'jwt', label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, pre: function (s) { return s.indexOf('eyJ') !== -1; } },
  { id: 'bearer', label: 'authorization header value', re: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi, keep: 1, accept: function (m) { return !/^(?:Bearer|Basic)\s+[\w.\-]+=[^=\s]/i.test(m); }, pre: function (s) { return /bearer|basic/i.test(s); } },
  { id: 'awskey', label: 'access key id', re: /\bAKIA[0-9A-Z]{16}\b/g, pre: function (s) { return s.indexOf('AKIA') !== -1; } },
  { id: 'hex', label: 'long hexadecimal string', re: /\b[0-9a-fA-F]{32,}\b/g, pre: function (s) { return s.length >= 32; } },
  { id: 'blob', label: 'long token-like string', re: /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, accept: function (s) { return /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s); }, pre: function (s) { return s.length >= 40; } },
  { id: 'card', label: 'card-like number', re: /\b\d(?:[ -]?\d){12,18}\b/g, accept: function (s) { const d = s.replace(/[ -]/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); }, pre: function (s) { return s.length >= 13; } }
];

// A value that is wholly a replacement made by this module: [label-xxxxxxxx].
const WHOLE_REPLACEMENT = /^\[[A-Za-z0-9_-]+-[0-9a-f]{8}\]$/;

/** Parses a rule file (JSON text). Returns { rules, errors }; each rule { id, label, re (engine), replace }. */
function parseRuleFile(text) {
  const errors = [];
  const rules = [];
  let data;
  try { data = JSON.parse(text); } catch (e) { return { rules: [], errors: ['The rule file is not valid JSON: ' + e.message] }; }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : null;
  if (!list) return { rules: [], errors: ['The rule file must be a list of rules or an object with a "rules" list.'] };
  if (list.length > 100) return { rules: [], errors: ['The rule file has more than 100 rules.'] };
  list.forEach(function (r, i) {
    const where = 'Rule ' + (i + 1) + (r && r.name ? ' ("' + String(r.name).slice(0, 40) + '")' : '');
    if (!r || typeof r !== 'object' || typeof r.pattern !== 'string' || !r.pattern) { errors.push(where + ': "pattern" is missing.'); return; }
    const replace = r.replace === undefined ? 'hash' : r.replace;
    if (typeof replace !== 'string' || replace.length > 100) { errors.push(where + ': "replace" must be text of at most 100 characters (or "hash", or "mask").'); return; }
    try {
      const re = safere.compile(r.pattern, { ignoreCase: typeof r.flags === 'string' && r.flags.indexOf('i') !== -1 });
      rules.push({ id: 'rule-' + (i + 1), label: String(r.name || ('rule ' + (i + 1))).slice(0, 60), re: re, replace: replace });
    } catch (e) {
      if (e instanceof safere.RegexError) errors.push(where + ': ' + e.message); else throw e;
    }
  });
  return { rules, errors };
}

/**
 * Creates the anonymiser. Options: builtins (array of ids, default all), rules (from parseRuleFile),
 * key (a Buffer, tests only), maxValues (tests only). Resolves to
 * { apply(text), applyQuiet(text), fieldRule, counts(), labels, size(), collisions() }.
 * applyQuiet does the same as apply but adds nothing to the counts (used to find the column names).
 */
function createAnonymiser(options) {
  const o = options || {};
  const key = Buffer.isBuffer(o.key) ? o.key : crypto.randomBytes(32);
  const maxValues = o.maxValues > 0 ? o.maxValues : MAX_VALUES;
  const enabled = o.builtins ? BUILTIN.filter(function (b) { return o.builtins.indexOf(b.id) !== -1; }) : BUILTIN;
  const custom = o.rules || [];
  const counts = {};
  // replacement -> 128-bit digest (as latin1 text) of the value that owns it
  const owners = new Map();
  // value -> replacement, for the values seen last (a speed-up; the owners map decides)
  let recent = new Map();
  let collisions = 0;

  const hmac = hmacSha256(key);
  function digest(kind, value, counter) {
    return hmac(kind + '\u0000' + value + (counter ? '\u0000' + counter : ''));
  }
  function shape(id, d, label) {
    const hex = d.toString('hex');
    switch (id) {
      case 'email': return 'user-' + hex.slice(0, 12) + '@example.invalid';
      case 'ipv4': return '10.' + d[0] + '.' + d[1] + '.' + d[2];
      case 'ipv6': return '2001:db8::' + hex.slice(0, 4) + ':' + hex.slice(4, 8);
      case 'card': return '[card-' + hex.slice(0, 8) + ']';
      case 'rule': return '[' + label + '-' + hex.slice(0, 8) + ']';
      default: return '[' + id + '-' + hex.slice(0, 8) + ']';
    }
  }
  /** The replacement of a value: stable for the value, and never the replacement of another value. */
  function replacement(id, value, label) {
    const norm = id === 'email' || id === 'ipv6' ? value.toLowerCase() : id === 'card' ? value.replace(/[ -]/g, '') : id === 'ipv4' ? value.split('.').map(function (x) { return String(parseInt(x, 10)); }).join('.') : value;
    const cacheKey = id + '\u0000' + (label || '') + '\u0000' + norm;
    const hit = recent.get(cacheKey);
    if (hit !== undefined) return hit;
    const first = digest(id, norm, 0);
    const identity = first.toString('latin1', 0, 16);
    let d = first;
    let result;
    for (let counter = 0; ; counter++) {
      if (counter > 0) d = digest(id, norm, counter);
      const candidate = shape(id, d, label);
      const owner = owners.get(candidate);
      if (owner === undefined) {
        if (owners.size >= maxValues) throw new AnonymiseError('This log holds more than ' + maxValues.toLocaleString('en-US') + ' different sensitive values, more than one anonymised copy can keep apart. Filter the log down to a smaller part and export that.', 'too-many-values');
        owners.set(candidate, identity);
        result = candidate;
        break;
      }
      if (owner === identity) { result = candidate; break; }
      collisions++;
      if (counter > 1000000) throw new AnonymiseError('The anonymiser could not find a free replacement for a value.', 'no-replacement');
    }
    if (recent.size >= FORWARD_CACHE) recent = new Map();
    recent.set(cacheKey, result);
    return result;
  }
  function bump(ctx, id) { if (!ctx.quiet) counts[id] = (counts[id] || 0) + 1; }

  // Builds the text with the values replaced. `found` is called with the text and yields
  // { name, valueStart, jsonish } in order; the value is read, judged with its name and replaced.
  function maskFound(s, ctx, find) {
    const ranges = markedRanges(s, ctx.so, ctx.sc);
    let out = '';
    let at = 0;
    // A list behind a secret JSON name ("tokens": ["a", "b"]): each flat element is a value; objects inside have their own names.
    const maskList = function (start, name) {
      let pos = start + 1;
      let last = -1;
      while (pos < s.length && pos - start < 4000) {
        while (pos < s.length && /[\s,]/.test(s[pos])) pos++;
        if (s[pos] === ']' || pos >= s.length) { last = pos; break; }
        const e = readValue(s, pos, true, ctx.so, ctx.sc);
        if (e === null || e.start < at || s[pos] === '{' || s[pos] === '[') break;
        if (!owners.has(e.inner) && isSecretKey(name, e.inner)) {
          bump(ctx, 'secret');
          out += s.slice(at, e.start) + e.q + replacement('secret', e.inner) + (e.closed ? e.closeQ : '');
          at = e.end;
        }
        pos = e.end;
      }
      return last;
    };
    // handle(name, valueStart, jsonish, matchIndex) replaces the value and returns where it ended, or -1
    find(s, function (name, valueStart, jsonish, matchIndex) {
      if (matchIndex < at) return -1;
      if (ranges && inRanges(ranges, matchIndex)) return -1;
      if (jsonish && s[valueStart] === '[') return maskList(valueStart, name);
      const v = readValue(s, valueStart, jsonish, ctx.so, ctx.sc);
      if (v === null || v.start < at) return -1;
      if (owners.has(v.inner)) return -1; // already one of this run's replacements (a field that is read again)
      if (!isSecretKey(name, v.inner)) return -1;
      bump(ctx, 'secret');
      out += s.slice(at, v.start) + v.q + replacement('secret', v.inner) + (v.closed ? v.closeQ : '');
      at = v.end;
      return v.end;
    });
    return at === 0 ? s : out + s.slice(at);
  }

  // A pass over every match of a regular expression: `locate(m, text)` gives the name and where its value starts.
  function maskByRegex(s, ctx, re, locate) {
    return maskFound(s, ctx, function (text, handle) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const l = locate(m, text);
        if (l === null || !isSecretName(l.name)) continue;
        const end = handle(l.name, l.valueStart, l.jsonish, m.index);
        if (end > re.lastIndex) re.lastIndex = end;
      }
    });
  }

  // <add key="DbPassword" value="x"/>, <param name="x" value="y">, <property name="x">y</property>
  function maskTags(s, ctx) {
    const ranges = markedRanges(s, ctx.so, ctx.sc);
    TAG_RE.lastIndex = 0;
    let out = '';
    let at = 0;
    let m;
    while ((m = TAG_RE.exec(s)) !== null) {
      if (m[0].indexOf('=') === -1) continue;
      if (ranges && inRanges(ranges, m.index)) continue;
      const attrs = [];
      ATTR_RE.lastIndex = 0;
      let a;
      while ((a = ATTR_RE.exec(m[0])) !== null) {
        const where = a.indices[2] || a.indices[3];
        attrs.push({ name: a[1].toLowerCase(), text: a[2] !== undefined ? a[2] : a[3], start: m.index + where[0], end: m.index + where[1] });
      }
      const label = attrs.find(function (x) { return ATTR_NAME.has(x.name) && isSecretName(decodeEscapes(x.text)); });
      if (!label) continue;
      const targets = attrs.filter(function (x) { return ATTR_VALUE.has(x.name) && x.text !== '' && !owners.has(x.text) && isSecretKey(decodeEscapes(label.text), x.text); });
      for (const t of targets) {
        bump(ctx, 'secret');
        out += s.slice(at, t.start) + replacement('secret', t.text);
        at = t.end;
      }
      if (!targets.length && !attrs.some(function (x) { return ATTR_VALUE.has(x.name); }) && !/\/>$/.test(m[0])) {
        // <property name="x">content</property>
        const close = s.indexOf('<', m.index + m[0].length);
        const content = s.slice(m.index + m[0].length, close < 0 ? s.length : close);
        if (content.trim() !== '' && content.length <= 2000 && !owners.has(content.trim()) && isSecretKey(decodeEscapes(label.text), content.trim())) {
          bump(ctx, 'secret');
          const lead = content.length - content.trimStart().length;
          out += s.slice(at, m.index + m[0].length + lead) + replacement('secret', content.trim());
          at = m.index + m[0].length + lead + content.trim().length;
        }
      }
    }
    return at === 0 ? s : out + s.slice(at);
  }

  // {"value": "x", "name": "DB_PASSWORD"}: the value comes first.
  function maskValueThenName(s, ctx) {
    const ranges = markedRanges(s, ctx.so, ctx.sc);
    const re = VALUE_THEN_NAME_RE;
    re.lastIndex = 0;
    let out = '';
    let at = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const nm = decodeEscapes(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
      if (!isSecretName(nm)) continue;
      if (ranges && inRanges(ranges, m.index)) continue;
      const [vs, ve] = m.indices[1];
      const raw = s.slice(vs, ve);
      const v = readValue(raw, 0, true, '', '');
      if (v === null || owners.has(v.inner) || !isSecretKey(nm, v.inner)) continue;
      bump(ctx, 'secret');
      out += s.slice(at, vs) + v.q + replacement('secret', v.inner) + (v.closed ? v.closeQ : '');
      at = vs + v.end;
    }
    return at === 0 ? s : out + s.slice(at);
  }

  // Replaces the value of a password given to a well-known command (spans are collected first, then applied in order).
  function maskCommands(s, ctx) {
    const ranges = markedRanges(s, ctx.so, ctx.sc);
    const spans = [];
    const add = function (start, end, index) {
      if (end <= start || (ranges && inRanges(ranges, index))) return;
      const value = s.slice(start, end);
      if (!owners.has(value)) spans.push([start, end]);
    };
    let m;
    if (/\bcurl\b/.test(s)) {
      CURL_USER_RE.lastIndex = 0;
      while ((m = CURL_USER_RE.exec(s)) !== null) {
        const g = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
        const colon = g.indexOf(':');
        if (colon < 0) continue;
        const base = m.index + m[0].lastIndexOf(g);
        add(base + colon + 1, base + g.length, m.index);
      }
    }
    if (/\bmysql/.test(s)) {
      MYSQL_P_RE.lastIndex = 0;
      while ((m = MYSQL_P_RE.exec(s)) !== null) add(m.index + 2, m.index + m[0].length, m.index);
    }
    for (const re of [SSHPASS_RE, REDIS_A_RE, DOCKER_P_RE]) {
      re.lastIndex = 0;
      while ((m = re.exec(s)) !== null) add(m.index + m[0].length - m[1].length, m.index + m[0].length, m.index);
    }
    if (!spans.length) return s;
    spans.sort(function (x, y) { return x[0] - y[0]; });
    let out = '';
    let at = 0;
    for (const sp of spans) {
      if (sp[0] < at) continue;
      bump(ctx, 'secret');
      out += s.slice(at, sp[0]) + replacement('secret', s.slice(sp[0], sp[1]));
      at = sp[1];
    }
    return out + s.slice(at);
  }

  // Replaces the value of every secret name in the text: name=value, name: value, "name": value (the
  // name may have spaces and brackets), name/value pairs, the options of a command line, a few
  // commands, XML attributes and elements.
  function maskSecrets(s, ctx) {
    const maybe = s.indexOf('=') !== -1 || s.indexOf(':') !== -1 || s.indexOf('--') !== -1 || s.indexOf('</') !== -1 || /\b(?:mysql|sshpass|redis-cli|docker|curl)/.test(s);
    if (!maybe || !SECRET_HINT.test(s)) return s;
    s = maskByRegex(s, ctx, KEY_RE, function (m) { return { name: m[1], valueStart: m.index + m[0].length, jsonish: m[2] !== '' }; });
    if (s.indexOf('"') !== -1 || s.indexOf("'") !== -1) s = maskByRegex(s, ctx, QUOTED_KEY_RE, function (m) { return { name: decodeEscapes(m[2]), valueStart: m.index + m[0].length, jsonish: true }; });
    if (s.indexOf('--') !== -1) {
      s = maskByRegex(s, ctx, CLI_SPACE_RE, function (m) { return { name: m[1], valueStart: m.index + m[0].length, jsonish: false }; });
      s = maskByRegex(s, ctx, CLI_ARRAY_RE, function (m) { return { name: m[1], valueStart: m.index + m[0].length, jsonish: false }; });
    }
    if (/name|key|id|property|setting|variable|var|param|option|field|label/i.test(s) && /value|val|data|content/i.test(s)) {
      s = maskByRegex(s, ctx, NAME_REF_RE, function (m, text) {
        const nm = decodeEscapes(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
        VALUE_AFTER_RE.lastIndex = m.index + m[0].length;
        const v = VALUE_AFTER_RE.exec(text);
        return v ? { name: nm, valueStart: VALUE_AFTER_RE.lastIndex, jsonish: true } : null;
      });
      s = maskValueThenName(s, ctx);
    }
    if (s.indexOf('<') !== -1) s = maskTags(s, ctx);
    s = maskCommands(s, ctx);
    if (s.indexOf('</') !== -1) {
      XML_RE.lastIndex = 0;
      let out = '';
      let at = 0;
      let m;
      while ((m = XML_RE.exec(s)) !== null) {
        if (!isSecretName(m[1]) || owners.has(m[2]) || !isSecretKey(m[1], m[2])) continue;
        bump(ctx, 'secret');
        const start = m.index + m[0].indexOf('>') + 1;
        out += s.slice(at, start) + replacement('secret', m[2]);
        at = start + m[2].length;
      }
      if (at) s = out + s.slice(at);
    }
    return s;
  }

  // All built-in patterns and the rule file on a piece of text. ctx: { quiet, meter, so, sc }
  // (so and sc mark the strings that were rewritten by the escape pass; they are left alone).
  function applyPlain(text, ctx) {
    let s = text;
    for (const b of enabled) {
      if (b.mask) { s = maskSecrets(s, ctx); continue; }
      if (b.pre && !b.pre(s)) continue;
      const ranges = markedRanges(s, ctx.so, ctx.sc);
      s = s.replace(b.re, function () {
        const args = arguments;
        const match = args[0];
        if (ranges && inRanges(ranges, args[args.length - 2])) return match;
        if (ctx.again && owners.has(match)) return match;
        if (b.accept && !b.accept(match)) return match;
        if (b.id === 'urlcred') { bump(ctx, 'secret'); return args[1] + args[2] + replacement('secret', args[3]) + args[4]; }
        bump(ctx, b.id);
        if (b.keep) return args[1] + ' ' + replacement(b.id, args[2]);
        return replacement(b.id, match);
      });
    }
    if (custom.length) {
      if (!ctx.meter) ctx.meter = safere.createMeter();
      for (const r of custom) {
        const ranges = markedRanges(s, ctx.so, ctx.sc);
        let out = '';
        let at = 0;
        let from = 0;
        try {
          while (from <= s.length) {
            const m = r.re.exec(s, from, { meter: ctx.meter, captures: false });
            if (!m) break;
            from = m.end > m.index ? m.end : m.end + 1;
            if (m.end <= m.index) continue;
            if (ranges && inRanges(ranges, m.index)) continue;
            out += s.slice(at, m.index);
            out += r.replace === 'hash' ? replacement('rule', m.text, r.label.replace(/[^A-Za-z0-9_-]+/g, '-')) : r.replace === 'mask' ? '*'.repeat(Math.min(m.text.length, 64)) : r.replace;
            at = m.end;
            bump(ctx, r.id);
          }
        } catch (e) {
          if (e instanceof safere.RegexError && e.code === 'budget') throw new AnonymiseError(r.label + ' (' + r.id.replace('rule-', 'rule ') + ') needs too much work for one of the lines, so the copy was stopped before any value could be missed. ' + e.message, 'budget');
          throw e;
        }
        if (at) s = out + s.slice(at);
      }
    }
    return s;
  }

  // The escape pass: every string in double quotes that holds an escape is decoded, run through
  // the rules (again with its own escapes, down to MAX_DEPTH levels) and, when it changed, written
  // back encoded again between the two marks. A name written with escapes is written plain.
  function rewriteEscaped(s, ctx, depth) {
    let out = '';
    let at = 0;
    let i = s.indexOf('"');
    while (i !== -1) {
      let j = i + 1;
      let escaped = false;
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\') { escaped = true; j += 2; } else j++; }
      const closed = j < s.length;
      const end = closed ? j + 1 : s.length;
      if (escaped) {
        const raw = s.slice(i + 1, closed ? j : s.length);
        const decoded = decodeEscapes(raw);
        let q = end;
        while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
        if (closed && (s[q] === ':' || s[q] === '=') && /^[A-Za-z_][\w.\-]*$/.test(decoded)) {
          // A name written with escapes ("password": ...) is written plain, so that the rules can see which name it is.
          out += s.slice(at, i) + '"' + decoded + '"';
          at = end;
        } else {
          const done = run(decoded, ctx.quiet, ctx.again, depth + 1, true, ctx.meter);
          if (done !== decoded) {
            out += s.slice(at, i) + ctx.so + '"' + encodeEscapes(done) + (closed ? '"' : '') + ctx.sc;
            at = end;
          }
        }
      }
      i = closed ? s.indexOf('"', end) : -1;
    }
    return at === 0 ? s : out + s.slice(at);
  }

  function run(text, quiet, again, depth, noDecode, meter) {
    const ctx = { quiet: quiet, again: !!again, meter: custom.length ? (meter || safere.createMeter()) : null, so: '', sc: '' };
    let s = text;
    if (depth < MAX_DEPTH && s.indexOf('\\') !== -1 && s.indexOf('"') !== -1) {
      const marks = pickMarks(s);
      if (marks) {
        ctx.so = marks[0];
        ctx.sc = marks[1];
        s = rewriteEscaped(s, ctx, depth);
      }
    }
    s = applyPlain(s, ctx);
    if ((ctx.so && s.indexOf(ctx.so) !== -1) || (ctx.sc && s.indexOf(ctx.sc) !== -1)) s = s.split(ctx.so).join('').split(ctx.sc).join('');
    if (!noDecode && HAS_ENCODING.test(s)) {
      // A line with HTML entities or percent escapes is read decoded too. When that reveals something
      // that the line as written did not show, the decoded line (with all replacements) is what is
      // written; otherwise the line stays as it was.
      const d = decodeEncoded(s);
      if (d !== s) {
        const r = run(d, quiet, true, depth, true, ctx.meter);
        if (r !== d) return r;
      }
    }
    return s;
  }

  // Fields of a parsed line. The values are read from the line after anonymisation, so every
  // replacement of the text is in the fields too. A field whose name says it holds a secret (the
  // same decision as for the text: secretnames.js, with the value) is replaced in full unless it
  // already is a replacement. A value that was decoded from an escape and so is not in the text as
  // it is written is run through the rules once more (`scan`).
  const fieldRule = {
    needs: function (name, value) { return isSecretKey(name, value); },
    apply: function (name, valueAfter) {
      const after = String(valueAfter);
      if (after === '' || WHOLE_REPLACEMENT.test(after)) return valueAfter;
      bump({ quiet: false }, 'secret');
      return replacement('secret', after);
    },
    scan: function (value) { return run(String(value), false, true, 0, false, null); }
  };

  const apply = function (text) { return run(text, false, false, 0, false, null); };
  const applyQuiet = function (text) { return run(text, true, false, 0, false, null); };
  apply.quiet = applyQuiet;
  return {
    apply: apply,
    applyQuiet: applyQuiet,
    fieldRule: fieldRule,
    counts: function () { return Object.assign({}, counts); },
    size: function () { return owners.size; },
    collisions: function () { return collisions; },
    labels: enabled.map(function (b) { return b.id; }).concat(custom.map(function (r) { return r.id; }))
  };
}

module.exports = { createAnonymiser, parseRuleFile, AnonymiseError, hmacSha256, isSecretKey, isSecretName, nameWords: names.nameWords, BUILTIN, MAX_VALUES, MAX_DEPTH, luhn };
