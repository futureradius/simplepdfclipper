# 4. MuPDF.js as the PDF engine, project licensed AGPL-3.0

Status: accepted (2026-11-03)

## Context

We need, in the browser: rendering a huge single-page Plan, reading its vector
geometry (for Snap), truly removing content outside the Clip, and writing PDF and SVG.
pdf.js no longer ships an SVG backend, and pdf-lib cannot remove content by area.

## Decision

Use MuPDF.js (`mupdf` on npm, v1.28.x, WASM) for rendering, geometry extraction and
export. Because MuPDF.js is AGPL-3.0-or-later, simplepdfclipper is licensed
AGPL-3.0-or-later and the repository is public.

Relevant MuPDF.js APIs (verified in v1.28.1 typings):

- `PDFPage.applyRedactions(blackBoxes, imageMethod, lineArtMethod, textMethod)` with
  `REDACT_LINE_ART_REMOVE_IF_COVERED` / `REDACT_LINE_ART_REMOVE_IF_TOUCHED` and
  `REDACT_TEXT_REMOVE`: true content removal.
- `PDFPage.setPageBox(box, rect)`: set the exported page to the Clip.
- Custom JS `Device` with `fillPath` / `strokePath` / text callbacks: geometry for
  Snap targets.
- `DocumentWriter(buffer, format, options)`: PDF and SVG output.

## Consequences

- The WASM binary is 10.4 MB (3.6 MB brotli). Because the app runs from `file://`
  (ADR 0001), it cannot be fetched at runtime. MuPDF.js reads its Emscripten config
  from `globalThis.$libmupdf_wasm_Module`, so the binary can be inlined and passed in
  as `wasmBinary`.
- One engine for everything: fewer mismatches between what is shown and what is
  exported.
