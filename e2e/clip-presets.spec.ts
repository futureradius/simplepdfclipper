// Clip presets (ADR 0015) and stretching to Plans of another size (ADR 0007): saved,
// loaded, marked as changed, stretched with the yellow note, exported and imported.

import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

const APP = pathToFileURL(resolve("dist/index.html")).href;
const PT = 72 / 25.4;

const num = async (page: Page, sel: string) => Number(await page.locator(sel).inputValue());
const near = (v: number, want: number, tol = 0.06) => expect(Math.abs(v - want), `${v} ≈ ${want}`).toBeLessThan(tol);

function makePlan(name: string, heightMm: number): string {
  mkdirSync("test-results", { recursive: true });
  const file = resolve(`test-results/${name}.pdf`);
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 210 * PT, heightMm * PT], 0, doc.newDictionary(), "0 g 10 10 50 50 re f"));
  writeFileSync(file, doc.saveToBuffer("compress").asUint8Array());
  return file;
}

async function openPlan(page: Page, file: string, size: string): Promise<void> {
  await page.locator("#file").setInputFiles(file);
  await expect(page.locator("#plan-info")).toContainText(size, { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden(); // the busy window (ADR 0012) blocks input until gone
}

test("Clip presets: save, load, changed, stretched with a note, export, import", async ({ page }) => {
  test.setTimeout(180_000);
  if (!existsSync("dist/index.html")) throw new Error("run `npm run build` first");
  const a4 = makePlan("clip-a4", 297);
  const taller = makePlan("clip-taller", 320);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept()); // "Ausschnitt-Vorlage … löschen?"
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => void delete (window as unknown as Record<string, unknown>).showSaveFilePicker); // headless: download fallback
  await page.goto(APP);
  // A header and a footer, stacked and touching.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "simplepdfclipper.lastRegions",
      JSON.stringify([
        { x: 0, y: 0, width: 210, height: 30, at: { x: 0, y: 0 } },
        { x: 0, y: 257, width: 210, height: 40, at: { x: 0, y: 30 } },
      ]),
    );
    localStorage.setItem("simplepdfclipper.lastPlanSize", JSON.stringify({ widthMm: 210, heightMm: 297 }));
  });
  await page.reload();
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await openPlan(page, a4, "210 × 297 mm");

  const select = page.locator("#clip-preset");
  const shown = page.locator("#clip-preset option:checked");
  const win = page.locator("#clip-presets");
  const rows = page.locator("#clip-presets-list li");
  const msg = page.locator("#clip-presets-msg");
  const note = page.locator("#stretch-note");
  const pickSecond = async () => {
    await page.locator("#regions .pick").nth(1).click();
    await expect(page.locator("#fields-caption")).toHaveText("Bereich 2 auf dem Plan");
  };
  await expect(page.locator("#regions li")).toHaveCount(2);
  await expect(note).toBeHidden(); // same size: restored exactly
  await expect(shown).toHaveText("–");

  // Save the Clip as a Clip preset.
  await page.locator("#clip-presets-open").click();
  await expect(win).toBeVisible();
  await expect(page.locator("#clip-presets-empty")).toBeVisible();
  await page.locator("#clip-preset-name").fill("  Kopf  und Fuß ");
  await page.locator("#clip-preset-save").click();
  await expect(msg).toHaveText("Ausschnitt-Vorlage „Kopf und Fuß“ gespeichert.");
  await page.locator("#clip-preset-name").fill("kopf und fuß");
  await page.locator("#clip-preset-save").click();
  await expect(msg).toHaveText("Es gibt schon eine Ausschnitt-Vorlage „kopf und fuß“.");
  await expect(rows).toHaveCount(1);
  await page.locator("#clip-presets-close").click();
  await expect(shown).toHaveText("Kopf und Fuß");
  // The export Presets don't notice.
  await expect(page.locator("#preset option:checked")).toHaveText("Standard");

  // Editing marks it as changed; picking it restores the Regions.
  await pickSecond();
  await page.locator("#clip-y").fill("200");
  await expect(shown).toHaveText("Kopf und Fuß (geändert)");
  await select.selectOption({ label: "Kopf und Fuß" });
  await expect(shown).toHaveText("Kopf und Fuß");
  await pickSecond();
  near(await num(page, "#clip-y"), 257);
  await expect(note).toBeHidden();

  // A taller Plan: the remembered Regions are stretched vertically, with the note.
  await openPlan(page, taller, "210 × 320 mm");
  await expect(note).toBeVisible();
  await expect(page.locator("#stretch-text")).toHaveText("Bereiche an die Plangröße angepasst: vertikal um +7,7 % gestreckt. Bitte prüfen.");
  await expect(shown).toHaveText("Kopf und Fuß"); // stretched, but still the preset
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("simplepdfclipper.lastRegions")!));
  near(stored[1].y + stored[1].height, 320, 1e-3); // the footer stays at the bottom edge
  near(stored[0].height, (30 * 320) / 297, 1e-3);
  expect(stored[1].at.y).toBe(stored[0].height); // still touching
  near(stored[0].width, 210, 1e-3); // not stretched horizontally
  await page.screenshot({ path: "test-results/clip-stretched.png" });
  // Closed with ×.
  await page.locator("#stretch-close").click();
  await expect(note).toBeHidden();

  // Loading the preset on this Plan stretches too; selecting doesn't end the note, editing does.
  await pickSecond();
  await page.locator("#clip-y").fill("250");
  await expect(shown).toHaveText("Kopf und Fuß (geändert)");
  await select.selectOption({ label: "Kopf und Fuß" });
  await expect(note).toBeVisible();
  await pickSecond();
  await expect(note).toBeVisible();
  near(await num(page, "#clip-y"), (257 * 320) / 297);
  await page.locator("#clip-h").fill("20");
  await expect(note).toBeHidden();

  // Overwrite with the edited Clip.
  await page.locator("#clip-presets-open").click();
  await expect(page.locator("#clip-preset-overwrite")).toHaveText("„Kopf und Fuß“ mit dem aktuellen Ausschnitt überschreiben");
  await page.locator("#clip-preset-overwrite").click();
  await expect(msg).toHaveText("Ausschnitt-Vorlage „Kopf und Fuß“ überschrieben.");
  await expect(page.locator("#clip-preset-overwrite")).toBeDisabled();

  // Export as a JSON file, and import it again: the name comes in numbered.
  const download = page.waitForEvent("download");
  await page.locator("#clip-presets-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("simplepdfclipper-Ausschnitt-Vorlagen.json");
  const json = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(json.kind).toBe("simplepdfclipper-clip-presets");
  expect(json.presets).toHaveLength(1);
  expect(json.presets[0].plan).toEqual({ widthMm: expect.closeTo(210, 3), heightMm: expect.closeTo(320, 3) });
  expect(json.presets[0].regions).toHaveLength(2);
  const exported = resolve("test-results/ausschnitt-vorlagen.json");
  writeFileSync(exported, readFileSync((await file.path())!));
  await page.locator("#clip-presets-file").setInputFiles(exported);
  await expect(msg).toHaveText("1 Ausschnitt-Vorlage importiert: „Kopf und Fuß (2)“.");
  await expect(rows).toHaveCount(2);
  // An export Presets file is refused here.
  writeFileSync(resolve("test-results/falsche.json"), JSON.stringify({ kind: "simplepdfclipper-presets", version: 1, presets: [] }));
  await page.locator("#clip-presets-file").setInputFiles(resolve("test-results/falsche.json"));
  await expect(msg).toContainText("keine Ausschnitt-Vorlagen-Datei");
  await page.screenshot({ path: "test-results/clip-presets-window.png" });

  // Delete one; the other stays.
  await rows.filter({ hasText: "(2)" }).getByRole("button", { name: "Löschen" }).click();
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(win).toBeHidden();

  // Back on the A4 Plan the preset (saved on the taller one) is stretched back.
  await openPlan(page, a4, "210 × 297 mm");
  await expect(page.locator("#stretch-text")).toContainText("vertikal um −7,2 % gestaucht");
  await expect(shown).toHaveText("Kopf und Fuß");
  expect(errors).toEqual([]);
});
