# simplepdfclipper

Cut a precise rectangle out of a huge vector PDF (e.g. a 1188 × 7660 mm construction
schedule) and export it as a **small, sharp SVG** (for the whiteboard tool) and as a **PDF**
in which everything outside the clip is actually removed, not just hidden.

Runs fully local: the whole app is a single HTML file you open in Microsoft Edge by
double-click. No server, no upload, no installation.

> Status: early development. See [`CONTEXT.md`](CONTEXT.md) for the domain and
> [`docs/adr/`](docs/adr/) for the design decisions.

## Using it

1. Get `simplepdfclipper.html` (built as `dist/index.html`).
2. Double-click it; it opens in Edge.
3. Open your Plan, select the clip, export.

## Development

Requires Node.js 22+ and Microsoft Edge (used by the end-to-end tests).

```sh
npm install
npm run testplan   # generate samples/test-plan.pdf (a synthetic 1188 x 7660 mm schedule)
npm run dev        # dev server
npm run build      # type-check + build dist/index.html (single self-contained file)
npm test           # unit tests (Vitest)
npm run test:e2e   # opens dist/index.html via file:// in Edge (Playwright)
```

`samples/` is git-ignored: never commit real Plans.

## License

AGPL-3.0-or-later, because it bundles [MuPDF.js](https://mupdf.readthedocs.io/)
(AGPL-3.0-or-later, © Artifex Software). See [`LICENSE`](LICENSE).
