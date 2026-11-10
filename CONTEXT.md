# simplepdfclipper: Context

A simple, offline, in-browser tool that opens one very large vector PDF (a construction
schedule) and exports a precisely chosen rectangular part of it as
vector PDF and SVG.

## Glossary

**Plan**
The input PDF. A single page, vector graphics + text only (not scanned), ~3 MB or more.
The reference case is a rail construction schedule: 1188.9 mm wide × 14270.9 mm tall, just over 3 MB, opens in ~2.4 s.

**UserUnit**
A PDF page-level scale factor. PDF limits pages to 14,400 units per side (200 in /
5,080 mm at the default 1/72 in per unit). The schedule sets `/UserUnit` (2.8092 for the
reference Plan) so that the long side is exactly 14,400 units. All sizes in the UI and
in exports are real millimetres with UserUnit applied. Programs that ignore UserUnit
show such Plans 2.8× too small.

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
Writing the Clip to a file. Always vector, never raster. Always 1:1. Either one page
that is exactly the Clip (PDF and SVG), or a **Tiled Export** (PDF only). Content outside
the Clip (or outside the Tile) is actually removed, not just hidden.

### Tiled Export

**Tiled Export**
An Export that cuts the Clip into a grid of Tiles, one per Sheet, to be printed and
assembled into the full Clip. PDF only.
_Avoid_: split pages, poster print, spreads

**Tile**
One rectangular piece of the Clip, printed at 1:1 on one Sheet. Neighbouring Tiles
meet exactly, without repeating any content. Named by grid position: row letter,
column number (A1, A2, … B1).
_Avoid_: spread, page (a page is the PDF's unit, a Tile is a piece of the Clip)

**Sheet**
The paper one Tile is printed on: the Tile plus the Margin around it.
_Avoid_: spread, page

**Tile grid**
How the Clip is divided into columns and rows of Tiles. Set either by **Paper format**
(every Sheet has that format; the last row and column may be only partly filled) or
freely, each axis on its own: by **count** (equal shares of the Clip) or by **length**
(every Tile that long, the last one shorter, its Sheet shrunk to fit).

**Margin**
The white border around the Tile on each Sheet. It holds no Plan content, only the
Tile label. Cutting it off makes neighbouring Tiles fit together exactly.
_Avoid_: edge, overlap (no content is repeated between Tiles)

**Tile label**
A small note in the Margin naming the Tile (e.g. "B3") and its source.

**Test Plan**
A generated stand-in for a real schedule (1188.9 × 14270.9 mm with UserUnit like the real one; dense vector lines, bars and
small text, ~4 MB). `npm run testplan`. Used for development, measurements and tests. Never committed.

## Why

Our online whiteboard tool shows imported PDFs pixelated. The team discusses the
schedule in the whiteboard tool, so the main job is: cut the relevant part out of the Plan
and get it into the whiteboard tool **sharp**, as SVG. PDF export is secondary.

## Users

The author plus a few non-technical colleagues. The UI must work without explanation:
open → select → export. No accounts, no server.
