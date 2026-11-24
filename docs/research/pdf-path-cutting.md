# How can the PDF export cut paths exactly at a Region edge?

Research for issue #34 (blocks #35). 2026-11-24. MuPDF.js 1.28.1 as installed; MuPDF C sources at tag
`1.28.1` and `master` (1.29.0 in development); ISO 32000-1:2008 (PDF 1.7).
Prototype code: [`pdf-path-cutting/`](pdf-path-cutting/) (copy the `.tmp.mjs` files to `samples/`
and run them with `node` from the repo root, so `import "mupdf"` resolves).

## Answer in short

MuPDF can't do it. Neither the C library nor MuPDF.js (1.28 or the 1.29 development version)
has a geometric cut. All its content filters keep or drop whole objects by their bounding box.
Its PDF-writing device does re-emit paths, but it loses the Plan's hatch patterns.

**Recommendation:** keep today's MuPDF redaction (text, images, line art entirely outside),
then run a small JavaScript pass over the redacted page content. It finds each path-painting
operator, tracks q/Q/cm, and replaces paths that cross the Clip with cut geometry: exact half-plane
clipping for fills and clip paths (Béziers split at the edge), centre-line cutting for strokes with
the dash phase carried over. A prototype on the Test Plan takes **20–90 ms** on top of the ~1 s
redaction, leaves **0 path coordinates outside the Clip** (before: 540–1,800), keeps the file size the
same (−3 % … +7 %) and differs from the original area in **0.02 % of pixels**, all of them in the
outermost 2 px (0.67 mm at 3 px/mm) along the Clip edge. **Effort:** about 3–4 days with tests.
**Main risks:** robustness on real-world content streams, and the small, accepted visual changes
at the edge. Details at the end.

## 1. Does MuPDF offer anything usable?

### Content-stream filters (`pdf_filter_options`, sanitize filter, culler)

`pdf_filter_page_contents` runs the page through a chain of filter processors and writes a new
content stream (`source/pdf/pdf-clean.c` l. 395; the output goes through `pdf_new_buffer_processor`,
l. 163/247). The only filter that removes content is the **sanitize filter**, through two hooks in
`pdf_sanitize_filter_options` (`include/mupdf/pdf/interpret.h` l. 350–386):

- `culler(ctx, opaque, fz_rect bbox, fz_cull_type type)` returns keep or drop for a **whole** object
  (path fill/stroke, clip path, glyph, image, shading), judged by its bounding box only.
- `text_filter` / `image_filter` work per glyph and per image.

No hook gets the path itself or can change it. `master` is the same; only the enums got names.

- **Redaction** (what we use) is this culler. For line art it drops an object if its bbox is
  covered by the redaction areas (`REMOVE_IF_COVERED`) or touches them (`REMOVE_IF_TOUCHED`), and
  otherwise keeps it whole (`pdf-clean.c` l. 1076–1096; options `include/mupdf/pdf/page.h`
  l. 269–271, unchanged in master).
- **`pdf_clip_page(ctx, page, rect)`** (C only, `page.h` l. 306, `pdf-clean.c` l. 1222–1345) is
  the same culler with "drop if the bbox misses the rect". Objects that cross the rect stay whole.
  It also drops links and FreeText annotations outside.
- **`mutool trim`** (`source/tools/pdftrim.c` l. 40–58, 60–122; doc `docs/tools/mutool-trim.md`)
  is the same again, for page boxes and margins. "Remove content inside/outside a box" means whole
  objects.
- **`pdf_vectorize_page`** / `PDF_CLEAN_VECTORIZE_YES` (`clean.h`) turns text into paths. Not relevant.

None of these filters is exposed in MuPDF.js. In 1.28.1 the WASM exports only
`_wasm_pdf_redact_page` and `_wasm_pdf_apply_redaction` (`node_modules/mupdf/dist/mupdf-wasm.d.ts`).
The 1.29.0 `platform/wasm/lib/mupdf.ts` on `master` has the same redaction call
(`applyRedactions`, l. 3048) and still no filter, culler, `clipPage` or processor API. A custom
culler would need our own WASM build of MuPDF, and it would still only drop whole objects.

