// Reads Snap targets from the Plan: axis-parallel line segments (from paths) and
// text edges, in mm with the origin at the Plan's top-left corner.

import type * as MuPDF from "mupdf";
import { apply, concat, emptyRect, extend, isEmpty, type Matrix } from "../export/geometry";
import { buildLines, type SnapIndex } from "../ui/snap";

const AXIS_EPS = 0.02; // mm: how far from exactly horizontal/vertical a segment may be
const MIN_LEN = 0.5; // mm: shorter segments are noise (glyph-like details, dots)

export function extractSnapTargets(mupdf: typeof MuPDF, list: MuPDF.DisplayList, pageToMm: Matrix): SnapIndex {
  const v: number[] = [];
  const h: number[] = [];
  const tv: number[] = [];
  const th: number[] = [];

  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    if (Math.abs(x1 - x0) < AXIS_EPS && Math.abs(y1 - y0) >= MIN_LEN) v.push((x0 + x1) / 2, Math.min(y0, y1), Math.max(y0, y1));
    else if (Math.abs(y1 - y0) < AXIS_EPS && Math.abs(x1 - x0) >= MIN_LEN) h.push((y0 + y1) / 2, Math.min(x0, x1), Math.max(x0, x1));
  };

  const walk = (path: MuPDF.Path, ctm: Matrix) => {
    let sx = 0, sy = 0, cx = 0, cy = 0;
    path.walk({
      moveTo(x, y) {
        [cx, cy] = apply(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo(x, y) {
        const [nx, ny] = apply(ctm, x, y);
        segment(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo(_x1, _y1, _x2, _y2, x3, y3) {
        [cx, cy] = apply(ctm, x3, y3);
      },
      closePath() {
        segment(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  };

  /** Text edges: the box around each span (approximate ascent/descent). */
  const text = (t: MuPDF.Text, ctm: Matrix) => {
    let box = emptyRect();
    const flush = () => {
      if (isEmpty(box)) return;
      tv.push(box.x0, box.y0, box.y1, box.x1, box.y0, box.y1);
      th.push(box.y0, box.x0, box.x1, box.y1, box.x0, box.x1);
      box = emptyRect();
    };
    t.walk({
      beginSpan() {
        flush();
      },
      showGlyph(font, trm, gid, _uni, wmode) {
        const m = concat(trm as Matrix, ctm);
        const adv = font.advanceGlyph(gid, wmode);
        for (const [gx, gy] of [
          [0, -0.2],
          [adv, 0.75],
        ] as const) {
          const [px, py] = apply(m, gx, gy);
          extend(box, px, py);
        }
      },
      endSpan() {
        flush();
      },
    });
    flush();
  };

  const dev = new mupdf.Device({
    fillPath(path, _eo, ctm) {
      walk(path, ctm as Matrix);
    },
    strokePath(path, _stroke, ctm) {
      walk(path, ctm as Matrix);
    },
    fillText(t, ctm) {
      text(t, ctm as Matrix);
    },
  });
  try {
    list.run(dev, pageToMm);
    dev.close();
  } finally {
    dev.destroy();
  }
  return { vertical: buildLines(v), horizontal: buildLines(h), textVertical: buildLines(tv), textHorizontal: buildLines(th) };
}
