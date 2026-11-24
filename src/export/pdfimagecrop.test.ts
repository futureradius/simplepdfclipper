import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { exportPdf } from "./pdf";
import { tokenize } from "./contentstream";

const PT = 72 / 25.4;
const DATE = new Date(2026, 10, 24);

describe("tokenize", () => {
  it("skips strings, arrays, dicts and inline image data", () => {
    const src = "q 1 0 0 1 5 6 cm (a\\) Q) Tj [(x]) 2] TJ << /A [1 2] /B (>>) >> BDC BI /W 2 /H 1 ID \x00Q\xffcm EI /Im0 Do % c Do\nQ";
    const ops = [...tokenize(new TextEncoder().encode(src))].map((o) => `${o.operands.join(",")}|${o.op}`);
    expect(ops).toEqual(["|q", "1,0,0,1,5,6|cm", "(a\\) Q)|Tj", "[(x]) 2]|TJ", "<< /A [1 2] /B (>>) >>|BDC", "|BI", "/Im0|Do", "|Q"]);
  });
});

/** An A4 "scan": one image, four coloured quadrants with some texture. */
function makeScan(dpi: number, jpeg: boolean, opts: { twice?: boolean; smask?: boolean } = {}): Uint8Array {
  const W = Math.round((210 / 25.4) * dpi);
  const H = Math.round((297 / 25.4) * dpi);
  const COLORS = [[230, 30, 30], [30, 200, 30], [30, 30, 230], [230, 200, 30]];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
  const px = pix.getPixels();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = COLORS[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)]!;
      const t = ((x * 7 + y * 13) % 41) - 20;
      const o = (y * W + x) * 3;
      px[o] = c[0]! + t;
      px[o + 1] = c[1]! + t;
      px[o + 2] = c[2]! + t;
    }
  const doc = new mupdf.PDFDocument();
  let image = jpeg ? new mupdf.Image(pix.asJPEG(80, false)) : new mupdf.Image(pix);
  if (opts.smask) {
    const m = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
    const mp = m.getPixels();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mp[y * W + x] = x < W / 4 ? 0 : 255; // left quarter transparent
    image = new mupdf.Image(pix, new mupdf.Image(m));
  }
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Im0", doc.addImage(image));
  res.put("XObject", xo);
  const pw = 210 * PT, ph = 297 * PT;
  // Used twice: once as the page, once as a half-size copy in the lower right corner.
  const twice = opts.twice ? ` q ${pw / 2} 0 0 ${ph / 2} ${pw / 2} 0 cm /Im0 Do Q` : "";
  doc.insertPage(-1, doc.addPage([0, 0, pw, ph], 0, res, `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q${twice}`));
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

function diffShare(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 64) n++;
  return n / (a.length / 3);
}

/** Pixel sizes of the images drawn on the page. */
function imageSizes(page: mupdf.Page): [number, number][] {
  const out: [number, number][] = [];
  const dev = new mupdf.Device({
    fillImage(image) {
      out.push([image.getWidth(), image.getHeight()]);
    },
  });
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  return out;
}

const open = (bytes: Uint8Array) => mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0);

// Straddles the centre: all four quadrants are visible.
const clip = { x: 80, y: 120, width: 50, height: 60 };

