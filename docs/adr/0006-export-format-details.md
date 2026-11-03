# 6. Export page size, units, SVG text

Status: accepted (2026-11-03)

## Decision

- **Page size:** the exported page is exactly the Clip at 1:1 scale. No fitting to
  paper sizes (the PDF viewer can scale when printing).
- **Units:** the UI shows and accepts millimetres with 0.1 mm resolution. Origin is the
  top-left corner of the Plan.
- **File names:** `<original name>_Ausschnitt.pdf` and `<original name>_Ausschnitt.svg`.
- **SVG text (provisional, under review):** text stays real `<text>`, not outlines.
  On import the app lists the Plan's fonts and proposes a substitute for each
  (closest-named common Windows font, else Arial); the user can change it. Each text
  gets `font-family="<original>, <substitute>, Arial, sans-serif"` and its original
  width via `textLength`, so substitutes keep the layout.

  Under review because the SVG's real destination is the whiteboard tool (see `CONTEXT.md`): fonts
  resolve on every meeting participant's machine, and nobody edits text inside the whiteboard tool.
  To be settled by the whiteboard tool spike.

## Consequences

With real text, SVG appearance depends on fonts where the SVG is displayed.
