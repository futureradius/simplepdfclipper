// The "Anordnen" view (ADR 0016): the Clip as exported, Regions moved in it with
// snapping, stopping at each other, growing the Clip past its start; exported as
// arranged in PDF, SVG and the Tiled Export (with an empty Sheet). A new Region is
// placed where it lies on the Plan; the Region list is reordered by dragging.

import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;
const W = 210;
const H = 297;

const num = async (page: Page, sel: string) => Number(await page.locator(sel).inputValue());
const near = (v: number, want: number, tol = 0.05) => expect(Math.abs(v - want), `${v} ≈ ${want}`).toBeLessThan(tol);

/** An A4 Plan with a word in each Region and one between them. */
function makePlan(): string {
  mkdirSync("test-results", { recursive: true });
  const file = resolve("test-results/arrange-plan.pdf");
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  res.put("Font", fonts);
  const text = (s: string, x: number, y: number) => `BT /F1 20 Tf ${x * PT} ${(H - y) * PT} Td (${s}) Tj ET`;
  const content = ["0 g", text("ALPHA", 15, 30), text("BETA", 45, 180), text("ZWISCHEN", 90, 100)].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, W * PT, H * PT], 0, res, content));
  writeFileSync(file, doc.saveToBuffer("compress").asUint8Array());
  return file;
}

/** Where a word lies on the first page of a PDF, in mm from the top-left corner. */
function wordAt(pdf: Uint8Array, word: string): { x: number; y: number } | undefined {
  const page = mupdf.Document.openDocument(pdf, "application/pdf").loadPage(0);
  const hit = page.search(word, "")[0]?.[0];
  return hit ? { x: hit[0]! / PT, y: hit[1]! / PT } : undefined;
}

