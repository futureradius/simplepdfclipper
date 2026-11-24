# 12. Interface layout and interaction

Status: accepted (2026-11-03)

## Decision

- **Look:** light, neutral greys, one accent colour (blue) for primary actions and
  the Clip; amber for snap guides. No dark mode. Name shown as "simple pdf clipper".
- **Start screen:** before a Plan is open, a drop zone ("Plan hierher ziehen") with a
  button to choose a file. PDFs can be dropped anywhere on the window, also later
  to switch Plans. Above the drop zone, a short intro for first-time users says what the
  tool does (SVG, PDF, Tiled Export); below it, a note says the Plan stays on this
  computer, is not uploaded, and the tool works offline (added 2026-11-24).
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
  "Ausschnitt" `F`. (Before: `0` Planbreite, `1` 1:1.) All shortcuts are listed in the
  About dialog under "Tastenkürzel", not in step 2 (too cluttered there).
- Code: `src/ui/minimap.ts` (size and visibility rules unit-tested), e2e in
  `e2e/single-file.spec.ts`.

## Busy window (2026-11-17, issue #26)

While a Document opened or an export ran, the only sign was a short line of text, so
it was not obvious that the app had accepted the command and was working.

- **A centred window over a dimmed app** for the jobs that block: loading the PDF
  engine, opening a Plan or a page, SVG export, PDF export and the Tiled Export. It is
  1/5 of the window width (at least 260 px), with a big spinner, what is happening
  ("SVG wird berechnet…", "Kachel 3 von 12 (B2)…", "Wird gespeichert…"), for the
  Tiled Export a progress bar, and the elapsed time ("0:07", counted from the
  command's start). A modal window rather than a spinner next to the status text:
  it is seen at once and says plainly that the tool cannot be used right now. Clicks,
  keys and dropped PDFs are blocked until the job ends.
- **"Abbrechen" only where the work really stops:** the Tiled Export, between Tiles
  (`Esc` too; not while saving). The engine cannot interrupt a running call, and
  restarting the worker and reloading the Plan would take about as long as the 2-5 s
  SVG/PDF export or Plan opening it would cut short; a button that only hid the
  window would leave the engine busy, so panning would stall. Those windows have no
  button.
- **Timing:** the app is blocked from the first moment (the modal dialog is open but
  transparent); the window fades in (150 ms) only if the job still runs after
  400 ms, so fast jobs don't flash it; once visible it stays at least 500 ms, then
  fades out. The pressed export button shows a small spinner with the same delay.
  The window closes before a "Save as" dialog opens.
- **Small inline spinners, no window,** where the tool stays usable: "Einrasten wird
  vorbereitet…" (only snapping waits) and page-picker thumbnails not drawn yet.
- In-progress texts live in the window only; the status lines show results and
  errors. No `progress` cursor.
- CSS animations only; `prefers-reduced-motion` pulses instead of rotating. With the
  main-thread engine (ADR 0010 fallback) the delay timer could not fire, so the window
  shows at once and one frame is awaited before the work starts; it cannot turn
  there, but it is visible.
- Code: `src/ui/busy.ts` (timing unit-tested), e2e in `e2e/busy.spec.ts` (tests set
  `window.__busyDelayMs = 0`) and the cancel steps in `e2e/tiled-export.spec.ts`.

## Mouse scheme for Regions (decided 2026-11-24, #14; built in #36, "Anordnen" in #37)

With several Regions (ADR 0016) the left button is needed for creating them, so:

- **Left button always selects and edits:** a drag on empty Plan creates a new Region
  and selects it; a click (< 4 px) on empty Plan deselects; a click on a Region selects
  it; dragging its edges resizes; dragging inside moves it (on the Plan in "Bereiche
  wählen", in the Clip in "Anordnen"). Before, dragging inside the Clip panned.
- **Right drag, middle drag and Space + left drag pan** (Space for touchpads); the
  browser's context menu is blocked in the view. The wheel still zooms.
- **Keys:** `B` "Bereiche wählen", `A` "Anordnen", `Entf` removes the selected Region
  (only in "Bereiche wählen"); arrow keys move the selected Region. Listed in the About
  dialog. No undo/redo.

Built in #36 (`src/ui/viewer.ts`, `regionAt` in `src/ui/clipdrag.ts`): a press moving
less than 4 px is a click. A left press grabs the selected Region's edges, corners or
inside first, then the inside of another Region (the one drawn on top); only the
selected Region has handles. A click outside the Plan counts as empty Plan. Cursors:
crosshair on empty Plan, move inside a Region, resize arrows on edges, grab while Space
is held. Space is kept from focused buttons (a held Space would press them again); in
text fields it types as usual. Everything outside all Regions is dimmed; with several
Regions each carries its number. `B`/`A` come with the "Anordnen" view (#37).
