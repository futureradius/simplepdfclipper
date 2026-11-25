# 16. Clips of several freely arranged Regions

Status: accepted (2026-11-24, issue #6, decided in #14); supersedes ADR 0002. Built:
cutting at the Clip edge (#35, for one-Region Clips; ADR 0005), Regions on the Plan and
their export (#36), the "Anordnen" view and the semi-automatic Layout (#37), placing a
new Region where it lies on the Plan and reordering the list (#44). Not built yet: #38.

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
- **A new Region** goes where it lies on the Plan (#44): on the same side of the Region
  closest to it on the Plan, touching it; the existing Layout stays.
- **Suggested Layout ("minimal fit"):** on "Neu anordnen" (until #44 also for a new
  Region, placed beside the existing Layout). It tries stacked top to bottom
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
  right with its vertical offset, whichever gives the smaller Clip. Replaced by #44
  (below); this rule is now only the fallback.
- **Until the semi-automatic Layout (#37):** a resized Region kept its place in the
  Clip; if it would overlap another, the whole Layout was suggested anew. Replaced by
  #37 (below).
- **Step 2:** list "Bereich 1, 2, …" (click selects, × removes), the selected Region's
  x/y/w/h fields (disabled when none is selected), the Clip's size and "Neu anordnen"
  (with ≥ 2 Regions). With no Region, step 2 and step 3 say "Ziehe auf dem Plan einen
  Bereich auf." and the export buttons are disabled. `F` / "Ausschnitt" shows the
  selected Region, or all Regions if none is selected.
- **Remembered** under `simplepdfclipper.lastRegions` (Regions with Layout); an old
  `lastClip` rectangle is read as a one-Region Clip. If any Region does not fit the
  Plan, all are ignored and the Plan starts with one Region. Since #38 they are stretched
  to a Plan of another size instead (ADR 0007).
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

## Built: the "Anordnen" view and the semi-automatic Layout (2026-11-24, #37)

- **Two modes in step 2:** a switch "Bereiche wählen" `B` | "Anordnen" `A` above the
  Region list, shown with ≥ 2 Regions. A new Plan starts in "Bereiche wählen"; removing
  Regions down to one leaves "Anordnen". Each mode keeps its own view (zoom and place);
  the first visit to "Anordnen" shows the whole Clip. The toolbar's "Ganzer Plan" and
  "Planbreite" (`1`, `2`) become "Ganzer Ausschnitt" and "Ausschnittbreite" there.
- **The view** (`src/ui/viewer.ts`, mode "arrange"): the world is the Clip. Each Region
  is drawn with the Plan images (overview and sharp renders, both in Plan mm) shifted to
  its place and clipped to it; empty space in the Clip is checkered (transparent in the
  export), the Clip has a dashed outline, the Regions blue outlines and numbers, no
  handles. Sharp renders are made per visible Region, sharing the pixel budget of one
  render; renders are kept while they hold few pixels (≥ 4, up to 4 × 16 MP). The Tile
  grid is drawn over the Clip. The minimap composes each Region's part of the Plan
  preview at its place.
- **Dragging** (`moveInLayout` in `src/export/regions.ts`): the target is the Region's
  place at the drag start plus the mouse movement. Snapping first: each axis snaps the
  Region's nearer edge to the other Regions' edges or the Clip's start (0), within 8
  screen px; Alt or the "An Linien einrasten" switch turns it off. Then the Region
  slides from where it is towards the target, one axis after the other (both orders
  tried, the closer result wins), stopping at the first Region in its way. So it can't
  jump across another Region; it goes around. Arrow keys slide the same way without
  snapping. The fields show the place in the Clip (x/y editable, w/h read-only); a typed
  place is taken directly if it is free, else the Region slides towards it.
- **Growing past the start:** during a drag the Layout is not normalised, so the Clip
  reaches from the Region dragged past its left/top edge; on release the Layout is
  shifted to start at (0, 0) again and the view shifts with it, so nothing jumps on
  screen. A typed place is normalised when the field is left.
- **Semi-automatic Layout** (`setRect`): unchanged size means a move on the Plan, and
  the Layout stays. Otherwise each axis whose size changed is handled on its own (x,
  then y), each edge that moved by d: the Region's edge moves by d in the Layout; the
  Regions touching that edge (edges coincide within 1e-6 mm and their extents across it
  overlap by more than a point), and those touching them further on that side, move by
  d too; any Region now overlapped by one of these is pushed in the direction of d just
  far enough to touch it, and pushes in turn. Shrinking pulls the touching chain back,
  and that may push a Region on the other side of a chain member (the Clip then grows
  that way). Finally the Layout is normalised.
- Tests: `src/export/regions.test.ts` (each edge growing and shrinking, chains, pushes,
  chains of pushes, corner resizes, growth past left/top; sliding, stopping, snapping,
  typed places), `e2e/arrange.spec.ts` (switching by button and keys, snapping and
  stopping, arrow keys, `Entf` ignored, growing past the left edge, typed place, PDF with
  each word where its Region now is, SVG, Tiled Export with an empty Sheet A1, leaving
  "Anordnen" with one Region).

## Built: new Regions where they lie on the Plan, reordering the list (2026-11-25, #44)

Feedback on #37: a Plan's header drawn as Region 2 went below the body and had to be
dragged around it in "Anordnen".

- **Placing a new Region** (`placeNew`): the existing Region closest to it on the Plan
  (smallest gap between the rectangles; the first one on a tie) is its reference. On
  each axis where the new Region lies wholly before or after the reference on the Plan,
  it is put touching the reference on that side in the Layout; where they overlap on the
  Plan, it keeps its offset from the reference. So a header above the body goes above
  it, a footnote to its right goes to its right, and one lying off both edges touches
  the reference at that corner. If that place is taken, the new Region moves on along
  the axis with the larger Plan gap, away from the reference, until it is free. The
  existing Layout stays; the Clip grows up or left if needed (the Layout is normalised
  as the Region is drawn). A new Region overlapping its reference on the Plan has no
  side and goes beside the Layout as before (#36). Considered and rejected: compacting
  the whole Layout from the Plan positions on every new Region (it would undo the
  user's arrangement).
- **Reordering** (`reorderRegion`): drag "Bereich n" in the list with the left button;
  the item moves among the others as the pointer passes their middles (also across
  wrapped rows), and on release the Regions are renumbered and the dragged one is
  selected. Only the numbering changes, never the Plan rectangles or the Layout. A click
  without moving (under 5 px) still selects; a drag ending where it started changes
  nothing. Listeners sit on the window, as the item is moved in the DOM while dragged.
- Tests: `src/export/regions.test.ts` (above, below, left, right, the closest Region
  wherever it sits in the Layout, corner, moving on past a taken place, the fallback;
  reordering), `e2e/arrange.spec.ts` (a header drawn second goes above the body in
  "Anordnen", dragging "Bereich 2" before "Bereich 1", a click still selects, a drag back
  to the start changes nothing).

## Built: Clip presets and stretching (2026-11-25, #38)

See ADR 0015 (Clip presets) and ADR 0007 (stretching, the note). The list in step 2 is
now updated in place while the number of Regions stays the same: rebuilding it swallowed
a click on "Bereich n" made right after typing in a field (the field's "change" on
blur showed the Regions again between mousedown and click).
