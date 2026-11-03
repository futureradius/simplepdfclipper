# 10. Delivered as one self-contained HTML file

Status: accepted (2026-11-03), feasibility to be confirmed in the first build

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

## Open risk

Whether a Web Worker (created from a Blob URL) works from `file://` in Edge. If not,
MuPDF runs on the main thread and the UI shows "Wird berechnet…" during heavy steps.
ADR 0008 is amended accordingly once tested.
