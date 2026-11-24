// Paths are cut exactly at the Clip edge in every export (ADR 0005, #35): nothing of a
// cut path remains outside, the picture inside stays the same, text keeps glyphs whose
// centre is inside.

import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { exportPdf } from "./pdf";
import { exportSvg } from "./index";
import { TiledPdfExport } from "./tiledpdf";
import { tokenize } from "./contentstream";
import { concat, IDENTITY, type Matrix, type Rect } from "./geometry";
import type { ClipMm } from "./collect";
import { UNITS_PER_MM } from "./ir";

const PT = 72 / 25.4;
const PAGE_H = 300;

/** A Plan with paths of every kind crossing the edges of CLIP (PDF space: x 85–255, y 101.6–243.3). */
function makePlan(withText: boolean): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const hatch = doc.addStream("0 0 0 RG 0.6 w 0 0 m 10 10 l S 0 10 m 10 20 l S\n", {
    Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {},
  });
  const form = doc.addStream("0 0.5 0 RG 1.5 w 0 0 m 100 0 l 100 20 l S\n", {
    Type: "XObject", Subtype: "Form", BBox: [-5, -5, 105, 25], Matrix: [2, 0, 0, 2, 150, 106], Resources: {},
  });
  const res = doc.addObject({
    Font: { F1: font },
    Pattern: { P1: hatch },
    XObject: { Fm1: form },
    ExtGState: { GS1: { LW: 4, LC: 1, D: [[5, 3], 0] }, GS2: { CA: 0.5, ca: 0.5 } },
  });
  const content = [
    "0 0 1 RG 3 w 0 J 20 150 m 380 150 l S", // horizontal line through both sides
    "1 0 0 RG 6 w 1 J 120 130 m 300 180 l S", // round caps, one end inside
    "0 0.4 0 RG 5 w 2 J 60 200 m 150 230 l S", // square caps, one end inside
    "0 G 1.5 w 0 J [6 4] 2 d 40 120 m 300 120 l S", // dashed, butt
    "0 G 3 w 1 J [0 5] 0 d 40 236 m 300 236 l S", // dotted, round
    "0.3 G 4 w 1 J [8 4] 0 d 100 90 m 100 260 l S", // dashed, round, crossing top and bottom
    "[] 0 d 0 J",
    "0.8 0.2 0.2 rg 0 G 2 w 255 210 m 277 210 295 192 295 170 c 295 148 277 130 255 130 c 233 130 215 148 215 170 c 215 192 233 210 255 210 c b", // circle on the right edge
    "0 0.6 0 rg 60 150 60 60 re 70 160 40 40 re f*", // even-odd ring across the left edge
    "/Pattern cs /P1 scn 150 60 80 80 re f", // hatch across the bottom edge
    "q 200 200 100 100 re W n 0 0 1 rg 150 150 200 200 re f Q", // clip path across the top right corner
    "q /Fm1 Do Q", // form with a scale, crossing the right edge
    "q 1 0 0 1 0 -30 cm /Fm1 Do Q", // the same form again, elsewhere
    "q 0 G /GS1 gs 80 110 m 270 140 l S Q", // line settings from an ExtGState
    "q /GS2 gs 0 0 1 rg 1 0 0 RG 8 w 1 J 230 200 m 280 260 l 230 260 l h B Q", // translucent fill + stroke
    "0 G 1 w 20 200 m 100 290 l S", // outside, passing the corner
  ];
  if (withText)
    content.push(
      "0 g BT /F1 20 Tf 203 180 Td (ABCDEFGHIJ) Tj ET", // D crosses the edge, centre inside
      "BT /F1 20 Tf 210 160 Td (ABCDEFGHIJ) Tj ET", // D crosses the edge, centre outside
    );
  const page = doc.addPage([0, 0, 400, PAGE_H], 0, res, content.join("\n"));
  doc.insertPage(-1, page);
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

const CLIP: ClipMm = { x: 30, y: 20, width: 60, height: 50 };

