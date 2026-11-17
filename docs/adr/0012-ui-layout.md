# 12. Interface layout and interaction

Status: accepted (2026-11-03)

## Decision

- **Look:** light, neutral greys, one accent colour (blue) for primary actions and
  the Clip; amber for snap guides. No dark mode. Name shown as "simple pdf clipper".
- **Start screen:** before a Plan is open, a drop zone ("Plan hierher ziehen") with a
  button to choose a file. PDFs can be dropped anywhere on the window, also later
  to switch Plans.
- **Workspace:** panel with three steps (1 Plan, 2 Ausschnitt, 3 Export), the
  precision view in the middle with a floating toolbar (zoom, Planbreite,
  Ausschnitt, 1:1), the overview on the right. Technical options (text as paths,
  merge mode, Plan details) are under "Erweitert"; size warnings stay visible.
- **Start view:** the Plan's full width, scrolled to the Clip. *(Now the whole Plan, see below.)* (Bug fixed: the view
  measured itself while still hidden, so the first fit used a 1 px width.)
- **Keyboard:** `+`/`-` zoom, `0` Plan width, `1` real size *(now `1`/`2`/`3`, see below)*, `F` show the Clip, arrow
  keys move the Clip by 0.1 mm (Shift: 1 mm). Ignored while typing in a field.
- **About dialog:** version, source code link, licence (AGPL-3.0) and credits
  (MuPDF / Artifex), as the AGPL asks recipients to be pointed to the source.
- **Size warnings** refer to whiteboard tools in general (2 MB recommended, 45 MB
  limit).
- **No font substitution dialog** (ADR 0006): the Plans in use only contain Arial,
  which is handled automatically. To be added if other fonts appear.

## Minimap and whole-Plan start view (2026-11-17, issue #4)

First-time users read the overview column as a control and found the start view
(full Plan width, scrolled to the Clip) too deep into the details.

- **Minimap instead of the overview column:** the whole Plan, floating over the
  bottom-right corner of the precision view, with a shadow; at most 1/3 of the view's
  height and at most 1/3 of its width. The precision view gets the freed column.
  The visible area is a red frame, the Clip a blue box, the Tile grid thin lines
  without names. Click centres the view there, dragging pans continuously. No Clip
  editing in the minimap any more (at ~25 px wide for the reference Plan, handles
  would be unusable); the Clip is edited in the precision view or the fields.
- **Collapse:** a × button shrinks it to a round button in the same corner. Not
  remembered: every Plan opens with the minimap expanded.
- **Hidden while the whole Plan is in view** (it would only repeat the picture);
  back as soon as the view is zoomed or moved so part of the Plan is outside.
- **Start view: the whole Plan** (all of the page), centred, with the Clip
  highlighted. Users start with the overview, not "in the thick of it".
- **Toolbar and keys:** "Ganzer Plan" `1`, "Planbreite" `2`, "1:1" `3`, then
  "Ausschnitt" `F`. (Before: `0` Planbreite, `1` 1:1.) The hint in step 2 lists them.
- Code: `src/ui/minimap.ts` (size and visibility rules unit-tested), e2e in
  `e2e/single-file.spec.ts`.
