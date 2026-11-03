# 6. Export page size, units, SVG text

Status: accepted (2026-11-03)

## Decision

- **Page size:** the exported page is exactly the Clip at 1:1 scale. No fitting to
  paper sizes (the PDF viewer can scale when printing).
- **Units:** the UI shows and accepts millimetres with 0.1 mm resolution. Origin is the
  top-left corner of the Plan.
- **File names:** `<original name>_Ausschnitt.pdf` and `<original name>_Ausschnitt.svg`.
- **SVG text:** real `<text>` by default. On import the app lists the Plan's fonts
  and proposes a substitute for each (closest-named common Windows font, else Arial);
  the user can change it. Each text gets
  `font-family="<original>, <substitute>, Arial, sans-serif"` and its original width
  via `textLength`, so substitutes keep the layout. Small visual differences between
  participants' machines are acceptable (all project members use Windows).
- **"Text als Pfade" checkbox** on export: text as outlines instead, as a fallback.
  File size and element count of both variants will be measured on the Test Plan and
  recorded here.

## Consequences

With real text, SVG appearance depends on fonts where the SVG is displayed.
