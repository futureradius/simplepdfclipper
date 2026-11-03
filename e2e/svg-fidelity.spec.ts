// Visual check of the SVG export: renders the Clip with MuPDF (reference) and the
// exported SVGs in Edge, and compares pixels. Writes diff images to samples/out/.

import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { exportSvg, type ClipMm, type MergeMode } from "../src/export/index";

const PLAN = "samples/test-plan.pdf";
const PX_PER_MM = 3;
const CLIP: ClipMm = { x: 0, y: 2000, width: 1188.9, height: 600 };

function renderReference(page: mupdf.Page, clip: ClipMm): Uint8Array {
  const w = Math.round(clip.width * PX_PER_MM);
  const h = Math.round(clip.height * PX_PER_MM);
  const s = (PX_PER_MM * 25.4) / 72;
  const [bx0, by0] = page.getBounds();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice([s, 0, 0, s, -bx0! * s - clip.x * PX_PER_MM, -by0! * s - clip.y * PX_PER_MM], pix);
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  const png = pix.asPNG().slice();
  pix.destroy();
  return png;
}

test("exported SVG looks like the PDF", async ({ page }) => {
  test.skip(!existsSync(PLAN), "run `npm run testplan` first");
  const doc = mupdf.Document.openDocument(readFileSync(PLAN), "application/pdf");
  const pdfPage = doc.loadPage(0);
  const ref = renderReference(pdfPage, CLIP);
  const svgs: Record<MergeMode, string> = {
    exact: exportSvg(mupdf, pdfPage, { clip: CLIP, textAsPaths: false, mergeMode: "exact" }).svg,
    balanced: exportSvg(mupdf, pdfPage, { clip: CLIP, textAsPaths: false, mergeMode: "balanced" }).svg,
    max: exportSvg(mupdf, pdfPage, { clip: CLIP, textAsPaths: false, mergeMode: "max" }).svg,
  };
  const outlines = exportSvg(mupdf, pdfPage, { clip: CLIP, textAsPaths: true, mergeMode: "balanced" }).svg;

  const w = Math.round(CLIP.width * PX_PER_MM);
  const h = Math.round(CLIP.height * PX_PER_MM);
  const images: Record<string, string> = {
    reference: `data:image/png;base64,${Buffer.from(ref).toString("base64")}`,
    exact: `data:image/svg+xml;base64,${Buffer.from(svgs.exact).toString("base64")}`,
    balanced: `data:image/svg+xml;base64,${Buffer.from(svgs.balanced).toString("base64")}`,
    max: `data:image/svg+xml;base64,${Buffer.from(svgs.max).toString("base64")}`,
    outlines: `data:image/svg+xml;base64,${Buffer.from(outlines).toString("base64")}`,
  };

  const { out: result, ink } = await page.evaluate(
    async ({ images, w, h, pairs }) => {
      const load = (src: string) =>
        new Promise<ImageData>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const ctx = c.getContext("2d")!;
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(ctx.getImageData(0, 0, w, h));
          };
          img.onerror = () => reject(new Error("image failed to load"));
          img.src = src;
        });
      const data: Record<string, ImageData> = {};
      for (const [k, v] of Object.entries(images)) data[k] = await load(v);
      // Robust "is everything there?" measures that do not depend on how thin
      // grey lines are anti-aliased: clearly red pixels (hatching, red lines) and
      // strongly dark pixels (text, black outlines, bars).
      const ink: Record<string, { red: number; dark: number }> = {};
      for (const [k, v] of Object.entries(data)) {
        let red = 0;
        let dark = 0;
        const d = v.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i]! > 140 && d[i + 1]! < 130 && d[i + 2]! < 130) red++;
          if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) < 110) dark++;
        }
        ink[k] = { red, dark };
      }
      const out: Record<string, { diffShare: number; diffPng: string }> = {};
      for (const [a, b] of pairs) {
        const A = data[a]!.data;
        const B = data[b]!.data;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        const diff = ctx.createImageData(w, h);
        let n = 0;
        for (let i = 0; i < A.length; i += 4) {
          const d = Math.max(Math.abs(A[i]! - B[i]!), Math.abs(A[i + 1]! - B[i + 1]!), Math.abs(A[i + 2]! - B[i + 2]!));
          const bad = d > 64;
          if (bad) n++;
          // diff image: faint copy of A, differing pixels in magenta
          const g = 255 - (255 - A[i]!) / 4;
          diff.data[i] = bad ? 255 : g;
          diff.data[i + 1] = bad ? 0 : g;
          diff.data[i + 2] = bad ? 255 : g;
          diff.data[i + 3] = 255;
        }
        ctx.putImageData(diff, 0, 0);
        out[`${a}-vs-${b}`] = { diffShare: n / (w * h), diffPng: c.toDataURL("image/png") };
      }
      return { out, ink };
    },
    {
      images,
      w,
      h,
      pairs: [
        ["reference", "exact"],
        ["exact", "balanced"],
        ["exact", "max"],
        ["reference", "outlines"],
      ] as [string, string][],
    },
  );

  mkdirSync("samples/out", { recursive: true });
  writeFileSync("samples/out/reference.png", ref);
  for (const [name, r] of Object.entries(result)) {
    writeFileSync(`samples/out/diff-${name}.png`, Buffer.from(r.diffPng.split(",")[1]!, "base64"));
    console.log(`${name}: ${(r.diffShare * 100).toFixed(3)} % of pixels differ`);
  }

  for (const [k, n] of Object.entries(ink)) console.log(`ink ${k}: red ${n.red}, dark ${n.dark}`);
  // Nothing may go missing: e.g. hatched areas (tiling patterns) must be there.
  expect(svgs.balanced).toContain("<pattern");
  for (const k of ["exact", "balanced", "max", "outlines"]) {
    for (const m of ["red"] as const) { // "dark" mostly measures text rasterisation (Edge vs MuPDF), so it is only logged
      const ratio = ink[k]![m] / ink.reference![m];
      // Missing hatching would push this towards 0; anti-aliasing of tile seams varies by ~20 %.
      expect(ratio, `${m} pixels ${k} vs reference`).toBeGreaterThan(0.7);
      expect(ratio, `${m} pixels ${k} vs reference`).toBeLessThan(1.3);
    }
  }
  // "Exakt" and "Ausgewogen" may differ only where lines cross lines.
  expect(result["exact-vs-balanced"]!.diffShare).toBeLessThan(0.0005);
  // The SVG must look like the PDF (allowing for font rasterisation differences).
  expect(result["reference-vs-exact"]!.diffShare).toBeLessThan(0.01);
});