describe("PDF export of a 300 dpi JPEG scan", () => {
  const scan = makeScan(300, true);
  const original = open(scan);
  const pdf = exportPdf(mupdf, scan, { clip, sourceName: "scan.pdf", date: DATE }).pdf;
  const page = open(pdf);

  it("embeds only the pixels inside the Clip, still as JPEG", () => {
    // 50 × 60 mm at 300 dpi ≈ 591 × 709 px, plus a 1 px border each side.
    const [[w, h]] = imageSizes(page) as [[number, number]];
    expect(w).toBeGreaterThanOrEqual(591);
    expect(w).toBeLessThanOrEqual(595);
    expect(h).toBeGreaterThanOrEqual(709);
    expect(h).toBeLessThanOrEqual(713);
    expect(new TextDecoder("latin1").decode(pdf)).toContain("/DCTDecode");
  });

  it("is much smaller than the scan", () => {
    expect(pdf.length).toBeLessThan(scan.length / 4);
  });

  it("renders like the original area", () => {
    const a = render(original, clip.x, clip.y, clip.width, clip.height, 3);
    const b = render(page, 0, 0, clip.width, clip.height, 3);
    expect(diffShare(a, b)).toBeLessThan(0.01);
  });

  it("crops every Tile of a Tiled Export again", () => {
    // Stage 2 of the Tiled Export: a Tile cut out of the Clip PDF, placed on a Sheet.
    const tile = { x: 20, y: 10, width: 30, height: 25 };
    const sheet = exportPdf(mupdf, pdf, { clip: tile, sourceName: "scan.pdf", date: DATE, sheet: { widthMm: 40, heightMm: 35, marginMm: 5, label: "A1" } }).pdf;
    const sp = open(sheet);
    const [[w, h]] = imageSizes(sp) as [[number, number]];
    expect(w).toBeLessThanOrEqual(30 * (300 / 25.4) + 4);
    expect(h).toBeLessThanOrEqual(25 * (300 / 25.4) + 4);
    const a = render(original, clip.x + tile.x, clip.y + tile.y, tile.width, tile.height, 3);
    const b = render(sp, 5, 5, tile.width, tile.height, 3);
    expect(diffShare(a, b)).toBeLessThan(0.01);
  });
});

describe("PDF export of other images", () => {
  it("stores a Flate scan losslessly, cropped", () => {
    const scan = makeScan(150, false);
    const pdf = exportPdf(mupdf, scan, { clip, sourceName: "scan.pdf", date: DATE }).pdf;
    const page = open(pdf);
    const [[w, h]] = imageSizes(page) as [[number, number]];
    expect(w).toBeLessThanOrEqual(300);
    expect(h).toBeLessThanOrEqual(360);
    expect(new TextDecoder("latin1").decode(pdf)).not.toContain("/DCTDecode");
    expect(diffShare(render(open(scan), clip.x, clip.y, clip.width, clip.height, 3), render(page, 0, 0, clip.width, clip.height, 3))).toBeLessThan(0.005);
  });

  it("crops an image used twice to the union of both visible windows", () => {
    // Clip over the lower right: the full-page use and the half-size copy are both visible.
    const c = { x: 150, y: 200, width: 40, height: 50 };
    const scan = makeScan(150, false, { twice: true });
    const pdf = exportPdf(mupdf, scan, { clip: c, sourceName: "scan.pdf", date: DATE }).pdf;
    const page = open(pdf);
    const sizes = imageSizes(page);
    expect(sizes).toHaveLength(2);
    for (const [w, h] of sizes) {
      expect(w).toBeLessThan(1240 / 2);
      expect(h).toBeLessThan(1754 / 2);
    }
    expect(diffShare(render(open(scan), c.x, c.y, c.width, c.height, 3), render(page, 0, 0, c.width, c.height, 3))).toBeLessThan(0.005);
  });

  it("crops the soft mask the same way", () => {
    // Clip across the transparent left quarter's edge (52.5 mm).
    const c = { x: 30, y: 100, width: 50, height: 40 };
    const scan = makeScan(150, false, { smask: true });
    const pdf = exportPdf(mupdf, scan, { clip: c, sourceName: "scan.pdf", date: DATE }).pdf;
    const page = open(pdf);
    const [[w]] = imageSizes(page) as [[number, number]];
    expect(w).toBeLessThanOrEqual(300);
    expect(new TextDecoder("latin1").decode(pdf)).toContain("/SMask");
    expect(diffShare(render(open(scan), c.x, c.y, c.width, c.height, 3), render(page, 0, 0, c.width, c.height, 3))).toBeLessThan(0.005);
  });
});
