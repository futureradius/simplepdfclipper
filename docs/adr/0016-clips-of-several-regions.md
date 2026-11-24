# 16. Clips of several freely arranged Regions

Status: accepted (2026-11-24, issue #6, decided in #14); supersedes ADR 0002. Built:
cutting at the Clip edge (#35, for one-Region Clips; ADR 0005), Regions on the Plan and
their export (#36). Not built yet: #37, #38.

## Context

ADR 0002 allowed exactly one rectangle per export. Users want to drop the irrelevant
middle of a schedule: e.g. the top legend, one time window from the middle and the symbol
legend from the bottom, exported together as one compact plan. Time axes run either way,
so the pieces may need to go below or beside each other.

## Decision

- **Glossary:** the **Clip** is still what is exported, now made of one or more
  **Regions** (UI "Bereich"). A one-Region Clip is the old Clip. Where each Region sits
  in the Clip is the **Layout** (UI "Anordnung"). All Regions come from the same Plan.
- **Free Layout:** Regions are only moved in the Clip, never scaled (exports stay 1:1)
  or rotated, and never overlap. They touch directly: no gap, no seam line. Empty space
  stays blank (transparent). Regions may overlap on the Plan (e.g. to repeat a header).
- **Two modes in step 2:** "Bereiche wählen" (`B`): Regions are created, resized and
  placed on the Plan, only here. "Anordnen" (`A`, only with ≥ 2 Regions): the Clip as
  exported; Regions are moved in it, only here, snapping to each other's and the
  Clip's edges. The Clip starts at its top-left corner and grows when a Region is
  dragged past it. The Tile grid is drawn in "Anordnen" (on the Plan only for a
  one-Region Clip).
- **Suggested Layout ("minimal fit"):** when a Region is added (placed next to the
  existing Layout, which stays) and on "Neu anordnen". It tries stacked top to bottom
  and side by side, both in Plan order, each Region keeping its offset from the Plan in
  the other direction (white space accepted), and keeps the smaller Clip; on a tie it
  stacks. Real rectangle packing was rejected as unpredictable.
- **Semi-automatic Layout:** when a Region is resized on the Plan, the moved edge moves
  the same way in the Layout; Regions touching that edge (and those touching them) move
  with it, so touching stays touching; a non-touching Region that would overlap is pushed
  and then touches. Moving a Region on the Plan without resizing keeps the Layout.
- **Exports:** PDF, SVG and Tiled Export all take multi-Region Clips. Everything outside
  all Regions is removed (ADR 0005), paths are cut at every Region edge. The Tiled
  Export cuts the stitched Clip; a Tile without content is still exported as an empty
  Sheet so the grid stays complete.
- **No Region:** the last Region can be removed; export is then disabled with a hint.
- **Clip presets** save Regions and Layout (ADR 0015); Regions are stretched to Plans of
  another size with a warning (ADR 0007).
- Undo/redo is out of scope.

## Consequences

- The export pipeline builds the stitched Clip as one page; the Tiled Export keeps its
  two stages (ADR 0013) and cuts Tiles from that page.
- The mouse scheme changes for everyone (ADR 0012): left edits, right/middle/Space pans.

## Built: Regions on the Plan (2026-11-24, #36)

- **Model:** `src/export/regions.ts`. A Region is its rectangle on the Plan plus `at`,
  its top-left corner in the Clip. The Clip reaches from (0, 0) to the far edges of its
  Regions; after a removal the Layout is shifted so it starts at (0, 0) again.
- **"Plan order"** in the suggested Layout means: stacked, sorted by top edge; side by
  side, sorted by left edge. The offset in the other direction is measured from the
  leftmost (topmost) Region. A new Region is placed while it is being drawn, so the
  Clip size in step 2 is right at every moment: below the Layout with its horizontal
  offset from the leftmost existing Region (never before the Clip's start), or to the
  right with its vertical offset, whichever gives the smaller Clip.
- **Until the semi-automatic Layout (#37):** a resized Region keeps its place in the
  Clip (a gap left by shrinking stays, "Neu anordnen" closes it); if it would overlap
  another, the whole Layout is suggested anew. Moving on the Plan keeps the Layout.
- **Step 2:** list "Bereich 1, 2, …" (click selects, × removes), the selected Region's
  x/y/w/h fields (disabled when none is selected), the Clip's size and "Neu anordnen"
  (with ≥ 2 Regions). With no Region, step 2 and step 3 say "Ziehe auf dem Plan einen
  Bereich auf." and the export buttons are disabled. `F` / "Ausschnitt" shows the
  selected Region, or all Regions if none is selected.
- **Remembered** under `simplepdfclipper.lastRegions` (Regions with Layout); an old
  `lastClip` rectangle is read as a one-Region Clip. If any Region does not fit the
  Plan, all are ignored and the Plan starts with one Region (until #38 stretches).
- **PDF:** each Region is exported on its own exactly like a one-Region Clip (removal,
  path cutting, image crop, ADR 0005); `src/export/stitchpdf.ts` then draws each result
  as a Form XObject at its place, clipped to the Region (a glyph kept whole at an edge
  must not reach into the neighbour). The space between Regions has no content. The
  document properties list every Region (Plan position, size, place in the Clip). Cost:
  one redaction pass per Region; a one-Region Clip takes the old path unchanged.
- **SVG:** each Region has its own collector, already placed in the stitched Clip
  (clip and pattern ids prefixed `r1`, `r2`, …); one pass over the page feeds all of
  them (`collectAll`: parsing the page and handing each drawing call to JS is most of
  the time), then all items are merged and written together. Items reaching past their
  Region's edge get a clip to the Region. The white background is drawn only behind
  the Regions; the space between them is transparent. Paths and text are now skipped
  by MuPDF's bounds before they are walked point by point, which also made every SVG
  export faster. Test Plan, SVG: one 500 × 600 mm Region 4.1 → 2.4 s; legend, time
  window and footer as three Regions 5.2 s (20.6 s with one pass per Region). PDF: the
  same three Regions 4.8 s (one Region 1.2 s).
- **Tiled Export:** stage 1 is the stitched PDF; Tile properties give the Tile's place
  in the stitched Clip. The Tile grid is drawn on the Plan only for a one-Region Clip.
- Tests: `src/export/regions.test.ts` (model, minimal fit), `src/export/stitch.test.ts`
  (PDF pixel diff per Region, nothing from between the Regions, SVG, empty Tile),
  `e2e/regions.spec.ts` (mouse scheme, list, removal, export, remembering).
