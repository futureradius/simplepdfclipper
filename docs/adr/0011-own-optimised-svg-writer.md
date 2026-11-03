# 11. Own optimised SVG writer

Status: accepted (2026-11-03)

## Context

The user's current workflow (Foxit + Inkscape) produces SVGs of ~12 MB that are sharp
in the whiteboard tool but lag; it recommends < 2 MB. Inkscape and MuPDF's built-in SVG writer
emit one element per path with verbose coordinates and repeated style attributes.
Element count likely drives lag in the whiteboard tool more than bytes.

## Decision

simplepdfclipper writes SVG itself: a custom MuPDF.js `Device` collects the
fill/stroke/text calls for the Clip, and our serializer emits optimised SVG:

- Coordinates rounded to a fixed 0.01 mm.
- Compact path syntax: relative commands, `H`/`V` for axis-aligned segments.
- Styles shared via CSS classes, not per-element attributes.
- Paths with identical style merged into one `<path>` with many subpaths.
- Repeated complex shapes defined once (`<symbol>`) and placed with `<use>`, only
  where that is smaller than inlining.
- Text handled per ADR 0006.

### Merge mode (user-selectable, "Erweitert" section)

| Mode | Merges | Exactness |
|---|---|---|
| Exakt | only consecutive same-style paths | always identical |
| Ausgewogen (default) | also across other elements when no overlapping element lies between them in paint order | identical |
| Maximal | all same-style paths regardless of order | overlaps may change stacking |

All three are one algorithm with a parameter (Exakt = no look-across, Maximal = no
overlap check), so the extra cost is mainly testing. The export view shows file size
and element count, so the user can compare modes.

## Consequences

- More code than using MuPDF's SVG output, but full control over size and text.
- Merging must preserve paint order exactly in modes Exakt and Ausgewogen; this is
  covered by tests that render original vs. export and compare pixels.
