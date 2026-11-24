import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;

/** A4 "scan": one textured 300 dpi JPEG covering the page. Returns its pixel size. */
function makeScan(path: string): [number, number] {
  const W = 2480, H = 3508;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
  const px = pix.getPixels();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const t = (x * 7 + y * 13) % 61;
      px[o] = 180 + t;
      px[o + 1] = 120 + t;
      px[o + 2] = x < W / 2 ? 60 + t : 160 + t;
    }
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Im0", doc.addImage(new mupdf.Image(pix.asJPEG(80, false))));
  res.put("XObject", xo);
  const pw = 210 * PT, ph = 297 * PT;
  doc.insertPage(-1, doc.addPage([0, 0, pw, ph], 0, res, `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`));
  writeFileSync(path, doc.saveToBuffer("compress").asUint8Array());
  return [W, H];
}

test("a small Clip of a JPEG scan exports a small PDF with only the visible pixels", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  mkdirSync("test-results", { recursive: true });
  const plan = resolve("test-results/scan-plan.pdf");
  makeScan(plan);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();

  await page.locator("#clip-x").fill("80");
  await page.locator("#clip-y").fill("120");
  await page.locator("#clip-w").fill("50");
  await page.locator("#clip-h").fill("60");
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#export-pdf").click();
  const bytes = readFileSync(await (await download).path());
  expect(bytes.length).toBeLessThan(readFileSync(plan).length / 4);
  const out = mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0);
  const sizes: [number, number][] = [];
  const dev = new mupdf.Device({
    fillImage(image) {
      sizes.push([image.getWidth(), image.getHeight()]);
    },
  });
  out.run(dev, mupdf.Matrix.identity);
  dev.close();
  // 50 × 60 mm at 300 dpi ≈ 591 × 709 px (+ 1 px border).
  expect(sizes).toHaveLength(1);
  expect(sizes[0]![0]).toBeLessThanOrEqual(595);
  expect(sizes[0]![1]).toBeLessThanOrEqual(713);
  expect(errors).toEqual([]);
});
