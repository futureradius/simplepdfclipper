// Helpers for export tests: render a page region, compare pictures, list path points.

import * as mupdf from "mupdf";
import { tokenize } from "../export/contentstream";
import { concat, IDENTITY, type Matrix, type Rect } from "../export/geometry";

const PT = 72 / 25.4;

export function render(page: mupdf.Page, x: number, y: number, w: number, h: number, pxPerMm: number): Uint8ClampedArray {
  const k = pxPerMm / PT;
  const [bx0, by0] = page.getBounds();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.round(w * pxPerMm), Math.round(h * pxPerMm)], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice([k, 0, 0, k, -bx0! * k - x * pxPerMm, -by0! * k - y * pxPerMm], pix);
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  const px = pix.getPixels().slice();
  pix.destroy();
  return px;
}

/**
 * Share of differing pixels, ignoring a band of `edge` px along the border: a stroke
 * cut at the edge loses the ink its parts outside put inside (caps, line width).
 */
export function diffShare(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, edge = 0): number {
  const height = a.length / 3 / width;
  let n = 0;
  let total = 0;
  for (let y = edge; y < height - edge; y++)
    for (let x = edge; x < width - edge; x++) {
      const i = (y * width + x) * 3;
      total++;
      if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 64) n++;
    }
  return n / total;
}

/** Every path coordinate on the page (first content stream, forms followed), in MuPDF page space. */
export function pathPoints(page: mupdf.PDFPage): [number, number][] {
  const pts: [number, number][] = [];
  const walk = (buf: Uint8Array, res: mupdf.PDFObject, ctm: Matrix) => {
    const stack: Matrix[] = [];
    let m = ctm;
    for (const { op, operands } of tokenize(buf)) {
      const o = operands.map(Number);
      if (op === "q") stack.push(m);
      else if (op === "Q") m = stack.pop() ?? m;
      else if (op === "cm") m = concat(o as Matrix, m);
      else if (op === "re") {
        for (const [x, y] of [[o[0]!, o[1]!], [o[0]! + o[2]!, o[1]! + o[3]!]]) pts.push([x! * m[0] + y! * m[2] + m[4], x! * m[1] + y! * m[3] + m[5]]);
      } else if (["m", "l", "c", "v", "y"].includes(op)) {
        for (let k = 0; k + 1 < o.length; k += 2) pts.push([o[k]! * m[0] + o[k + 1]! * m[2] + m[4], o[k]! * m[1] + o[k + 1]! * m[3] + m[5]]);
      } else if (op === "Do") {
        const ref = res.get("XObject").get(operands[0]!.slice(1));
        const f = ref.resolve();
        if (f.get("Subtype").asName() !== "Form") continue;
        const fm = f.get("Matrix");
        const mat = fm.isArray() ? ([0, 1, 2, 3, 4, 5].map((i) => fm.get(i).asNumber()) as Matrix) : IDENTITY;
        const fr = f.get("Resources");
        walk(ref.readStream().asUint8Array(), fr.isDictionary() ? fr : res, concat(mat, m));
      }
    }
  };
  const obj = page.getObject();
  const c = obj.get("Contents");
  walk((c.isArray() ? c.get(0) : c).readStream().asUint8Array(), obj.getInheritable("Resources"), page.getTransform() as Matrix);
  return pts;
}

export const outside = (pts: [number, number][], r: Rect, tol = 1e-3) =>
  pts.filter(([x, y]) => x < r.x0 - tol || x > r.x1 + tol || y < r.y0 - tol || y > r.y1 + tol);
