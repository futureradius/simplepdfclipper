# 10. Delivered as one self-contained HTML file

Status: accepted (2026-11-03), feasibility confirmed the same day

## Context

The app must open by double-click from disk (ADR 0001). From `file://`, Edge blocks
loading further files (ES modules, `fetch`, WASM). Start scripts / local servers are
often blocked by corporate IT.

## Decision

The build produces a single `simplepdfclipper.html` with all JS inlined and the MuPDF
WASM binary embedded compressed (gzip + base64, decompressed in the browser with
`DecompressionStream`), handed to MuPDF.js as `wasmBinary` via
`globalThis.$libmupdf_wasm_Module`. Expected size roughly 5–7 MB. The UI shows the
app version and build date.

## Findings (Edge 156, tested via Playwright on `file://`)

- Build output: one `dist/index.html`, 6.5 MB (4.8 MB gzip). Rolldown code splitting
  is disabled for both the page and the worker so nothing is loaded at runtime.
- Workers from `file://`: classic worker from `blob:` works; **module worker from
  `blob:` fails** (error event, no message); module worker from `data:` works.
  MuPDF.js needs a module worker (top-level await), so on `file://` the app makes
  Vite's inline worker take its `data:` URL path (`src/engine/client.ts`).
- If the worker still fails, the engine falls back to the main thread
  (UI shows which mode is active).
- The 2.2 MB Test Plan (440k drawing operations) opens in about a second.

Covered by `e2e/single-file.spec.ts`.
