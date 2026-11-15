# Statistics (Pro)

**Big Log Atlas: Show Statistics (Pro)** reads the whole log (or the merged stream) once, with a progress notice you can cancel, and opens a page beside the log with:

* **Lines by level**: how many lines have each level (fatal, error, warn, info, debug, trace) and how many have none, with their share. With a [parse profile](profiles.md), a line whose text has no level but whose `level` field has one is counted by the field.
* **Lines over time**: a bar chart and, behind it, the table of its numbers (so nothing depends on seeing the chart). Each bar is one time interval (the interval is chosen so that there are at most 60 bars; the page says how long a bar is). The red part of a bar is the lines at error level or above. It needs a recognised time stamp format ([timestamps](timestamps.md)); otherwise the page says there is no chart.
* **Error bursts**: runs of at least five fatal or error lines in which each is at most 10 seconds after the one before (or, for a log without time stamps, at most 25 lines after it). The ten biggest bursts are listed with their first and last line number and, when known, their times.
* **Most frequent values** of up to five fields you name (with a parse profile): the ten most frequent values and their line counts. The counts are exact for the first 200,000 different values seen. If a field has more different values than that, the page says so and says how many lines with later new values were not counted, so a count is never silently wrong.
* A note when lines longer than 1,048,576 characters were read only in part, and when the count was cancelled (then the numbers cover only the part that was read).

The page has no script, a content security policy that allows only its own style, and every value from the log is escaped.

## Memory

The statistics keep a histogram of at most 2,048 buckets (neighbouring buckets are merged when it grows), the counts of up to 200,000 distinct values per field and the ten biggest bursts, whatever the size of the log.

## Speed

One pass over the log with level detection and time stamp extraction on every line; see [limits](limits.md) for measured numbers. A field with a `log4j` or `regex` profile adds the cost of that profile for every line.
