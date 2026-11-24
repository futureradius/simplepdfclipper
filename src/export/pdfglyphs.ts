// Text at the Clip edge in the PDF export (ADR 0005, #35): a glyph is kept whole if the
// centre of its box (glyphbox.ts) lies inside the Clip, otherwise it is removed.
//
// MuPDF's redaction removes a glyph as soon as its (shrunk) box touches a redaction
// area, so redacting the outside directly would also remove glyphs that are mostly
// inside. Instead, after far-away text is gone, the glyphs near the Clip are listed
// (MuPDF page space) and the outside is redacted as rectangles that leave out the
// kept glyphs crossing the edge.

import type * as MuPDF from "mupdf";
import type { Matrix, Rect } from "./geometry";
import { GlyphBoxes } from "./glyphbox";

const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
const within = (outer: Rect, r: Rect) => r.x0 >= outer.x0 && r.y0 >= outer.y0 && r.x1 <= outer.x1 && r.y1 <= outer.y1;
const meets = (a: Rect, b: Rect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

/**
 * Rectangles along one side of the Clip, reaching from the edge to `far`, that leave
 * out the given obstacles. In side coordinates: u runs along the edge, w outward from
 * it. Each obstacle covers [u0, u1] from the edge (w = 0) out to w.
 */
function sideRects(u0: number, u1: number, far: number, obstacles: { u0: number; u1: number; w: number }[], eps: number): [number, number, number][] {
  const cuts = [...new Set([u0, u1, ...obstacles.flatMap((o) => [o.u0, o.u1]).filter((u) => u > u0 && u < u1)])].sort((a, b) => a - b);
  const out: [number, number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1]!;
    let w = eps;
    for (const o of obstacles) if (o.u0 <= a && o.u1 >= b) w = Math.max(w, o.w + eps);
    if (w < far) {
      const prev = out[out.length - 1];
      if (prev && prev[2] === w && prev[1] === a) prev[1] = b; // merge equal neighbours
      else out.push([a, b, w]);
    }
  }
  return out.map(([a, b, w]) => [a, b, w]);
}

/**
 * Removes the glyphs on `page` whose box centre is outside `clip` (MuPDF page
 * space); `far` is a distance beyond all content. Glyphs in pattern cells and soft
 * masks are left alone (redaction doesn't reach them). Returns how many glyphs were
 * removed.
 *
 * Redaction removes every glyph whose (shrunk) box touches a redaction area. So the area
 * outside the Clip is redacted as rectangles that leave out the kept glyphs crossing
 * the edge; a glyph to remove that only reaches outside under such a kept glyph gets
 * a tiny quad of its own on a point no kept glyph covers.
 */
export function removeGlyphsOutside(mupdf: typeof MuPDF, page: MuPDF.PDFPage, clip: Rect, far: number): number {
  const boxes = new GlyphBoxes(mupdf);
  const outside: Rect[] = [];
  const kept: Rect[] = [];
  let skip = 0;
  const onText = (text: MuPDF.Text, ctm: Matrix) => {
    if (skip) return;
    text.walk({
      showGlyph(font, trm, gid, _uni, wmode) {
        const g = boxes.get(font, trm as Matrix, gid, wmode, ctm);
        if (within(clip, g.redact)) return;
        if (inside(clip, g.centre[0], g.centre[1])) kept.push(g.redact);
        else outside.push(g.redact);
      },
    });
  };
  const dev = new mupdf.Device({
    fillText: (text, ctm) => onText(text, ctm as Matrix),
    strokeText: (text, _s, ctm) => onText(text, ctm as Matrix),
    clipText: (text, ctm) => onText(text, ctm as Matrix),
    clipStrokeText: (text, _s, ctm) => onText(text, ctm as Matrix),
    ignoreText: (text, ctm) => onText(text, ctm as Matrix),
    beginTile: () => {
      skip++;
      return 1; // don't run the tile's content (endTile still follows)
    },
    endTile: () => void skip--,
    beginMask: () => void skip++,
    endMask: () => void skip--,
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  if (!outside.length) return 0;

  // The outside, minus the kept glyphs, as rectangles.
  const eps = 0.01;
  const { x0, y0, x1, y1 } = clip;
  const quad = (r: Rect): MuPDF.Quad => [r.x0, r.y0, r.x1, r.y0, r.x0, r.y1, r.x1, r.y1];
  const rects: Rect[] = [];
  const obst = (side: (k: Rect) => { u0: number; u1: number; w: number }) =>
    kept.map(side).filter((o) => o.w > 0).map((o) => ({ u0: o.u0 - eps, u1: o.u1 + eps, w: o.w }));
  for (const [a, b, w] of sideRects(-far, far, far, obst((k) => ({ u0: k.x0, u1: k.x1, w: y0 - k.y0 })), eps))
    rects.push({ x0: a, y0: -far, x1: b, y1: y0 - w }); // above
  for (const [a, b, w] of sideRects(-far, far, far, obst((k) => ({ u0: k.x0, u1: k.x1, w: k.y1 - y1 })), eps))
    rects.push({ x0: a, y0: y1 + w, x1: b, y1: far }); // below
  for (const [a, b, w] of sideRects(y0, y1, far, obst((k) => ({ u0: k.y0, u1: k.y1, w: x0 - k.x0 })), eps))
    rects.push({ x0: -far, y0: a, x1: x0 - w, y1: b }); // left
  for (const [a, b, w] of sideRects(y0, y1, far, obst((k) => ({ u0: k.y0, u1: k.y1, w: k.x1 - x1 })), eps))
    rects.push({ x0: x1 + w, y0: a, x1: far, y1: b }); // right

  // Glyphs those rectangles miss: a point of their own, outside the Clip and the kept glyphs.
  const quads = rects.map(quad);
  let removed = 0;
  for (const box of outside) {
    removed++;
    if (rects.some((r) => meets(r, box))) continue;
    const candidates: [number, number][] = [];
    for (const u of [0.05, 0.25, 0.5, 0.75, 0.95])
      for (const v of [0.05, 0.25, 0.5, 0.75, 0.95]) candidates.push([box.x0 + (box.x1 - box.x0) * u, box.y0 + (box.y1 - box.y0) * v]);
    const free = candidates.find(([x, y]) => !inside(clip, x, y) && !kept.some((k) => inside(grow(k, eps), x, y)));
    if (!free) {
      removed--; // can't be removed without a kept glyph: stays
      continue;
    }
    quads.push(quad({ x0: free[0] - eps / 2, y0: free[1] - eps / 2, x1: free[0] + eps / 2, y1: free[1] + eps / 2 }));
  }
  const annot = page.createAnnotation("Redact");
  annot.setQuadPoints(quads);
  page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  return removed;
}