MuPDF's rasteriser does cut dashed strokes to the visible area internally
(`source/fitz/draw-path.c` l. 1250–1300). That code is only used for drawing.

### A device that re-emits paths: `DocumentWriter(buf, "pdf")`

MuPDF.js has `Device` with JS callbacks (`mupdf.d.ts` l. 274–317) and `DocumentWriter`
(l. 325), whose `"pdf"` format is MuPDF's PDF-writing device (`source/pdf/pdf-device.c`). So a
JS device can sit between `page.run()` and the writer, get every `fillPath`/`strokePath` with its
`Path`, `StrokeState` and CTM, cut it, and pass on a new `Path`. That is the same set-up as our SVG
collector. I tried it as a pass-through on the redacted Test Plan
([`devroute.tmp.mjs`](pdf-path-cutting/devroute.tmp.mjs)): 74 ms, 0.11 MB. But the PDF device
can't write everything a Plan contains:

| Lost or changed | Source (`pdf-device.c` @1.28.1) | Effect |
|---|---|---|
| Tiling patterns (hatching) | l. 1351 "tiled patterns are not supported in the pdf-write device"; device hint `FZ_NO_TILING` l. 1409 | **Measured:** hatch missing, 0.72 % of pixels differ, ink 12.99 % → 12.06 % |
| Type 3 fonts | l. 488 throws `FZ_ERROR_UNSUPPORTED` | export fails |
| Clip by image mask | l. 1192 "does not support image masks" | content lost |
| Shadings other than linear/radial | l. 1017 | lost |
| Soft-mask transfer functions | l. 1276 "Ignoring Transfer function" | changed |
| Clip by stroke | l. 810 FIXME: written as `W n` on the stroke's path | wrong clip shape |
| Triangle caps | l. 142 → butt | (XPS only) |
| Optional content (layers) | no `begin_layer` / `end_layer` handlers (l. 1409–1440) | layer structure flattened |
| Fonts | `pdf_dev_font` l. 476–498: re-embedded as Identity-encoded CID fonts or substitutes | original encoding/ToUnicode not kept as is |
| Structure tree, marked content, colour spaces as written | interpreter level | lost or normalised |

Rejected: the Test Plan's hatching alone rules it out.

## 2. Can MuPDF.js read and rewrite the content stream ourselves?

Yes. Everything needed is in the 1.28.1 API:

- `PDFObject.readStream()` / `writeStream()` (`mupdf.d.ts` l. 614/617) read and replace any
  stream: page `/Contents`, Form XObjects, pattern streams. `pdf.ts` already reads and rewrites
  `/Contents`.
- `getInheritable("Resources")` and dictionary access reach `/XObject`, `/Pattern` and `/ExtGState`
  (needed for `gs` entries `/LW`, `/D`, `/CA`, `/ca`, `/BM`).
- There is **no** content-stream tokenizer in MuPDF.js (no processor API), so we write one
  (~120 lines). It has to handle numbers, names, literal and hex strings, arrays, `<<…>>`
  (marked-content properties, inline-image dictionaries), comments and inline images (`BI … ID
  <binary> EI`).

What makes this much easier: **we run after redaction.** MuPDF's redaction already rewrote the
page through its filter and buffer processor, so:

