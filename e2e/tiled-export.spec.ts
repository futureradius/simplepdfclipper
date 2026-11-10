import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const TEST_PLAN = resolve("samples/test-plan.pdf");
const PT_TO_MM = 25.4 / 72;

test.beforeAll(() => {
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  if (!existsSync(TEST_PLAN)) throw new Error("run `npm run testplan` first");
});

async function setClip(page: Page, x: number, y: number, w: number, h: number) {
  await page.locator("#clip-x").fill(String(x));
  await page.locator("#clip-y").fill(String(y));
  await page.locator("#clip-w").fill(String(w));
  await page.locator("#clip-h").fill(String(h));
}

async function openPlan(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#plan-info")).toContainText("geladen in", { timeout: 60_000 });
}

const pdfPages = (bytes: Buffer) => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  return Array.from({ length: doc.countPages() }, (_, i) => {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    return [Math.round((x1! - x0!) * PT_TO_MM * 10) / 10, Math.round((y1! - y0!) * PT_TO_MM * 10) / 10];
  });
};

test("Tiled Export: settings, grid preview, folder, multipage, ZIP fallback, cancel, remembered", async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Facts about Edge on file:// (ADR 0013 open question), before anything is faked.
  await page.goto(APP);
  const api = await page.evaluate(() => ({
    secure: window.isSecureContext,
    folderPicker: typeof (window as unknown as Record<string, unknown>).showDirectoryPicker,
    savePicker: typeof (window as unknown as Record<string, unknown>).showSaveFilePicker,
  }));
  console.log("file:// in Edge:", JSON.stringify(api));
  expect(api.folderPicker).toBe("function");

  // Headless: no native dialogs. A fake folder collects the files in memory;
  // no "Save as" dialog, so multipage takes the download path.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    const files: Record<string, number> = {};
    w.__folderFiles = files;
    w.showDirectoryPicker = async () => ({
      name: "Kacheln",
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (b: Blob) => void (files[name] = b.size),
          close: async () => undefined,
        }),
      }),
    });
  });
  await openPlan(page);
  await setClip(page, 0, 2000, 1188.9, 600);

  // Switching on: SVG unavailable with a visible reason, PDF button becomes the Tiles button.
  await expect(page.locator("#tiles-panel")).toBeHidden();
  await page.locator("#tiles-on").check({ force: true });
  await expect(page.locator("#tiles-panel")).toBeVisible();
  await expect(page.locator("#export-svg")).toBeDisabled();
  await expect(page.locator("#svg-note")).toBeVisible();
  await expect(page.locator("#svg-wrap")).toHaveAttribute("title", /nicht verfügbar/);
  await expect(page.locator("#export-pdf")).toHaveText("Kacheln exportieren");

  // Default: A4, automatic orientation -> landscape needs fewer Sheets (5 × 4 = 20).
  await expect(page.locator("#tiles-summary")).toContainText("5 Spalten × 4 Zeilen = 20 Blätter");
  await expect(page.locator("#tiles-summary")).toContainText("A4 quer (297 × 210 mm)");
  await expect(page.locator("#tile-grid line")).toHaveCount(4 + 3);
  await page.locator("#zoom-clip").click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/tiles-paper.png" });

  // Single files into the (fake) folder.
  await page.locator("#export-pdf").click();
  await expect(page.locator("#export-status")).toContainText("20 Kacheln im Ordner „Kacheln“ gespeichert", { timeout: 120_000 });
  const files = await page.evaluate(() => (window as unknown as { __folderFiles: Record<string, number> }).__folderFiles);
  expect(Object.keys(files).sort()).toContain("test-plan_Ausschnitt_Kachel_D5.pdf");
  expect(Object.keys(files).length).toBe(20);
  console.log(await page.locator("#export-status").innerText());

  // Free grid: 3 columns by count, rows of 250 mm by length.
  await page.locator("label:has(input[value=free]) span").click();
  await page.locator("#tiles-cols").fill("3");
  await page.locator("#tiles-row-h").fill("250");
  await expect(page.locator("#tiles-col-w")).toHaveValue("396.3");
  await expect(page.locator("#tiles-rows")).toHaveValue("3");
  await expect(page.locator("#tiles-rows-rest")).toHaveText("letzte Zeile 100 mm");
  await expect(page.locator("#tiles-col-w").locator("xpath=ancestor::div[contains(@class,'field')]")).toHaveClass(/derived/);
  await expect(page.locator("#tiles-rows").locator("xpath=ancestor::div[contains(@class,'field')]")).toHaveClass(/derived/);
  await expect(page.locator("#tiles-summary")).toContainText("3 Spalten × 3 Zeilen = 9 Blätter");
  // The leading values stay when the Clip changes; the derived ones follow.
  await setClip(page, 0, 2000, 900, 700);
  await expect(page.locator("#tiles-col-w")).toHaveValue("300");
  await expect(page.locator("#tiles-row-h")).toHaveValue("250");
  await expect(page.locator("#tiles-rows-rest")).toHaveText("letzte Zeile 200 mm");
  await page.screenshot({ path: "test-results/tiles-free.png" });

  // Multipage file (download, as there is no "Save as" dialog headless).
  await page.locator("input[name=tiles-output][value=multipage]").check();
  const book = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  const bookFile = await book;
  expect(bookFile.suggestedFilename()).toBe("test-plan_Ausschnitt_Kacheln.pdf");
  const sizes = pdfPages(readFileSync(await bookFile.path()));
  expect(sizes.length).toBe(9);
  expect(sizes[0]).toEqual([320, 270]); // 300 × 250 + 10 mm Margin all round
  expect(sizes[8]).toEqual([320, 220]); // last row: 200 mm
  await expect(page.locator("#export-status")).toContainText("Mehrseitige PDF mit 9 Seiten");

  // ZIP fallback when there is no folder picker.
  await page.evaluate(() => delete (window as unknown as Record<string, unknown>).showDirectoryPicker);
  await page.locator("input[name=tiles-output][value=files]").check();
  const zipDl = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  const zipFile = await zipDl;
  expect(zipFile.suggestedFilename()).toBe("test-plan_Ausschnitt_Kacheln.zip");
  await expect(page.locator("#export-status")).toContainText("9 Kacheln als ZIP-Datei gespeichert");
  const dir = mkdtempSync(join(tmpdir(), "tiles-zip-"));
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", await zipFile.path(), "-C", dir]);
  expect(readdirSync(dir).sort()).toEqual(["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"].map((n) => `test-plan_Ausschnitt_Kachel_${n}.pdf`));
  expect(pdfPages(readFileSync(join(dir, "test-plan_Ausschnitt_Kachel_C3.pdf")))).toEqual([[320, 220]]);

  // Many Sheets: warning, and cancelling saves nothing.
  await page.locator("label:has(input[value=paper]) span").click();
  await setClip(page, 0, 0, 1188.9, 14270.9);
  await page.locator("#tiles-orientation").selectOption("portrait");
  await expect(page.locator("#tiles-summary")).toContainText("7 Spalten × 52 Zeilen = 364 Blätter");
  await expect(page.locator("#tiles-summary .warn")).toContainText("Viele Blätter");
  await page.locator("#export-pdf").click();
  await expect(page.locator("#export-status")).toContainText("Kachel", { timeout: 60_000 });
  await page.locator("#tiles-cancel").click();
  await expect(page.locator("#export-status")).toContainText("Abgebrochen. Es wurde nichts gespeichert.", { timeout: 60_000 });
  await expect(page.locator("#export-pdf")).toBeEnabled();

  // Settings are remembered.
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#tiles-panel")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#tiles-orientation")).toHaveValue("portrait");
  await expect(page.locator("input[name=tiles-mode][value=paper]")).toBeChecked();
  await expect(page.locator("#tiles-row-h")).toHaveValue("250");

  // Switching off restores the normal export.
  await page.locator("#tiles-on").uncheck({ force: true });
  await expect(page.locator("#export-svg")).toBeEnabled();
  await expect(page.locator("#svg-note")).toBeHidden();
  await expect(page.locator("#export-pdf")).toHaveText("PDF exportieren");
  expect(errors).toEqual([]);
});
