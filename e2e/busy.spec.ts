// Busy window (ADR 0012, issue #26): shown while a Plan opens and while an export
// runs, blocking the app; gone afterwards. The delay is set to 0 so the fast jobs on
// the Test Plan show it too.
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

test("busy window while a Plan opens and an SVG exports, with a spinner on the button", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__busyDelayMs = 0;
    delete w.showSaveFilePicker; // headless: download fallback
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();

  // Opening a Plan.
  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#busy")).toHaveClass(/shown/);
  await expect(page.locator("#busy-text")).toHaveText("Plan wird geöffnet…");
  await expect(page.locator("#busy-time")).toHaveText(/^\d+:\d\d$/);
  await expect(page.locator("#busy-cancel")).toBeHidden(); // opening cannot be stopped
  await expect(page.locator("#plan-info")).toContainText("geladen in", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();

  // SVG export.
  await page.locator("#clip-y").fill("2000");
  await page.locator("#clip-h").fill("600");
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-svg").click();
  await expect(page.locator("#busy")).toHaveClass(/shown/);
  await expect(page.locator("#busy-text")).toHaveText("SVG wird berechnet…");
  await expect(page.locator("#export-svg")).toHaveClass(/busy/);
  await page.screenshot({ path: "test-results/busy.png" });
  await download;
  await expect(page.locator("#export-status")).toContainText("Elemente");
  await expect(page.locator("#busy")).toBeHidden();
  await expect(page.locator("#export-svg")).not.toHaveClass(/busy/);
  expect(errors).toEqual([]);
});
