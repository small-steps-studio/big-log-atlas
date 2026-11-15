'use strict';
// Which names say that their value is a secret. One decision for a name and its value, used for the
// text of a line and for the field columns of an export alike (see anonymise.js and exporter.js).
//
//   * A name is split into words at every character that is not a letter or a digit, at digits and at
//     capital letters, with accents removed: db_password, DB_PASSWORD, "Password (confirm)", "api key",
//     userPassword, client-secret, Contraseña -> db, password / user, password / client, secret ...
//   * It is secret when a word is one of the secret words (pass, pwd, token, ...), contains one of the
//     secret stems (password, secret, token, credential, cookie, ...; also in German, French, Spanish,
//     Italian, Dutch, Portuguese and Swedish), or when it is "<api|access|private|...> key". Words that
//     only look similar are not secret (tokenizer, secretary).
//   * A name that measures or flags something (tokens_used, max_tokens, session_count,
//     password_changed, csrf_valid, auth_method, cookie_consent, expires_in) does not hold a secret
//     when its value is a number, a boolean or one short lower-case word. A plural such as `tokens`
//     with a number as value is a count.

const STEMS = ['password', 'passwd', 'passphrase', 'passcode', 'secret', 'token', 'credential', 'apikey', 'accesskey', 'privatekey', 'signingkey', 'encryptionkey',
  'masterkey', 'sshkey', 'licensekey', 'licencekey', 'clientkey', 'authorization', 'authkey', 'cookie', 'jwt', 'bearer', 'csrf', 'xsrf', 'signature', 'sessionid', 'sessionkey',
  'passwort', 'kennwort', 'contrasena', 'wachtwoord', 'motdepasse'];
const WORDS = new Set(['pass', 'pwd', 'pw', 'pin', 'otp', 'sid', 'auth', 'oauth', 'session', 'cred', 'creds', 'cvv', 'cvc', 'ssn', 'secrets', 'tokens', 'passwords',
  'mdp', 'clave', 'senha', 'losenord', 'haslo', 'secreto', 'segreto', 'geheim', 'geheimnis', 'jeton', 'schluessel', 'chiave', 'passe']);
const KEY_PREFIXES = new Set(['api', 'access', 'private', 'secret', 'signing', 'encryption', 'master', 'ssh', 'license', 'licence', 'client', 'service', 'auth', 'app', 'account', 'session', 'bearer']);
// Words that look like a stem and are not (tokenizer, secretary, ...).
const NOT_SECRET_WORD = /^(?:detoken|retoken|token)?(?:iz|is)(?:e|es|ed|er|ers|ing|ation|ations)$|^secretar(?:y|ies|iat|iats)$|^secretly$|^tokenless$/;
// A plural that is a metric when its value is a number.
const PLURAL = new Set(['tokens', 'secrets', 'passwords', 'creds']);

// A name whose last word is one of these measures or flags something.
const MEASURE_LAST = new Set(['count', 'counts', 'used', 'usage', 'max', 'min', 'total', 'duration', 'ms', 'millis', 'msec', 'seconds', 'secs', 'sec', 'length', 'len', 'size', 'limit',
  'limits', 'changed', 'valid', 'invalid', 'validity', 'enabled', 'disabled', 'consent', 'method', 'methods', 'type', 'types', 'kind', 'expires', 'expiry', 'expired', 'ttl', 'age',
  'rate', 'ratio', 'status', 'mode', 'policy', 'version', 'format', 'algorithm', 'alg', 'required', 'present', 'exists', 'verified', 'attempts', 'retries', 'remaining', 'left',
  'updated', 'created', 'rotated', 'in']);
// ... and so does a name whose first word is one of these.
const MEASURE_FIRST = new Set(['max', 'min', 'total', 'num', 'number', 'avg', 'average', 'mean', 'count', 'completion', 'input', 'output', 'cached', 'remaining', 'is', 'has',
  'use', 'uses', 'enable', 'disable', 'allow', 'require', 'no', 'skip']);

/** The words of a name (see the header). */
function nameWords(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase().split(' ').filter(Boolean);
}

function measures(words) {
  return words.length > 1 && (MEASURE_LAST.has(words[words.length - 1]) || MEASURE_FIRST.has(words[0]));
}

const cache = new Map();
// { secret, measure, pluralOnly } for a name
function judge(name) {
  let j = cache.get(name);
  if (j !== undefined) return j;
  const words = nameWords(name);
  let secret = false;
  let plain = false; // secret through a word that is not a plural metric
  for (const w of words) {
    if (NOT_SECRET_WORD.test(w)) continue;
    const hit = WORDS.has(w) || STEMS.some(function (s) { return w.indexOf(s) !== -1; });
    if (hit) { secret = true; if (!PLURAL.has(w)) plain = true; }
  }
  for (let i = 0; i + 1 < words.length; i++) if (words[i + 1] === 'key' && KEY_PREFIXES.has(words[i])) { secret = true; plain = true; }
  if (!secret && words.join('').indexOf('motdepasse') !== -1) { secret = true; plain = true; }
  // the last part of a path (client.db_password_count) is judged too for the measure
  const last = String(name).split(/[./]/).pop();
  const measure = measures(words) || (last !== name && measures(nameWords(last)));
  j = { secret: secret, measure: measure, pluralOnly: secret && !plain };
  if (cache.size > 5000) cache.clear();
  cache.set(name, j);
  return j;
}

/** True when the name alone says "secret" (a count or a flag is not looked at). */
function isSecretName(name) { return judge(name).secret; }

const NUMBER = /^-?\d{1,12}(?:\.\d{1,6})?$/;
const FLAG = /^(?:true|false|yes|no|on|off|null|none|nil|enabled|disabled|ok)$/i;
const SIMPLE_WORD = /^[a-z][a-z0-9_.\-]{0,31}$/;

/**
 * True when the value that belongs to the name is a secret. A name that measures or flags
 * something keeps a value that is a number, a boolean or one short lower-case word; a plural
 * (`tokens`) keeps a number.
 */
function isSecretKey(name, value) {
  const j = judge(String(name));
  if (!j.secret) return false;
  if (value === undefined || value === null) return true;
  const v = String(value).trim();
  if (j.measure && (NUMBER.test(v) || FLAG.test(v) || SIMPLE_WORD.test(v))) return false;
  if (j.pluralOnly && NUMBER.test(v)) return false;
  return true;
}

module.exports = { nameWords, isSecretName, isSecretKey };
