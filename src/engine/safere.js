'use strict';
// A regular expression engine without backtracking: the work for a text is proportional to the
// length of the text times the size of the pattern (never exponential), and every call is stopped
// by a work limit.
//
//   * test(text): "does the pattern match anywhere in the text?" runs a lazily built DFA (a cache
//     of at most MAX_STATES states; when it is full it is emptied and built again). When the cache
//     keeps overflowing (a pattern with a huge state space) the same call goes on with a
//     simulation of the pattern that needs no cache (time: text length x live alternatives).
//   * exec(text, from): the leftmost match with its groups, by a Pike VM that advances all
//     alternatives together (time proportional to text length x program size).
//   * Work limit: every call counts its work in units (one unit is about one instruction visited
//     or one capture slot copied; a cached DFA step counts 1/2) and stops with a RegexError of
//     code "budget" when the count passes WORK_LIMIT, or the limit of the meter passed in. A
//     meter can be shared by several calls (findAll uses one for all its matches, a screen of rows
//     can share one), so that the limit holds for the whole batch. About WORK_LIMIT units take
//     a fraction of a second, so no call can block the editor for long.
//
// Supported syntax (JavaScript flavour, applied to UTF-16 code units): literals, ., escapes
// \d \D \w \W \s \S \b \B \t \n \r \f \v \0 \xHH \uHHHH, classes [...] and [^...] with ranges,
// groups (...), (?:...), (?<name>...), alternation |, quantifiers * + ? {n} {n,} {n,m} with the
// lazy suffix ?, anchors ^ and $ (the start and end of the line).
// A repeated group that can match the empty string (for example (a?|b)+) may report a different
// match span than the engine of the JavaScript runtime; whether a line matches is never affected.
// Refused with a clear message: back-references, look-ahead and look-behind (they cannot be
// matched in guaranteed linear time), \p{...} classes and characters above U+FFFF inside classes.

const MAX_PATTERN = 2000;
const MAX_PROGRAM = 6000;
const MAX_DEPTH = 64;
const MAX_STATES = 3000;
// The work limit of one call (or of one shared meter), in units; see the header.
const WORK_LIMIT = 5000000;
// The limit of a loop of calls that share one meter (a screen of table rows): eight calls' worth.
const BATCH_LIMIT = WORK_LIMIT * 8;

class RegexError extends Error {
  constructor(message, code, position) { super(message); this.name = 'RegexError'; this.code = code; this.position = position; }
}

const BUDGET_MESSAGE = 'This pattern needs too much work for these lines, so it was stopped to keep the editor responsive. Simplify it (avoid long repeats such as {200} and repeats inside repeats), or use the plain text search.';
function budgetError() { return new RegexError(BUDGET_MESSAGE, 'budget', 0); }

/** A work meter: { used, limit }. Pass one in the options of test/exec/findAll to share the limit between calls. */
function createMeter(limit) { return { used: 0, limit: limit > 0 ? limit : WORK_LIMIT }; }
// Calls without a meter reuse this one (the engine is synchronous, so calls never overlap).
const SHARED_METER = { used: 0, limit: WORK_LIMIT };
function meterFor(options) {
  if (options && options.meter) return options.meter;
  SHARED_METER.used = 0;
  SHARED_METER.limit = options && options.budget > 0 ? options.budget : WORK_LIMIT;
  return SHARED_METER;
}

// ---- character sets as sorted interval lists [lo, hi, lo, hi, ...] over 0..65535 --------------

const MAX_UNIT = 0xFFFF;
const DIGIT = [48, 57];
const WORD = [48, 57, 65, 90, 95, 95, 97, 122];
const SPACE = [9, 13, 32, 32, 160, 160, 0x1680, 0x1680, 0x2000, 0x200A, 0x2028, 0x2029, 0x202F, 0x202F, 0x205F, 0x205F, 0x3000, 0x3000, 0xFEFF, 0xFEFF];
const ANY = negate([10, 10, 13, 13, 0x2028, 0x2029]);

function normalize(list) {
  const pairs = [];
  for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
  pairs.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  const out = [];
  for (const p of pairs) {
    if (p[1] < p[0]) continue;
    if (out.length && p[0] <= out[out.length - 1] + 1) { if (p[1] > out[out.length - 1]) out[out.length - 1] = p[1]; } else out.push(p[0], p[1]);
  }
  return out;
}

function negate(iv) {
  const s = normalize(iv);
  const out = [];
  let next = 0;
  for (let i = 0; i < s.length; i += 2) {
    if (s[i] > next) out.push(next, s[i] - 1);
    next = s[i + 1] + 1;
  }
  if (next <= MAX_UNIT) out.push(next, MAX_UNIT);
  return out;
}

