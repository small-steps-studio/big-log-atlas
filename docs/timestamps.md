# Time stamps

Big Log Atlas detects the time stamp format of a log from its first lines and uses it for level filters (to tell where a record starts), the time range filter, the time jump, the statistics, the merge by time and the time column of exports. A format is chosen when at least a fifth of the non-empty sample lines carry a time stamp of that format (and at least three lines, unless the sample is smaller).

## Zones and the computer's time zone

Times are read as milliseconds since 1970 in UTC. A time that carries a zone (`Z`, `+02:00`, `-0530`, `+0200`) is converted. **A time without a zone is read as UTC**, so that the order of lines never depends on the time zone of the computer or on daylight saving changes. When you type a time (time range, time jump), the same rule applies: add a zone if your log's local time is not UTC. No local-time function is used anywhere.

## The formats

### `iso`

ISO 8601 and close relatives: `2024-05-01T12:34:56.789Z`, `2024-05-01 12:34:56,789`, `2024-05-01T12:34:56+02:00`, `2024-05-01 12:34:56 -0530`. Fractions of up to 9 digits (read to milliseconds). The time stamp may appear anywhere in the first 320 characters of the line, which also covers JSON lines with a `"ts"` field and syslog RFC 5424.

### `slash`

`2024/05/01 12:34:56` (nginx error log style).

### `clf`

Web server access log: `[01/May/2024:12:34:56 +0200]`.

### `apache-error`

Apache error log: `[Wed May 01 12:34:56.123456 2024]`.

### `syslog`

Syslog RFC 3164 at the start of a line, optionally after `<34>`: `May  1 12:34:56`. **The line has no year.** The year is taken from the file's modification time; a month that lies more than one month after the modification month counts as the previous year (so `Dec 31` in a file modified in January is last year's). This is a guess and the documentation states it as one.

### `logcat`

Month and day with milliseconds at the start of a line, no year: `05-01 12:34:56.789`. The year is chosen as for syslog.

### `epoch`

Unix time in a field named `ts`, `time`, `timestamp`, `@timestamp`, `t`, `unixtime` or `time_unix` of a JSON line, or in `ts=`, `time=` or `timestamp=` of a logfmt line. Nine to eleven digits are seconds (a fraction is allowed: `1714566896.250`); twelve or thirteen digits are milliseconds.

### `time-of-day`

Only a time at the start of the line: `12:34:56.789`. It counts from midnight of an undefined day, so it orders lines correctly within one day only.

## Lines without a time stamp

A line that has none (a stack trace line, a line of a multi-line message) is treated as part of the record above it: the time range filter follows the line above, the statistics count it as "without a time stamp", and the merge by time keeps it behind the line above it. Lines before the first time stamp of a file take that first time stamp in a merge.

## What is not recognised

Dates written month first or day first with slashes (`01/05/2024`, which is ambiguous), time stamps with names of months in other languages, week numbers, and times beyond the first 320 characters of a line. If no format is recognised, the time features say so and do nothing.

## Time jump (Pro)

**Jump To Time (Pro)** and `t:` in the go-to box find the first line at or after a time. When the log is completely indexed and has at least 2,000 lines, the extension bisects the sparse line index (a handful of reads) and then checks the landing point: the first line at or after the time must have a line before the narrowed range that is earlier than the time. For a log that is in time order this is exact. When the check fails, or the index is not complete, or the log is shorter, the extension reads the log once from the start and returns the first line at or after the time, which is exact for any log and takes as long as a search. A log whose lines are out of order far from the landing point can still give a different answer from the one-pass reading; that is the price of not reading the whole file.
