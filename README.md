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
4. Set the Clip: drag its edges in the precision view (they snap to lines; hold Alt
   to place freely), or type the mm values. The view starts with the whole Plan; the
   minimap in the bottom-right corner moves the view (keys: `1` whole Plan, `2` Plan
   width, `3` 1:1, `F` Clip).
5. Export as SVG (for the whiteboard tool) or as PDF (for documentation; everything outside the
   Clip is removed from the file).
6. To print a large Clip at real size, switch on "Auf Blätter aufteilen": the Clip is cut
   into Tiles by paper format (A4–A0 or custom) or freely (columns/rows by count or by
   length), each on its own Sheet with a Margin, cut marks and a label. Saved as numbered
   single PDFs into a folder, or as one multipage PDF (ADR 0013).

Scanned Plans (pages that are images) work too: the PDF keeps only the pixels inside the
Clip, and the SVG embeds only the part of the image inside it (ADR 0005).

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
- [ ] Named presets for export settings (#5)

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

The page icon (scissors) is by [Noah Jacobus](https://www.svgrepo.com/author/Noah%20Jacobus/),
from the "Chunk 16px Thick Interface Icons" collection on [SVG Repo](https://www.svgrepo.com/svg/535606/scissors), public domain.
