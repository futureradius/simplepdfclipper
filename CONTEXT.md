# simplepdfclipper: Context

A simple, offline, in-browser tool that opens one very large vector PDF (a construction
schedule) and exports a precisely chosen rectangular part of it as
vector PDF and SVG.

## Glossary

**Document**
The PDF file the user opens. Usually a single page; if it has more, the user picks one in
the page picker (ADR 0014).

**Plan**
The page of the Document being worked on: usually vector graphics + text, ~3 MB or more.
Scanned Plans (the page is an image) work too. Everything else (Clip, Export, Tiles,
Snap targets) refers to this one page; an export never spans pages.
_Avoid_: page picker results called "document"; the Document is the file, the Plan its page
The reference case is a rail construction schedule: 1188.9 mm wide × 14270.9 mm tall, just over 3 MB, opens in ~2.4 s.

**UserUnit**
A PDF page-level scale factor. PDF limits pages to 14,400 units per side (200 in /
5,080 mm at the default 1/72 in per unit). The schedule sets `/UserUnit` (2.8092 for the
reference Plan) so that the long side is exactly 14,400 units. All sizes in the UI and
in exports are real millimetres with UserUnit applied. Programs that ignore UserUnit
show such Plans 2.8× too small.

**Clip**
What is exported: one or more Regions of the Plan, put together. Everything inside a
Region is kept; everything else is dropped. There is exactly one Clip per export. A Clip
with one Region is a plain rectangle cut out of the Plan.

**Region**
One axis-aligned rectangle the user selects on the Plan, part of a Clip. UI: "Bereich".
Regions are numbered in list order, which the user can change by dragging; the number
has no effect on the Plan or the Layout.
_Avoid_: box, clipping-box, piece

**Layout**
Where each Region sits in the Clip. Regions keep their size (1:1) and are only moved,
never scaled or rotated; they never overlap, and the space between them stays empty.
A new Region goes where it lies on the Plan, next to the Region closest to it there; the
user may rearrange them freely in the "Anordnen" view, and "Neu anordnen" suggests a
compact Layout.
Resizing a Region on the Plan moves its edges the same way in the Layout; Regions
touching that edge move along, others in the way are pushed. UI: "Anordnung".
_Avoid_: montage, composition

**Clip preset**
A named, saved set of Regions with their Layout, kept in the browser and shareable as a
file. On a Plan of another size it is stretched to fit. UI: "Ausschnitt-Vorlage".
_Avoid_: Preset (that is export settings only)

**Snap**
While dragging a Region edge, the edge jumps to a nearby **Snap target**. Can be turned
on and off at any time.

**Snap target**
A horizontal or vertical line or text edge already in the Plan (grid lines, row
borders, date column boundaries) that a Region edge can snap to.

**Export**
Writing the Clip to a file. Never rasterised: vectors and text stay vectors and text,
images in the Plan are kept as images, cut to the Clip. Always 1:1. Either one page
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

**Preset**
A named copy of all export settings in step 3: Tiled Export setup and SVG options,
never the Clip. Only the user's own, kept in the browser, shareable as a JSON file.
"Standard" (the factory settings) is not a Preset (ADR 0015). UI: "Vorlage".
_Avoid_: profile, template (in code and docs)

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
