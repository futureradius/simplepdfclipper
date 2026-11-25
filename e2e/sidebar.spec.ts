import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

// The tidied-up interface before 0.2.0 (#50, ADR 0012): no header bar, "Über" top right,
// a resizable sidebar with foldable steps, the help in About instead of the sidebar.

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;

test("sidebar: Über pill, other file in step 1, folding and width are remembered, help in About", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  mkdirSync("test-results", { recursive: true });
  const plan = resolve("test-results/sidebar-plan.pdf");
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 210 * PT, 297 * PT], 0, doc.newDictionary(), ""));
  writeFileSync(plan, doc.saveToBuffer("compress").asUint8Array());

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });

  // Start page: no header bar; name small above the headline, "Über" top right, new texts.
  await expect(page.locator("header")).toHaveCount(0);
  await expect(page.locator("#start .brand")).toHaveText("simple pdf clipper");
  await expect(page.locator("#start .intro > p")).toHaveText(
    "Aus einer großen PDF-Datei einen oder mehrere Ausschnitte markieren, aufteilen und als SVG oder PDF exportieren.",
  );
  await expect(page.locator("#start .uses li").nth(0)).toHaveText("SVGschlank und scharf");
  await expect(page.locator("#start .uses li").nth(1)).toHaveText("PDFbereit zu drucken oder zur Ablage");
  await expect(page.locator("#start .uses li").nth(2)).toContainText("der Ausschnitt kann auf Papierformate oder frei aufgeteilt werden.");
  const pill = (await page.locator("#about-open").boundingBox())!;
  expect(pill.x + pill.width).toBeGreaterThan(1400 - 40);
  expect(pill.y).toBeLessThan(30);

  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone

  // Workspace: "Über" sits over the top right of the Plan view; "Andere Datei öffnen…" in step 1.
  const viewer = (await page.locator("#viewer").boundingBox())!;
  const pill2 = (await page.locator("#about-open").boundingBox())!;
  expect(pill2.x).toBeGreaterThan(viewer.x);
  expect(pill2.y).toBeLessThan(viewer.y + 40);
  await expect(page.locator('section[data-step="1"] #open-other')).toHaveText("Andere Datei öffnen…");
  // No usage hints in step 2 any more (they are in About).
  await expect(page.locator("#hint-plan, #hint-arrange")).toHaveCount(0);

  // The Tile output choice sits above the export buttons, outside the Tile box, only with Tiles on.
  await expect(page.locator("#tiles-output")).toBeHidden();
  await page.locator("#tiles-on").check();
  await expect(page.locator("#tiles-output")).toBeVisible();
  await expect(page.locator("#tiles-panel #tiles-output")).toHaveCount(0);
  const output = (await page.locator("#tiles-output").boundingBox())!;
  const buttons = (await page.locator(".export-buttons").boundingBox())!;
  const box = (await page.locator("#tiles-panel").boundingBox())!;
  expect(output.y).toBeGreaterThan(box.y + box.height);
  expect(output.y + output.height).toBeLessThanOrEqual(buttons.y);
  await page.locator("#tiles-on").uncheck();
  await expect(page.locator("#tiles-output")).toBeHidden();

  // Folding: a click on the heading leaves only the heading; remembered after a reload.
  const step2 = page.locator('section[data-step="2"]');
  await step2.locator(".step-toggle").click();
  await expect(step2.locator(".step-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#regions")).toBeHidden();

  // Width: drag the handle on the sidebar's right edge; clamped to 560 px; remembered.
  const panel = page.locator("#panel");
  expect((await panel.boundingBox())!.width).toBeCloseTo(320, 0);
  const handle = (await page.locator("#panel-resize").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 100, 300, { steps: 5 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeCloseTo(420, 0);
  await page.mouse.move(420, 300);
  await page.mouse.down();
  await page.mouse.move(900, 300, { steps: 5 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeCloseTo(560, 0);

  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();
  expect((await panel.boundingBox())!.width).toBeCloseTo(560, 0);
  await expect(page.locator("#regions")).toBeHidden();
  await step2.locator(".step-toggle").click();
  await expect(page.locator("#regions")).toBeVisible();

  // Double-click resets the width.
  await page.locator("#panel-resize").dblclick();
  expect((await panel.boundingBox())!.width).toBeCloseTo(320, 0);

  // Without a Region, the prompt links to "Wie geht's" in About.
  await page.locator("#regions .remove").first().click();
  await expect(page.locator("#no-region")).toBeVisible();
  await page.locator("#howto-link").click();
  await expect(page.locator("#about")).toBeVisible();
  await expect(page.locator("#about-howto")).toBeInViewport();
  await expect(page.locator("#about h3")).toHaveText(["Über das Projekt", "Wie geht's", "Tastenkürzel", "Lizenz & Dank"]);
  await expect(page.locator("#about")).toContainText("Über den linken oder oberen Rand hinaus ziehen vergrößert den Ausschnitt dorthin.");
  // The About window is wider, and the long key description wraps instead of squeezing the column.
  expect((await page.locator("#about").boundingBox())!.width).toBeCloseTo(640, 0);
  const keyCell = (await page.locator("#shortcuts td").first().boundingBox())!;
  expect(keyCell.width).toBeLessThan(640 * 0.4);
  await page.screenshot({ path: "test-results/about.png" });
  await page.locator("#about-close").click();
  await page.screenshot({ path: "test-results/sidebar.png" });
  expect(errors).toEqual([]);
});
