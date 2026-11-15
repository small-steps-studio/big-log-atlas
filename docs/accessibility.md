# Accessibility

What the viewer does for keyboard and screen reader users, and what it does not do. These statements describe the design and the checks that were made, not a conformance claim, and the viewer has not been tested with every screen reader.

## Keyboard

* Everything in the viewer can be done with the keyboard: the log list has a single tab stop; arrow keys, Page Up and Page Down, Ctrl+Home and Ctrl+End move the cursor and scroll; Shift extends the selection; Ctrl+F, Ctrl+G, F3, F2 and Ctrl+C work as described in [getting started](getting-started.md). The toolbar buttons and boxes are reached with Tab and have visible focus outlines.
* Every action has a Command Palette command too, which does not depend on the page having focus.
* Escape returns from a box to the list and cancels a running search, count, filter or wait.

## Screen readers

* The list is a grid (`role="grid"`) with the total number of rows (`aria-rowcount`); each drawn row is a row with its number in the log (`aria-rowindex`), its selection state and cells. The cursor is announced through `aria-activedescendant`.
* Every button and box has a text label. Toggle buttons expose their state (`aria-pressed`). The custom scroll bar has `role="scrollbar"` with a text value ("line 1,234 of 12,000,000").
* Changes are announced through polite live regions: the match count, the filter progress, the banner with notices, the status line.
* The level of a line is never given by colour alone: each row has a letter in the margin (F, E, W, I, D, T) with a text label ("error", "warning", ...).
* The statistics page is plain HTML with headings, captions and table headers; the bar chart has a text description and the table behind it carries the same numbers.
* The table view uses real table markup with column headers (`scope="col"`) and sort buttons labelled "Sort by <column>".

## Colour and contrast

All colours come from the editor's theme variables (text, background, selection, focus border, error, warning, information, description, find match highlight), so the viewer follows the theme you chose, including high-contrast themes. In forced-colours mode the selection and the matches get an outline. The six highlight-rule colours are translucent backgrounds behind the theme's text colour. Contrast depends on your theme; the viewer does not set a text colour of its own.

## Motion

Nothing is animated.

## Known limits

* A log of millions of lines is drawn as a window of rows. A screen reader reads the rows that are drawn; it cannot read the whole log, which is not possible for any viewer of such files. Use search, filters and the statistics to find what matters.
* The row cells are not individually focusable.
* The font size of the list follows the editor's font size setting (`editor.fontSize`); the toolbar follows the editor's interface font size.

If something here does not work for you, please report it (**Report A Problem**).
