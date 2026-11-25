import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { makeMultiPageDocument } from "../src/testing/multipage";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;

function pdfText(path: string): { pages: number; text: string } {
  const doc = mupdf.Document.openDocument(readFileSync(path), "application/pdf");
  return { pages: doc.countPages(), text: doc.loadPage(0).toStructuredText("preserve-whitespace").asText() };
}

function makeSinglePage(path: string): void {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 200 * PT, 100 * PT], 0, doc.newDictionary(), "0 g 10 10 50 50 re f"));
  writeFileSync(path, doc.saveToBuffer("compress").asUint8Array());
}

test("multi-page Document: page picker, page switching, exports of the chosen page", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  mkdirSync("test-results", { recursive: true });
  const multi = resolve("test-results/mehrseitig.pdf");
  writeFileSync(multi, makeMultiPageDocument());
  const single = resolve("test-results/einseitig.pdf");
  makeSinglePage(single);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });

  const picker = page.locator("#pages");
  const thumbs = page.locator("#pages-grid .thumb");

  // First open: the picker shows every page; "Abbrechen" returns to the start screen.
  await page.locator("#file").setInputFiles(multi);
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#pages-info")).toHaveText("mehrseitig.pdf · 3 Seiten");
  await expect(thumbs).toHaveCount(3);
  await expect(thumbs.nth(1)).toContainText("Seite 2");
  await expect(page.locator("#pages-grid .thumb.ready")).toHaveCount(3, { timeout: 30_000 });
  // Proportions follow the pages: page 2 is landscape A3.
  const t1 = (await thumbs.nth(0).locator("canvas").boundingBox())!;
  const t2 = (await thumbs.nth(1).locator("canvas").boundingBox())!;
  expect(t1.height / t1.width).toBeCloseTo(297 / 210, 1);
  expect(t2.width / t2.height).toBeCloseTo(420 / 297, 1);
  await page.screenshot({ path: "test-results/page-picker.png" });
  await page.locator("#pages-cancel").click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#start")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();

  // Pick page 2.
  await page.locator("#file").setInputFiles(multi);
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await thumbs.nth(1).click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#plan-info")).toContainText("420 × 297 mm · geladen in", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
  await expect(page.locator("#pager")).toBeVisible();
  await expect(page.locator("#page-pick")).toHaveText("Seite 2 von 3");
  await expect(page.locator("#plan-details")).toContainText("Seiten3");

  // Export: only page 2, named after it.
  await page.locator("#clip-x").fill("10");
  await page.locator("#clip-y").fill("10");
  await page.locator("#clip-w").fill("150");
  await page.locator("#clip-h").fill("60");
  let download = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#export-pdf").click();
  let file = await download;
  expect(file.suggestedFilename()).toBe("mehrseitig_S2_Ausschnitt.pdf");
  const pdf = pdfText(await file.path());
  expect(pdf.pages).toBe(1);
  expect(pdf.text).toContain("SEITE ZWEI");
  await page.screenshot({ path: "test-results/multipage.png" });

  // ▶: page 3, smaller: the Clip is stretched to it with a note (ADR 0007).
  await page.locator("#page-next").click();
  await expect(page.locator("#page-pick")).toHaveText("Seite 3 von 3");
  await expect(page.locator("#plan-info")).toContainText("297 × 210 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
  await expect(page.locator("#page-next")).toBeDisabled();
  await expect(page.locator("#page-prev")).toBeEnabled();
  expect(await page.locator("#clip-w").inputValue()).toBe("106.1"); // 150 × 297 / 420
  await expect(page.locator("#stretch-text")).toHaveText(
    "Bereiche an die Plangröße angepasst: horizontal um −29,3 % gestaucht, vertikal um −29,3 % gestaucht. Bitte prüfen.",
  );

  // Reopen the picker from step 1: the current page is marked; Escape keeps it.
  await page.locator("#page-pick").click();
  await expect(picker).toBeVisible();
  await expect(page.locator("#pages-grid .thumb.current")).toContainText("Seite 3");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(page.locator("#page-pick")).toHaveText("Seite 3 von 3");

  // Pick page 1 in the picker; SVG export of page 1.
  await page.locator("#page-pick").click();
  await thumbs.nth(0).click();
  await expect(page.locator("#page-pick")).toHaveText("Seite 1 von 3");
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
  await expect(page.locator("#page-prev")).toBeDisabled();
  download = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#export-svg").click();
  file = await download;
  expect(file.suggestedFilename()).toBe("mehrseitig_S1_Ausschnitt.svg");
  const svg = readFileSync(await file.path(), "utf8");
  expect(svg).toContain("EINS");
  expect(svg).not.toContain("ZWEI");

  // A Clip wider than the new page is stretched to it, no longer reset (ADR 0007).
  await page.locator("#page-next").click();
  await expect(page.locator("#page-pick")).toHaveText("Seite 2 von 3");
  await expect(page.locator("#plan-info")).toContainText("420 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
  await page.locator("#clip-x").fill("0");
  await page.locator("#clip-w").fill("400");
  await page.locator("#page-next").click(); // page 3 is 297 mm wide
  await expect(page.locator("#plan-info")).toContainText("297 × 210 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
  expect(await page.locator("#clip-w").inputValue()).toBe("282.9"); // 400 × 297 / 420
  await expect(page.locator("#stretch-note")).toBeVisible();

  // A single-page file opens straight away, without page controls or page in the name.
  await page.locator("#file").setInputFiles(single);
  await expect(page.locator("#plan-info")).toContainText("200 × 100 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
  await expect(picker).toBeHidden();
  await expect(page.locator("#pager")).toBeHidden();
  download = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#export-pdf").click();
  expect((await download).suggestedFilename()).toBe("einseitig_Ausschnitt.pdf");

  // Cancelling the picker for another file keeps the current Plan.
  await page.locator("#file").setInputFiles(multi);
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await page.locator("#pages-cancel").click();
  await expect(page.locator("#plan-name")).toHaveText("einseitig.pdf");
  await expect(page.locator("#plan-info")).toContainText("200 × 100 mm");
  download = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#export-pdf").click();
  expect(pdfText(await (await download).path()).pages).toBe(1);

  expect(errors).toEqual([]);
});
