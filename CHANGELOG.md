# Changelog

## 0.1.0

First release.

Free:

* Read-only viewer for log files of any size: the file is read in chunks and never loaded into memory; a sparse line index (saved between sessions for logs of 1 MB or more) and virtual scrolling keep every operation fast and memory small.
* Open from the Explorer menu or the Command Palette; jump to a line, a percentage or a byte offset.
* Search with text or regular expressions (an engine without backtracking, with a work limit on every call so that a costly pattern is stopped with a message instead of freezing the editor; patterns that cannot be matched in guaranteed linear time, such as back-references and look-around, are refused with a message), next and previous with wrap-around, match case, whole word, counts of matching lines with progress and cancel.
* Level colouring with a letter in the margin; time stamp detection in eight formats; filters by level, text and regular expression that stream and keep real line numbers; bookmarks.
* Follow mode (tail) with pause, detection of truncation and rotation; copy of lines and selections; status bar with line, percentage, size and encoding.
* Encodings UTF-8, UTF-16 LE and BE and Latin-1 with detection and manual override; LF, CRLF and mixed line ends; very long lines shown cut with the details pane for the rest.
* Walkthrough, sample logs with invented data, Report A Problem, documentation.

Pro (free 14-day trial, then a licence key):

* Parse profiles: JSON Lines (numbers kept exactly), logfmt, syslog, web server access logs, nginx and Apache error logs, log4j and logback conversion patterns, and your own regular expression with named groups; the table view with sortable columns for a window of lines, field filters (`status>=500 path~^/api/`) and parsed fields in the details pane.
* Time range filter, jump to a time, statistics (levels, rate over time, most frequent values, error bursts), merge of up to 16 files by time with a source tag, saved filters and highlight rules per workspace.
* Export of the filtered lines to text, CSV, JSON or JSON Lines (streaming; CSV formula cells neutralised, with an opt-out setting), pretty-printed JSON lines, anonymised export (the shapes listed in docs/export.md, each tested in all parse profiles and export formats: values after secret names in many spellings, e-mail and IP addresses, card-like numbers, token-like strings, and your own rule file; a fresh random key for every export; two different values never share a replacement; the field columns of a CSV or JSON export are read from the anonymised line; what it cannot do is listed, and the copy should be read before it is shared), comparison of two log excerpts after replacing times and ids (the result says "identical" only when every byte is equal, and names line ends, byte order mark and encoding differences).

Measured on one Windows computer before the last fixes of this version (see docs/limits.md, which also gives a repeat on a busy computer; the regular expression search was slower there, 15.4 s instead of 11.6 s for the 986 MB log): a 986 MB log of 11.5 million lines opens in 16 ms and is indexed in 1.6 seconds, and a 3.98 GB log of 46 million lines opens in 5 ms and is indexed in 4.4 seconds; a random line is read in about 0.1 ms; a plain text search over all lines takes 6.2 seconds (986 MB) and 18.4 seconds (3.98 GB); the process stays below 90 MB of resident memory in these runs. A log of 20 GB was not measured.

Tested locally on Windows only: the automated tests (in several time zones and from a path with spaces and non-ASCII characters) and a scripted check of the packaged extension, installed in a throw-away copy of VS Code 1.146 with a fresh profile. Not yet tested on macOS or Linux, on remote windows or on other editor versions; a continuous-integration workflow for three systems is prepared but has not been run.
