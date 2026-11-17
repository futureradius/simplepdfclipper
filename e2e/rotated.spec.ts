import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;

/** A4 portrait stored with /Rotate 90 (a "landscape scan"): text near the displayed top-left. */
function makeRotatedPlan(path: string): void {
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  res.put("Font", fonts);
  // Displayed top-left of a page rotated 90° clockwise = stored lower-left corner.
  const content = `0 g 20 20 400 30 re f BT /F1 24 Tf ${30 * PT} ${30 * PT} Td (Gedreht) Tj ET`;
  doc.insertPage(-1, doc.addPage([0, 0, 210 * PT, 297 * PT], 90, res, content));
  writeFileSync(path, doc.saveToBuffer("compress").asUint8Array());
}

test("opens a rotated page as displayed and exports it upright", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  mkdirSync("test-results", { recursive: true });
  const plan = resolve("test-results/rotated-plan.pdf");
  makeRotatedPlan(plan);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  // Shown as displayed: landscape.
  await expect(page.locator("#plan-info")).toContainText("297 × 210 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone

  await page.locator("#clip-x").fill("10");
  await page.locator("#clip-y").fill("150");
  await page.locator("#clip-w").fill("200");
  await page.locator("#clip-h").fill("50");
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#export-pdf").click();
  const file = await download;
  const out = mupdf.Document.openDocument(readFileSync(await file.path()), "application/pdf").loadPage(0) as mupdf.PDFPage;
  const [x0, y0, x1, y1] = out.getBounds();
  expect((x1! - x0!) / PT).toBeCloseTo(200, 1);
  expect((y1! - y0!) / PT).toBeCloseTo(50, 1);
  const rot = out.getObject().get("Rotate");
  expect(rot.isNull() || rot.asNumber() === 0).toBe(true);
  // The Clip is in the displayed lower half; the text is in the displayed top-left.
  expect(out.toStructuredText("preserve-whitespace").asText()).not.toContain("Gedreht");
  expect(errors).toEqual([]);
});
