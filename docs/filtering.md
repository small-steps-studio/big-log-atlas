# Filtering

A filter shows only the lines that pass it. The filtered view streams: lines appear as they are found, with the progress of the scan ("12,345 lines match so far, 37% scanned"). Filtered lines keep their real line numbers. Clearing the filter returns to the whole log at the line you had selected.

## Free filters

* **Text or regular expression**: type in the filter box. It uses the options **Aa**, **W** and **.\*** of the toolbar.
* **Level**: the buttons **F E W I D T** (fatal, error, warning, info, debug, trace) show only lines of the chosen levels. Several levels can be chosen. The same is available as **Big Log Atlas: Filter By Level**.
* Text and level filters combine: a line must pass both.
* **Big Log Atlas: Clear Filter** (or the **Clear** button) removes all filters, including the Pro parts below.

### How levels are found

A line's level is read from a level field first (`"level":"warn"`, `level=error`, `severity`), then from an upper-case level word near the start of the line (`ERROR`, `WARN`, `WARNING`, `INFO`, `DEBUG`, `TRACE`, `FATAL`, `CRITICAL`, `SEVERE`, `NOTICE`, `ERR`, ...), then from a bracketed word (`[error]`, as in nginx), then from "Error:" or "Warning:" at the start. Lines without a recognised level have none.

### Continuation lines

A line without a level of its own (a stack trace line, for example) belongs to the record above it and passes a level filter together with it. When the log has time stamps, a line that starts with one begins a new record, so it does not inherit the level of the line above.

## Limits that are stated, not hidden

* A filter keeps at most `bigLogAtlas.filter.maxMatches` matching lines (2,000,000 by default, about 8 bytes each). When a filter finds more, it stops and says "The filter stopped at 2,000,000 matching lines ... so the list is incomplete". Narrow the filter.
* Only the first 1,048,576 characters of a line are tested. The message after a filter says how many longer lines were read only in part.
* A filter that is cancelled keeps what it found and says "(cancelled; the list is incomplete)".
* A filter set while the line index is still being built waits for the index ("waiting for the line index...") and then covers the whole log; cancelling the wait clears the filter.

## Pro filters

* **Filter By Field (Pro)**: needs a [parse profile](profiles.md). Terms such as `status>=500 path~^/api/ level=error`; all terms must hold. Operators `=`, `!=`, `>`, `>=`, `<`, `<=`, `~` (regular expression) and `!~`. Numbers are compared as exact decimals, including numbers with an exponent such as `1.5e3` or `2E-7` (the digits are never converted to floating point). `=` and `!=` compare the text exactly, so `00123` and `123` differ, as identifiers should. A line that the profile cannot parse, or that lacks the field, passes only `!=` and `!~`.
* **Filter By Time Range (Pro)**: lines between two times; see [timestamps](timestamps.md). A line without a time stamp follows the line above it.
* **Save Current Filter (Pro)** and **Apply Saved Filter (Pro)**: keep filters (text, options, levels, field filter, time range) per workspace, up to 50.
* **Edit Highlight Rules (Pro)**: colour parts of lines (up to 20 rules, text or regular expression, six colours) in every log of the workspace.

Pro filters are part of the same filter: they are removed by **Clear Filter** and applied together with the text and level filters.