function render(page: mupdf.Page, x: number, y: number, w: number, h: number, pxPerMm: number): Uint8ClampedArray {
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
function diffShare(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, edge = 0): number {
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
function pathPoints(page: mupdf.PDFPage): [number, number][] {
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

const outside = (pts: [number, number][], r: Rect, tol = 1e-3) =>
  pts.filter(([x, y]) => x < r.x0 - tol || x > r.x1 + tol || y < r.y0 - tol || y > r.y1 + tol);

describe("paths are cut at the Clip edge", () => {
  const plan = makePlan(false);
  const textPlan = makePlan(true);
  const original = mupdf.Document.openDocument(plan, "application/pdf").loadPage(0) as mupdf.PDFPage;

  it("the Plan really has content crossing the edge", () => {
    const area = { x0: CLIP.x * PT, y0: CLIP.y * PT, x1: (CLIP.x + CLIP.width) * PT, y1: (CLIP.y + CLIP.height) * PT };
    expect(outside(pathPoints(original), area).length).toBeGreaterThan(20);
  });

  it("PDF: no path coordinate outside, same picture", () => {
    const r = exportPdf(mupdf, plan, { clip: CLIP, sourceName: "plan.pdf", date: new Date(2026, 10, 24) });
    expect(r.uncut).toBe(0);
    const page = mupdf.Document.openDocument(r.pdf, "application/pdf").loadPage(0) as mupdf.PDFPage;
    const area = { x0: 0, y0: 0, x1: CLIP.width * PT, y1: CLIP.height * PT };
    const pts = pathPoints(page);
    expect(pts.length).toBeGreaterThan(50);
    expect(outside(pts, area)).toEqual([]);

    const a = render(original, CLIP.x, CLIP.y, CLIP.width, CLIP.height, 8);
    const b = render(page, 0, 0, CLIP.width, CLIP.height, 8);
    // 8 px/mm; the thickest line is 8 pt (2.8 mm): its half width is 12 px.
    const all = diffShare(a, b, CLIP.width * 8);
    const inner = diffShare(a, b, CLIP.width * 8, 12);
    console.log(`edge-cut PDF: ${(all * 100).toFixed(3)} % of pixels differ, ${(inner * 100).toFixed(3)} % away from the edge`);
    expect(inner).toBeLessThan(0.0005);
    expect(all).toBeLessThan(0.005);
  });

  it("PDF and SVG: a glyph is kept whole if its centre is inside, else removed", () => {
    const r = exportPdf(mupdf, textPlan, { clip: CLIP, sourceName: "plan.pdf", date: new Date() });
    const page = mupdf.Document.openDocument(r.pdf, "application/pdf").loadPage(0);
    const lines = page.toStructuredText("preserve-whitespace").asText().split(/\n/).map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual(["ABCD", "ABC"]);
    const src = mupdf.Document.openDocument(textPlan, "application/pdf").loadPage(0);
    const svg = exportSvg(mupdf, src, { clip: CLIP, textAsPaths: false, mergeMode: "balanced" }).svg;
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(texts).toEqual(["ABCD", "ABC"]);
  });

  it("Tiles: no path coordinate outside the Tile, same picture", () => {
    const tiled = new TiledPdfExport(mupdf, plan, {
      clip: CLIP, page: 0, sourceName: "plan.pdf", date: new Date(), multipage: false, rows: 2, columns: 2, marginMm: 5,
    });
    try {
      for (const [x, y] of [[0, 0], [30, 0], [0, 25], [30, 25]] as const) {
        const t = { name: "A1", row: 0, column: 0, x, y, width: 30, height: 25, sheetWidth: 40, sheetHeight: 35 };
        const pdf = tiled.tile(t)!;
        const page = mupdf.Document.openDocument(pdf, "application/pdf").loadPage(0) as mupdf.PDFPage;
        const area = { x0: 5 * PT, y0: 5 * PT, x1: 35 * PT, y1: 30 * PT };
        expect(outside(pathPoints(page), area)).toEqual([]);
        // A fresh page each time: rendering one page again at another offset shifts the
        // hatch (MuPDF reuses its rendered pattern tile).
        const a = render(mupdf.Document.openDocument(plan, "application/pdf").loadPage(0), CLIP.x + x, CLIP.y + y, 30, 25, 8);
        const b = render(page, 5, 5, 30, 25, 8);
        expect(diffShare(a, b, 30 * 8, 12), `Tile at ${x}, ${y}, away from the edge`).toBeLessThan(0.0005);
        expect(diffShare(a, b, 30 * 8), `Tile at ${x}, ${y}`).toBeLessThan(0.01);
      }
    } finally {
      tiled.destroy();
    }
  });

  it("SVG: no path coordinate outside the Clip", () => {
    const r = exportSvg(mupdf, original, { clip: CLIP, textAsPaths: false, mergeMode: "balanced" });
    const w = CLIP.width * UNITS_PER_MM;
    const h = CLIP.height * UNITS_PER_MM;
    const svg = r.svg.replace(/<pattern[\s\S]*?<\/pattern>/g, "");
    const ds = [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => m[1]!);
    expect(ds.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const d of ds) {
      // relative commands (PathEncoder): track the current point
      let x = 0, y = 0, sx = 0, sy = 0;
      let cmd = "";
      const toks = d.match(/[a-zA-Z]|-?\d+/g)!;
      for (let i = 0; i < toks.length; ) {
        if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
        const n = () => Number(toks[i++]);
        if (cmd === "m") { x += n(); y += n(); sx = x; sy = y; cmd = "l"; }
        else if (cmd === "l") { x += n(); y += n(); }
        else if (cmd === "h") x += n();
        else if (cmd === "v") y += n();
        else if (cmd === "c") { const p = [n(), n(), n(), n()]; for (let k = 0; k < 4; k += 2) if (x + p[k]! < -1 || x + p[k]! > w + 1 || y + p[k + 1]! < -1 || y + p[k + 1]! > h + 1) bad.push(d); x += n(); y += n(); }
        else if (cmd === "z") { x = sx; y = sy; continue; }
        else throw new Error(cmd);
        if (x < -1 || x > w + 1 || y < -1 || y > h + 1) bad.push(`${x},${y}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
