import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const TEST_PLAN = resolve("samples/test-plan.pdf");

test.beforeAll(() => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  if (!existsSync(TEST_PLAN)) throw new Error("run `npm run testplan` first");
});

test("opens from file://, loads the Test Plan and exports an SVG", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") console.log(`[browser ${m.type()}] ${m.text()}`);
  });
  // Headless: no native "Save as" dialog, so take the download fallback.
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  });

  await page.goto(APP);
  await expect(page.locator("#engine-status")).toContainText("bereit", { timeout: 60_000 });
  const mode = await page.locator("body").getAttribute("data-engine");
  console.log(`engine mode from file://: ${mode}`);
  expect(mode).toBe("worker");

  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#plan-info")).toContainText("1188.9 × 14270.9 mm (geladen in", { timeout: 60_000 });
  await expect(page.locator("#plan-details")).toContainText("UserUnit");
  await expect(page.locator("#preview")).toHaveJSProperty("naturalWidth", 800);

  await page.locator("#clip-y").fill("2000");
  await page.locator("#clip-h").fill("600");
  await expect(page.locator("#clip-note")).toContainText("1188.9 × 600.0 mm");

  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-svg").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("test-plan_Ausschnitt.svg");
  await expect(page.locator("#export-status")).toContainText("Elemente");
  const svg = readFileSync(await file.path(), "utf8");
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain('width="1188.9mm" height="600mm"');
  console.log(await page.locator("#export-status").innerText());
  await page.screenshot({ path: "test-results/app.png" });
  expect(errors).toEqual([]);
});
