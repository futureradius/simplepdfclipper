# simplepdfclipper: Context

A simple, offline, in-browser tool that opens one very large vector PDF (a construction
schedule) and exports a precisely chosen rectangular part of it as
vector PDF and SVG.

## Glossary

**Plan**
The input PDF. A single page, vector graphics + text only (not scanned), ~3 MB or more.
The reference case is a rail construction schedule, about 1188 mm wide × 7660 mm tall.

**Clip**
The one axis-aligned rectangle the user selects on the Plan. Everything inside is kept;
everything outside is dropped. There is exactly one Clip per export.

**Snap**
While dragging a Clip edge, the edge jumps to a nearby **Snap target**. Can be turned
on and off at any time.

**Snap target**
A horizontal or vertical line or text edge already in the Plan (grid lines, row
borders, date column boundaries) that a Clip edge can snap to.

**Export**
Writing the Clip to a file. Always vector (PDF and SVG). No raster output.

## Users

The author plus a few non-technical colleagues. The UI must work without explanation:
open → select → export. No accounts, no server.
