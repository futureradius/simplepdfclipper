// Saving (ADR 0009, issue #27): the "Save as" dialog opens on the click, before the
// export is computed, since the browser allows it only ~5 s after the click; and the
// download fallback keeps its file until the next download, so renaming it slowly in
// the browser's own dialog no longer saves 0 KB.
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

async function openPlan(page: import("@playwright/test").Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP);
  await expect(page.locator("#choose")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#file").setInputFiles(TEST_PLAN);
  await expect(page.locator("#plan-info")).toContainText("geladen in", { timeout: 60_000 });
  await expect(page.locator("#busy")).toBeHidden();
  await page.locator("#clip-y").fill("2000");
  await page.locator("#clip-h").fill("600");
}

test("asks where to save on the click, before the export is computed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A fake "Save as" dialog that, like Edge, refuses once the click's activation is gone.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const log: { name: string; statusAtCall: string; written?: string }[] = [];
    w.__saves = log;
    w.__cancelNext = false;
    w.showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      if (!navigator.userActivation.isActive)
        throw new DOMException("Must be handling a user gesture to show a file picker.", "SecurityError");
      const entry: (typeof log)[number] = { name: suggestedName, statusAtCall: document.getElementById("export-status")!.textContent ?? "" };
      log.push(entry);
      if (w.__cancelNext) throw new DOMException("The user aborted a request.", "AbortError");
      return {
        createWritable: async () => ({
          write: async (b: Blob) => void (entry.written = (await b.text()).slice(0, 2000)),
          close: async () => {},
        }),
      };
    };
  });
  await openPlan(page);
  const saves = () => page.evaluate(() => (window as unknown as { __saves: { name: string; statusAtCall: string; written?: string }[] }).__saves);

  await page.locator("#export-svg").click();
  await expect(page.locator("#export-status")).toContainText("Elemente", { timeout: 120_000 });
  await expect.poll(async () => (await saves())[0]?.written ?? "").toContain("<svg");
  expect((await saves())[0]!.name).toMatch(/\.svg$/);
  expect((await saves())[0]!.statusAtCall).toBe(""); // asked before anything was computed

  await page.locator("#export-pdf").click();
  await expect(page.locator("#export-status")).toContainText("PDF:", { timeout: 120_000 });
  await expect.poll(async () => (await saves())[1]?.written ?? "").toMatch(/^%PDF/);
  expect((await saves())[1]!.name).toMatch(/\.pdf$/);
  expect((await saves())[1]!.statusAtCall).not.toContain("PDF:"); // still the SVG's result

  // Cancelling the dialog exports nothing.
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__cancelNext = true));
  await page.locator("#export-svg").click();
  await expect.poll(async () => (await saves()).length).toBe(3);
  await expect(page.locator("#busy")).toBeHidden();
  await expect(page.locator("#export-status")).toContainText("PDF:"); // the previous result stays
  await expect(page.locator("#export-svg")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("the download fallback keeps its file until the next download", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker; // no dialog: download fallback
    const downloads: string[] = [];
    const revoked: string[] = [];
    w.__downloads = downloads;
    w.__revoked = revoked;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) downloads.push(this.href);
      return click.call(this);
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      revoke(url);
    };
  });
  await openPlan(page);
  const state = () => page.evaluate(() => {
    const w = window as unknown as { __downloads: string[]; __revoked: string[] };
    return { downloads: [...w.__downloads], revoked: [...w.__revoked] };
  });

  let download = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-pdf").click();
  await download;
  await page.clock.runFor(60_000); // the user takes a minute to type a new name
  const first = (await state()).downloads[0]!;
  expect((await state()).revoked).not.toContain(first);
  expect(await page.evaluate(async (u) => (await (await fetch(u)).text()).slice(0, 4), first)).toBe("%PDF");

  // The next download frees the previous one.
  download = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#export-svg").click();
  await download;
  expect((await state()).revoked).toContain(first);
  expect((await state()).revoked).not.toContain((await state()).downloads[1]);
  expect(errors).toEqual([]);
});
