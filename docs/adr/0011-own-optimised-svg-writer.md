# 11. Own optimised SVG writer

Status: accepted (2026-11-03), implemented and measured the same day

## Context

The user's current workflow (Foxit + Inkscape) produces SVGs of ~12 MB that are sharp
in the whiteboard tool but lag; it recommends < 2 MB. Inkscape and MuPDF's built-in SVG writer
emit one element per path with verbose coordinates and repeated style attributes.
Element count likely drives lag in the whiteboard tool more than bytes.

## Decision

simplepdfclipper writes SVG itself (`src/export/`): a custom MuPDF.js `Device`
collects the fill/stroke/text/image calls inside the Clip (`collect.ts`), they are
merged (`merge.ts`) and serialised (`svg.ts`):

- Coordinates are integers in a viewBox of 0.01 mm units: fixed 0.01 mm precision
  with no decimal points.
- Compact path syntax: relative commands, `h`/`v` for axis-aligned segments, repeated
  command letters and needless separators omitted.
- **No CSS.** Shared styles are attributes, on the single merged `<path>` or on a
  `<g>` around text of the same style. Attributes work in every SVG renderer, and
  after merging there are so few paths that classes would not save anything.
- Paths with identical style are merged into one `<path>` with many subpaths.
- **Stroke compaction** (`strokes.ts`): within a merged stroke group (opaque, not
  dashed), axis-parallel pieces on the same line that touch or overlap are joined
  into one line, and duplicate edges vanish. Exporters draw grid lines row by row and
  cells as separate rectangles, so this removes most of the line data. Rectangles
  are split into edges only where that keeps the mitred corners exactly (butt caps:
  edges extended by half the width; square caps: as is); per group the smaller
  encoding wins.
- **No `<symbol>`/`<use>` instancing.** Merging already puts repeated shapes into one
  path; `<use>` per instance would add elements.
- Items entirely outside the Clip are dropped; items crossing the edge are kept whole
  and cut by the viewBox (ADR 0005).
- **PDF clip paths** become `<clipPath>` elements: rectangles as `<rect>` (and left
  out entirely when they do not cut anything), other shapes as exact `<path>`
  (e.g. the schedule's slanted bands). Nested clips chain via `clip-path` on the
  `<clipPath>`. IDs are plain (`c1`, `c2`…) for strict SVG parsers.
- **Tiling patterns** (e.g. the schedule's hatched areas) become SVG `<pattern>`s: the tile
  content is recorded once in pattern space; further uses with a different matrix
  reference it via `xlink:href`. The filled area is a rect with `fill="url(#p…)"`,
  cut to the shape by its clip path. Note: MuPDF passes the fill area to
  `beginTile` in *pattern* space, not device space.
- PDF line width 0 ("thinnest line") becomes 0.05 mm (SVG would hide width 0).
- Not reproduced (counted and shown to the user as a warning): shadings, image masks,
  soft masks, nested patterns, transparency group effects; clips by stroke, text or
  image mask are approximated by their bounding box.

### History

- 2026-11-03: the first real schedule export reported 1,630 skipped pattern fills and 1,268
  approximated clips; the user confirmed hatching was missing. Patterns and exact clip
  paths were added, the Test Plan got hatched slanted zones, and the visual test now
  also compares the amount of ink (non-white pixels) so missing areas fail the test.

### Merge mode (user-selectable, "Erweitert" section)

| Mode | Merges | Exactness |
|---|---|---|
| Exakt | only into the most recent element | always identical |
| Ausgewogen (default) | into the latest same-style element if nothing painted after it overlaps (grid spatial index over bounding boxes); a line may pass under/over other *lines* | identical except the colour of points where two lines cross |
| Maximal | into the latest same-style element regardless of order | overlaps may change stacking |

In every mode: translucent and dashed items are never merged, and filled paths only
merge if they do not overlap a member of the group (overlapping subpaths in one path
can cancel out under the fill rule).

## Measurements (Test Plan, 1188.9 × 14,270.9 mm, ~820k drawing operations)

| Clip | Text | Mode | PDF objects in Clip | SVG elements | Size |
|---|---|---|---|---|---|
| full width, 600 mm tall | real text | exact | 33,773 | 1,504 | 0.50 MB |
| full width, 600 mm tall | real text | **balanced** | 33,773 | **1,291** | **0.49 MB** |
| full width, 600 mm tall | real text | max | 33,773 | 739 | 0.44 MB |
| full width, 600 mm tall | outlines | balanced | 33,773 | 571 | 1.46 MB |
| full width, 600 mm tall | outlines | max | 33,773 | 18 | 1.42 MB |
| table + 1 year, 2000 mm tall | real text | balanced | 26,532 | 4,068 | 0.56 MB |
| table + 1 year, 2000 mm tall | outlines | balanced | 26,532 | 1,668 | 3.85 MB |

Export takes 2–5 s (MuPDF runs the whole page through the device; only the Clip's
items are kept). Real text elements dominate the element count in text mode.

Visual check (`e2e/svg-fidelity.spec.ts`, Edge, 3 px/mm, pixels differing by > 25 %):

- exact vs. balanced: **0.000 %**
- exact vs. max: 0.002 %
- PDF (MuPDF raster) vs. SVG: 0.25 % with real text, 0.10 % with outlines: glyph
  rasterisation differences only, verified by inspecting crops.

### Full-page measurements after stroke compaction (2026-11-03)

The first full-page export of a real schedule (3.1 MB PDF) gave ~9.5 MB SVG
(Ausgewogen). PDF content streams are deflate-compressed, SVG is not: the full Test
Plan SVG is 11.4 MB but only 0.26 MB gzipped, i.e. mostly repetition.
`scripts/svg-breakdown.mjs` showed 89 % of the bytes were line data.

| Full Test Plan (1188.9 × 14270.9 mm) | before | stroke compaction | + lines may cross (Ausgewogen) |
|---|---|---|---|
| Exakt | 11.4 MB | 7.9 MB | 7.9 MB |
| Ausgewogen | 11.4 MB | 7.6 MB | 6.5 MB |
| Maximal | ~10 MB | 1.1 MB | 1.1 MB |

Ausgewogen stays far above Maximal on the Test Plan because each row's zebra band is
drawn between that row's grid pieces; moving the pieces past the band would hide
them, so they cannot merge. Maximal ignores this (harmless in the Test Plan, but in
real Plans e.g. white label boxes drawn over lines could end up under them).

Visual test: Exakt vs. Ausgewogen still 0.000 % differing pixels. The "ink" check
was replaced by counting clearly red pixels (hatching, red lines; ~94 % in all
variants vs. the MuPDF raster), because thin grey lines anti-alias lighter when
drawn once instead of twice, and Edge renders text lighter than MuPDF.

## Consequences

- More code than using MuPDF's SVG output, but full control over size and text.
- Paint-order preservation in Exakt/Ausgewogen is covered by unit tests (`merge`) and
  the pixel comparison.
