# 14. Multi-page Documents: one page is the Plan

Status: accepted (2026-11-17, issue #1)

## Context

The app assumed a single-page file and silently used page 1 of anything else. Some
schedules come as multi-page PDFs (one sheet per section, cover page first). Users
need to choose the page they clip from. Worse, the PDF export copied the whole file
and only rebuilt page 1, so the other pages travelled along unredacted (against
ADR 0005).

## Decision

- **Glossary:** the opened file is the **Document**; the **Plan** is the one page of it
  being worked on. Clip, Export, Tiles and Snap targets stay page-based. One export is
  always one page: several pages in one export, or a Clip spanning pages, are out of
  scope.
- **Page picker:** opens automatically only for Documents with more than one page;
  single-page files open straight away as before. A dialog "Seite wählen" shows
  thumbnails, three side by side, "Seite n" under each, scrolling. Thumbnails are drawn
  lazily as they scroll into view, one at a time (the engine is shared, so opening the
  picked page never waits behind a long queue), so a 200-page Document does not stall.
  Placeholders already have the page's proportions (all page sizes are read when the
  Document opens, which is cheap). Picking a page opens it. "Abbrechen" (or Escape)
  keeps the current Plan, or stays on the start screen on a first open.
- **Two-step opening in the engine:** `openDocument` loads the file as a *candidate*
  (thumbnails come from it), `openPage` makes one of its pages the Plan and only then
  drops the previous Document. Until a page is picked, the previous Plan stays fully
  usable; `discardDocument` drops the candidate on cancel.
- **Step 1** shows "Seite n von m" with ◀ ▶ to switch pages; clicking the label reopens
  the picker with the current page marked. Shown only for multi-page Documents.
  Disabled while a page is loading or an export runs.
- **Switching pages:** the Clip is kept if it fits the new page, otherwise reset to the
  default (the ADR 0007 rule, as on opening a file). The view starts with the whole
  page (ADR 0012). Snap targets are extracted again for the new page.
- **Exports contain only the chosen page.** The PDF export reduces the copied Document
  to that page before redacting (`rearrangePages`), also when page 1 is chosen. Every
  export request names its page and the engine refuses one for a page other than the
  one shown, so a page switch can never mix up what is exported.
- **Names:** for multi-page Documents the page is part of the export file names
  (`Plan_S3_Ausschnitt.pdf`, `.svg`, `Plan_S3_Ausschnitt_Kachel_A1.pdf`,
  `…_Kacheln.pdf`, `…_Kacheln.zip`) and of the source in document properties and Tile
  labels ("Plan.pdf, Seite 3"). Single-page files keep their old names.

## Consequences

- Code: `src/engine/core.ts` (candidate Document, `openPage`, `renderThumbnail`),
  `src/ui/pagepicker.ts` (dialog, lazy thumbnails, name helpers), `src/main.ts`
  (step 1 pager, page switching). Tests: `src/engine/multipage.test.ts` and
  `e2e/multipage.spec.ts`, both on a generated three-page Document
  (`src/testing/multipage.ts`).
- The viewer drops sharp renders that arrive after another page or Plan was opened.