- the syntax is normalised (one stream, balanced q/Q, MuPDF's number format);
- only objects that touch the Clip are left (Test Plan: 0.15–1.4 MB instead of 32.7 MB);
- **every Form XObject is a fresh copy for its one place of use**: redaction sets
  `instance_forms = 1` (`pdf-clean.c` l. 1110), and `pdf_filter_Do_form` makes a new `Fm…`
  instance per `Do` (`pdf-op-filter.c` l. 2626–2633). So each form can be rewritten in place, with
  the CTM at its `Do` times its `/Matrix`, without affecting another use.
- Redaction does not touch patterns, soft masks or Type 3 glyph procs (`recurse = 0`, l. 1109).
  Pattern cells don't need cutting: they repeat in pattern space and only show inside the filled
  path, and that path is in the page content and gets cut (PDF 1.7 p. 182, note on the pattern matrix: it is relative to the default space of the page or form, which `pdf.ts` already handles).

**Cost on the Test Plan** (4.2 MB file, 32.7 MB content, 2.4 M operators; the real 3 MB
reference Plan is not in the repo, so I measured on the Test Plan). Prototype
[`cut-lib.tmp.mjs`](pdf-path-cutting/cut-lib.tmp.mjs) + [`cut-run.tmp.mjs`](pdf-path-cutting/cut-run.tmp.mjs),
Node 24, this laptop:

| Clip (mm) | Content after redaction | Paths / crossing the Clip | Tokenize + cut | Path points outside Clip before → after | Pixels differing (>64/255) | File size, redaction only → + cut |
|---|---|---|---|---|---|---|
| 500 × 600 at 200/3000 | 621 kB, 44,788 ops | 14,123 / 1,275 | 17 + 47 ms | 1,811 (up to 10.7 m away) → **0** | 0.020 % | 0.089 → 0.086 MB |
| 1188.9 × 600 at 0/2000 (full width) | 1,448 kB, 103,108 ops | 33,092 / 866 | 43 + 90 ms | 542 → **0** | 0.018 % | 0.194 → 0.194 MB |
| 333.3 × 1222.2 at 37.3/7011.7 | 147 kB, 11,380 ops | 1,757 / 1,028 | 7 + 21 ms | 1,575 → **0** | 0.000 % | 0.029 → 0.031 MB |

Redaction itself stays at ~1.0 s. For comparison, cutting the **unredacted** 32.7 MB stream in JS
takes 0.6 s just to tokenize and 3.0 s to cut. So: redaction first, then cut.

All differing pixels are in the **outermost 2 px rows/columns** along the Clip edge (≤ 0.67 mm at
3 px/mm). With a stroke overhang (see 4.4) they go to 0.000 %. ADR 0005's 0.1 % limit is met
either way.

The known gap in ADR 0005 (a path outside the Clip that crosses from one redaction band into
another is kept) also goes away: the cut pass removes every path that has nothing inside the Clip.

## 3. Alternative: write the PDF from our own IR

The SVG writer's IR (`src/export/collect.ts`, `ir.ts`) is built for SVG and drops a lot that a PDF
must keep. Writing the PDF from it would lose or need new code for:

- **Colour:** the IR stores `#rrggbb` (`colorToHex`). CMYK, spot colours, ICC-based colour spaces
  and overprint would become RGB.
- **Fonts:** the IR has glyph IDs, Unicode and the `Font`. `PDFDocument.addFont/addSimpleFont`
  exist, but re-embedding (Identity-H CID fonts, our own ToUnicode, widths, vertical text) is
  exactly the `pdf-device.c` path above, with the same losses. Subsets would be re-embedded per font.
- **Shadings, image masks, soft masks, nested patterns, transparency groups and blend modes:**
  ADR 0011 lists them as "not reproduced" (counted and shown as a warning in the SVG). In a PDF
  they would have to be written again by hand.
- **Optional content (layers), marked content and structure tree, ActualText, links:** not in the IR.
- **Images:** would be re-added through `addImage`. Their compression is kept only if MuPDF can
  pass the buffer through.
- **Size and speed:** the IR is flattened to 0.01 mm export units. That suits SVG, but would
  re-quantise PDF coordinates.

It is a second PDF writer that has to match a Plan's whole feature set. Rejected: a lot of work and
a high fidelity risk, while the rewrite pass changes only path operators and leaves everything
else as MuPDF wrote it.

## 4. Geometry specifics

All cutting happens **in the user space of each path**, not in page or device space. The Clip is
axis-aligned in MuPDF page space; with `M = CTM × page.getTransform()` each of its four edges
becomes a half-plane `g(x, y) = αx + βy + γ ≥ 0` in user space (a parallelogram for rotated or
sheared CTMs). Half-planes map to half-planes under affine maps, and Bézier curves are
affine-invariant. So the cut is exact under any CTM: non-uniform, rotated (`/Rotate`), or
`UserUnit`. In user space the pen is round and dash lengths are measured in user space, as the
spec requires (§8.4.3.2 line width, §8.4.3.6 dashes, p. 133–135). MuPDF's dasher works there too
(`draw-path.c` l. 1076–1090, 1570–1580).

### 4.1 Fills (and clip paths `W`/`W*`)

- Clip each subpath **separately** against the four half-planes in turn (Sutherland–Hodgman with
  curves): split every segment at the roots of `g` along it (linear for lines; cubic for Béziers,
  solved in closed form from `g` of the 4 control points), keep the pieces inside, and join exit
  and re-entry points with a straight line **along the edge**. Curves stay curves (de Casteljau
  split, no flattening).
- **Even-odd and non-zero both stay correct.** An excursion outside is replaced by a segment on
  the boundary line. The removed loop (excursion + boundary segment) lies entirely in the closed
  outside half-plane, so it adds nothing to the winding number of any point inside. Every point
  inside keeps its winding number, so both rules give the same inside area. Requirements: clip
  subpaths independently (never merge them) and keep the operator (`f`/`f*`, `W`/`W*`).
- Side effect: zero-area slivers along the edge where two excursions meet. They are harmless
  (on the page border) and could be tidied up later.
- A clip path that ends up empty is written as an empty clip (`0 0 0 0 re W n`), so later content
  stays invisible as before.

### 4.2 Strokes: cut at the edge, butt ends

- Cut the **centre line** at all roots against all four half-planes. A piece is inside if its
  midpoint is. Consecutive inside pieces become one **open** subpath ("run"), so joins between
  them stay joins.
- **Closed subpaths** (`h`, `re`, `s`, `b`) that cross the edge become open. The ring is rotated
  to start just after an outside piece, so the original start vertex becomes an inner vertex and
  keeps its line join.
- **Cut ends must not stick out (#35).** PDF has one cap style per stroke (`J`, Table 54 p. 133),
  so a stroke can't have butt cut ends and round original ends. Way out:
  - butt caps (the usual case in Plans): nothing to do;
  - **square caps:** write the run with `0 J` and extend each *original* end by w/2 along its
    tangent. That gives exactly the same shape (§8.4.3.3, Table 54: the stroke "shall continue beyond the
    endpoint of the path for a distance equal to half the line width");
  - **round caps:** write the run with `0 J` and add a degenerate subpath `x y m x y l` at each
    original end, stroked with `1 J`. A degenerate subpath with round caps paints "a filled circle
    centered at the single point" (§8.5.3.2, p. 144), in the same stroke colour without copying
    any colour state. With translucent strokes the dot and the line overlap and the overlap gets
    darker. In that case write the dots and the run inside one transparency group (rare in Plans).
- **Joins at the cut:** the join at a vertex *outside* the Clip goes away with the vertex. A
  mitre at such a vertex reaches up to `miterLimit × w/2` and can poke into the Clip; it is lost.
  A **diagonal** butt end at the edge leaves a small notch inside (≤ w/2 deep): the butt end is
  perpendicular to the line, not to the edge. These two effects are the 0.02 % of pixels in the
  outermost 2 px.
- **Optional overhang** (tried, not recommended by default): cut strokes at the Clip widened by
  `r = w/2 × max(√2, miterLimit if mitre join)`, measured in user space
  (`g + r·|(α, β)|`). Pixel diff becomes 0.000 %, but up to 2.5 mm of line remains outside on the
  Test Plan, which breaks "nothing outside, not even invisibly". A per-crossing overhang
  (`w/2·|cos θ|` for butt ends, 0 for lines perpendicular to the edge such as grid lines) would
  be smaller, but it is still not zero. Keep the strict cut; the page box and the Sheet's
  `re W n` hide cap ink at the edge.
- **Hairlines** (`0 w`): cut the same way; there is no width to think about.

### 4.3 Dash phase

- The dash pattern restarts with the phase at **each subpath** (§8.4.3.6, p. 135: "the dash
  pattern shall be restarted and the dash phase shall be reapplied to it at the beginning of each
  subpath"; MuPDF does the same in `fz_dash_moveto`).
- So each run of a dashed stroke gets its own phase: `phase + arc length` (user space) from the
  original subpath start to the run start. Runs of one paint operator therefore become separate
  strokes: `q [array] phase' d … S Q`. Non-dashed runs stay in one path.
- Arc length: exact for lines; Gauss–Legendre (8 points) for Béziers, error far below what
  renderers get from flattening curves.
- Edge case: a run of a **closed** dashed subpath that passes the original start vertex has a jump
  in phase there. Split it at that vertex; the join there becomes two caps (visible only if a dash
  is "on" exactly there).

### 4.4 Fill + stroke operators (`B`, `B*`, `b`, `b*`)

The fill needs the clipped outline (with edge segments); the stroke needs the cut centre line
(without them, or the Clip edge would get stroked). So split them into `f`/`f*` followed by `S`.
§8.5.3 (p. 143) says `B` "shall produce the same result as constructing two identical
path objects, painting the first with f and the second with S". But §11.7.4.4 (p. 365) treats
the combined fill and stroke as **one** object for transparency. So split directly when the
graphics state is opaque with blend mode Normal. Otherwise wrap the pair in a transparency group
(Form XObject with `/Group`).

### 4.5 Not paths, for completeness

Text, images and `sh` shadings are not cut by this pass. Text stays as redaction leaves it; the
glyph-centre rule is #35's text part. Images are #22. A `sh` fills the current clip, which the cut
`W n` bounds. Type 3 glyph procs, pattern cells and soft-mask groups are not touched; neither
redaction nor this pass recurses into them.

## 5. Recommendation

**Redaction as today, then a JS "path cut" pass over the redacted page content and its
instanced Form XObjects**, in `src/export/pdf.ts` between `applyRedactions` and the page rebuild.
Tiles get it for free, because `TiledPdfExport` runs `exportPdf` again per Tile.

Pieces (TypeScript, in `src/export/`):

1. `contentstream.ts`: tokenizer + serializer (inline images, strings, dicts, comments).
2. `pathcut.ts`: half-plane fill clipping with Béziers, stroke run cutting, dash phase, cap
   emulation (square → extension, round → degenerate dot), `B` splitting. Pure geometry, unit
   tested, shared with the SVG side (#35 needs the same cut there, on IR `PathData`).
3. Rewrite pass: q/Q/cm stack, `w`/`J`/`j`/`M`/`d`, `gs` (`/LW`, `/D`, `/CA`, `/ca`, `/BM` from
   `ExtGState`), `Do` into the `Fm…` instances (CTM × `/Matrix`), paths whose points are all
   inside passed through byte for byte.
4. Numbers written with `pdf.ts`'s `f()` (12 significant digits, never exponent notation: the
   pitfalls in ADR 0005).
5. Fallback: if a stream can't be parsed, keep today's result and count a warning, as the SVG
   export does.

**Effort:** about 1 day for the tokenizer and rewrite pass, 1–1.5 days for the geometry (the
prototype covers most of it), 1–1.5 days for tests: "no path coordinate outside the Clip" by
re-parsing the output, pixel diff < 0.1 %, and unit cases for curves, dashes, even-odd,
round/square caps, rotated pages and non-uniform CTMs, hatch patterns and Tiles. About **3–4
days**. Runtime cost: +20–130 ms per export on the Test Plan.

**Risks:**

- **Real-world content:** the Test Plan is generated and has no Form XObjects in the Clip, no
  `gs` stroke settings, no inline images and no clip paths across the edge. Check on the real
  reference Plan and on PDFs from other exporters before relying on it. MuPDF's normalised output
  lowers the risk; the fallback contains it.
- **Edge pixels:** notches at diagonal butt ends and lost mitre tips at vertices just outside.
  Measured 0.02 % of pixels, all within 0.67 mm of the edge. Accepted by "strokes end at the edge
  with butt ends".
- **Transparency:** `B` splitting and round-cap dots need a group under alpha or blend modes;
  more code for a rare case.
- **Things not cut:** pattern cells, soft-mask forms and Type 3 procs keep their own content
  (already so today, since redaction doesn't recurse); `sh` shading data stays.
- **Byte-level stability:** MuPDF's redaction output format may change between versions. The
  tokenizer must accept any valid content stream, not just MuPDF's style.
