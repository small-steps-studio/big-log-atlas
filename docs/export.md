# Export, anonymise and compare (Pro)

## Export Filtered Lines

**Big Log Atlas: Export Filtered Lines (Pro)** writes the lines of the view that pass the current filter (all lines when there is no filter) to a file you choose. The export streams: lines are read and written in blocks of about 1 MB, so a multi-gigabyte log is exported with a small, constant amount of memory. It cannot overwrite the log that is open. A cancelled export says so, and the file is incomplete.

| Format | Content |
| --- | --- |
| Text | The lines as they are, with LF line ends |
| CSV | `line`, `time` (ISO 8601 UTC, when a time format is recognised), `level`, `source` (merged views), the fields of the [parse profile](profiles.md) (up to 30), `text` |
| JSON | One array of objects: `line`, `time`, `level`, `source`, `fields`, `text` |
| JSON Lines | The same objects, one per line |

* The file is written in UTF-8, whatever the encoding of the log.
* Lines longer than 1,048,576 characters are written up to that length; the message after the export says how many.
* **CSV and formulas.** A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets an apostrophe in front, so that a spreadsheet shows it as text instead of running it. The setting `bigLogAtlas.export.neutraliseFormulas` (on by default) turns this off when you need the exact values and open the file in a program that does not run formulas. Cells with commas, quotes or line breaks are quoted; quotes are doubled.
* The columns of a profile come from the fields of the first matching lines (at most 2,000 are looked at to find the names), so a field that first appears later is not a column.

## Export Anonymised Copy

**Big Log Atlas: Export Anonymised Copy (Pro)** does the same as the export, with every line passed through the anonymiser first. It replaces the shapes listed under "Covered shapes" and nothing else. **It does not make a log safe to share.** Read the copy before you share it: open it in the viewer and search it for the names, host names and other details that matter in your case. "What it cannot do" lists what the rules do not see.

### Covered shapes

Each shape has an id. The test file `test/anonymise.shapes.test.js` runs every shape in this table in all eight parse profiles and all four export formats (text, CSV, JSON, JSON Lines) and fails when any original value is still in any output file; `test/anonymise.hostile.test.js` does the same for a built corpus of 1,224 spellings of secret names, each with a value that can be searched for. Another test fails when this table and the tested shapes are not the same list. A shape that is not in the table is not promised.

| Id | Shape | Examples | Replaced with |
| --- | --- | --- | --- |
| S01 | The value after a secret name, in `name=value`, `name: value`, `name = value`, `"name": "value"`, and each element of a JSON list under a secret name. The name is split into words at every character that is not a letter or a digit, at digits and at capital letters. It is secret when a word is one of `pass`, `pwd`, `pw`, `pin`, `otp`, `sid`, `auth`, `session`, `cred`, `cvv`, ..., contains `password`, `secret`, `token`, `credential`, `cookie`, `signature`, ..., or is `<api, access, private, signing, ...> key` | `db_password=x`, `DB_PASSWORD=x`, `MYSQL_ROOT_PASSWORD=x`, `userPassword=x`, `authToken=x`, `apiSecret=x`, `refresh_token=x`, `pass=x`, `X-Api-Key: x`, `Set-Cookie: sid=x`, `"passwords": ["x", "y"]` | `[secret-<8 hex>]` for the whole value |
| S02 | A quoted name of any characters: spaces, brackets, hyphens | `"api key": "x"`, `"Password (confirm)": "x"`, `"client-secret": "x"`, `"Client Secret": "x"` | `[secret-<8 hex>]` |
| S03 | The credential of an `Authorization` header, with its scheme word | `Authorization: Token x`, `Authorization: Bearer x`, `Authorization: Basic x`, `Proxy-Authorization: Digest x`, `"Authorization": "Bearer x"` | `[secret-<8 hex>]` for scheme and credential together |
| S04 | A quoted value with spaces, in double or single quotes, and a quote that is never closed (the rest of the line is the value) | `password="two words"`, `secret='two words'` | `[secret-<8 hex>]` |
| S05 | A password in a web address or in a connection string | `postgres://app:x@host/db`, `Server=db;Password=x;Timeout=5` | `[secret-<8 hex>]` for the password |
| S06 | JSON escapes: `\uXXXX`, an escaped quote inside a string, a name written with escapes, and JSON inside a JSON string down to four levels | `"email":"alice@example.org"`, `"msg":"retry with password=\"x\" failed"`, `"password":"x"`, `{"inner":"{\"password\":\"x\"}"}` | the value that the escapes stand for is replaced and the string is written back with its escapes |
| S07 | A name and a value as two members: either order, a list of them, YAML flow, and `name=... value=...` | `{"name":"DB_PASSWORD","value":"x"}`, `{"value":"x","name":"DB_PASSWORD"}`, `{"key":"api_key","value":"x"}`, `- {name: DB_PASSWORD, value: x}` | `[secret-<8 hex>]` for the value |
| S08 | XML attributes and elements, INI, YAML, properties and environment lines | `<add key="DbPassword" value="x"/>`, `<param name="client_secret" value="x">`, `<property name="DB_PASSWORD">x</property>`, `<password>x</password>`, `password = x`, `db.password=x`, `export DB_PASSWORD=x` | `[secret-<8 hex>]` |
| S09 | Command lines: options and a few well-known commands | `--password x`, `--password=x`, `"--token", "x"` in a list of arguments, `curl -u user:x`, `mysql -pX`, `sshpass -p x`, `redis-cli -a x`, `docker login -p x` | `[secret-<8 hex>]` for the password |
| S10 | HTML entities and percent escapes that hide a secret. A line in which this reveals something is written decoded, with the replacements in it | `password=&quot;x&quot;`, `token&#61;x`, `%26password%3Dx`, `a=1&amp;password=x` | `[secret-<8 hex>]` |
| S11 | Python values with a prefix | `{'password': b'x', 'token': u'x', 'secret': r'x'}` | `[secret-<8 hex>]` |
| S12 | Names in German, French, Spanish, Portuguese, Dutch and Swedish (accents are ignored) | `passwort=x`, `kennwort=x`, `mot_de_passe=x`, `contraseña=x`, `clave=x`, `senha=x`, `wachtwoord=x`, `lösenord=x` | `[secret-<8 hex>]` |
| S13 | E-mail addresses, IPv4 addresses (also with leading zeros), IPv6 addresses written in full or with `::`, card numbers with a valid check digit, JSON web tokens, access key ids that start with `AKIA`, hexadecimal strings of 32 or more digits, token-like strings of 40 or more characters with upper case, lower case and digits | `alice@example.org`, `203.0.113.77`, `010.001.002.003`, `4111 1111 1111 1111` | e-mail: `user-<12 hex>@example.invalid`; IPv4: `10.<a>.<b>.<c>`; IPv6: `2001:db8::<hex>:<hex>`; the others `[kind-<8 hex>]` |
| S14 | An e-mail address or an IP address used as a JSON key, in the text, in the header of a CSV and in the keys of JSON fields | `{"quota":{"bob@example.org":5}}` | as in S13 |

