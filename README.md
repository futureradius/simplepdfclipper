# simplepdfclipper

Cut a precise rectangle out of a huge vector PDF (e.g. construction schedule)
and export it as a **SVG** and as a **PDF** in which everything outside the clip
is actually removed, not just hidden.

Runs fully local: the whole app is a single HTML file you open in Microsoft Edge by
double-click. No server, no upload, no installation.

> Status: early development. See [`CONTEXT.md`](CONTEXT.md) for the domain and
> [`docs/adr/`](docs/adr/) for the design decisions.

## Using it

1. Get `simplepdfclipper.html` (built as `dist/index.html`).
2. Double-click it; it opens in Edge.
3. Open your Plan. If the PDF has several pages, pick one in the page picker; switch
   pages later with ◀ ▶ in step 1 (ADR 0014). Exports then carry the page in their
   name (`Plan_S3_Ausschnitt.svg`) and contain only that page.
4. Set the Clip: one or more Regions ("Bereich") of the Plan. Drag with the left
   button on empty Plan to draw a new Region; click a Region to select it, drag its edges
   to resize (they snap to lines; hold Alt to place freely; an edge stops at the Plan
   edge) or inside it to move it, or type the mm values of the selected Region. `Entf`
   or × removes it. Pan with the right or middle button, or Space + left drag. The view
   starts with the whole Plan; the minimap in the bottom-right corner moves the view
   (keys: `1` whole Plan, `2` Plan width, `3` 1:1, `F` selected Region).
   A new Region is put in the Clip where it lies on the Plan, next to the Region closest
   to it (a header drawn later still goes on top). Drag "Bereich n" in the list to
   renumber the Regions.
   With two or more Regions, "Anordnen" (`A`; back with `B`) shows the Clip as it will
   be exported: drag a Region to place it (it snaps to the others' edges and stops at
   them; dragging past the left or top edge grows the Clip), or type its place.
   Resizing a Region on the Plan keeps touching Regions touching. "Neu anordnen" lays
   them out again as compactly as possible (ADR 0016).
5. Export as SVG (for the whiteboard tool) or as PDF (for documentation; everything outside the
   Regions is removed from the file). Several Regions are exported together as one page,
   as arranged. The "Save as" dialog opens first, then the export is computed.
6. To print a large Clip at real size, switch on "Auf Blätter aufteilen": the Clip is cut
   into Tiles by paper format (A4–A0 or custom) or freely (columns/rows by count or by
   length), each on its own Sheet with a Margin, cut marks and a label. Saved as numbered
   single PDFs into a folder, or as one multipage PDF (ADR 0013).
7. Setups you use often can be saved as named Presets ("Vorlage" in step 3, ✎ to
   save, rename, delete, and to export or import them as a JSON file for colleagues).
   Picking one sets all export settings at once; the Clip stays (ADR 0015).
8. Regions you use on every version of a Plan can be saved as Clip presets ("Vorlage" in
   step 2, ✎ for the same actions). The last Clip is restored when a Plan is opened.
   On a Plan of another size both are stretched to fit, and a yellow note says by how
   much: check the Regions then (ADR 0007, 0015).

Scanned Plans (pages that are images) work too: the PDF, every Tile and the SVG embed
only the part of the image inside the Clip, so a small Clip of a scan is a small file
(ADR 0005).

Lines and shapes that cross the Clip edge are cut exactly there in every export: nothing
of them stays in the file outside the Clip, not even invisibly. A cut line ends flat at
the edge; dashes continue as before. Text at the edge keeps a letter whole if its centre
is inside, otherwise the letter is removed (ADR 0005).

## Roadmap

- [x] Optimised SVG export (merging, real text, hatching, clip shapes)
- [x] Precision view with zoom and snapping
- [x] PDF export with real removal outside the Clip (ADR 0005)
- [ ] ~~Font substitution dialog~~ (not needed so far, ADR 0012)
- [x] UI overhaul (ADR 0012)
- [x] Tiled Export for printing at real size (ADR 0013)
- [x] Scanned Plans: images cropped to the Clip in the SVG too (#2)
- [x] Rotated pages (`/Rotate`), exported upright (#16)
- [x] Minimap and whole-Plan start view (#4)
- [x] Multi-page PDFs: page picker, one page per export (#1)
- [x] Named presets for export settings (#5)
- [x] Scanned Plans: images cropped to the Clip in the PDF too (#22)
- [x] Lines and shapes cut exactly at the Clip edge in every export (#35)
- [x] Clips of several Regions, chosen on the Plan, exported as one page (#36)
- [x] Arranging Regions freely in an "Anordnen" view (#37)
- [x] Clip presets, stretched to Plans of another size (#38)

## Development

Requires Node.js 22+ and Microsoft Edge (used by the end-to-end tests).
Run the commands one at a time (Windows PowerShell 5.1 does not support `&&`;
use `;` to chain them).

```sh
npm install
npm run testplan   # generate samples/test-plan.pdf (synthetic 1188.9 x 14270.9 mm schedule)
npm run dev        # dev server
npm run build      # type-check + build dist/index.html (single self-contained file)
npm test           # unit tests (Vitest)
npm run test:e2e   # opens dist/index.html via file:// in Edge (Playwright)
```

`samples/` and `test/` are git-ignored: never commit real Plans or clips from them.

## License

AGPL-3.0-or-later, because it bundles [MuPDF.js](https://mupdf.readthedocs.io/)
(AGPL-3.0-or-later, © Artifex Software). See [`LICENSE`](LICENSE).

The logo (also the tab icon) is the "crop" icon from [Lucide](https://lucide.dev/icons/crop),
© Lucide Contributors, ISC license.
