# Getting started

Big Log Atlas opens log files of any size in a read-only viewer. The file is never loaded into memory: it is read in chunks, a small line index is built in the background, and only the lines on the screen are held.

## Open a log

* In the Explorer, right-click a file and choose **Open As Large Log**, or
* run **Big Log Atlas: Open As Large Log** from the Command Palette and pick a file, or
* run **Big Log Atlas: Open Sample Log** (or **Open Sample JSON Lines Log**) to try the viewer on short invented logs.

Only files on your computer are opened (not files in a virtual workspace). The log is shown in its own tab. You can open several logs; each has its own view. The file is only read: Big Log Atlas never changes a log.

The first screen of lines appears at once. The line index is built in the background and the status line shows its progress ("Indexing: 37%"). While it runs you can already scroll and search the part that is indexed (a search that finds nothing there says "No match so far (still indexing)"). A jump to a line or position that is not indexed yet, a filter, a time jump, the statistics and an export wait for the index, so that none of them covers only a part of the log; Escape cancels the wait. Logs of at least 1 MB keep a saved index in the extension's storage, so a log that has not changed opens without scanning again (see [limits](limits.md)).

## The view

* The list shows one line per row with its line number, a letter for its level (F, E, W, I, D, T when a level is recognised) and the text. A line longer than the display limit (2,000 characters by default) ends with a marker; select it to read more in the details pane.
* The toolbar has the find box with three options (**Aa** match case, **W** whole word, **.\*** regular expression), the filter box with level buttons, the go-to box, follow and pause buttons, **Table (Pro)** and **Encoding**.
* The details pane below the list shows the selected line completely (up to 65,536 characters), its byte offset, level and time, and buttons for Pro tools.
* The status bar of the editor shows "Ln 1,234 of 12,000,000 · 45% · 1.2 GB · UTF-8" while a log is active.

## Keyboard

| Keys | Action |
| --- | --- |
| Arrow Up / Down | Move the cursor one line (with Shift: extend the selection) |
| Page Up / Page Down | Move one page |
| Ctrl+Home / Ctrl+End | First / last line |
| Home / End | Scroll left / right |
| Ctrl+F | Focus the find box |
| Enter / Shift+Enter in the find box, F3 / Shift+F3 | Next / previous match |
| Ctrl+G | Focus the go-to box |
| Ctrl+C | Copy the selected lines |
| Ctrl+A | Select all lines of the view (copy stops at 200,000 lines or 32 MiB, and says so) |
| Ctrl+F2 / F2 / Shift+F2 | Toggle a bookmark / next bookmark / previous bookmark |
| Escape | Cancel a running search, count, filter or wait |

Every command in the Command Palette that acts on the open log ("Find", "Find Next", "Go To", "Filter By Level", "Follow File", "Change Encoding", "Toggle Bookmark", "Copy Selected Lines") does the same as the keys and buttons.

## Go to

Type in the go-to box (or run **Go To Line, Percentage Or Byte Offset**):

* `1234` or `line 1,234`: a line number,
* `50%` or `12.5%`: a position in the file by bytes,
* `@1048576` or `0x1F4000`: a byte offset,
* `t:2026-01-15 10:30` (Pro): the first line at or after a time, see [timestamps](timestamps.md).

## Next

[Searching](searching.md), [filtering](filtering.md), [follow mode and bookmarks](follow.md), [parse profiles](profiles.md) (Pro), [statistics](statistics.md) (Pro), [merge](merge.md) (Pro), [export and anonymise](export.md) (Pro), [licence and trial](licence.md), [limits and measured numbers](limits.md), [accessibility](accessibility.md), [troubleshooting](troubleshooting.md).
