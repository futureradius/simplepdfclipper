import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;
const PLAN = resolve("test-results/vorlagen.pdf");

async function openPlan(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(PLAN);
  await expect(page.locator("#plan-info")).toContainText("geladen in", { timeout: 60_000 });
}

test("named export Presets: save, apply, changed, overwrite, remembered, rename, export, import, delete", async ({ page }) => {
  test.setTimeout(180_000);
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  mkdirSync("test-results", { recursive: true });
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 1000 * PT, 700 * PT], 0, doc.newDictionary(), "0 g 10 10 50 50 re f"));
  writeFileSync(PLAN, doc.saveToBuffer("compress").asUint8Array());

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept()); // "Vorlage … löschen?"
  await page.addInitScript(() => void delete (window as unknown as Record<string, unknown>).showSaveFilePicker);
  await openPlan(page);

  const preset = page.locator("#preset");
  const shown = page.locator("#preset option:checked");
  const tilesOn = page.locator("#tiles-on");
  const margin = page.locator("#tiles-margin");
  const textPaths = page.locator("#text-paths");
  const win = page.locator("#presets");
  const rows = page.locator("#presets-list li");
  const msg = page.locator("#presets-msg");
  await page.locator("details.advanced summary").click();

  // Factory settings: only "Standard".
  await expect(shown).toHaveText("Standard");
  await expect(preset.locator("option")).toHaveCount(1);

  // Changing a setting by hand marks the dropdown.
  await tilesOn.check({ force: true });
  await page.locator("#tiles-format").selectOption("A0");
  await margin.fill("5");
  await textPaths.check();
  await expect(shown).toHaveText("Standard (geändert)");

  // Save as a new Preset.
  await page.locator("#presets-open").click();
  await expect(win).toBeVisible();
  await expect(page.locator("#presets-empty")).toBeVisible();
  await expect(page.locator("#preset-overwrite")).toBeHidden();
  await page.locator("#preset-name").fill("Standard");
  await page.locator("#preset-save").click();
  await expect(msg).toContainText("Werkseinstellung");
  await page.locator("#preset-name").fill("  Plotter   A0 ");
  await page.locator("#preset-save").click();
  await expect(msg).toHaveText("Vorlage „Plotter A0“ gespeichert.");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveClass(/current/);
  await page.locator("#presets-close").click();
  await expect(shown).toHaveText("Plotter A0");

  // Change by hand, then overwrite the Preset with it.
  await margin.fill("7");
  await expect(shown).toHaveText("Plotter A0 (geändert)");
  await page.locator("#presets-open").click();
  await expect(page.locator("#preset-overwrite")).toHaveText("„Plotter A0“ mit aktuellen Einstellungen überschreiben");
  await page.locator("#preset-overwrite").click();
  await expect(page.locator("#preset-overwrite")).toBeDisabled();
  await page.locator("#presets-close").click();
  await expect(shown).toHaveText("Plotter A0");

  // Picking applies: Standard resets everything, the Preset brings it back.
  await preset.selectOption({ label: "Standard" });
  await expect(tilesOn).not.toBeChecked();
  await expect(textPaths).not.toBeChecked();
  await expect(margin).toHaveValue("10");
  await expect(page.locator("#tiles-format")).toHaveValue("A4");
  await preset.selectOption({ label: "Plotter A0" });
  await expect(tilesOn).toBeChecked();
  await expect(textPaths).toBeChecked();
  await expect(margin).toHaveValue("7");
  await expect(page.locator("#tiles-format")).toHaveValue("A0");
  await expect(page.locator("#tiles-summary")).toContainText("A0");

  // Picking the Preset again undoes changes made by hand; changing back clears the mark.
  await page.locator('input[name="merge"][value="max"]').check();
  await expect(shown).toHaveText("Plotter A0 (geändert)");
  await page.locator('input[name="merge"][value="balanced"]').check();
  await expect(shown).toHaveText("Plotter A0");
  await margin.fill("3");
  await preset.selectOption({ label: "Plotter A0" });
  await expect(margin).toHaveValue("7");
  await expect(shown).toHaveText("Plotter A0");

  // Remembered on the next start, matching Preset or last one with "(geändert)".
  await openPlan(page);
  await expect(shown).toHaveText("Plotter A0");
  await expect(margin).toHaveValue("7");
  await margin.fill("4");
  await openPlan(page);
  await expect(shown).toHaveText("Plotter A0 (geändert)");
  await expect(margin).toHaveValue("4");
  await expect(textPaths).toBeChecked();

  // Rename: clashes refused, Escape cancels, Enter confirms.
  await page.locator("#presets-open").click();
  await rows.first().getByRole("button", { name: "Umbenennen" }).click();
  const nameField = rows.first().locator("input");
  await nameField.fill("standard");
  await nameField.press("Enter");
  await expect(msg).toContainText("Werkseinstellung");
  await nameField.press("Escape");
  await expect(win).toBeVisible();
  await expect(rows.first().locator(".name")).toHaveText("Plotter A0");
  await rows.first().getByRole("button", { name: "Umbenennen" }).click();
  await rows.first().locator("input").fill("Plotter groß");
  await rows.first().locator("input").press("Enter");
  await expect(rows.first().locator(".name")).toHaveText("Plotter groß");
  await expect(shown).toHaveText("Plotter groß (geändert)");
  await page.screenshot({ path: "test-results/presets-window.png" });

  // Export as a JSON file.
  const download = page.waitForEvent("download");
  await page.locator("#presets-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("simplepdfclipper-Vorlagen.json");
  const json = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(json.kind).toBe("simplepdfclipper-presets");
  expect(json.presets).toHaveLength(1);
  expect(json.presets[0].name).toBe("Plotter groß");
  expect(json.presets[0].settings.tiles).toMatchObject({ enabled: true, format: "A0", marginMm: 7 });
  expect(json.presets[0].settings.svg).toEqual({ textAsPaths: true, mergeMode: "balanced" });

  // Import: a clashing name comes in numbered; a wrong file is refused.
  const exported = resolve("test-results/vorlagen.json");
  writeFileSync(exported, readFileSync((await file.path())!));
  await page.locator("#presets-file").setInputFiles(exported);
  await expect(msg).toHaveText("1 Vorlage importiert: „Plotter groß (2)“.");
  await expect(rows).toHaveCount(2);
  await page.locator("#presets-file").setInputFiles(PLAN);
  await expect(msg).toContainText("keine Vorlagen-Datei");
  await expect(rows).toHaveCount(2);

  // Delete (confirmed): the picked one is gone, the dropdown falls back to Standard.
  await rows.filter({ hasText: "Plotter groß (2)" }).getByRole("button", { name: "Löschen" }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button", { name: "Löschen" }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator("#presets-empty")).toBeVisible();
  await expect(page.locator("#presets-export")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(win).toBeHidden();
  await expect(shown).toHaveText("Standard (geändert)");
  await expect(margin).toHaveValue("4"); // deleting a Preset doesn't change the settings

  expect(errors).toEqual([]);
});
