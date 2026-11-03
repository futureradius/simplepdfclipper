import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { exportPdf } from "./pdf";
import type { ClipMm } from "./collect";

const PLAN = "samples/test-plan.pdf";
const PT_TO_MM = 25.4 / 72;
const have = existsSync(PLAN);

function render(page: mupdf.Page, x: number, y: number, w: number, h: number, pxPerMm: number): Uint8ClampedArray {
  const k = pxPerMm * PT_TO_MM;
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

function diffShare(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 64) n++;
  return n / (a.length / 3);
}

describe.skipIf(!have)("PDF export on the Test Plan", () => {
  const bytes = have ? new Uint8Array(readFileSync(PLAN)) : new Uint8Array();
  const original = have ? mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0) : undefined;

  it("removes everything outside the Clip, keeps the inside identical, normalises UserUnit", () => {
    const clip: ClipMm = { x: 0, y: 2000, width: 1188.9, height: 600 };
    const t = performance.now();
    const r = exportPdf(mupdf, bytes, { clip, sourceName: "test-plan.pdf", date: new Date(2026, 10, 3) });
    console.log(`PDF export: ${(r.pdf.length / 1e6).toFixed(2)} MB (Plan ${(bytes.length / 1e6).toFixed(2)} MB), ${((performance.now() - t) / 1000).toFixed(1)} s`);
    mkdirSync("samples/out", { recursive: true });
    writeFileSync("samples/out/test-plan_Ausschnitt.pdf", r.pdf);
    expect(r.normalised).toBe(true);

    const out = mupdf.Document.openDocument(r.pdf, "application/pdf") as mupdf.PDFDocument;
    const page = out.loadPage(0) as mupdf.PDFPage;
    const [x0, y0, x1, y1] = page.getBounds();
    expect((x1! - x0!) * PT_TO_MM).toBeCloseTo(1188.9, 1);
    expect((y1! - y0!) * PT_TO_MM).toBeCloseTo(600, 1);
    expect(page.getObject().get("UserUnit").isNull()).toBe(true);
    expect(out.getMetaData("info:Subject")).toContain("oben 2000,0 mm");

    // Same picture as the original area (3 px/mm).
    const a = render(original!, 0, 2000, 1188.9, 600, 3);
    const b = render(page, 0, 0, 1188.9, 600, 3);
    const d = diffShare(a, b);
    console.log(`pixels differing from the original area: ${(d * 100).toFixed(3)} %`);
    expect(d).toBeLessThan(0.001);

    // Text outside the Clip is gone from the file, not just hidden.
    const text = page.toStructuredText("preserve-whitespace").asText();
    expect(text).toContain("Bahnsteig"); // text inside
    expect(text).not.toContain("Bauablaufplan"); // title at the top, outside
    const raw = new TextDecoder("latin1").decode(out.saveToBuffer("decompress").asUint8Array());
    expect(raw).not.toContain("Bauablaufplan");
    expect(raw).not.toContain("Testplan (generiert)");
    // Most of the drawing operations are gone.
    expect(r.pdf.length).toBeLessThan(bytes.length / 4);
  }, 120_000);

  it("keeps UserUnit for Clips longer than 5,080 mm", () => {
    const clip: ClipMm = { x: 100, y: 1000, width: 600, height: 6000 };
    const r = exportPdf(mupdf, bytes, { clip, sourceName: "test-plan.pdf", date: new Date() });
    expect(r.normalised).toBe(false);
    const page = mupdf.Document.openDocument(r.pdf, "application/pdf").loadPage(0) as mupdf.PDFPage;
    const [x0, y0, x1, y1] = page.getBounds();
    expect((x1! - x0!) * PT_TO_MM).toBeCloseTo(600, 1);
    expect((y1! - y0!) * PT_TO_MM).toBeCloseTo(6000, 1);
    expect(page.getObject().get("UserUnit").asNumber()).toBeCloseTo(2.809, 2);
    const a = render(original!, 100, 1000, 600, 6000, 0.5);
    const b = render(page, 0, 0, 600, 6000, 0.5);
    expect(diffShare(a, b)).toBeLessThan(0.001);
  }, 120_000);
});
