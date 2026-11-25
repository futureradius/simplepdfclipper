# 13. Tiled Export

Status: accepted (2026-11-10)

## Context

Large Clips (up to the full 1.2 × 14.3 m schedule) need to go on paper: on an
office printer as many A4 Sheets, or on a plotter as a few long strips, then cut and
assembled. ADR 0006 said the exported page is always exactly the Clip and the PDF
viewer scales when printing; ADR 0009 said nothing is added to the page. Neither works
for printing a Clip at real size across many Sheets.

## Decision

A **Tiled Export** (glossary: Tile, Sheet, Tile grid, Margin, Tile label) cuts the
Clip into a grid of Tiles, each printed 1:1 on its own Sheet. ~~PDF only; the SVG
button is disabled while it is switched on, with a note and tooltip saying why.~~
Amended 2026-11-25 (#46): also as SVG, see *SVG Tiles* below.

- **Always 1:1, never scaled.** Only the size of the pieces changes, never the Plan's scale.
- **Tile grid**, two ways:
  - *Paper format*: A4–A0 or custom W × H, orientation portrait / landscape /
    automatic (fewer Sheets; portrait on a tie). Tile = format − 2 × Margin. Grid
    anchored at the Clip's top-left; last row/column partly filled, Sheet keeps the
    full format.
  - *Free*, per axis, as two linked fields (count ⇄ length). The field edited last
    leads and is kept when the Clip changes; the other is calculated. Count →
    equal Tiles. Length (of the Tile, not the Sheet) → last Tile shorter and its
    Sheet shrunk to fit. Defaults 1 × 1. This covers "3 columns, rows of 3 m each".
- **Margin, no overlap.** One Margin on all four sides (default 10 mm, 0 allowed).
  Neighbouring Tiles meet exactly; cutting off the Margins makes them fit. Overlap
  (content repeated on both neighbours) was considered and rejected: not needed for
  plotted-and-cut Sheets, and it complicates assembly.
- **On the page (amends ADR 0009):** only inside the Margin: corner cut marks at the
  Tile corners and a small grey Tile label
  (`B3 · Zeile B von E, Spalte 3 von 3 · <Plan> · <Datum>`). Both omitted when the
  Margin is too narrow. Never on top of Plan content.
- **Page size (amends ADR 0006):** a page is a Sheet, not the Clip. The UserUnit rule
  still applies to Sheets longer than 5,080 mm.
- **Removal per Tile (ADR 0005):** each Tile is redacted to its own area, in both
  output modes, so any single Tile file can be handed out on its own.
- **Naming:** row letters (A … Z, AA, AB …), column numbers: `A1, A2, … B1`.
  Empty Tiles are exported too, so the grid has no gaps.
- **Output:** chosen per export:
  - single-page files `<Plan>_Ausschnitt_Kachel_B3.pdf`, written into a folder
    chosen with the folder picker; fallback: one ZIP download;
  - one multipage file `<Plan>_Ausschnitt_Kacheln.pdf`, pages row by row.
- **Limits:** a remainder under 0.1 mm is no Tile of its own; it joins the last Tile (nothing is lost); Tiles at least 10 mm; above 100
  Sheets an amber warning, never a refusal. Progress ("Kachel 12 von 70") with
  cancel, in the busy window (ADR 0012).
- **Preview:** the Tile grid with Tile names is drawn over the Clip in the precision
  view; the minimap (ADR 0012) shows the cut lines only, without names.
- **Remembered** like the Clip (ADR 0007): on/off, mode, format, orientation, both
  axes' leading field and value, Margin, output mode. Named Presets: ADR 0015.

## SVG Tiles (amendment, 2026-11-25, #46)

A huge Clip is too big for one SVG in the whiteboard tool (ADR 0009: < 2 MB recommended,
> 45 MB rejected), and the SVG export can now cut paths, text and images cleanly at any
rectangle edge (ADR 0005, #15, #35). So the Tiled Export also writes SVG:

- **Both buttons export Tiles** while "In Kacheln aufteilen" is on: "SVG-Kacheln
  exportieren" and "PDF-Kacheln exportieren". The format is the button, not a setting.
- **Bare Tile:** an SVG Tile is exactly the Tile, at 1:1: no Margin, cut marks or Tile
  label, as it goes into the whiteboard, not onto paper. The SVG Tiles are the grid the
  preview shows, the same Tiles as the PDF. In *Paper format* the Margin therefore
  still sets the Tile size (A4 with 10 mm: 190 × 277 mm), and a hint under the Margin
  says so: Margin 0 gives full-format Tiles. Considered and rejected: drawing the Margin
  in SVG too (by default every SVG Tile would get a white border and leave gaps in the
  whiteboard), and a separate Margin per format (the format is only known from the
  button clicked, so it would need a new format choice in step 3).
- **Output:** "Einzelne Dateien" writes `<Plan>_Ausschnitt_Kachel_B3.svg` into a folder
  (ZIP download as the fallback); "Eine Datei (PDF mehrseitig, SVG als ZIP)" writes one
  uncompressed `<Plan>_Ausschnitt_Kacheln.zip` through the "Save as" dialog (the
  whiteboard needs the SVGs unpacked anyway).
- **Empty Tiles are skipped** (nothing of the Plan left in them after cutting; the white
  background does not count). The names keep each Tile's place in the grid; the done
  note counts the skipped ones.
- **Reassembly:** the whiteboard tool keeps an imported SVG's real size and snaps, so
  exact edges and the Tile names in the file names are enough: no outline, no position
  note in the file.
- **Size warning per Tile** (ADR 0009): the done note shows the total and the largest
  Tile (size, elements), amber above 2 MB and red above 45 MB. Never refuses. Splitting
  by what the whiteboard can take ("at most N MB per SVG") instead of by mm is a
  separate issue (#49).
- **Settings:** the SVG options (text as paths, merging) and Presets (ADR 0015) apply
  unchanged. Tiles that cross Regions of a stitched Clip (ADR 0016) are one seamless
  picture, as in the plain SVG export.
- **UI wording:** "In Kacheln aufteilen" (was "Auf Blätter aufteilen (Kacheln)"); the
  summary counts "Kacheln".

Implementation: `tileRegions` (`src/export/index.ts`) turns a Tile into the Regions that
fall inside it, cut to it and placed in it, so a Tile is exported like a stitched Clip;
`exportSvgTiles` collects a batch of Tiles in one shared pass (`collectAll`). A pass
costs about the same however many Tiles it serves (Test Plan: ~2.5 s for a 2 m Clip,
~4.5 s for the whole 14 m Plan, plus ~0.03 s per Tile), so the UI sends batches of 100
Tiles: 294 A4 Tiles of the whole Plan take 20.6 s (18.8 s in one call, 34.5 s in calls
of 50), with progress and "Abbrechen" between calls. Two fixes made this possible:

- The shared pass computes a drawing call's bounds once and hands it only to the
  collectors it can reach; before, each collector asked MuPDF for the bounds itself
  (42 Tiles in one pass: 13.4 s → 4.0 s).
- MuPDF.js wraps each Path, Text, StrokeState and ColorSpace it hands a JS device in
  an object that holds a reference until the garbage collector finalises it, which
  hardly happens. Every SVG export left ~300 MB of WASM memory behind on the Test
  Plan, and about 40 passes ran out of memory. The collector now releases them when the
  callback returns: memory stays flat, and a plain SVG export is about a third faster.

## Implementation (2026-11-10)

- `src/export/tilegrid.ts`: the Tile grid (pure geometry, unit-tested).
  `src/export/tiledpdf.ts`: two stages, so the big Plan is redacted only once: the
  Clip is exported as usual, then every Tile is cut out of that Clip PDF with the same
  `exportPdf` (removal per Tile), placed on its Sheet. One engine call per Tile, so the
  UI shows progress and can cancel. Test Plan, Clip 1188.9 × 600 mm on A4: 21 Tiles in
  2.3 s, 0.34 MB in total.
- On a Sheet the Tile content is clipped to the Tile (`re W n`). Paths are cut at the
  Tile edge (ADR 0005, #35), but line widths, caps and glyphs kept whole at the edge
  would otherwise reach into the Margin.
- Cut marks: 0.1 pt black lines, 1 mm away from each Tile corner, up to 5 mm long; need
  a Margin of at least 2 mm. Tile label: 7 pt grey base-14 Helvetica (not embedded,
  WinAnsi), needs at least 4 mm. A Tile too narrow for the full label gets just its name.
- Multipage: each Tile PDF is grafted into one document.
- Edge on `file://` is a secure context and offers `showDirectoryPicker` (checked in the
  e2e test), so single files go straight into a folder. The ZIP fallback is a small
  stored (uncompressed) writer in `src/ui/zip.ts`. Dialogs are opened before the export
  starts, as they need the click that started it.
