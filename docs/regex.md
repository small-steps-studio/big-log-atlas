# Regular expressions

Every regular expression you type (the find box, the filter box, field filters, a `regex` or `log4j` profile, highlight rules, anonymiser rule files) runs on a matching engine that was written for this extension and that **cannot backtrack**. A pattern such as `(a+)+$` that makes other tools hang for minutes on a line of a few dozen characters finishes at once here, on a line of any length.

What is guaranteed, and how it is enforced:

* The work for a line grows with the length of the line times the size of the pattern, never exponentially.
* On top of that, **every call has a work limit**. A pattern that needs more work than the limit allows for a line (for example `[ab]*a[ab]{1000}c` on a line of a million characters, which needs far more work than the limit allows) is stopped with the message "This pattern needs too much work for these lines, so it was stopped to keep the editor responsive. Simplify it (avoid long repeats such as {200} and repeats inside repeats), or use the plain text search." A search, a filter or a count that is stopped this way says so and keeps no half-finished list; an export stops and removes the incomplete file; row highlights are left out for the rows concerned and a notice says so.
* A pass over a log gives the editor a turn after about every 15 milliseconds of work (between two lines; one call is never longer than the work limit), and Escape or the cancel button stops it between lines.

On the computer where it was measured (Windows, Node 24), the adversarial cases in the test suite (huge state spaces on a line of a million characters, 600 groups on a line of 2,000 characters, a pattern that scans to the end of the line for every match) each finished or were refused within about half a second. That is a measurement, not a promise for other machines: the limit counts work, not seconds, and a slower computer takes proportionally longer.

## How it works

* "Does this line match?" is decided by a lazily built finite automaton: one table lookup per character once the states exist. The table is built as needed and kept to at most 3,000 states (it is emptied and rebuilt when it fills, which is still correct). When it keeps overflowing, which happens for patterns with a huge state space, the same search goes on by following the live alternatives one character at a time, without a table.
* "Where does it match, and what do the named groups hold?" (highlights, profile fields) is decided by a Pike virtual machine that follows all alternatives together: time proportional to the length of the line times the size of the pattern. Highlights do not need the groups, so a pattern with hundreds of groups costs no more there than one without.
* The work limit is about 5 million units per call (a unit is roughly one instruction of the pattern visited for one character, or one capture position copied). One call of `findAll` (all matches in a line) and one screen of highlighted rows share a single limit, so a large number of matches or rows cannot add up beyond it. The table of parsed rows (a profile with a pattern of your own) shares a limit of eight calls' worth for the whole window and says "The table could not be built: This pattern needs too much work..." when it is passed. Loops over many lines (export, the discovery of its columns, statistics, filters, counts) check the limit on every call and give the editor a turn about every 15 milliseconds of work, so a pattern that is just under the limit on every line makes them slow, but not unresponsive; Escape stops them.
* The pattern is limited to 2,000 characters, 64 levels of nesting, repeat counts up to 1,000, and 6,000 internal steps after repeats are expanded. A pattern that exceeds a limit is refused with a message.

## Supported syntax

Literal characters; `.` (any character except a line break); escapes `\d \D \w \W \s \S \b \B \t \n \r \f \v \0 \xHH \uHHHH`; character classes `[abc]`, `[^abc]`, `[a-z0-9_]` with escapes inside; groups `( )`, `(?: )` and named groups `(?<name> )`; alternation `|`; quantifiers `* + ? {n} {n,} {n,m}` and their lazy forms (`*?`, `+?`, `??`, `{n,m}?`); the anchors `^` and `$` (start and end of the line); the match case and case-insensitive modes (the **Aa** button).

Characters are UTF-16 code units, as in JavaScript patterns without the `u` flag. Case-insensitive matching follows the same rules as the JavaScript engine: two characters match when their upper-case forms (as a single code unit) are equal, so `é` matches `É`, while the long s and the Kelvin sign do not match `s` and `k`.

## Refused, with a message that says why

| Construct | Why |
| --- | --- |
| Back-references (`\1`, `\k<name>`) | They cannot be matched in guaranteed linear time |
| Look-ahead and look-behind (`(?=`, `(?!`, `(?<=`, `(?<!`) | The same |
| `\p{...}` property classes, `\u{...}` escapes, `\cX` | Not supported |
| Characters above U+FFFF inside a character class | Not supported (outside a class they work) |
| Stacked quantifiers such as `a**` | Not valid (as in JavaScript) |
| Inline flags such as `(?i)` | Not supported; use the **Aa** button |

When a pattern is refused, nothing is searched or filtered and the previous state is kept.

## One known difference from the JavaScript engine

For a repeated group that can match the empty string, such as `(a?|b)+`, the span of the match that is highlighted, or the text of a named group, may differ from what the JavaScript engine reports. In the extension's tests, which compare more than 10,000 random pattern and text pairs (plus more than 20,000 pairs with letters that have unusual case rules) with the JavaScript engine, the answers to "does it match" always agreed, and the spans agreed for every pattern without such a group.

## Text search

Text that is not a regular expression is searched literally (`indexOf`), which is the fastest path. **W** (whole word) treats letters, digits and underscore as word characters.
