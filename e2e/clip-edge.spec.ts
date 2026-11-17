import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;

const num = async (page: Page, sel: string) => Number(await page.locator(sel).inputValue());

test("a Clip edge dragged past the Plan edge stops there and the opposite edge stays put", async ({ page }) => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  mkdirSync("test-results", { recursive: true });
  const plan = resolve("test-results/edge-plan.pdf");
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 210 * PT, 297 * PT], 0, doc.newDictionary(), ""));
  writeFileSync(plan, doc.saveToBuffer("compress").asUint8Array());

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(plan);
  await expect(page.locator("#plan-info")).toContainText("210 × 297 mm", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone

  // Clip 10..110 x 10..60 mm, fitted in the precision view (centre 60, 35).
  await page.locator("#clip-x").fill("10");
  await page.locator("#clip-y").fill("10");
  await page.locator("#clip-w").fill("100");
  await page.locator("#clip-h").fill("50");
  await page.locator("#zoom-clip").click();
  const canvas = (await page.locator("#viewer-canvas").boundingBox())!;
  const zoom = Math.min(canvas.width / (100 * 1.16), canvas.height / (50 * 1.16));
  const sx = (mm: number) => canvas.x + canvas.width / 2 + (mm - 60) * zoom;
  const sy = (mm: number) => canvas.y + canvas.height / 2 + (mm - 35) * zoom;
  expect(sy(-5)).toBeGreaterThan(1); // the overshoot target is still in the window

  // Top edge dragged 15 mm above the Plan: stops at 0, bottom stays at 60.
  await page.mouse.move(sx(60), sy(10));
  await page.mouse.down();
  await page.mouse.move(sx(60), sy(-5), { steps: 6 });
  await page.mouse.up();
  expect(await num(page, "#clip-y")).toBeCloseTo(0, 1);
  expect(await num(page, "#clip-h")).toBeCloseTo(60, 1);

  // Left edge dragged past the Plan: stops at 0, right stays at 110.
  await page.mouse.move(sx(10), sy(30));
  await page.mouse.down();
  await page.mouse.move(Math.max(1, sx(-15)), sy(30), { steps: 6 });
  await page.mouse.up();
  expect(await num(page, "#clip-x")).toBeCloseTo(0, 1);
  expect(await num(page, "#clip-w")).toBeCloseTo(110, 1);
  expect(errors).toEqual([]);
});
