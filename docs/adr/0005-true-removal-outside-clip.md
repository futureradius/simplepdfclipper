# 5. Content outside the Clip is actually removed

Status: accepted (2026-11-03)

## Context

Most crop tools only change the PDF's MediaBox/CropBox. The full Plan is still in the
file and anyone with a PDF editor can recover it. Clips are shared with third parties.
Not leaking the rest of the Plan is the main reason this tool exists.

## Decision

The exported PDF contains no content that lies entirely outside the Clip. Removal is
done by redacting the area outside the Clip (MuPDF redaction, without black boxes),
then setting the page box to the Clip.

SVG export only ever contains content within the Clip.

### Objects crossing the Clip edge

Lines and shapes that are partly inside the Clip are kept whole
(`REDACT_LINE_ART_REMOVE_IF_COVERED`); the page box cuts them visually at the edge.
Removing everything that touches the outside (`REMOVE_IF_TOUCHED`) would delete grid
lines and bars crossing the Clip.

Text is removed glyph by glyph. Glyphs on the edge that are kept and stick out a
little are acceptable.

## Consequences

The file still contains the invisible remainder of crossing lines and shapes. That
reveals at most their extent, not readable schedule content. Accepted.

## Implementation (2026-11-03, `src/export/pdf.ts`)

1. A fresh copy of the Plan file is opened (the view is not touched).
2. Four redaction annotations cover everything outside the Clip (bands above,
   below, left, right, reaching far beyond the page), applied with
   `applyRedactions(no black boxes, REDACT_IMAGE_PIXELS, REDACT_LINE_ART_REMOVE_IF_COVERED,
   REDACT_TEXT_REMOVE)`.
3. The page is rebuilt around the Clip: its content is wrapped in
   `q <scale> 0 0 <scale> <tx> <ty> cm … Q`, MediaBox becomes the Clip (other boxes and
   annotations are dropped), and if the Clip is at most 5,080 mm per side the
   UserUnit is removed and the scale baked into the transformation (ADR 0006 update).
4. Page-level patterns get the same transformation in their `/Matrix`: PDF patterns
   are anchored to the page's default coordinate space, not to `cm`, so without
   this the hatching shifted and scaled.
5. Document properties: title, subject (source file, Clip position and size in mm,
   export date, note that content outside was removed), creator.
6. Saved with `garbage=deduplicate,compress`, which drops the old content streams.

Pitfall found by the pixel test: matrix numbers written with 4 decimals (scale
2.8092 instead of 2.80923…) shifted content 14 m from the origin by 0.14 mm. Matrix
numbers are now written with 12 significant digits.

Tests (`src/export/pdf.test.ts`, e2e): exported page vs. original area < 0.1 %
differing pixels at 3 px/mm; text outside (the Plan title) absent from the page text
and from the decompressed file; Clip > 5,080 mm keeps UserUnit and renders
identically. Test Plan Clip 1188.9 × 600 mm: 0.19 MB (Plan 4.2 MB), ~1 s.

Known limit: a path entirely outside the Clip that crosses from one band into
another without being covered by either band alone (e.g. a diagonal through the
corner region) is kept, invisible beyond the page edge.
