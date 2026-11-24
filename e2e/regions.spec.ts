// Several Regions on the Plan (ADR 0016) with the mouse scheme of ADR 0012: the left
// button draws, selects, moves; right, middle and Space + left drag pan; Entf and ×
// remove. Exported as one stitched page.

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
const near = (v: number, want: number, tol = 1) => expect(Math.abs(v - want), `${v} ≈ ${want}`).toBeLessThan(tol);

/** An A4 Plan with a word in each future Region and one between them. */
function makePlan(): string {
  mkdirSync("test-results", { recursive: true });
  const file = resolve("test-results/regions-plan.pdf");
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

async function openPlan(page: Page, file: string): Promise<void> {
  await page.locator("#file").setInputFiles(file);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
}

test("Regions are drawn, selected, moved and removed on the Plan, and exported stitched", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  const plan = makePlan();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => void delete (window as unknown as Record<string, unknown>).showSaveFilePicker); // headless: download fallback
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await openPlan(page, plan);

  // A new Plan starts with one Region, selected.
  const items = page.locator("#regions li");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveClass(/selected/);
  await page.locator("#snap").uncheck(); // exact mouse positions below
  await page.locator("#clip-x").fill("10");
  await page.locator("#clip-y").fill("10");
  await page.locator("#clip-w").fill("60");
  await page.locator("#clip-h").fill("30");
  await page.locator("#zoom-plan").click();

  // Plan mm -> screen px at the whole-Plan view (2 % margin, centred).
  const canvas = (await page.locator("#viewer-canvas").boundingBox())!;
  const zoom = Math.min(canvas.width / (W * 1.04), canvas.height / (H * 1.04));
  const sx = (mm: number) => canvas.x + canvas.width / 2 + (mm - W / 2) * zoom;
  const sy = (mm: number) => canvas.y + canvas.height / 2 + (mm - H / 2) * zoom;
  const drag = async (x0: number, y0: number, x1: number, y1: number, button: "left" | "right" | "middle" = "left") => {
    await page.mouse.move(sx(x0), sy(y0));
    await page.mouse.down({ button });
    await page.mouse.move(sx(x1), sy(y1), { steps: 8 });
    await page.mouse.up({ button });
  };
  const click = (x: number, y: number) => page.mouse.click(sx(x), sy(y));

  // Left drag on empty Plan: a new Region, selected, placed below the first in the Clip.
  await drag(20, 150, 120, 200);
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveClass(/selected/);
  near(await num(page, "#clip-x"), 20);
  near(await num(page, "#clip-y"), 150);
  near(await num(page, "#clip-w"), 100);
  near(await num(page, "#clip-h"), 50);
  await expect(page.locator("#clip-size")).toContainText("aus 2 Bereichen");
  await expect(page.locator("#relayout")).toBeVisible();
  await page.screenshot({ path: "test-results/regions.png" });

  // A click on a Region selects it; a click on empty Plan deselects.
  await click(40, 25);
  await expect(items.nth(0)).toHaveClass(/selected/);
  expect(await num(page, "#clip-x")).toBeCloseTo(10, 1);
  await click(150, 60);
  await expect(page.locator("#regions li.selected")).toHaveCount(0);
  await expect(page.locator("#clip-x")).toBeDisabled();
  await expect(items).toHaveCount(2); // a click draws nothing

  // Dragging inside an unselected Region selects and moves it on the Plan.
  await drag(60, 175, 70, 175);
  await expect(items.nth(1)).toHaveClass(/selected/);
  near(await num(page, "#clip-x"), 30);
  near(await num(page, "#clip-y"), 150);
  near(await num(page, "#clip-w"), 100, 0.05); // moved, not resized

  // Right, middle and Space + left drag pan: the view moves (the minimap appears), the Regions stay.
  const regionsNow = async () => page.evaluate(() => localStorage.getItem("simplepdfclipper.lastRegions"));
  const before = await regionsNow();
  for (const how of ["right", "middle", "space"] as const) {
    await page.locator("#zoom-plan").click();
    await expect(page.locator("#minimap")).toBeHidden();
    if (how === "space") {
      await page.keyboard.down(" ");
      await drag(150, 60, 180, 90);
      await page.keyboard.up(" ");
    } else await drag(150, 60, 180, 90, how);
    await expect(page.locator("#minimap"), how).toBeVisible();
    expect(await regionsNow(), how).toBe(before);
    await expect(items).toHaveCount(2);
  }
  await page.locator("#zoom-plan").click();

  // A third Region, removed again with Entf (the list button keeps the keys away from the fields).
  await drag(100, 230, 150, 260);
  await expect(items).toHaveCount(3);
  await page.locator("#regions .pick").nth(2).click();
  await page.keyboard.press("Delete");
  await expect(items).toHaveCount(2);
  await expect(page.locator("#regions .pick")).toHaveText(["Bereich 1", "Bereich 2"]);

  // Export the two Regions: one page the size of the Clip, nothing from between them.
  await page.locator("#regions .pick").nth(1).click();
  const width = await num(page, "#clip-w");
  const pdfDownload = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  const pdf = readFileSync(await (await pdfDownload).path());
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const out = doc.loadPage(0);
  const [x0, y0, x1, y1] = out.getBounds();
  // Drawn 10 mm right of the first Region, so placed below it 10 mm in; moving it on the
  // Plan kept that place (the Layout stays).
  expect((x1! - x0!) / PT).toBeCloseTo(10 + width, 0);
  expect((y1! - y0!) / PT).toBeCloseTo(80, 0);
  const text = out.toStructuredText("preserve-whitespace").asText();
  expect(text).toContain("ALPHA");
  expect(text).toContain("BETA");
  expect(text).not.toContain("ZWISCHEN");
  expect(doc.getMetaData("info:Subject")).toContain("aus 2 Bereichen");

  const svgDownload = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-svg").click();
  const svg = readFileSync(await (await svgDownload).path(), "utf8");
  expect(svg).toContain("ALPHA");
  expect(svg).toContain("BETA");
  expect(svg).not.toContain("ZWISCHEN");

  // Reopened, the Plan gets the same Regions back (ADR 0007).
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await openPlan(page, plan);
  await expect(items).toHaveCount(2);

  // × removes Bereich 1, the other becomes Bereich 1; removing the last disables export.
  await page.locator("#regions .remove").first().click();
  await expect(page.locator("#regions .pick")).toHaveText(["Bereich 1"]);
  await expect(page.locator("#relayout")).toBeHidden();
  await page.locator("#regions .remove").first().click();
  await expect(items).toHaveCount(0);
  await expect(page.locator("#no-region")).toBeVisible();
  await expect(page.locator("#export-hint")).toHaveText("Ziehe auf dem Plan einen Bereich auf.");
  await expect(page.locator("#export-svg")).toBeDisabled();
  await expect(page.locator("#export-pdf")).toBeDisabled();
  // …until a new Region is drawn.
  await page.locator("#zoom-plan").click();
  await drag(20, 20, 80, 60);
  await expect(items).toHaveCount(1);
  await expect(page.locator("#export-pdf")).toBeEnabled();
  expect(errors).toEqual([]);
});
