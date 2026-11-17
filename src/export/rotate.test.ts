import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { exportPdf } from "./pdf";
import { exportSvg } from "./index";
import { TiledPdfExport } from "./tiledpdf";
import { computeTileGrid, DEFAULT_TILE_SETTINGS, tiles, type TileGrid } from "./tilegrid";
import { apply, invert, type Matrix } from "./geometry";
import { UNITS_PER_MM } from "./ir";

const PT = 72 / 25.4;

/**
 * An A4 portrait page stored with /Rotate: an image (four coloured quadrants), a thick
 * black L in the lower left, a hatch of diagonal lines, and text in two corners.
 * Asymmetric, so any wrong rotation or mirroring shows.
 */
function makePage(rotate: mupdf.Rotate): Uint8Array {
  const W = 124, H = 175; // 15 dpi is enough for colour areas
  const COLORS = [[230, 30, 30], [30, 200, 30], [30, 30, 230], [230, 200, 30]];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
  const px = pix.getPixels();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) px.set(COLORS[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)]!, (y * W + x) * 3);
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Im0", doc.addImage(new mupdf.Image(pix)));
  res.put("XObject", xo);
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  res.put("Font", fonts);
  const pw = 210 * PT, ph = 297 * PT;
  const mm = (v: number) => (v * PT).toFixed(3);
  const content = [
    `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`,
    `0 g ${mm(20)} ${mm(20)} ${mm(80)} ${mm(10)} re f ${mm(20)} ${mm(20)} ${mm(10)} ${mm(120)} re f`,
    `1 w 1 1 1 RG ` + Array.from({ length: 10 }, (_, i) => `${mm(120 + i * 6)} ${mm(150)} m ${mm(150 + i * 6)} ${mm(200)} l`).join(" ") + " S",
    `BT 0 g /F1 30 Tf ${mm(110)} ${mm(260)} Td (OBEN) Tj ET`,
    `BT 0 g /F1 30 Tf ${mm(20)} ${mm(270)} Td (LINKS) Tj ET`,
  ].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, pw, ph], rotate, res, content));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** Renders an area in mm of the page as displayed (rotation applied by MuPDF). */
function render(page: mupdf.Page, x: number, y: number, w: number, h: number, pxPerMm: number): Uint8ClampedArray {
  const k = pxPerMm / PT;
  const [bx0, by0] = page.getBounds();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.round(w * pxPerMm), Math.round(h * pxPerMm)], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice([k, 0, 0, k, -bx0! * k - x * pxPerMm, -by0! * k - y * pxPerMm], pix);
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  return pix.getPixels().slice();
}

/** Image pixels touching the outside are whitened by the redaction; the test image has 1.7 mm pixels. */
const EDGE = 2;

/** Share of differing pixels between two pages' areas, without the EDGE border. */
function compare(p: mupdf.Page, x: number, y: number, q: mupdf.Page, qx: number, qy: number, w: number, h: number): number {
  return differing(render(p, x + EDGE, y + EDGE, w - 2 * EDGE, h - 2 * EDGE, 2), render(q, qx + EDGE, qy + EDGE, w - 2 * EDGE, h - 2 * EDGE, 2));
}

function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3)
    if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 64) n++;
  return n / (a.length / 3);
}

