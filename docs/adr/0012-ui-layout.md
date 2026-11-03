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
- **Start view:** the Plan's full width, scrolled to the Clip. (Bug fixed: the view
  measured itself while still hidden, so the first fit used a 1 px width.)
- **Keyboard:** `+`/`-` zoom, `0` Plan width, `1` real size, `F` show the Clip, arrow
  keys move the Clip by 0.1 mm (Shift: 1 mm). Ignored while typing in a field.
- **About dialog:** version, source code link, licence (AGPL-3.0) and credits
  (MuPDF / Artifex), as the AGPL asks recipients to be pointed to the source.
- **Size warnings** refer to whiteboard tools in general (2 MB recommended, 45 MB
  limit).
- **No font substitution dialog** (ADR 0006): the Plans in use only contain Arial,
  which is handled automatically. To be added if other fonts appear.