// Case-insensitive matching follows the canonicalisation of the JavaScript runtime (ECMAScript
// "Canonicalize" without the u flag): a character is replaced by its upper-case form when that
// is a single UTF-16 code unit, and a character from U+0080 up is never mapped to one below it.
// Two characters match when their canonical forms are the same. (Mapping to both the lower and the
// upper case, as a first version did, matches more than the runtime for letters such as the
// Kelvin sign and the long s.)
let CANON = null;
let CANON_GROUPS = null;
function canonTables() {
  if (CANON) return;
  const canon = new Uint16Array(MAX_UNIT + 1);
  const groups = new Map();
  for (let c = 0; c <= MAX_UNIT; c++) {
    let cu = c;
    if (c < 0xD800 || c > 0xDFFF) {
      const up = String.fromCharCode(c).toUpperCase();
      if (up.length === 1) {
        const u = up.charCodeAt(0);
        if (!(c >= 128 && u < 128)) cu = u;
      }
    }
    canon[c] = cu;
    if (cu !== c || groups.has(cu)) {
      let g = groups.get(cu);
      if (!g) { g = [cu]; groups.set(cu, g); }
      if (c !== cu) g.push(c);
    }
  }
  CANON = canon;
  CANON_GROUPS = groups;
}

/** The set plus every character whose canonical form is the canonical form of a member. */
function addCase(iv) {
  canonTables();
  const extra = [];
  const seen = new Set();
  for (let i = 0; i < iv.length; i += 2) {
    for (let c = iv[i]; c <= iv[i + 1]; c++) {
      const cu = CANON[c];
      if (seen.has(cu)) continue;
      seen.add(cu);
      const g = CANON_GROUPS.get(cu);
      if (g) for (const m of g) extra.push(m, m);
    }
  }
  return extra.length ? normalize(iv.concat(extra)) : iv;
}

