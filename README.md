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
3. Open your Plan.
4. Set the Clip: drag its edges in the precision view (they snap to lines; hold Alt
   to place freely), draw it in the overview on the right, or type the mm values.
5. Export as SVG (for the whiteboard tool).

## Roadmap

- [x] Optimised SVG export (merging, real text, hatching, clip shapes)
- [x] Precision view with zoom and snapping
- [ ] PDF export with real removal outside the Clip (ADR 0005)
- [ ] Font substitution dialog (ADR 0006)
- [ ] UI overhaul (the current UI is a functional prototype)

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