describe.each([0, 90, 180, 270] as mupdf.Rotate[])("page with /Rotate %i", (rotate) => {
  const bytes = makePage(rotate);
  const original = mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0);
  const [bx0, by0, bx1, by1] = original.getBounds();
  const widthMm = (bx1! - bx0!) / PT;
  const heightMm = (by1! - by0!) / PT;
  // Lower-right two thirds of the page as displayed: crosses the image quadrants, the L, the hatch, one text.
  const clip = { x: widthMm / 3, y: heightMm / 3, width: (widthMm * 2) / 3, height: (heightMm * 2) / 3 };
  const date = new Date(2026, 10, 17);

  it("exports an upright PDF page that looks like the displayed area", () => {
    const r = exportPdf(mupdf, bytes, { clip, page: 0, sourceName: "rot.pdf", date });
    const page = mupdf.Document.openDocument(r.pdf, "application/pdf").loadPage(0) as mupdf.PDFPage;
    const rot = page.getObject().get("Rotate");
    expect(rot.isNull() || rot.asNumber() === 0).toBe(true);
    const [x0, y0, x1, y1] = page.getBounds();
    expect((x1! - x0!) / PT).toBeCloseTo(clip.width, 1);
    expect((y1! - y0!) / PT).toBeCloseTo(clip.height, 1);
    expect(compare(original, clip.x, clip.y, page, 0, 0, clip.width, clip.height)).toBeLessThan(0.005);
    // Float leftovers (1e-13) once came out as exponent notation, which PDF can't read: blank page.
    const content = page.getObject().get("Contents");
    const first = content.isArray() ? content.get(0) : content;
    expect(first.readStream().asString()).not.toMatch(/de[-+]?d/);
  });

  it("removes text outside the Clip", () => {
    const r = exportPdf(mupdf, bytes, { clip, page: 0, sourceName: "rot.pdf", date });
    const page = mupdf.Document.openDocument(r.pdf, "application/pdf").loadPage(0);
    const kept = page.toStructuredText("preserve-whitespace").asText();
    for (const word of ["OBEN", "LINKS"]) {
      // Where the word is displayed (page space, pt): kept exactly if it lies in the Clip.
      const q = original.search(word, "")[0]![0]!;
      const cx = ((q[0] + q[2] + q[4] + q[6]) / 4 - bx0!) / PT;
      const cy = ((q[1] + q[3] + q[5] + q[7]) / 4 - by0!) / PT;
      const inside = cx > clip.x && cx < clip.x + clip.width && cy > clip.y && cy < clip.y + clip.height;
      expect(kept.includes(word), word).toBe(inside);
    }
  });

  it("cuts Tiles out of the rotated page the same way", () => {
    const g = computeTileGrid(clip.width, clip.height, {
      ...DEFAULT_TILE_SETTINGS,
      enabled: true,
      mode: "free",
      columns: { lead: "count", count: 2, lengthMm: 1 },
      rows: { lead: "count", count: 1, lengthMm: 1 },
      marginMm: 0,
    }) as TileGrid;
    const job = { clip, page: 0, sourceName: "rot.pdf", date, multipage: false, rows: 1, columns: 2, marginMm: 0 };
    const t = new TiledPdfExport(mupdf, bytes, job);
    const second = tiles(g)[1]!;
    const page = mupdf.Document.openDocument(t.tile(second)!, "application/pdf").loadPage(0);
    expect(compare(original, clip.x + second.x, clip.y + second.y, page, 0, 0, second.width, second.height)).toBeLessThan(0.005);
  });

  it("places the image in the SVG where it is displayed", () => {
    const r = exportSvg(mupdf, original, { clip, mergeMode: "balanced", textAsPaths: false, reuseShapes: true });
    const m = r.svg.match(/<image [^>]*transform="matrix\(([^)]*)\)"[^>]*xlink:href="data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)"/)!;
    const inv = invert(m[1]!.split(" ").map(Number) as Matrix);
    const pix = new mupdf.Image(Buffer.from(m[2]!, "base64")).toPixmap();
    const [w, h, n, px] = [pix.getWidth(), pix.getHeight(), pix.getNumberOfComponents(), pix.getPixels()];
    // Sample the image only, away from the drawn shapes: render the original without them is
    // not possible, so compare colour classes at points where the image is uncovered.
    const a = render(original, clip.x, clip.y, clip.width, clip.height, 1);
    let same = 0, total = 0;
    for (let ymm = 0.5; ymm < clip.height - 1; ymm += 3)
      for (let xmm = 0.5; xmm < clip.width - 1; xmm += 3) {
        const j = (Math.floor(ymm) * Math.round(clip.width) + Math.floor(xmm)) * 3;
        if (a[j] === 0 && a[j + 1] === 0 && a[j + 2] === 0) continue; // black shapes or text
        if (a[j]! > 240 && a[j + 1]! > 240 && a[j + 2]! > 240) continue; // white hatch
        const [u, v] = apply(inv, xmm * UNITS_PER_MM, ymm * UNITS_PER_MM);
        const i = (Math.min(h - 1, Math.floor(v * h)) * w + Math.min(w - 1, Math.floor(u * w))) * n;
        total++;
        if (Math.max(...[0, 1, 2].map((c) => Math.abs(px[i + c]! - a[j + c]!))) < 64) same++;
      }
    expect(total).toBeGreaterThan(100);
    expect(same / total).toBeGreaterThan(0.95);
  });
});