function contains(iv, c) {
  let lo = 0;
  let hi = (iv.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < iv[mid * 2]) hi = mid - 1;
    else if (c > iv[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---- parser -------------------------------------------------------------------------------------

function parse(pattern, ignoreCase) {
  if (typeof pattern !== 'string') throw new RegexError('The pattern must be text.', 'syntax', 0);
  if (pattern.length > MAX_PATTERN) throw new RegexError('The pattern is longer than ' + MAX_PATTERN + ' characters.', 'too-large', 0);
  let pos = 0;
  let groupCount = 0;
  const names = [];
  const REFUSED_LOOK = 'Look-ahead and look-behind are not supported: they cannot be matched in guaranteed linear time. Rewrite the pattern without them, or use the text search.';
  const REFUSED_BACKREF = 'Back-references are not supported: they cannot be matched in guaranteed linear time. Rewrite the pattern without them, or use the text search.';

  function fail(message, code) { throw new RegexError(message, code || 'syntax', pos); }
  function lit(c) { return { t: 'set', set: ignoreCase ? addCase([c, c]) : [c, c], single: c }; }
  function peek() { return pattern[pos]; }

  function parseAlt(depth) {
    if (depth > MAX_DEPTH) fail('The pattern is nested more than ' + MAX_DEPTH + ' levels deep.', 'too-large');
    const branches = [parseCat(depth)];
    while (peek() === '|') { pos++; branches.push(parseCat(depth)); }
    return branches.length === 1 ? branches[0] : { t: 'alt', items: branches };
  }

  function parseCat(depth) {
    const items = [];
    while (pos < pattern.length && peek() !== '|' && peek() !== ')') {
      const atom = parseAtom(depth);
      items.push(parseQuant(atom));
    }
    return items.length === 0 ? { t: 'empty' } : items.length === 1 ? items[0] : { t: 'cat', items: items };
  }

  function parseNumber() {
    const start = pos;
    while (pos < pattern.length && pattern[pos] >= '0' && pattern[pos] <= '9') pos++;
    return pos > start ? Number(pattern.slice(start, pos)) : null;
  }

  function parseQuant(atom) {
    {
      const c = peek();
      let min;
      let max;
      if (c === '*') { min = 0; max = Infinity; pos++; }
      else if (c === '+') { min = 1; max = Infinity; pos++; }
      else if (c === '?') { min = 0; max = 1; pos++; }
      else if (c === '{') {
        const save = pos;
        pos++;
        const a = parseNumber();
        let b = a;
        let ok = a !== null;
        if (ok && peek() === ',') { pos++; b = parseNumber(); if (b === null) b = Infinity; }
        if (ok && peek() === '}') { pos++; min = a; max = b; }
        else { pos = save; return atom; /* a lone { is a literal in JavaScript; handled by parseAtom next */ }
        if (max < min) fail('The quantifier {' + a + ',' + b + '} is not valid (the maximum is smaller than the minimum).');
        if (min > 1000 || (max !== Infinity && max > 1000)) fail('A repeat count above 1000 is not supported.', 'too-large');
      } else return atom;
      if (atom.t === 'assert') fail('A quantifier cannot follow ^, $ or a word boundary.');
      let lazy = false;
      if (peek() === '?') { lazy = true; pos++; }
      return { t: 'rep', node: atom, min: min, max: max, lazy: lazy };
    }
  }

  function parseAtom(depth) {
    const c = pattern[pos];
    if (c === '(') {
      pos++;
      let capture = true;
      let name = null;
      if (peek() === '?') {
        pos++;
        const n = peek();
        if (n === ':') { pos++; capture = false; }
        else if (n === '=' || n === '!') fail(REFUSED_LOOK, 'unsupported');
        else if (n === '<') {
          const n2 = pattern[pos + 1];
          if (n2 === '=' || n2 === '!') fail(REFUSED_LOOK, 'unsupported');
          pos++;
          const end = pattern.indexOf('>', pos);
          if (end < 0) fail('A group name is not closed with >.');
          name = pattern.slice(pos, end);
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('The group name "' + name + '" is not valid (letters, digits and _ only).');
          if (names.indexOf(name) !== -1) fail('The group name "' + name + '" is used twice.');
          pos = end + 1;
        } else fail('The group syntax (?' + (n || '') + ' is not supported.', 'unsupported');
      }
      let index = null;
      if (capture) { index = ++groupCount; names[index] = name; }
      const inner = parseAlt(depth + 1);
      if (peek() !== ')') fail('A group is not closed with ).');
      pos++;
      return capture ? { t: 'group', node: inner, index: index } : inner;
    }
    if (c === '[') return parseClass();
    if (c === '.') { pos++; return { t: 'set', set: ANY }; }
    if (c === '^') { pos++; return { t: 'assert', kind: 'bol' }; }
    if (c === '$') { pos++; return { t: 'assert', kind: 'eol' }; }
    if (c === '\\') return parseEscape(false);
    if (c === '*' || c === '+' || c === '?') fail('A quantifier has nothing to repeat.');
    if (c === ')') fail('Unexpected ).');
    pos++;
    return lit(c.charCodeAt(0));
  }

  function hex(n) {
    const s = pattern.slice(pos, pos + n);
    if (s.length !== n || !/^[0-9A-Fa-f]+$/.test(s)) fail('A hexadecimal escape is not valid.');
    pos += n;
    return parseInt(s, 16);
  }

  // Escape after the backslash at pos. In a class, \b is a backspace and assertions are impossible.
  function parseEscape(inClass) {
    pos++;
    if (pos >= pattern.length) fail('The pattern ends with a backslash.');
    const c = pattern[pos++];
    switch (c) {
      case 'd': return { t: 'set', set: DIGIT };
      case 'D': return { t: 'set', set: negate(DIGIT) };
      case 'w': return { t: 'set', set: WORD };
      case 'W': return { t: 'set', set: negate(WORD) };
      case 's': return { t: 'set', set: SPACE };
      case 'S': return { t: 'set', set: negate(SPACE) };
      case 'b': return inClass ? lit(8) : { t: 'assert', kind: 'wordb' };
      case 'B': if (inClass) return lit(66); return { t: 'assert', kind: 'nwordb' };
      case 't': return lit(9);
      case 'n': return lit(10);
      case 'r': return lit(13);
      case 'f': return lit(12);
      case 'v': return lit(11);
      case '0': return lit(0);
      case 'x': return lit(hex(2));
      case 'u': {
        if (peek() === '{') fail('\\u{...} escapes are not supported.', 'unsupported');
        return lit(hex(4));
      }
      case 'p': case 'P': fail('Unicode property escapes (\\p{...}) are not supported.', 'unsupported'); break;
      case 'k': fail(REFUSED_BACKREF, 'unsupported'); break;
      case 'c': fail('Control-letter escapes (\\cX) are not supported.', 'unsupported'); break;
      default:
        if (c >= '1' && c <= '9') fail(REFUSED_BACKREF, 'unsupported');
        return lit(c.charCodeAt(0));
    }
    return null;
  }

  function parseClass() {
    pos++;
    let negated = false;
    if (peek() === '^') { negated = true; pos++; }
    let set = [];
    let first = true;
    for (;;) {
      if (pos >= pattern.length) fail('A character class is not closed with ].');
      const c = pattern[pos];
      if (c === ']' && !first) { pos++; break; }
      if (c === ']' && first) { pos++; break; }
      first = false;
      const lo = classAtom();
      if (peek() === '-' && pattern[pos + 1] !== ']' && pos + 1 < pattern.length) {
        const save = pos;
        pos++;
        const hi = classAtom();
        if (lo.single !== null && hi.single !== null) {
          if (hi.single < lo.single) { pos = save; fail('A character range is out of order.'); }
          set = set.concat([lo.single, hi.single]);
        } else {
          // A class escape next to a hyphen: the hyphen is a literal.
          set = set.concat(lo.set, [45, 45], hi.set);
        }
      } else set = set.concat(lo.set);
    }
    let result = normalize(set);
    if (ignoreCase) result = addCase(result);
    if (negated) result = negate(result);
    return { t: 'set', set: result };
  }

  // One class member: { single: char code | null, set: intervals }.
  function classAtom() {
    const c = pattern[pos];
    if (c === '\\') {
      const node = parseEscape(true);
      return { single: node.single === undefined ? null : node.single, set: node.set };
    }
    const code = c.charCodeAt(0);
    if (code >= 0xD800 && code <= 0xDFFF) fail('Characters above U+FFFF inside a character class are not supported.', 'unsupported');
    pos++;
    return { single: code, set: [code, code] };
  }

  const ast = parseAlt(0);
  if (pos < pattern.length) fail(peek() === ')' ? 'Unexpected ).' : 'The pattern could not be read.');
  return { ast: ast, groups: groupCount, names: names };
}

// ---- program ------------------------------------------------------------------------------------

const OP_CHAR = 0;
const OP_SPLIT = 1;
const OP_JMP = 2;
const OP_SAVE = 3;
const OP_ASSERT = 4;
const OP_MATCH = 5;
const ASSERT_BOL = 0;
const ASSERT_EOL = 1;
const ASSERT_WORDB = 2;
const ASSERT_NWORDB = 3;
const ASSERT_CODES = { bol: ASSERT_BOL, eol: ASSERT_EOL, wordb: ASSERT_WORDB, nwordb: ASSERT_NWORDB };

function compileProgram(parsed) {
  const op = [];
  const x = [];
  const y = [];
  const sets = [];
  const setIds = new Map();
  function emit(o, a, b) {
    if (op.length >= MAX_PROGRAM) throw new RegexError('The pattern is too large (more than ' + MAX_PROGRAM + ' steps after expanding repeats).', 'too-large', 0);
    op.push(o); x.push(a === undefined ? 0 : a); y.push(b === undefined ? 0 : b);
    return op.length - 1;
  }
  function setId(iv) {
    const key = iv.join(',');
    let id = setIds.get(key);
    if (id === undefined) { id = sets.length; sets.push(iv); setIds.set(key, id); }
    return id;
  }
  function gen(n) {
    switch (n.t) {
      case 'empty': return;
      case 'set': emit(OP_CHAR, setId(n.set)); return;
      case 'assert': emit(OP_ASSERT, ASSERT_CODES[n.kind]); return;
      case 'cat': for (const it of n.items) gen(it); return;
      case 'group': emit(OP_SAVE, n.index * 2); gen(n.node); emit(OP_SAVE, n.index * 2 + 1); return;
      case 'alt': {
        const jumps = [];
        for (let i = 0; i < n.items.length; i++) {
          if (i < n.items.length - 1) {
            const split = emit(OP_SPLIT);
            x[split] = op.length;
            gen(n.items[i]);
            jumps.push(emit(OP_JMP));
            y[split] = op.length;
          } else gen(n.items[i]);
        }
        for (const j of jumps) x[j] = op.length;
        return;
      }
      case 'rep': {
        const lazy = n.lazy;
        const min = n.min;
        const max = n.max;
        const mark = function (split, bodyStart, out) { if (lazy) { x[split] = out; y[split] = bodyStart; } else { x[split] = bodyStart; y[split] = out; } };
        if (max === Infinity) {
          for (let i = 0; i < Math.max(0, min - 1); i++) gen(n.node);
          if (min >= 1) {
            const start = op.length;
            gen(n.node);
            const split = emit(OP_SPLIT);
            mark(split, start, op.length);
          } else {
            const split = emit(OP_SPLIT);
            const bodyStart = op.length;
            gen(n.node);
            emit(OP_JMP, split);
            mark(split, bodyStart, op.length);
          }
          return;
        }
        for (let i = 0; i < min; i++) gen(n.node);
        const splits = [];
        for (let i = 0; i < max - min; i++) {
          const split = emit(OP_SPLIT);
          splits.push(split);
          const bodyStart = op.length;
          gen(n.node);
          // The "skip" target is patched after the whole repeat is emitted.
          x[split] = lazy ? -1 : bodyStart; y[split] = lazy ? bodyStart : -1;
        }
        for (const s of splits) { if (lazy) x[s] = op.length; else y[s] = op.length; }
        return;
      }
      default: throw new RegexError('Internal error: unknown node.', 'syntax', 0);
    }
  }
  gen(parsed.ast);
  emit(OP_MATCH);
  return { op: Int32Array.from(op), x: Int32Array.from(x), y: Int32Array.from(y), sets: sets };
}

// ---- equivalence classes of characters ----------------------------------------------------------

function buildClasses(prog) {
  const sets = prog.sets.concat([WORD]);
  const points = new Set([0, MAX_UNIT + 1]);
  for (const s of sets) for (let i = 0; i < s.length; i += 2) { points.add(s[i]); points.add(s[i + 1] + 1); }
  const bounds = Array.from(points).sort(function (a, b) { return a - b; });
  const classOf = new Uint16Array(MAX_UNIT + 1);
  const sigToClass = new Map();
  const reps = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i];
    const hi = bounds[i + 1] - 1;
    let sig = '';
    for (let k = 0; k < sets.length; k++) sig += contains(sets[k], lo) ? '1' : '0';
    let cls = sigToClass.get(sig);
    if (cls === undefined) { cls = reps.length; sigToClass.set(sig, cls); reps.push(lo); }
    classOf.fill(cls, lo, hi + 1);
  }
  return { classOf: classOf, count: reps.length, reps: reps };
}

// ---- lazy DFA (test) ----------------------------------------------------------------------------

const START_KERNEL = Object.freeze([0]);

class Dfa {
  constructor(prog, maxStates) {
    this.prog = prog;
    this.maxStates = maxStates || MAX_STATES;
    const cl = buildClasses(prog);
    this.classOf = cl.classOf;
    this.nClasses = cl.count;
    this.classWord = new Uint8Array(cl.count);
    for (let c = 0; c < cl.count; c++) this.classWord[c] = contains(WORD, cl.reps[c]) ? 1 : 0;
    // membership of each class in each CHAR instruction's set
    this.member = [];
    for (let s = 0; s < prog.sets.length; s++) {
      const m = new Uint8Array(cl.count);
      for (let c = 0; c < cl.count; c++) m[c] = contains(prog.sets[s], cl.reps[c]) ? 1 : 0;
      this.member.push(m);
    }
    const n = prog.op.length;
    this.seen = new Int32Array(n);
    this.stamp = 0;
    this.stack = new Int32Array(n * 3 + 8);
    // Buffers of the cache-free simulation.
    this.bufA = new Int32Array(n + 2);
    this.bufB = new Int32Array(n + 2);
    this.cons = new Int32Array(n + 2);
    this.seenK = new Int32Array(n + 2);
    this.stampK = 0;
    this.resets = 0;
    this.work = 0;        // units spent building states (callers read the difference)
    this.builds = 0;      // states built, over the life of the regular expression
    this.chars = 0;       // characters scanned by earlier calls
    this.simulateOnly = false;
    this.resetCache();
  }

  resetCache() {
    this.kernels = [];
    this.prevs = [];
    this.map = new Map();
    this.trans = new Int32Array(this.maxStates * this.nClasses).fill(-1);
    this.end = new Int8Array(this.maxStates).fill(-1);
    this.stateFor([0], 0);
  }

  stateFor(kernel, prev) {
    const key = prev + ':' + kernel.join(',');
    let id = this.map.get(key);
    if (id === undefined) {
      id = this.kernels.length;
      this.kernels.push(kernel);
      this.prevs.push(prev);
      this.map.set(key, id);
      this.builds++;
    }
    return id;
  }

  // Follows the empty moves from the kernel; returns { consuming pcs, matched }.
  closure(kernel, prev, next) {
    const prog = this.prog;
    const op = prog.op;
    const stamp = ++this.stamp;
    const seen = this.seen;
    const stack = this.stack;
    const out = [];
    let matched = false;
    let visits = 0;
    for (let k = kernel.length - 1; k >= 0; k--) {
      let sp = 0;
      stack[sp++] = kernel[k];
      while (sp > 0) {
        const pc = stack[--sp];
        if (seen[pc] === stamp) continue;
        seen[pc] = stamp;
        visits++;
        switch (op[pc]) {
          case OP_CHAR: out.push(pc); break;
          case OP_MATCH: matched = true; break;
          case OP_JMP: stack[sp++] = prog.x[pc]; break;
          case OP_SAVE: stack[sp++] = pc + 1; break;
          case OP_SPLIT: stack[sp++] = prog.y[pc]; stack[sp++] = prog.x[pc]; break;
          case OP_ASSERT: {
            const kind = prog.x[pc];
            let ok;
            if (kind === ASSERT_BOL) ok = prev === 0;
            else if (kind === ASSERT_EOL) ok = next === 3;
            else if (kind === ASSERT_WORDB) ok = (prev === 1) !== (next === 1);
            else ok = (prev === 1) === (next === 1);
            if (ok) stack[sp++] = pc + 1;
            break;
          }
          default: break;
        }
      }
    }
    this.work += visits + kernel.length;
    return { pcs: out, matched: matched };
  }

  // The state reached from state s on a character of class cls: a state number, or -2 for "matched".
  // When the cache is full it is emptied (this.resets grows) and the new state is returned.
  computeTransition(s, cls) {
    const prev = this.prevs[s];
    const next = this.classWord[cls] ? 1 : 2;
    const c = this.closure(this.kernels[s], prev, next);
    if (c.matched) return -2;
    const kernelSet = new Set([0]);
    for (const pc of c.pcs) if (this.member[this.prog.x[pc]][cls]) kernelSet.add(pc + 1);
    const kernel = Array.from(kernelSet).sort(function (a, b) { return a - b; });
    this.work += 8 + 6 * kernel.length;
    const nprev = this.classWord[cls] ? 1 : 2;
    const id = this.map.get(nprev + ':' + kernel.join(','));
    if (id !== undefined) return id;
    if (this.kernels.length >= this.maxStates - 1) {
      this.resetCache();
      this.resets++;
      this.work += 200;
    }
    return this.stateFor(kernel, nprev);
  }

  endMatches(s) {
    let e = this.end[s];
    if (e === -1) { e = this.closure(this.kernels[s], this.prevs[s], 3).matched ? 1 : 0; this.end[s] = e; }
    return e === 1;
  }

  /** The state before the first character when the search starts after `prev` (0 line start, 1 word character, 2 other). */
  startState(prev) {
    if (prev === 0) return 0;
    const id = this.map.get(prev + ':0');
    return id === undefined ? this.stateFor([0], prev) : id;
  }

  /**
   * Does the pattern match anywhere in the text from position `from` on? (The characters before
   * `from` only count as context for ^ and word boundaries.) Throws a "budget" RegexError when the
   * work limit is passed.
   */
  test(text, meter, from) {
    const start = from > 0 ? from : 0;
    const prev0 = start === 0 ? 0 : isWordCode(text.charCodeAt(start - 1)) ? 1 : 2;
    if (this.simulateOnly) return this.simulate(text, start, START_KERNEL, prev0, meter);
    const classOf = this.classOf;
    const nC = this.nClasses;
    const len = text.length;
    const limit = meter.limit;
    let spent = 0;
    let s = this.startState(prev0);
    for (let i = start; i < len; i++) {
      const cls = classOf[text.charCodeAt(i)];
      let t = this.trans[s * nC + cls];
      if (t === -1) {
        const resets = this.resets;
        const w0 = this.work;
        t = this.computeTransition(s, cls);
        const flushed = this.resets !== resets;
        if (!flushed) this.trans[s * nC + cls] = t;
        spent += this.work - w0;
        if (meter.used + spent + ((i - start) >> 1) > limit) { meter.used += spent + ((i - start) >> 1); this.chars += i - start; throw budgetError(); }
        if (flushed && t !== -2 && this.resets >= 3 && this.builds * 6 > this.chars + i - start) {
          // The state space is too large for the cache: from here on, simulate without it.
          this.simulateOnly = true;
          meter.used += spent + ((i - start) >> 1);
          this.chars += i + 1 - start;
          return this.simulate(text, i + 1, this.kernels[t], this.prevs[t], meter);
        }
      }
      if (t === -2) { meter.used += spent + ((i - start) >> 1); this.chars += i + 1 - start; return true; }
      s = t;
    }
    meter.used += spent + ((len - start) >> 1);
    this.chars += len - start;
    return this.endMatches(s);
  }

  /**
   * The same search without a cache of states: the set of live positions in the program is
   * advanced one character at a time (time per character proportional to the live alternatives).
   * `kernel0` and `prev0` describe the position to continue from.
   */
  simulate(text, from, kernel0, prev0, meter) {
    const prog = this.prog;
    const op = prog.op;
    const px = prog.x;
    const py = prog.y;
    const classOf = this.classOf;
    const classWord = this.classWord;
    const member = this.member;
    const cons = this.cons;
    const seen = this.seen;
    const seenK = this.seenK;
    const stack = this.stack;
    const len = text.length;
    const limit = meter.limit;
    let cur = this.bufA;
    let nxt = this.bufB;
    let curLen = kernel0.length;
    for (let k = 0; k < curLen; k++) cur[k] = kernel0[k];
    let prev = prev0;
    let used = meter.used;
    for (let i = from; i <= len; i++) {
      let next = 3;
      let cls = -1;
      if (i < len) { cls = classOf[text.charCodeAt(i)]; next = classWord[cls] ? 1 : 2; }
      const stamp = ++this.stamp;
      let consLen = 0;
      let visits = 0;
      let matched = false;
      for (let k = 0; k < curLen && !matched; k++) {
        let sp = 0;
        stack[sp++] = cur[k];
        while (sp > 0) {
          const pc = stack[--sp];
          if (seen[pc] === stamp) continue;
          seen[pc] = stamp;
          visits++;
          switch (op[pc]) {
            case OP_CHAR: cons[consLen++] = pc; break;
            case OP_MATCH: matched = true; break;
            case OP_JMP: stack[sp++] = px[pc]; break;
            case OP_SAVE: stack[sp++] = pc + 1; break;
            case OP_SPLIT: stack[sp++] = py[pc]; stack[sp++] = px[pc]; break;
            case OP_ASSERT: {
              const kind = px[pc];
              let ok;
              if (kind === ASSERT_BOL) ok = prev === 0;
              else if (kind === ASSERT_EOL) ok = next === 3;
              else if (kind === ASSERT_WORDB) ok = (prev === 1) !== (next === 1);
              else ok = (prev === 1) === (next === 1);
              if (ok) stack[sp++] = pc + 1;
              break;
            }
            default: break;
          }
        }
      }
      used += visits + consLen + 2;
      if (matched) { meter.used = used; return true; }
      if (used > limit) { meter.used = used; throw budgetError(); }
      if (i === len) break;
      let nl = 0;
      const stampK = ++this.stampK;
      for (let j = 0; j < consLen; j++) {
        const pc = cons[j];
        if (member[px[pc]][cls]) {
          const np = pc + 1;
          if (seenK[np] !== stampK) { seenK[np] = stampK; nxt[nl++] = np; }
        }
      }
      if (seenK[0] !== stampK) { seenK[0] = stampK; nxt[nl++] = 0; }
      const tmp = cur; cur = nxt; nxt = tmp;
      curLen = nl;
      prev = classWord[cls] ? 1 : 2;
    }
    meter.used = used;
    return false;
  }
}

// ---- Pike VM (exec) -------------------------------------------------------------------------------

function isWordCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122); }

