# 1. Fully local browser app, handed over as files

Status: accepted (2026-11-03), revised the same day

## Context

Construction schedules are often confidential. Users include non-technical colleagues
who should not have to install anything. The tool must not depend on any hosting:
the author hands someone the files, and they open the page on their own PC.

## Decision

simplepdfclipper runs entirely in the browser (Edge), opened from local files. No
server, no hosting (no GitHub Pages), no network access needed. The Plan is read from
the local disk and never uploaded.

## Consequences

- PDF parsing, rendering and export all happen client-side (JS/WASM).
- Must work from `file://`. Edge blocks ES module imports, `fetch()` of local files and
  file-URL workers there, so the build has to inline everything (see the delivery
  ADR).
- Memory and canvas size limits of the browser apply. At 1188 × 7660 mm the Plan is
  far bigger than any single canvas, so rendering must be tiled (only the visible
  viewport at the current zoom).