test("Regions are arranged in the Anordnen view and exported as arranged", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  const plan = makePlan();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => void delete (window as unknown as Record<string, unknown>).showSaveFilePicker); // headless: download fallback
  await page.goto(APP);
  // Two Regions, stacked: ALPHA (60 × 30) above BETA (50 × 30).
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "simplepdfclipper.lastRegions",
      JSON.stringify([
        { x: 10, y: 10, width: 60, height: 30, at: { x: 0, y: 0 } },
        { x: 40, y: 160, width: 50, height: 30, at: { x: 0, y: 30 } },
      ]),
    );
  });
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();

  const items = page.locator("#regions li");
  await expect(items).toHaveCount(2);
  await expect(page.locator("#modes")).toBeVisible();
  await expect(page.locator("#mode-plan")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#hint-plan")).toBeVisible();

  // Switching modes: the button, B and A.
  await page.locator("#mode-arrange").click();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "arrange");
  await page.keyboard.press("b");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "plan");
  await page.keyboard.press("a");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "arrange");
  await expect(page.locator("#mode-arrange")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#hint-arrange")).toBeVisible();
  await expect(page.locator("#zoom-plan")).toHaveText("Ganzer Ausschnitt");
  await expect(page.locator("#fields-caption")).toHaveText("Bereich 1 im Ausschnitt");
  await expect(page.locator("#clip-w")).toHaveJSProperty("readOnly", true);
  await expect(page.locator("#clip-x")).toHaveJSProperty("readOnly", false);
  await expect(page.locator("#clip-size")).toContainText("60 × 60 mm");

  // Layout mm -> screen px at the whole-Clip view ("1": 2 % margin, centred).
  const canvas = (await page.locator("#viewer-canvas").boundingBox())!;
  let map = (x: number, y: number) => ({ x, y });
  const fit = async (w: number, h: number) => {
    await page.locator("#zoom-plan").click();
    const zoom = Math.min(canvas.width / (w * 1.04), canvas.height / (h * 1.04));
    map = (x, y) => ({ x: canvas.x + canvas.width / 2 + (x - w / 2) * zoom, y: canvas.y + canvas.height / 2 + (y - h / 2) * zoom });
  };
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    const a = map(x0, y0);
    const b = map(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
  };
  await fit(60, 60);
  await page.screenshot({ path: "test-results/arrange-start.png" });

  // BETA dragged up and to the right of ALPHA: it stops at ALPHA on the way, then snaps
  // to ALPHA's right edge and the Clip's top.
  await drag(25, 45, 85.3, 15.2);
  await expect(items.nth(1)).toHaveClass(/selected/);
  near(await num(page, "#clip-x"), 60);
  near(await num(page, "#clip-y"), 0);
  await expect(page.locator("#clip-size")).toContainText("110 × 30 mm");
  await page.screenshot({ path: "test-results/arrange-side.png" });

  // Arrow keys move it in the Clip; Entf does nothing here.
  await page.keyboard.press("Shift+ArrowDown");
  near(await num(page, "#clip-y"), 1);
  await expect(page.locator("#clip-size")).toContainText("110 × 31 mm");
  await page.keyboard.press("Shift+ArrowUp");
  near(await num(page, "#clip-y"), 0);
  await page.keyboard.press("Delete");
  await expect(items).toHaveCount(2);

  // ALPHA down by 40, then past the Clip's left edge by 30: the Clip grows to the left.
  await page.locator("#snap").uncheck();
  await fit(110, 30);
  await drag(30, 15, 30, 55);
  await expect(items.nth(0)).toHaveClass(/selected/);
  near(await num(page, "#clip-y"), 40, 0.2);
  await page.locator("#clip-y").fill("40"); // exact again (typed position)
  await page.locator("#clip-y").press("Enter");
  await page.locator("#clip-y").blur();
  await expect(page.locator("#clip-size")).toContainText("110 × 70 mm");
  await fit(110, 70);
  await drag(30, 55, 0, 55);
  near(await num(page, "#clip-x"), 0); // ALPHA starts the Clip again…
  await page.locator("#regions .pick").nth(1).click();
  near(await num(page, "#clip-x"), 90, 0.2); // …and BETA moved right with everything else
  await expect(page.locator("#clip-size")).toContainText("140 × 70 mm");
  await page.screenshot({ path: "test-results/arrange-grown.png" });
  // A typed position jumps there if it is free.
  await page.locator("#clip-x").fill("30");
  await page.locator("#clip-x").blur();
  await expect(page.locator("#clip-size")).toContainText("80 × 70 mm");

  // PDF: one page the size of the arranged Clip, each word where its Region now is.
  const pdfDownload = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  const pdf = readFileSync(await (await pdfDownload).path());
  const out = mupdf.Document.openDocument(pdf, "application/pdf").loadPage(0);
  const [x0, y0, x1, y1] = out.getBounds();
  expect((x1! - x0!) / PT).toBeCloseTo(80, 0);
  expect((y1! - y0!) / PT).toBeCloseTo(70, 0);
  const alpha = wordAt(pdf, "ALPHA")!;
  const beta = wordAt(pdf, "BETA")!;
  expect(alpha.y).toBeGreaterThan(40); // ALPHA's Region at (0, 40)
  expect(alpha.x).toBeLessThan(30);
  expect(beta.x).toBeGreaterThan(30); // BETA's Region at (30, 0)
  expect(beta.y).toBeLessThan(30);
  expect(wordAt(pdf, "ZWISCHEN")).toBeUndefined();

  const svgDownload = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-svg").click();
  const svg = readFileSync(await (await svgDownload).path(), "utf8");
  expect(svg).toContain('width="80mm" height="70mm"');
  expect(svg).toContain("ALPHA");
  expect(svg).toContain("BETA");
  expect(svg).not.toContain("ZWISCHEN");

  // Tiled Export of the arranged Clip: 25 × 35 mm Tiles, so A1 (top left) is empty but still a Sheet.
  await page.locator("#tiles-on").check({ force: true });
  await page.locator("label:has(input[value=free]) span").click();
  await page.locator("#tiles-col-w").fill("25");
  await page.locator("#tiles-row-h").fill("35");
  await expect(page.locator("#tiles-summary")).toContainText("4 Spalten × 2 Zeilen = 8 Blätter");
  await page.screenshot({ path: "test-results/arrange-tiles.png" });
  await page.locator("input[name=tiles-output][value=multipage]").check();
  const book = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  const bookDoc = mupdf.Document.openDocument(readFileSync(await (await book).path()), "application/pdf");
  expect(bookDoc.countPages()).toBe(8);
  const words = (i: number) => bookDoc.loadPage(i).toStructuredText("preserve-whitespace").asText();
  expect(words(0).replace("A1", "").trim()).toBe(""); // only its label in the margin
  const all = Array.from({ length: 8 }, (_, i) => words(i)).join(" ");
  expect(all).toMatch(/ALPH/); // the words are cut between Tiles
  expect(all).toMatch(/BET/);
  expect(all).not.toContain("ZWISCHEN");
  await page.locator("#tiles-on").uncheck({ force: true });

  // Back to "Bereiche wählen"; with one Region left there is no "Anordnen".
  await page.locator("#regions .pick").first().click(); // keys go to the fields and switches otherwise
  await page.keyboard.press("b");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "plan");
  await expect(page.locator("#zoom-plan")).toHaveText("Ganzer Plan");
  await page.locator("#regions .remove").nth(1).click();
  await expect(items).toHaveCount(1);
  await expect(page.locator("#modes")).toBeHidden();
  await page.locator("#regions .pick").first().click();
  await page.keyboard.press("a");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "plan");
  expect(errors).toEqual([]);
});

