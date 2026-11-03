# 1. Offline browser app

Status: accepted (2026-11-03)

## Context

Construction schedules are often confidential. Users include non-technical colleagues
who should not have to install anything.

## Decision

simplepdfclipper is a static web app that runs entirely in the browser. The Plan is
read from the local disk and never uploaded. No backend. It can be hosted as static
files (e.g. GitHub Pages) or opened locally.

## Consequences

- PDF parsing, rendering and export all happen client-side (JS/WASM).
- Memory and canvas size limits of the browser apply. At 1188 × 7660 mm the Plan is
  far bigger than any single canvas, so rendering must be tiled (only the visible
  viewport at the current zoom).
