# Troubleshooting

## The log does not open

| Message | What to do |
| --- | --- |
| "The file does not exist (any more)" | The path is gone or the file was moved. |
| "The file cannot be opened: access is denied" | The operating system refuses to read the file. Check its permissions. |
| "The file is locked by another program" | Another program holds the file open exclusively (Windows). Close it, or copy the file and open the copy. |
| "Only files on this computer can be opened" | Virtual workspaces and non-file schemes are not supported. Open a folder on a normal file system (in a remote window, open the folder in that remote window). |
| "This is not a file" | You chose a folder. |

## The text looks wrong

* **Strange characters.** The encoding was guessed wrongly. Click **Encoding** (or run **Change Encoding**) and choose UTF-8, UTF-16 LE, UTF-16 BE or Latin-1. The status bar and the details pane show the encoding in use; the choice applies to this log only. Set a default with `bigLogAtlas.defaultEncoding`.
* **"This file looks binary".** The file holds NUL bytes that are not UTF-16 text (a compressed file, a database, a core dump). It is shown as text; control characters appear as symbols (for example the NUL byte as ␀). This is not a log.
* **A line is cut off.** A line longer than `bigLogAtlas.maxLineChars` (2,000 by default) ends with a marker in the list. Select it: the details pane shows up to 65,536 characters.
* **Old Mac line ends.** A lone CR is not a line break; a file that uses only CR is one line. Convert it first.

## Slow or incomplete

* **"Indexing" stays in the status line.** The line index of a very large file takes a while (see [limits](limits.md) for measured rates); scrolling and search work on the indexed part meanwhile (a search that finds nothing there says so). A jump to a place that is not indexed yet, a filter, a time jump, the statistics and an export wait for the index; Escape cancels the wait.
* **"This pattern needs too much work for these lines".** The regular expression needs more work than the limit allows for a line, for example a repeat such as `{500}` over a line of hundreds of thousands of characters, or several repeats of `.*` in a row. The search, filter or export stops at once and keeps no half-finished result. Simplify the pattern, search for a fixed part of it first, or use the plain text search. See [regex](regex.md).
* **Search or filter is slow.** Searching a multi-gigabyte log reads all of it. Text search is the fastest; a regular expression takes about twice as long; a filter with a `regex` profile field is slower still. Cancel with Escape and narrow the filter.
* **"The filter stopped at 2,000,000 matching lines".** The result list is capped (setting `bigLogAtlas.filter.maxMatches`) so that memory stays bounded. Narrow the filter or raise the limit.
* **Counts say "so far (indexing)".** The index is still being built; the number is final when the status line shows the line count without a progress note.
* **The saved index is not used.** It is used only when the path, size and modification time are unchanged and the checksums of the first and last 4 KB match. A log that is still growing is scanned again from where it stopped, not from the start.

## Search and filters

* **"The regular expression was not accepted".** The message names the reason (back-references and look-around are not supported, a limit was exceeded, or the pattern is invalid). See [regex](regex.md).
* **A level is not recognised.** Levels are recognised by the rules in [filtering](filtering.md). A level written in another way (`<3>`, a number) is not recognised.
* **The time range or time jump says no time stamps were recognised.** See the supported formats in [timestamps](timestamps.md).

## Follow mode

* **New lines do not appear.** Check that **Follow** is on and not paused. Some programs write in large blocks; the view updates when the lines are in the file. A file on a network share or a synchronised folder may report its size late.
* **"The file is not there at the moment".** The log is being rotated; the extension waits and continues when the file comes back.

## Licence and Pro

* **A Pro command offers to buy.** The 14-day trial is over, or the stored key is not valid. **Show Licence Status** says which.
* **The licence check cannot connect.** The only host the extension contacts is `live.dodopayments.com` (port 443). Behind a proxy, set the editor's `http.proxy`. Older editors may not send the licence check through the proxy; then the last successful check keeps Pro working for 14 days.
* **I entered the key twice and now it says the maximum number of computers.** Entering a key that is already active on this computer does not use another activation. If a message says the limit is reached, run **Remove Licence From This Machine** on one of the other computers.
* **Linux: "could not be saved in the secret storage".** Start a credential store (GNOME Keyring or KWallet) and try again.

## Still stuck

Run **Big Log Atlas: Report A Problem**: it copies a diagnostics block (versions, settings, the size and shape of the open log; no content, names or paths) and opens the issues page <https://github.com/small-steps-studio/big-log-atlas/issues>. Never post a licence key or confidential log content in a public issue; attach a small example without confidential content instead.
