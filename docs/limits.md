# Limits and measured numbers

Every limit below is a constant in the code, and every pass that can hit one tells you when it did. Nothing is silently dropped.

## Measured speed and memory

Measured by `test/helpers/large-run.js` (the process that `test/large.test.js` starts) on one Windows 11 computer (Node 24.18, 8 logical processors), run alone on an otherwise idle computer; inside the whole test suite, which runs several test files at the same time, the same operations took about twice as long. The logs are synthetic (one line of about 85 bytes per request: time, level, service, an id and a few words) and were written just before each run, so the operating system's file cache was warm; a cold read is limited by the speed of your disk. The JavaScript heap of the measuring process was limited to 300 MB. A "pass" is one streaming read of the whole file.

| | 98 MB | 986 MB | 3.98 GB |
| --- | ---: | ---: | ---: |
| Lines | 1,150,000 | 11,500,000 | 46,000,000 |
| Open and show the first 40 lines (before any index exists) | 14 ms | 16 ms | 5 ms |
| Index the whole file (one pass, 4 MB chunks) | 0.11 s (860 MB/s) | 1.6 s (594 MB/s) | 4.4 s (856 MB/s) |
| Index entries held, memory of the index | 4,493, 72 KB | 44,922, 0.7 MB | 179,688, 2.9 MB |
| Read one random line | 0.10 ms | 0.12 ms | 0.10 ms |
| Jump to 50% of the bytes (line number of that byte) | 1 ms | 1 ms | 1 ms |
| Count lines containing a plain text (case-sensitive) | 0.39 s | 6.2 s | 18.4 s |
| Count lines matching a regular expression | 0.82 s | 11.6 s | 35.5 s |
| Count lines matching a catastrophic pattern `(a+)+$` or `(x+x+)+y` | 0.74 s | 11.1 s | 39.9 s |
| Level filter into a result list | 0.74 s | 9.7 s | 36.3 s |
| Peak resident memory of the process (including the runtime itself, about 35 to 46 MB) | 58 MB | 76 MB | 85 MB |
| Peak JavaScript heap | 7 MB | 11 MB | 15 MB |

These numbers were measured before the last fixes of version 0.1.0 (the work limit of the regular expression engine and the short pauses that let the editor breathe during a pass). A repeat of the 986 MB and 98 MB rows with the final code was made on a computer that was busy with other work at the time, so it is not comparable with the table: 986 MB: index 2.3 s, plain text search 11.0 s, regular expression 15.4 s, catastrophic pattern 12.6 s, level filter 17.0 s, peak memory 81 MB; 98 MB: plain text 0.9 to 1.4 s, regular expression 1.4 to 1.9 s, level filter 1.6 to 1.9 s over three runs. The index, which the fixes did not touch, was also slower in that repeat (0.18 to 0.23 s for 98 MB against 0.11 s), so most of the difference is the computer, not the code; but the table was not measured again on an idle computer. Run `test/helpers/large-run.js` (it is in the repository) for numbers that apply to your machine.

All counts equal the numbers derived by hand from the generating formula (the number of ERROR lines, and the lines of a regular expression that matches ids below 200,000), and 200 random lines per file matched the formula.

What this shows: the time to the first lines does not depend on the size of the file; indexing and every full pass take time in proportion to the size; memory stays small because only the index (about 16 bytes per entry, capped) and one chunk are held. **A file of 20 GB was not measured.** By proportion, a warm-cache index of 20 GB would take in the order of half a minute and a plain text search several minutes, but on a cold disk the speed of the disk decides; treat these as estimates, not as measurements.

Growth: appending 1,000 lines to the 986 MB and the 3.98 GB logs and refreshing took about 1 ms each (only the new part is scanned).

## Limits of the viewer

| What | Limit | What happens at the limit |
| --- | --- | --- |
| Characters of a line searched, filtered, counted, exported, merged | the first 1,048,576 | Each pass reports how many longer lines it read only in part |
| Characters of a line shown in the list | `bigLogAtlas.maxLineChars`, 2,000 by default (200 to 100,000) | The row ends with a marker; select it to see more |
| Characters of a line in the details pane | 65,536 | A note says the line is longer |
| Matching lines kept by a filter | `bigLogAtlas.filter.maxMatches`, 2,000,000 by default (1,000 to 10,000,000) | The filter stops and says the list is incomplete |
| Lines copied at once | 200,000 lines or 32 million characters | The message says the copy stopped at the limit |
| Index entries | 2,000,000 (32 MB) | Every second entry is dropped and the spacing doubles; reads become slightly slower, nothing is lost |
| Saved indexes | `bigLogAtlas.indexCache.maxMB`, 64 by default; only logs of 1 MB or more; files older than 60 days are removed | The oldest are deleted first |
| Bytes looked at to detect the encoding | the first 64 KiB | Choose the encoding by hand if the guess is wrong |
| Rows asked from the extension at once | 400; the page keeps at most 4,000 rows | |
| Bookmarks | 5,000 per log | The message says so |

Not supported: compressed files, files on virtual file systems, a lone CR as a line break, line ends other than LF and CR LF, UTF-32.

## Limits of the regular expression engine

2,000 characters per pattern, 64 levels of nesting, repeat counts up to 1,000, 6,000 internal steps after repeats are expanded, 3,000 cached automaton states (the cache is emptied and rebuilt when it fills), a step budget for finding match spans. Back-references, look-ahead and look-behind are refused. See [regex](regex.md).

## Limits of the Pro tools

| What | Limit |
| --- | --- |
| Parse profile: JSON line | 1 MiB per line, 8 levels of nesting, 200 fields, 20,000 characters per value |
| Parse profile: table | a window of 500 lines, 30 columns, cells cut at 300 characters |
| Statistics: histogram | 2,048 buckets while counting (neighbours are merged), at most 60 bars shown |
| Statistics: most frequent values | exact for the first 200,000 different values of a field; the page says how many lines were not counted beyond that |
| Statistics: error bursts | the ten biggest |
| Merge | 16 files; 500,000 checkpoints (every second one is dropped when it would exceed that) |
| Export: columns of a profile | 30; names taken from the first 2,000 matching lines |
| Anonymiser rule file | 100 rules, a replacement text of 100 characters at most, a mask of 64 characters at most |
| Excerpt comparison | 20,000 lines per excerpt, 2,000 differing lines |
| Saved filters / highlight rules | 50 / 20 per workspace |

## Speed of the Pro tools

The statistics, the exports and the time range filter read the whole log once and do more work per line than a plain search (level detection, time stamp extraction, profile parsing). The built-in profiles use fixed patterns; the `log4j` and `regex` profiles run on the regular expression engine ([regex](regex.md)), which is slower than a built-in profile by a factor you should measure on your logs before you apply a field filter to a multi-gigabyte file. The anonymiser works on each line with fixed patterns and your rules; its measured speed is in [export](export.md).
