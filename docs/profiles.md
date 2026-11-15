# Parse profiles (Pro)

A parse profile tells Big Log Atlas how to read a line as named fields. With a profile you get columns (the **Table** view), field filters, sortable columns, parsed fields in the details pane, most frequent values in the [statistics](statistics.md) and field columns in the [CSV and JSON exports](export.md).

Choose one with **Big Log Atlas: Choose Parse Profile (Pro)**. "Detect from the first lines" tries the built-in profiles on the first 200 lines and picks the one that fits at least half of them. A log can have one profile at a time; the profile belongs to the open view and is not saved.

Values stay text. JSON numbers keep their exact digits (a 20-digit identifier is not rounded, `10.50` stays `10.50`). Sorting and the field operators `>`, `>=`, `<`, `<=` compare number-like values as exact decimals and everything else as text by code point; there is no floating point anywhere in the comparison.

## The profiles

### `jsonl`

JSON Lines: one JSON object per line. Nested objects are flattened with dots (`a.b.c`), array items with their index (`items.0`). At most 200 fields per line and 8 levels of nesting; values are cut at 20,000 characters. A line that is not one complete, valid JSON object does not parse. A line may be at most 1 MiB. In the details pane **Pretty-print JSON (Pro)** shows the object indented, keeping numbers exactly; it also works for a line such as `2026-01-15 INFO {"a":1}` whose object follows a prefix.

### `logfmt`

`key=value` pairs separated by spaces; a value may be quoted with `"` and use `\"`, `\n` and `\t`. A line needs at least two pairs (or a `level`, `msg` or `time` pair) to count as logfmt.

### `syslog`

RFC 3164 (`<34>Oct 11 22:14:15 host app[123]: message`) and RFC 5424 (`<165>1 2026-01-15T10:00:00.003Z host app 4711 ID47 [sd@1 k="v"] message`). Fields: `facility`, `severity` and `level` (from the priority), `time`, `host`, `app`, `pid`, `msgid`, `structured`, `message`.

### `access`

Web server access logs in the common and the combined format. Fields: `remote_addr`, `ident`, `user`, `time`, `request`, `method`, `path`, `protocol`, `status`, `bytes`, `referer`, `user_agent`, and `level` (`info` below status 400, `warn` for 4xx, `error` for 5xx).

### `nginx-error`

nginx error log lines (`2026/01/15 10:00:00 [error] 31#31: *7 message, client: 192.0.2.7, server: example.org, request: "GET /x HTTP/1.1"`). Fields: `time`, `level`, `pid`, `tid`, `connection`, `message`, and `client`, `server`, `request`, `upstream`, `host`, `referrer` when present.

### `apache-error`

Apache error log lines (`[Wed May 01 12:34:56.123456 2024] [core:error] [pid 1234:tid 5678] [client 192.0.2.7:5555] message`). Fields: `time`, `module`, `level`, `pid`, `tid`, `client`, `message`.

### `log4j`

A log4j or logback conversion pattern, which you type when you choose the profile, for example `%d{yyyy-MM-dd HH:mm:ss.SSS} [%t] %-5level %logger{36} - %msg%n`. Supported words: `%d` `%p` `%level` `%t` `%thread` `%c` `%logger` `%C` `%class` `%m` `%msg` `%message` `%M` `%L` `%F` `%r` `%i` `%l` `%X` `%x` `%n`, with width and precision modifiers (`%-5level`, `%logger{36}`). The pattern is converted into a regular expression with named groups (`time`, `level`, `thread`, `logger`, `message`, ...) and runs on the regular expression engine. Anything else is refused with "The conversion word %xyz is not supported".

### `regex`

Your own regular expression with named groups, for example `^(?<time>\S+) (?<level>[A-Z]+) (?<message>.*)$`. The named groups become the fields. It runs on the regular expression engine, which cannot backtrack and stops a pattern that needs too much work for a line with a message; back-references and look-around are refused (see [regex](regex.md)). Lines that do not match have no fields. The last pattern you typed is remembered for the workspace.

## The table

**Table (Pro)** (or the offer after choosing a profile) shows a window of up to 500 lines from the top of the view as a table: a **Line** column and up to 30 columns taken from the fields of those lines, in the order they first appear. Click a column header to sort the window (again for descending). **Previous window** and **Next window** move by 500 lines. The sort applies to the window only; the table says so. Lines the profile cannot parse appear as rows without cells.

## Speed

The built-in profiles use fixed patterns or hand-written readers. The `log4j` and `regex` profiles run on the regular expression engine, which is slower (see [limits](limits.md)); they are meant for tables and filters, and a field filter on a multi-gigabyte log with such a profile takes correspondingly longer.