/**
 * The leftmost match from `from`, as an array of capture positions (slot 0 and 1 are the whole
 * match), or null. With wantCaps false only the whole match is tracked, so a pattern with
 * hundreds of groups costs no more than one without. Work is added to `meter`; a "budget" RegexError
 * is thrown when the limit is passed. `scratch` holds buffers reused between calls.
 */
function pikeExec(prog, groups, text, from, wantCaps, meter, scratch) {
  const op = prog.op;
  const px = prog.x;
  const py = prog.y;
  const sets = prog.sets;
  const n = op.length;
  const len = text.length;
  const nCaps = wantCaps ? (groups + 1) * 2 : 2;
  const copyCost = 1 + (nCaps >> 2);
  const limit = meter.limit;
  let work = meter.used;
  let clist = [];
  let nlist = [];
  if (!scratch.markC) { scratch.markC = new Int32Array(n); scratch.markN = new Int32Array(n); }
  let markC = scratch.markC.fill(-1);
  let markN = scratch.markN.fill(-1);
  let matchCaps = null;
  const stack = [];

  // Adds the thread (pc0, caps0) at text position `at` and everything reachable by empty moves.
  function add(list, markArr, pc0, caps0, at) {
    stack.push(pc0, caps0);
    while (stack.length) {
      let caps = stack.pop();
      let pc = stack.pop();
      for (;;) {
        if (markArr[pc] === at) break;
        markArr[pc] = at;
        work++;
        const o = op[pc];
        if (o === OP_JMP) { pc = px[pc]; continue; }
        if (o === OP_SPLIT) { stack.push(py[pc], caps); pc = px[pc]; continue; }
        if (o === OP_SAVE) {
          const slot = px[pc];
          if (slot < nCaps) {
            work += copyCost;
            if (work > limit) throw budgetError();
            const copy = caps.slice();
            copy[slot] = at;
            caps = copy;
          }
          pc++; continue;
        }
        if (o === OP_ASSERT) {
          const kind = px[pc];
          const prevWord = at > 0 && isWordCode(text.charCodeAt(at - 1));
          const nextWord = at < len && isWordCode(text.charCodeAt(at));
          let ok;
          if (kind === ASSERT_BOL) ok = at === 0;
          else if (kind === ASSERT_EOL) ok = at === len;
          else if (kind === ASSERT_WORDB) ok = prevWord !== nextWord;
          else ok = prevWord === nextWord;
          if (!ok) break;
          pc++; continue;
        }
        list.push(pc, caps);
        break;
      }
    }
  }

  try {
    for (let pos = from; pos <= len; pos++) {
      if (matchCaps === null) {
        // The start thread has the lowest priority: it is added after the running threads.
        const caps = new Array(nCaps).fill(-1);
        caps[0] = pos;
        add(clist, markC, 0, caps, pos);
      }
      const code = pos < len ? text.charCodeAt(pos) : -1;
      nlist = [];
      work += 2 + (clist.length >> 1);
      if (work > limit) throw budgetError();
      for (let i = 0; i < clist.length; i += 2) {
        const pc = clist[i];
        const caps = clist[i + 1];
        const o = op[pc];
        if (o === OP_CHAR) {
          if (code >= 0 && contains(sets[px[pc]], code)) add(nlist, markN, pc + 1, caps, pos + 1);
        } else if (o === OP_MATCH) {
          matchCaps = caps.slice();
          matchCaps[1] = pos;
          break; // the threads of lower priority are cut off
        }
      }
      clist = nlist;
      const tmp = markC; markC = markN; markN = tmp;
      if (clist.length === 0 && matchCaps !== null) break;
    }
  } finally {
    meter.used = work;
  }
  return matchCaps;
}

