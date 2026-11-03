# 6. Export page size, units, SVG text

Status: accepted (2026-11-03)

## Decision

- **Page size:** the exported page is exactly the Clip at 1:1 scale. No fitting to
  paper sizes (the PDF viewer can scale when printing).
- **Units:** the UI shows and accepts millimetres with 0.1 mm resolution. Origin is the
  top-left corner of the Plan.
- **SVG text:** text stays real, editable `<text>`, not outlines. If a Plan font is not
  available, use the closest-named installed font, otherwise Arial. How the user
  confirms font substitution is still open.

## Consequences

SVG appearance depends on fonts where the SVG is opened; layout can shift if a
substitute font has different widths.
