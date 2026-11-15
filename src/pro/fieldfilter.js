'use strict';
// Field filters (Pro): "status>=500 path~^/api level=ERROR". Terms are separated by spaces, a value
// with spaces is written in double quotes. All terms must hold. A line that the profile cannot
// parse, or that lacks the field, satisfies only the negative operators (!= and !~).
// Operators: = != > >= < <= ~ (regular expression, no backtracking) !~
// = and != compare the text exactly (so 00123 and 123 differ, as identifiers should); > >= < <= compare
// numbers as exact decimals and other values as text.

const safere = require('../engine/safere');
const { compareValues } = require('./profiles');

const OPS = ['!=', '>=', '<=', '!~', '=', '>', '<', '~'];

function tokenize(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let tok = '';
    while (i < n && !/\s/.test(text[i])) {
      if (text[i] === '"') {
        i++;
        while (i < n && text[i] !== '"') { if (text[i] === '\\' && i + 1 < n) i++; tok += text[i++]; }
        if (i >= n) throw new Error('A quoted value is not closed with ".');
        i++;
        tok += '\u0000'; // marks that part of the token was quoted
      } else tok += text[i++];
    }
    out.push(tok);
  }
  return out;
}

/** Parses the expression; throws an Error with a message for the user. Returns [] for empty text. */
function parseFilter(text) {
  const terms = [];
  for (const raw of tokenize(String(text || ''))) {
    const tok = raw;
    let pos = -1;
    let op = '';
    for (let i = 0; i < tok.length; i++) {
      const hit = OPS.find(function (o) { return tok.startsWith(o, i); });
      if (hit) { pos = i; op = hit; break; }
    }
    if (pos <= 0) throw new Error('"' + raw.replace(/\u0000/g, '') + '" is not a field filter. Write it as name=value, name>=10 or name~regex.');
    const field = tok.slice(0, pos).replace(/\u0000/g, '');
    const value = tok.slice(pos + op.length).replace(/\u0000/g, '');
    const term = { field: field, op: op, value: value };
    if (op === '~' || op === '!~') {
      try { term.re = safere.compile(value, { ignoreCase: false }); } catch (e) {
        if (e instanceof safere.RegexError) throw new Error('The expression for "' + field + '" was not accepted: ' + e.message);
        throw e;
      }
    }
    terms.push(term);
  }
  if (terms.length > 20) throw new Error('A field filter may have at most 20 terms.');
  return terms;
}

function termHolds(term, fields) {
  const present = fields && Object.prototype.hasOwnProperty.call(fields, term.field) && fields[term.field] !== undefined;
  const v = present ? String(fields[term.field]) : undefined;
  switch (term.op) {
    case '=': return present && v === term.value;
    case '!=': return !present || v !== term.value;
    case '>': return present && compareValues(v, term.value) > 0;
    case '>=': return present && compareValues(v, term.value) >= 0;
    case '<': return present && compareValues(v, term.value) < 0;
    case '<=': return present && compareValues(v, term.value) <= 0;
    case '~': return present && term.re.test(v);
    case '!~': return !present || !term.re.test(v);
    default: return false;
  }
}

/** True when every term holds for the fields object. */
function matches(terms, fields) {
  for (const t of terms) if (!termHolds(t, fields)) return false;
  return true;
}

module.exports = { parseFilter, matches };