The words of S01 in full: as a word of their own `pass`, `pwd`, `pw`, `pin`, `otp`, `sid`, `auth`, `oauth`, `session`, `cred`, `creds`, `cvv`, `cvc`, `ssn`, `secrets`, `tokens`, `passwords`; inside a word `password`, `passwd`, `passphrase`, `passcode`, `secret`, `token`, `credential`, `apikey`, `cookie`, `jwt`, `bearer`, `csrf`, `xsrf`, `signature`, `authorization` and the matching words of S12; and the pairs `api`, `access`, `private`, `secret`, `signing`, `encryption`, `master`, `ssh`, `license`, `client`, `service`, `auth`, `app`, `account`, `session` or `bearer` followed by `key`.

### Names that are kept on purpose

A name that measures or flags something does not hold a secret when its value is a number, a boolean or one short lower-case word. The tests keep these, with real secrets next to them that are still replaced: `tokens_used`, `max_tokens`, `completion_tokens`, `num_tokens`, `session_count`, `session_duration_ms`, `auth_method`, `token_type`, `password_changed`, `is_password_set`, `csrf_valid`, `signature_valid`, `cookie_consent`, `expires_in`, `pin_count`. A plural such as `tokens` with a number as value is a count. Words that only look similar are not secret names: `tokenizer`, `secretary`, `author`, `passenger`, `bypass`, `sort_key`, `keyboard`, `keyId`, `publicKey`. A name of that kind with a value that looks like a secret (capitals, digits and symbols mixed) is still replaced. The decision is the same for a name and its value everywhere: in the text of a line, in a field column, in a header.

### How replacements are made

The replacement of a value is derived with HMAC-SHA256 from a 256-bit key drawn from the system's cryptographic random source for each export. The same value gets the same replacement within one export, so a user or an address can still be followed through the copy, and **two different values never get the same replacement**: while an export runs, the extension keeps in memory which replacement belongs to which value (a 128-bit digest of the value, not the value itself), and when a replacement is already taken it uses the next candidate derived from the same value. The key is never saved, shown or logged, and nothing is saved that links original values to replacements; the copy cannot be turned back into the original by anyone who has only the copy. A different export uses a different key. The digests are freed when the export ends. They need about 200 bytes per different value, and an export stops with a message when one copy would have to keep apart more than 2,000,000 different values (filter the log down and export that).

### Columns with a parse profile

When a parse profile is chosen, the CSV and JSON exports have a column (or a `fields` entry) for each field. The fields are read from the line **after** it was anonymised, so a field never holds a value that the `text` column has replaced. A field whose name and value say "secret" (the decision of the previous section) is replaced in full, and when the text still held that value, it is replaced in the text too, so that the two columns agree. A value that a reader decoded from an escape and that is not in the text as written goes through the rules once more. The names of the columns are read from the anonymised lines too (S14). If a replacement breaks the structure of a line (a rule file whose replacement text contains a quote inside a JSON line), the fields of that line are left empty rather than read from the original.

### A rule file

A rule file adds your own rules. It is JSON, either a list or `{ "rules": [...] }`:

