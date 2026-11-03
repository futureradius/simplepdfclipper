import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const TEST_PLAN = resolve("samples/test-plan.pdf");

test.beforeAll(() => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  if (!existsSync(TEST_PLAN)) throw new Error("run `npm run testplan` first");
});

test("opens from file:// and loads the Test Plan", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") console.log(`[browser ${m.type()}] ${m.text()}`);
  });

  await page.goto(APP);
  await expect(page.locator("#engine-status")).toContainText("bereit", { timeout: 60_000 });
  const mode = await page.locator("body").getAttribute("data-engine");
  console.log(`engine mode from file://: ${mode}`);
  expect(mode).toBe("worker");

  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#plan-info")).toContainText("1188.0 × 7660.0 mm (geladen in", { timeout: 60_000 });
  await expect(page.locator("#plan-details")).toContainText("MediaBox");
  await expect(page.locator("#preview")).toHaveJSProperty("naturalWidth", 800);
  await page.screenshot({ path: "test-results/preview.png" });
  expect(errors).toEqual([]);
});
