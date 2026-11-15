# Merge by time (Pro)

**Big Log Atlas: Merge Log Files By Time (Pro)** shows 2 to 16 log files as one stream ordered by time stamp, with the name of the source file in front of every line. It is meant for following one request or one incident across the logs of several services.

## How it is ordered

* The time stamp format of each file is detected on its own ([timestamps](timestamps.md)), so files in different formats can be merged. Times without a zone are read as UTC, so choose files whose local time zones agree or add the zones.
* The merge takes, at every step, the next line of whichever file has the earliest time. **Equal times keep the order of the files, then the order of the lines.**
* A line without a time stamp (a stack trace line) stays behind the line above it in its own file. Lines before the first time stamp of a file take that first time stamp.
* A file in which no time stamp is recognised is placed at the start, in file order, and the notice after the merge says so.
* A file whose time stamps are not in order: the merged order inside that file keeps the order of the file, and the notice names the file and how many of its lines are earlier than the line before them. The merge is a merge of the files' own order, so it is only as good as that order.

## What you get

A merged view works like a log: scrolling, search, level and text filters, go to a line or a percentage, copy (with the file tag in front of each copied line), the Pro filters, statistics, export and the excerpt comparison. It does not offer follow mode or encodings (a merged view is a snapshot of the files at the time of the merge), a byte offset (there is no single file), or bookmarks that survive closing the view.

## Memory and speed

The files are scanned once, in chunks. The merge keeps a checkpoint (the next line of every file) for about every 256th merged line, at most 500,000 checkpoints (it keeps every second one when it would exceed that), so a window of the merged stream is read by restoring the nearest checkpoint and merging forward a few hundred lines. Memory does not grow with the size of the files.
