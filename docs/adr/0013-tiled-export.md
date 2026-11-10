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
Clip into a grid of Tiles, each printed 1:1 on its own Sheet. PDF only; the SVG
button is disabled while it is switched on, with a note and tooltip saying why.

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
  cancel.
- **Preview:** the Tile grid with Tile names is drawn over the Clip in the precision
  view and the overview.
- **Remembered** like the Clip (ADR 0007): on/off, mode, format, orientation, both
  axes' leading field and value, Margin, output mode. Named presets: issue #5.

## Implementation (2026-11-10)

- `src/export/tilegrid.ts`: the Tile grid (pure geometry, unit-tested).
  `src/export/tiledpdf.ts`: two stages, so the big Plan is redacted only once: the
  Clip is exported as usual, then every Tile is cut out of that Clip PDF with the same
  `exportPdf` (removal per Tile), placed on its Sheet. One engine call per Tile, so the
  UI shows progress and can cancel. Test Plan, Clip 1188.9 × 600 mm on A4: 21 Tiles in
  2.3 s, 0.34 MB in total.
- On a Sheet the Tile content is clipped to the Tile (`re W n`): lines kept whole across
  the edge (ADR 0005) would otherwise show in the Margin.
- Cut marks: 0.1 pt black lines, 1 mm away from each Tile corner, up to 5 mm long; need
  a Margin of at least 2 mm. Tile label: 7 pt grey base-14 Helvetica (not embedded,
  WinAnsi), needs at least 4 mm. A Tile too narrow for the full label gets just its name.
- Multipage: each Tile PDF is grafted into one document.
- Edge on `file://` is a secure context and offers `showDirectoryPicker` (checked in the
  e2e test), so single files go straight into a folder. The ZIP fallback is a small
  stored (uncompressed) writer in `src/ui/zip.ts`. Dialogs are opened before the export
  starts, as they need the click that started it.
