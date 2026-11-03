# 3. Precision tools and vector-only export

Status: accepted (2026-11-03)

## Decision

Precision comes from three tools:

1. Deep zoom (several hundred percent) with smooth panning.
2. **Snap** of Clip edges to **Snap targets** in the Plan, with an on/off toggle.
3. Numeric entry of Clip edges as a fallback.

Details:

- Snap radius is 8 screen pixels, so it feels the same at every zoom level.
- Snap can be toggled in the UI; holding **Alt** while dragging disables it temporarily.
- The Clip has drag handles on all edges and corners, plus four number fields
  (Links, Oben, Breite, Höhe) in mm.

Export is vector only, to PDF and SVG. No raster export.

## Consequences

- Snapping needs the Plan's vector geometry (lines, text boxes), not just a rendered
  bitmap, so the PDF engine must expose content-level geometry.
- The export must keep vectors and text, not rasterize the Clip.