test("removing a Region in Anordnen leaves the view when one is left", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  const plan = makePlan();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "simplepdfclipper.lastRegions",
      JSON.stringify([
        { x: 10, y: 10, width: 60, height: 30, at: { x: 0, y: 0 } },
        { x: 40, y: 160, width: 50, height: 30, at: { x: 0, y: 30 } },
      ]),
    );
  });
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#busy")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#regions li")).toHaveCount(2, { timeout: 60_000 });
  await page.locator("#mode-arrange").click();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "arrange");
  await page.locator("#regions .remove").first().click();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "plan");
  await expect(page.locator("#hint-plan")).toBeVisible();
});

test("a new Region goes where it lies on the Plan; the list is reordered by dragging", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  const plan = makePlan();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  // BETA first (the body), then the "header" ALPHA above it is drawn.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("simplepdfclipper.lastRegions", JSON.stringify([{ x: 40, y: 160, width: 50, height: 30, at: { x: 0, y: 0 } }]));
  });
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();
  await page.locator("#snap").uncheck();
  await page.locator("#zoom-plan").click();

  const canvas = (await page.locator("#viewer-canvas").boundingBox())!;
  const zoom = Math.min(canvas.width / (W * 1.04), canvas.height / (H * 1.04));
  const sx = (mm: number) => canvas.x + canvas.width / 2 + (mm - W / 2) * zoom;
  const sy = (mm: number) => canvas.y + canvas.height / 2 + (mm - H / 2) * zoom;
  await page.mouse.move(sx(10), sy(10));
  await page.mouse.down();
  await page.mouse.move(sx(70), sy(40), { steps: 8 });
  await page.mouse.up();
  const picks = page.locator("#regions .pick");
  await expect(picks).toHaveText(["Bereich 1", "Bereich 2"]);
  const a = { x: await num(page, "#clip-x"), y: await num(page, "#clip-y"), h: await num(page, "#clip-h") };
  near(a.x, 10, 1);
  near(a.y, 10, 1);

  // In the Clip the header is above the body, keeping its offset: no dragging around needed.
  await page.locator("#mode-arrange").click();
  await expect(page.locator("#fields-caption")).toHaveText("Bereich 2 im Ausschnitt");
  near(await num(page, "#clip-x"), 0);
  near(await num(page, "#clip-y"), 0);
  await picks.nth(0).click();
  near(await num(page, "#clip-x"), 40 - a.x, 0.06);
  near(await num(page, "#clip-y"), a.h, 0.06);

  // Drag "Bereich 2" before "Bereich 1": the header becomes Region 1, selected; the Layout stays.
  const box = async (i: number) => (await picks.nth(i).boundingBox())!;
  const from = await box(1);
  const to = await box(0);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 10 });
  await expect(page.locator("#regions li.dragging")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator("#regions li.dragging")).toHaveCount(0);
  await expect(picks).toHaveText(["Bereich 1", "Bereich 2"]);
  await expect(page.locator("#regions li").nth(0)).toHaveClass(/selected/);
  await expect(page.locator("#fields-caption")).toHaveText("Bereich 1 im Ausschnitt");
  near(await num(page, "#clip-x"), 0);
  near(await num(page, "#clip-y"), 0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("simplepdfclipper.lastRegions")!));
  near(stored[0].x, a.x, 0.01);
  near(stored[1].x, 40, 1e-6);
  await page.screenshot({ path: "test-results/reorder.png" });

  // A click still selects; on the Plan Region 2 is the body now.
  await picks.nth(1).click();
  await page.locator("#mode-plan").click();
  await expect(page.locator("#fields-caption")).toHaveText("Bereich 2 auf dem Plan");
  near(await num(page, "#clip-x"), 40);
  near(await num(page, "#clip-y"), 160);
  // A drag that ends where it started changes nothing.
  const b = await box(0);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2 + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  const again = await page.evaluate(() => JSON.parse(localStorage.getItem("simplepdfclipper.lastRegions")!));
  expect(again).toEqual(stored);
  expect(errors).toEqual([]);
});
