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
Writing the Clip to a file. Always vector (PDF and SVG). No raster output. The
exported page is exactly the Clip at 1:1. Content outside the Clip is actually
removed, not just hidden.

**Test Plan**
A generated stand-in for a real schedule (1188 × 7660 mm, an early size estimate; dense vector lines, bars and
small text, ~3 MB). Used for development and performance tests. Never committed.

## Why

Our online whiteboard tool shows imported PDFs pixelated. The team discusses the
schedule in the whiteboard tool, so the main job is: cut the relevant part out of the Plan
and get it into the whiteboard tool **sharp**, as SVG. PDF export is secondary.

## Users

The author plus a few non-technical colleagues. The UI must work without explanation:
open → select → export. No accounts, no server.
