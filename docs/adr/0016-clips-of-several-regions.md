# 16. Clips of several freely arranged Regions

Status: accepted (2026-11-24, issue #6, decided in #14); supersedes ADR 0002. Not built
yet: #35, #36, #37, #38.

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
