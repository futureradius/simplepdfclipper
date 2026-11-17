import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { visiblePixels, windowMatrix } from "./imagecrop";
import { exportSvg } from "./index";
import { apply, invert, type Matrix } from "./geometry";
import { UNITS_PER_MM } from "./ir";

const PT = 72 / 25.4;

describe("visiblePixels / windowMatrix", () => {
  const m: Matrix = [1000, 0, 0, 500, 0, 0]; // 100 × 50 px image drawn 1000 × 500 units

  it("keeps the pixels under the visible area plus a 1 px border", () => {
    expect(visiblePixels(m, 100, 50, { x0: 200, y0: 100, x1: 400, y1: 300 })).toEqual({ x0: 19, y0: 9, x1: 41, y1: 31 });
  });

  it("clamps to the image and reports nothing when it is not visible", () => {
    expect(visiblePixels(m, 100, 50, { x0: -50, y0: -50, x1: 5000, y1: 5000 })).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
    expect(visiblePixels(m, 100, 50, { x0: 2000, y0: 0, x1: 3000, y1: 100 })).toBeUndefined();
  });

  it("covers the visible area for a rotated image", () => {
    const rot: Matrix = [0, 1000, -500, 0, 500, 0]; // rotated 90°
    const win = visiblePixels(rot, 100, 50, { x0: 0, y0: 0, x1: 250, y1: 500 })!;
    const wm = windowMatrix(rot, 100, 50, win);
    // The cropped image's corners still span the visible area.
    const xs = [apply(wm, 0, 0), apply(wm, 1, 1)].flatMap(([x]) => [x]);
    expect(Math.min(...xs)).toBeLessThanOrEqual(0);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(250);
  });

  it("draws the window exactly where it was in the whole image", () => {
    const win = { x0: 19, y0: 9, x1: 41, y1: 31 };
    const wm = windowMatrix(m, 100, 50, win);
    expect(apply(wm, 0, 0)).toEqual(apply(m, 0.19, 0.18));
    const [x, y] = apply(wm, 1, 1);
    expect(x).toBeCloseTo(410);
    expect(y).toBeCloseTo(310);
  });
});

/** An A4 "scan": one 150 dpi image with four coloured quadrants. */
function makeScan(): Uint8Array {
  const W = 1240, H = 1754;
  const COLORS = [[230, 30, 30], [30, 200, 30], [30, 30, 230], [230, 200, 30]];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
  const px = pix.getPixels();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = COLORS[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)]!;
      px.set(c, (y * W + x) * 3);
    }
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Im0", doc.addImage(new mupdf.Image(pix)));
  res.put("XObject", xo);
  const pw = 210 * PT, ph = 297 * PT;
  doc.insertPage(-1, doc.addPage([0, 0, pw, ph], 0, res, `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

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

describe("SVG export of a scanned page", () => {
  const scan = mupdf.Document.openDocument(makeScan(), "application/pdf").loadPage(0);
  // Straddles the centre: all four quadrants are visible.
  const clip = { x: 80, y: 120, width: 50, height: 60 };
  const r = exportSvg(mupdf, scan, { clip, mergeMode: "balanced", textAsPaths: false, reuseShapes: true });
  const svg = r.svg;

  it("embeds only the pixels inside the Clip", () => {
    const m = svg.match(/data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)/)!;
    const img = new mupdf.Image(Buffer.from(m[2]!, "base64"));
    // 50 × 60 mm at 150 dpi ≈ 295 × 354 px, plus a 1 px border each side.
    expect(img.getWidth()).toBeLessThanOrEqual(300);
    expect(img.getHeight()).toBeLessThanOrEqual(360);
    expect(svg.length).toBeLessThan(30_000);
  });

  it("places every pixel where the original shows it", () => {
    // MuPDF.js reads no SVG, so sample the embedded image through its transform.
    const m = svg.match(/<image [^>]*transform="matrix\(([^)]*)\)"[^>]*xlink:href="data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)"/)!;
    const wm = m[1]!.split(" ").map(Number) as Matrix;
    const pix = new mupdf.Image(Buffer.from(m[2]!, "base64")).toPixmap();
    const [w, h, n, px] = [pix.getWidth(), pix.getHeight(), pix.getNumberOfComponents(), pix.getPixels()];
    const inv = invert(wm);
    const a = render(scan, clip.x, clip.y, clip.width, clip.height, 2);
    let differing = 0, total = 0;
    for (let ymm = 0.25; ymm < clip.height; ymm += 0.5)
      for (let xmm = 0.25; xmm < clip.width; xmm += 0.5) {
        const [u, v] = apply(inv, xmm * UNITS_PER_MM, ymm * UNITS_PER_MM);
        const i = (Math.floor(v * h) * w + Math.floor(u * w)) * n;
        const j = (Math.floor(ymm * 2) * clip.width * 2 + Math.floor(xmm * 2)) * 3;
        total++;
        if (Math.max(...[0, 1, 2].map((c) => Math.abs(px[i + c]! - a[j + c]!))) > 64) differing++;
      }
    // Only samples right at the quadrant borders may differ.
    expect(differing / total).toBeLessThan(0.02);
  });
});
