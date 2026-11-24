# 5. Content outside the Clip is actually removed

Status: accepted (2026-11-03); objects crossing the edge are cut since 2026-11-24 (#35)

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

(Superseded on 2026-11-24 by "Paths are cut" below.) Lines and shapes that are partly
inside the Clip are kept whole
(`REDACT_LINE_ART_REMOVE_IF_COVERED`); the page box cuts them visually at the edge.
Removing everything that touches the outside (`REMOVE_IF_TOUCHED`) would delete grid
lines and bars crossing the Clip.

Text is removed glyph by glyph. Glyphs on the edge that are kept and stick out a
little are acceptable.

## Consequences

(Until #35.) The file still contains the invisible remainder of crossing lines and shapes. That
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

Known limit (gone since #35: the path cut removes such paths): a path entirely outside the Clip that crosses from one band into
another without being covered by either band alone (e.g. a diagonal through the
corner region) is kept, invisible beyond the page edge.

## Images in the SVG (2026-11-17)

A check with generated scans (one image per page, with and without an invisible OCR
text layer, 150 dpi Flate and 300 dpi JPEG) found the PDF and Tiled Export correct:
`REDACT_IMAGE_PIXELS` whitens the pixels outside, invisible text outside is removed.
The SVG export, though, embedded the whole page image and only hid the outside with an
SVG clip: the rest of the scan was in the file, and a 300 dpi A4 scan made an 11.6 MB SVG.

Now the SVG embeds only the pixels under the visible area (the Clip, narrowed by any
clip in the Plan) plus a 1 px border, and the image matrix is adjusted so it sits
exactly where it did. Images inside pattern tiles are kept whole (they repeat in
pattern space). The same scan: 0.51 MB. Tests: `src/export/imagecrop.test.ts`.

In the PDF the redacted image keeps its full pixel size (mostly white), so a small Clip
of a JPEG scan can be a little larger than the scan itself (2.0 vs. 1.6 MB). Accepted. (Superseded
by the next section.)

## Rotated pages (2026-11-17)

Pages with `/Rotate` (90/180/270, e.g. landscape scans stored as portrait) used to be
refused. The Clip is always chosen on the page as displayed (MuPDF page space includes
the rotation), and the redaction bands are already in that space. Step 3 now builds the
new content matrix from the page's own transform (`PDFPage.getTransform()`: UserUnit,
rotation, y flip), then moves the Clip's corner to the origin, y up, in units of the new
page. The exported page is upright with `/Rotate 0` (overrides an inherited value).
For unrotated pages this is the same matrix as before. Patterns get the full matrix too.

Pitfall found on the way: matrix numbers below 1e-6 (float leftovers such as
`-1.1e-13`) were written in JS exponent notation, which PDF can't read, so the whole
page came out blank. Such numbers are now written as 0. This affected unrotated pages too.

Tests: `src/export/rotate.test.ts` (pages at 0/90/180/270 with an image, shapes, hatch
and text: PDF, Tile and SVG match the displayed area; text outside removed; no exponent
notation), `e2e/rotated.spec.ts`.

## Paths are cut, not kept whole (decided 2026-11-24, #14; built in #35)

With several Regions (ADR 0016) a line kept whole would run invisibly through the
neighbouring Regions, and some whiteboard tools ignore SVG clip paths. So every export
(PDF, SVG, every Tile, also one-Region Clips) now cuts paths geometrically at the edge:
fills exactly (curves too), strokes end at the edge without caps sticking out, dash
patterns continue with the right phase. Nothing of a cut path remains outside, not even
invisibly. Text: a glyph is kept whole if its centre is inside, else removed. Images:
visible pixels + 1 px, clipped visually (PDF side: #22). MuPDF 1.28 redaction cannot
cut line art; how the PDF side does it is researched in #34. Built in #35: see the last section.

## Images cropped in the PDF too (2026-11-24, #22)

After redaction a partly visible image still had its full pixel size, mostly white.
Now step 1 is followed by a crop pass (`src/export/pdfimagecrop.ts`):

- The redacted content stream is walked (`src/export/contentstream.ts`: a small
  tokenizer, `q`/`Q`/`cm` tracking, `Do` followed into Form XObjects) to find where each
  image XObject is drawn. The visible pixels are worked out as in the SVG (Clip + 1 px
  border); an image drawn several times keeps the union of its visible windows.
- The image's entry in the resource dictionary is swapped for a Form XObject with
  BBox [0 0 1 1] that draws the cropped image in its sub-rectangle of the unit square.
  The content streams stay byte for byte the same. An image that is never visible is
  swapped for an empty Form.
- Encoding: redaction rewrites partly covered images losslessly, so the source filter
  is gone by then. The pixel sizes of the page's JPEG images are recorded before
  redaction, and an image of such a size is stored as JPEG again (quality 90);
  everything else is stored losslessly (Flate). Soft masks of the same size are cropped
  with the image.
- Left whole: stencil masks (`/ImageMask`, drawn in the fill colour), images with
  `/Mask` or `/SMaskInData`, JPEG 2000, soft masks of another size than their image,
  inline images, and images reachable from patterns, soft-mask groups or Type 3 fonts
  (they are drawn in their own spaces, possibly repeated).

The Tiled Export runs the same export again per Tile on the Clip PDF, so every Tile
holds only its own pixels.

Tests (`src/export/pdfimagecrop.test.ts`, generated A4 scans): a 300 dpi JPEG scan
cropped to 50 × 60 mm keeps a ~593 × 711 px JPEG, the file is less than ¼ of the scan,
and the page renders like the original area (< 1 % differing pixels at 3 px/mm); the
same for a Tile on a Sheet; a Flate scan stays lossless; an image drawn twice; a soft
mask.

## Paths cut at the edge: implementation (2026-11-24, #35)

The geometry is shared (`src/export/pathcut.ts`, pure functions). The Clip is a set of
half-planes, so the PDF side cuts in each path's own user space (exact under any
transformation: rotated pages, non-uniform scales, UserUnit) and the SVG side in export
units.

- **Fills and clip paths:** each subpath is clipped on its own against each half-plane
  (Sutherland–Hodgman with curves): segments are split where they cross the edge
  (Béziers by de Casteljau at the roots of a cubic, never flattened), the pieces
  outside are dropped and the gap is closed along the edge. Every point inside keeps
  its winding number, so non-zero and even-odd fills stay correct. A clip path with
  nothing inside becomes an empty clip.
- **Strokes:** the centre line is cut at the edge; consecutive pieces inside stay one
  subpath (their joins stay); a closed subpath that crosses the edge is opened after a
  piece outside. A cut end gets no cap. PDF and SVG have one cap style per stroke, so
  where a run has a cut end and an original end, the original end is emulated: a square
  cap by extending the end by half the line width (then butt caps), a round cap by a
  zero-length subpath at the end (a dot, painted with round caps).
- **Dashes:** each run continues the pattern with the phase at its start (phase + arc
  length, Gauss–Legendre for curves); dashed closed subpaths are split where the pattern
  restarts. With round or square caps, a dash that is "on" at a cut is taken out as its
  own piece (butt at the cut), and the rest of the run starts in the middle of the next gap.
- **Fill + stroke** (`B`, `b`): the fill gets the clipped area, the stroke the cut centre
  line. Under transparency (alpha < 1, a blend mode, a soft mask) several paints of one
  path would overlap differently from the original, so they are painted opaque inside a
  transparency group (a Form XObject with `/Group`) that gets the alpha as a whole.

**PDF** (`src/export/pdfpathcut.ts`): after redaction, the page content and the Form
XObjects it draws are walked with our tokenizer (`contentstream.ts`, now with byte
offsets), tracking `q`/`Q`/`cm`, `w`, `J`, `M`, `d` and `gs` (`/LW`, `/LC`, `/ML`, `/D`,
`/CA`, `/ca`, `/BM`, `/SMask`). A path whose control points are all inside is copied
byte for byte; any other is replaced by its cut geometry (numbers with 12 significant
digits, never exponent notation). Redaction makes every Form a fresh copy for its one
use, so forms are rewritten in place; a form drawn again anyway gets its own copy.
Patterns, soft masks and Type 3 glyphs are not followed (they draw in their own spaces
and show only through paths that are cut). A stream that can't be read is left as it
was and counted; the UI then says that lines there are only hidden at the edge.

**Text** follows one rule in PDF and SVG (`src/export/glyphbox.ts`): a glyph's box is
its advance across and the font's descender to ascender up (as in MuPDF's structured
text; MuPDF.js has no ascender call, so one glyph per font is run through a display list
into structured text). The glyph is kept whole if the box centre is inside, else removed.
Measured on MuPDF 1.28: redaction removes a glyph as soon as this box, shrunk by 10 % on
each side, touches a redaction area. That would also remove glyphs mostly inside, so the
PDF export now removes content in stages:

1. bands 200 pt away from the Clip: text there, and the line art they cover;
2. bands at the Clip: image pixels and line art, no text;
3. the glyphs left near the Clip are listed (`src/export/pdfglyphs.ts`); the outside is
   redacted as rectangles that leave out the (shrunk) boxes of the kept glyphs crossing
   the edge; a glyph to remove that reaches outside only under such a kept glyph gets a
   tiny quad of its own on a point no kept glyph covers;
4. the path cut;
5. the image crop.

A glyph with its centre inside that reaches more than 200 pt (70 mm) outside is removed
in step 1. Accepted.

**SVG** (`collect.ts`): fills, strokes and clip paths are cut in export units as they
are collected (not inside pattern tiles); a cut stroke becomes one item per paint
(another cap or dash phase). A translucent stroke with a round-cap dot is a little
darker where the dot overlaps the line; accepted (rare).

**Visible change at the edge:** ink that parts outside put inside is gone: the cap of a
dash ending just outside, a round dot centred just outside, the half width of a thick
line whose centre line runs just outside, the notch of a diagonal butt end, a mitre tip
of a vertex outside. All of it lies within half a line width of the edge. Test Plan,
Clip 1188.9 × 600 mm: 0.021 % of pixels differ (was 0.003 %), 1.3 s instead of 1.1 s;
600 × 6000 mm: 2.3 s instead of 2.6 s.

Tests: `src/export/pathcut.test.ts` (geometry: curves, even-odd and non-zero, a rotated
non-uniform transformation, caps, dash phase, closed subpaths) and
`src/export/edgecut.test.ts` (a generated Plan with lines, curves, dashed and dotted
lines with butt and round caps, square caps, an even-odd ring, a hatch, a clip path, a
Form XObject drawn twice, ExtGState line settings, a translucent fill + stroke, and
text): no path coordinate outside the Clip in the PDF, in every Tile and in the SVG; the
picture matches the Plan area away from the edge (< 0.05 % of pixels at 8 px/mm); the
text keeps "ABCD" where the D's centre is inside and "ABC" where it is outside, in PDF
and SVG.