```json
{ "rules": [
  { "name": "customer", "pattern": "CUST-[0-9]{6}", "replace": "hash" },
  { "name": "plan", "pattern": "plan=(?:gold|silver)", "replace": "mask" },
  { "name": "note", "pattern": "internal note:.*", "replace": "<removed>", "flags": "i" }
] }
```

`replace` is `hash` (the default: `[name-<8 hex digits>]`), `mask` (asterisks of the same length, at most 64) or any text of up to 100 characters. `flags` may contain `i` for case-insensitive. Patterns run on the engine without backtracking, with a work limit per line ([regex](regex.md)); a rule that is not valid is reported with its number and name and nothing is exported. A rule that needs too much work for a line stops the export with a message that names the rule, and the incomplete file is removed (a rule is never skipped silently). Every match of a rule in a line is replaced. At most 100 rules.

### What it cannot do

The rules look for the shapes above and for nothing else. These stay in the copy:

* A secret in free text, with no secret name and no known shape in front of it ("login with password hunter2", a password in a sentence).
* A secret after a name that is not one of the secret words (`foo=...`, a one-letter name, a customer's own word), unless the value itself has one of the shapes of S13.
* A secret in an encoding that is not listed in S06 and S10: base64 or hexadecimal text of a password under an ordinary name, an encoding applied twice (`%253D`), quoted-printable text, a different alphabet (a Cyrillic letter in place of a Latin one in a name), JSON escaped more than four levels deep.
* An unquoted value that contains a space, `&`, `;` or `,`: the value ends there, and the rest stays (`password=ab cd` replaces `ab` only).
* A value that is not on the same line as its name, a secret in an XML child element (`<setting name="x"><value>...</value></setting>`), a key that spreads over several lines (each line is anonymised on its own).
* A password given to a command that is not listed in S09 (`mysql -p password` with a space, other tools' options).
* Names of people, user names, host names, customer numbers, file names and paths, free text, and every number or word that does not look like one of the shapes. A dotted number such as a software version `1.2.3.4` is treated as an IP address, a hexadecimal string of 32 or more digits as a secret.
* File names stay: the source tag of a merged view is passed through the rules, but a file name is not recognised as sensitive by itself. Field names that are not an address or a secret name stay (the header of the CSV, the keys of the JSON fields), and so does the structure of the lines.

The message after the export lists how many values each rule replaced in the text of the lines (the counts only, never the values).

### Speed

Measured on one Windows computer that was busy with other work, with the final rules, on a JSON Lines log of 50 MB (188,000 lines, an e-mail address and an IPv4 address in two places of each line, 377,000 different values): 7.3 seconds as text and 10.6 seconds as CSV with a profile (about 5 to 7 MB per second), the process using 240 to 260 MB and the editor never blocked for more than 0.03 seconds. A log of 1 GB therefore takes in the order of three to four minutes. A rule file with expensive patterns takes longer.

### Before you share a copy

Open the copy in the viewer. Search it for the names of people and companies, host names, user names, paths and anything else that identifies your systems or customers; search it for words such as `password`, `secret`, `token` and `key` to see what is left around them. If something is left, add a rule (see above) and export again. The extension cannot know what is sensitive for you.

## Compare Two Log Excerpts

**Big Log Atlas: Compare Two Log Excerpts (Pro)** compares a range of lines of the open log with a range of another log (an open log, or a file you pick). Before the comparison, parts that change from run to run are replaced by placeholders: time stamps (`<time>`), UUIDs (`<uuid>`), `0x` addresses and hexadecimal strings of 12 or more digits (`<hex>`) and numbers of six or more digits (`<number>`). The result opens in the editor's side-by-side comparison, and a message gives the numbers of lines that match exactly, lines that match in their text only (another line end, or a line longer than the scan limit that was compared by a digest), lines that match only after the replacement, and lines only in one excerpt.

Nothing is cut: lines are read up to 1,048,576 characters, and a longer line is compared by a digest of everything that was read and by its length in bytes; the side-by-side view shows the first 4,000 characters of a line and, for a longer one, how many characters follow and a short digest, so two lines that differ only far out do not look alike. Whitespace, blank lines, tabs and trailing spaces are differences.

**"Identical" means every byte.** The message says the excerpts are identical only when the bytes of the two excerpts are equal (a SHA-256 digest of each excerpt is compared). When the text of the lines is the same but something that the text view cannot show differs, the message says what: line ends (CRLF against LF, or a missing line break at the end of the file), a byte order mark on only one of the logs, a different encoding (for example UTF-16 against UTF-8), or bytes that differ in a way that looks alike once decoded. A merged view has no bytes of its own, so only its text is compared, and the message says that the bytes could not be compared. An excerpt that is shorter than the range asked for (the log ends earlier) says how many of the lines it has, and an excerpt that starts after the last line is refused.

The comparison is bounded: at most 20,000 lines per excerpt, and at most 2,000 differing lines. When the two excerpts differ more than that, it says so and shows nothing, instead of showing a partial answer. The difference is the minimal one (Myers).
