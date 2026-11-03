import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const TEST_PLAN = resolve("samples/test-plan.pdf");
// Test Plan geometry (scripts/make-test-plan.mjs): week lines at 380 + k * WEEK_W mm.
const WEEK_W = (1188.9 - 380) / 260;

test.beforeAll(() => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  if (!existsSync(TEST_PLAN)) throw new Error("run `npm run testplan` first");
});

const num = async (page: Page, id: string) => Number((await page.locator(id).inputValue()).replace(",", "."));

async function setClip(page: Page, x: number, y: number, w: number, h: number) {
  await page.locator("#clip-x").fill(String(x));
  await page.locator("#clip-y").fill(String(y));
  await page.locator("#clip-w").fill(String(w));
  await page.locator("#clip-h").fill(String(h));
}

test("opens from file://, snaps the Clip in the precision view and exports an SVG", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") console.log(`[browser ${m.type()}] ${m.text()}`);
  });
  // Headless: no native "Save as" dialog, so take the download fallback.
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#start")).toBeVisible();
  await page.screenshot({ path: "test-results/start.png" });
  expect(await page.locator("body").getAttribute("data-engine")).toBe("worker");

  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#plan-info")).toContainText("1.188,9 × 14.270,9 mm · geladen in", { timeout: 60_000 });
  await expect(page.locator("#plan-details")).toContainText("UserUnit");
  await expect(page.locator("body")).toHaveAttribute("data-snap-ready", "1", { timeout: 60_000 });
  await expect(page.locator("#snap-status")).toContainText("Linien zum Einrasten");

  // Start view: the Plan's full width fills the precision view.
  const view = (await page.locator("#viewer-canvas").boundingBox())!;
  const expectedPercent = (view.width / (1188.9 * 1.02) / (96 / 25.4)) * 100;
  const shownPercent = Number((await page.locator("#zoom-label").innerText()).replace(/[^0-9,]/g, "").replace(",", "."));
  console.log(`start zoom ${shownPercent} %, expected ${expectedPercent.toFixed(1)} %`);
  expect(Math.abs(shownPercent - expectedPercent)).toBeLessThan(1.5);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/workspace.png" });

  // Keyboard: Shift+ArrowRight moves the Clip by 1 mm.
  const xBefore = await num(page, "#clip-x");
  await page.locator("#viewer-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+ArrowRight");
  expect(await num(page, "#clip-x")).toBeCloseTo(xBefore + 1, 5);
  await page.keyboard.press("ArrowLeft");
  expect(await num(page, "#clip-x")).toBeCloseTo(xBefore + 0.9, 5);

  // Clip 300..700 x 2000..2250 mm, shown fitted in the precision view.
  await setClip(page, 300, 2000, 400, 250);
  await page.locator("#zoom-clip").click();
  const canvas = (await page.locator("#viewer-canvas").boundingBox())!;
  const zoom = Math.min(canvas.width / (400 * 1.16), canvas.height / (250 * 1.16));
  const sx = (mm: number) => canvas.x + canvas.width / 2 + (mm - 500) * zoom;
  const midY = canvas.y + canvas.height / 2;
  await page.waitForTimeout(800); // let the sharp render arrive
  await page.screenshot({ path: "test-results/viewer.png" });

  // Drag the right edge (700 mm) to ~712.6 mm: snaps to the week line at 380 + 107 weeks.
  await page.mouse.move(sx(700), midY);
  await page.mouse.down();
  await page.mouse.move(sx(712.6), midY, { steps: 6 });
  await page.screenshot({ path: "test-results/snapping.png" });
  await page.mouse.up();
  const right = (await num(page, "#clip-x")) + (await num(page, "#clip-w"));
  expect(right).toBeCloseTo(380 + 107 * WEEK_W, 1);

  // Same drag with Alt held: no snapping.
  await page.mouse.move(sx(right), midY);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(sx(706.6), midY, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const free = (await num(page, "#clip-x")) + (await num(page, "#clip-w"));
  expect(Math.abs(free - 706.6)).toBeLessThan(0.5);
  expect(Math.abs(((free - 380) / WEEK_W) % 1)).toBeGreaterThan(0.05); // not on a week line

  // Overview: dragging the right edge of the red box resizes it.
  await setClip(page, 0, 10, 1188.9, 300);
  const box = (await page.locator("#clip-box").boundingBox())!;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 50, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await num(page, "#clip-w")).toBeLessThan(1000);

  // Export.
  await setClip(page, 0, 2000, 1188.9, 600);
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-svg").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("test-plan_Ausschnitt.svg");
  await expect(page.locator("#export-status")).toContainText("Elemente");
  const svg = readFileSync(await file.path(), "utf8");
  expect(svg).toContain('width="1188.9mm" height="600mm"');
  console.log(await page.locator("#export-status").innerText());


  // PDF export: page is exactly the Clip, content outside is gone.
  const pdfDownload = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  const pdfFile = await pdfDownload;
  expect(pdfFile.suggestedFilename()).toBe("test-plan_Ausschnitt.pdf");
  await expect(page.locator("#export-status")).toContainText("Inhalte außerhalb des Ausschnitts entfernt");
  const outDoc = mupdf.Document.openDocument(readFileSync(await pdfFile.path()), "application/pdf");
  const outPage = outDoc.loadPage(0);
  const [x0, y0, x1, y1] = outPage.getBounds();
  expect(((x1! - x0!) * 25.4) / 72).toBeCloseTo(1188.9, 1);
  expect(((y1! - y0!) * 25.4) / 72).toBeCloseTo(600, 1);
  expect(outPage.toStructuredText("preserve-whitespace").asText()).not.toContain("Bauablaufplan");
  console.log(await page.locator("#export-status").innerText());
  await page.screenshot({ path: "test-results/app.png" });
  await page.locator("#about-open").click();
  await expect(page.locator("#about")).toContainText("github.com/futureradius/simplepdfclipper");
  await page.screenshot({ path: "test-results/about.png" });
  await page.locator("#about-close").click();
  expect(errors).toEqual([]);
});
