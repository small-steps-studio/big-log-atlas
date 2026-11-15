'use strict';
// Log level detection from a line: structured fields first (JSON "level", logfmt level=), then
// upper-case level words and bracketed level words (also as `[module:level]`, as in Apache logs) near the start of the line. The patterns are
// plain alternations of literals (no nested repeats), so they run in linear time.

const LEVELS = Object.freeze([
  { id: 'trace', rank: 0, label: 'TRACE', letter: 'T' },
  { id: 'debug', rank: 1, label: 'DEBUG', letter: 'D' },
  { id: 'info', rank: 2, label: 'INFO', letter: 'I' },
  { id: 'warn', rank: 3, label: 'WARN', letter: 'W' },
  { id: 'error', rank: 4, label: 'ERROR', letter: 'E' },
  { id: 'fatal', rank: 5, label: 'FATAL', letter: 'F' }
]);

const WORD_RANK = Object.freeze({
  trace: 0, verbose: 0, finest: 0, finer: 0, fine: 1, debug: 1, dbg: 1, info: 2, information: 2, informational: 2, notice: 2,
  warn: 3, warning: 3, error: 4, err: 4, severe: 4, fatal: 5, critical: 5, crit: 5, alert: 5, emerg: 5, emergency: 5, panic: 5
});

const KV_RE = /(?:"(?:level|lvl|severity|loglevel|levelname|log\.level)"\s*:\s*"?|\b(?:level|lvl|severity|loglevel|levelname)=["']?)([A-Za-z]{3,12})/i;
const TOKEN_RE = /(?:^|[^A-Za-z0-9_])(FATAL|CRITICAL|CRIT|SEVERE|EMERG|EMERGENCY|ALERT|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE|VERBOSE|FINEST|FINER|FINE)(?![A-Za-z0-9])/;
const BRACKET_RE = /\[(?:[a-z0-9_]{1,24}:)?(fatal|critical|crit|emerg|alert|error|err|warning|warn|notice|info|debug|trace)\]/i;
const TITLE_RE = /(?:^|[^A-Za-z0-9_])(Error|Warning|Fatal|Critical)(?=[:\]])/;

/** The level rank (0 trace .. 5 fatal) of a line, or -1 when none is recognised. */
function levelRank(line) {
  const head = line.length > 400 ? line.slice(0, 400) : line;
  let m = KV_RE.exec(head);
  if (m) { const r = WORD_RANK[m[1].toLowerCase()]; if (r !== undefined) return r; }
  const short = head.length > 160 ? head.slice(0, 160) : head;
  m = TOKEN_RE.exec(short);
  if (m) return WORD_RANK[m[1].toLowerCase()];
  m = BRACKET_RE.exec(short);
  if (m) return WORD_RANK[m[1].toLowerCase()];
  m = TITLE_RE.exec(short);
  if (m) return WORD_RANK[m[1].toLowerCase()];
  return -1;
}

/** Same as levelRank but as the level record, or null. */
function levelOf(line) {
  const r = levelRank(line);
  return r < 0 ? null : LEVELS[r];
}

/** Rank of a level word taken from a parsed field (for example "warning"), or -1. */
function rankOfWord(word) {
  if (typeof word !== 'string') return -1;
  const r = WORD_RANK[word.trim().toLowerCase()];
  return r === undefined ? -1 : r;
}

module.exports = { LEVELS, levelRank, levelOf, rankOfWord };