// ---- public API ---------------------------------------------------------------------------------

/**
 * Compiles a pattern. Throws RegexError (with .code syntax | unsupported | too-large) for a
 * pattern that is invalid or cannot be matched in linear time. The result has:
 *   test(text, options) -> boolean, exec(text, from, options) -> { index, end, text, groups } | null,
 *   findAll(text, max, options) -> list of matches, groupNames.
 * `options.meter` (see createMeter) shares one work limit between calls; `options.budget` sets the
 * limit of this call; without either the limit is WORK_LIMIT. A call that passes its limit throws
 * a RegexError with code "budget" and a message that tells the user what to do.
 */
function compile(pattern, options) {
  const ignoreCase = !!(options && options.ignoreCase);
  const parsed = parse(pattern, ignoreCase);
  const prog = compileProgram(parsed);
  let dfa = null;
  const scratch = {};
  const groups = parsed.groups;
  const names = parsed.names;
  function run(text, from, wantCaps, meter) {
    // On a long text a quick check with the DFA first: no match at all costs a fraction of the VM's work.
    if (text.length - from > 256) {
      if (!dfa) dfa = new Dfa(prog, options && options.maxStates >= 4 ? Math.min(options.maxStates, MAX_STATES) : 0);
      if (!dfa.test(text, meter, from)) return null;
    }
    const caps = pikeExec(prog, groups, text, from, wantCaps, meter, scratch);
    if (!caps) return null;
    const g = {};
    const list = [];
    if (wantCaps) {
      for (let i = 1; i <= groups; i++) {
        const s = caps[i * 2];
        const e = caps[i * 2 + 1];
        const v = s >= 0 && e >= s ? text.slice(s, e) : undefined;
        list[i] = v;
        if (names[i]) g[names[i]] = v;
      }
    }
    return { index: caps[0], end: caps[1], text: text.slice(caps[0], caps[1]), groups: g, captures: list };
  }
  return {
    pattern: pattern,
    groupCount: groups,
    groupNames: names.filter(function (v) { return !!v; }),
    programSize: prog.op.length,
    test: function (text, opts) {
      if (!dfa) dfa = new Dfa(prog, options && options.maxStates >= 4 ? Math.min(options.maxStates, MAX_STATES) : 0);
      return dfa.test(text, meterFor(opts), 0);
    },
    // `opts.captures === false` leaves the groups out (faster for a pattern with many groups).
    exec: function (text, from, opts) {
      return run(text, from || 0, !(opts && opts.captures === false), meterFor(opts));
    },
    // All non-overlapping matches (at most `max`); the groups are not filled in. One work limit covers the whole call.
    findAll: function (text, max, opts) {
      const meter = meterFor(opts);
      const out = [];
      let from = 0;
      const limit = max || 1000;
      while (from <= text.length && out.length < limit) {
        const m = run(text, from, false, meter);
        if (!m) break;
        out.push(m);
        from = m.end > m.index ? m.end : m.end + 1;
      }
      return out;
    }
  };
}

/** Text with every regular expression special character escaped. */
function escapeText(text) { return String(text).replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&'); }

module.exports = { compile, RegexError, escapeText, createMeter, WORK_LIMIT, BATCH_LIMIT, BUDGET_MESSAGE, MAX_PATTERN, MAX_PROGRAM, MAX_STATES };
