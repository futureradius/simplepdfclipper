# 8. Tech stack and target browser

Status: accepted (2026-11-03)

## Decision

- TypeScript + Vite, plain DOM (no UI framework).
- MuPDF.js runs in a Web Worker so the UI stays responsive.
- Tests: Vitest for logic, Playwright for the browser.
- Target browser: current Microsoft Edge. Chrome should work for free (same engine).
  Firefox is best effort, not tested.
