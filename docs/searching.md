# Searching

Type in the find box. The search starts at the cursor and the first match is shown at once; **Enter** or **F3** goes to the next match, **Shift+Enter** or **Shift+F3** to the previous one. When there is no match after (before) the cursor the search wraps around to the other end of the log and says so.

## Options

* **Aa**: match case. Off by default.
* **W**: whole word. A match must not touch a letter, digit or underscore on either side.
* **.\***: the text is a regular expression (see [regex](regex.md)). Off: the text is searched literally.

The three options also apply to the filter box.

## Counts

After a short pause the number of matching lines is counted in the background and shown next to the box: "at least 12,345 lines (37% scanned)" while it runs, "12,345 lines" when it is done. It counts lines, not occurrences. Typing again, pressing Escape or closing the log cancels the count. While the line index of a very large log is still being built, the count says "so far (indexing)".

## What is searched

* Every line of the log, from the first to the last, streaming; nothing is held in memory.
* Only the first 1,048,576 characters of a line are searched. A pass that meets a longer line tells you how many lines it read only in part, so a missing match in the tail of a very long line is never silent.
* In a filtered view the search covers the lines of the filter (the rows you see); clear the filter to search the whole log.
* In a merged view (Pro) the search covers the merged stream.
* The text is compared as UTF-16 text after decoding with the log's encoding. Case-insensitive search folds case by the rules of the JavaScript runtime.

## Highlights

Matches are marked in the rows that are on screen. Highlight rules (Pro) colour parts of lines permanently, see [filtering](filtering.md).

## Searching a pattern that is refused

A regular expression that cannot be matched in guaranteed linear time (back-references, look-ahead, look-behind) is refused with a message that names the reason. Nothing is searched until the pattern is accepted. See [regex](regex.md).
