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

## Implementation (2026-11-03)

**Layout:** settings panel (left), precision view (centre), overview as navigator
(right, shows the Clip in red and the visible area in blue; click to jump, drag to
draw/move/resize the Clip).

**Precision view (`src/ui/viewer.ts`):** canvas, wheel zooms around the cursor
(2 %–1,700 %, 100 % = real size at 96 dpi), dragging pans; dragging Clip edges or
corners resizes. Inside the Clip dragging also pans, so the view can always be moved
even when zoomed into the Clip.

**Rendering like a map:** MuPDF.js has no scissor-rect rendering, so drawing any part
of the Plan walks all ~820k objects of the Test Plan (~220 ms, independent of size).
Therefore the view is not tiled; instead:

- at open, the page is converted once to a MuPDF display list (0.7 s; 3× faster to
  draw than the PDF content),
- while zooming/panning, existing images are scaled: the overview as base layer
  plus the last few sharp renders,
- 120 ms after the view rests, the visible area plus a 25 % margin is rendered sharp
  in one pass (~300 ms for 2400 × 1500 px), capped at 16 Mpx.

**Snap targets (`src/engine/snaptargets.ts`, `src/ui/snap.ts`):** after opening, one
pass over the display list (~1.5–2 s) collects axis-parallel segments of all paths
(≥ 0.5 mm) and the boxes of text spans, in mm. Segments on the same position are
merged (2,800 row-wise pieces of one grid line → one line), giving ~10k lines on the
Test Plan; these are sent to the UI as typed arrays and queried by binary search
while dragging. Only lines whose extent overlaps the visible part of the moving edge
count. **Lines win over text edges**: text boxes are estimated from font metrics, so
they are used only when no line is within reach (otherwise a row border snapped to
the top of the text above it). A snapped edge shows a dashed blue guide.

## Consequences

- Snapping needs the Plan's vector geometry (lines, text boxes), not just a rendered
  bitmap, so the PDF engine must expose content-level geometry.
- The export must keep vectors and text, not rasterize the Clip.
