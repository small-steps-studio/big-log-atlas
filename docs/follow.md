# Follow mode and bookmarks

## Follow (tail)

Press **Follow** in the toolbar (or run **Big Log Atlas: Follow File (Tail)**) to watch a file that is still being written. The extension looks at the file every `bigLogAtlas.follow.intervalMs` milliseconds (500 by default). When lines are added, only the new part is scanned (not the whole file again), the line count grows, and the view scrolls to the end.

**Pause** keeps follow mode on but stops the view from jumping, so you can read; new lines are still counted ("12 new lines (follow is paused)"). Press **Pause** again to resume. **Follow** again turns it off.

When a filter is active, new lines are tested against it and added to the filtered view.

### What follow mode does when the file changes in other ways

| Event | What happens |
| --- | --- |
| The file becomes shorter | "The file was truncated; it was read again from the start." The index starts again; the filter, search count and bookmarks are cleared. |
| The file is replaced (log rotation) | "The file was replaced (log rotation); the new file is shown from the start." Detected by the file id, or by a changed start of the file. |
| The beginning of the file is edited | "The start of the file changed; it was read again from the start." Detected by a checksum of the first and the last indexed 4 KB. |
| The file disappears for a moment (rotation) | A notice says it is waiting for the file to come back; nothing is lost. |
| The last line is not finished yet | It is shown as the last line and completed on a later check. |

Follow mode is available for a single file; a merged view (Pro) is a snapshot.

A line break is a line feed (LF) or CR followed by LF. A lone CR is not a line break.

## Bookmarks

* **Ctrl+F2** (or **Big Log Atlas: Toggle Bookmark On Current Line**) sets or removes a bookmark on the cursor line; a bookmarked line has a dot before its number and a coloured edge.
* **F2** / **Shift+F2** (or **Go To Next Bookmark** / **Go To Previous Bookmark**) jump to the next / previous bookmark and wrap around at the ends.
* Bookmarks are kept per log (identified by a hash of its path) in the editor's workspace storage, up to 5,000 per log. They are cleared when the file is truncated or replaced, because the line numbers no longer mean the same.
