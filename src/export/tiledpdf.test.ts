import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { TiledPdfExport } from "./tiledpdf";
import { winAnsiHex } from "./pdf";
import { computeTileGrid, DEFAULT_TILE_SETTINGS, tiles, type TileGrid, type TileSettings } from "./tilegrid";
import type { ClipMm } from "./collect";

const PLAN = "samples/test-plan.pdf";
const PT_TO_MM = 25.4 / 72;
const have = existsSync(PLAN);

function render(page: mupdf.Page, x: number, y: number, w: number, h: number, pxPerMm: number): Uint8ClampedArray {
  const k = pxPerMm * PT_TO_MM;
  const [bx0, by0] = page.getBounds();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.round(w * pxPerMm), Math.round(h * pxPerMm)], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice([k, 0, 0, k, -bx0! * k - x * pxPerMm, -by0! * k - y * pxPerMm], pix);
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  const px = pix.getPixels().slice();
  pix.destroy();
  return px;
}

function diffShare(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 64) n++;
  return n / (a.length / 3);
}

const inked = (px: Uint8ClampedArray) => px.some((v) => v < 200);

const grid = (clip: ClipMm, s: Partial<TileSettings>): TileGrid => {
  const g = computeTileGrid(clip.width, clip.height, { ...DEFAULT_TILE_SETTINGS, enabled: true, ...s });
  if ("error" in g) throw new Error(g.error);
  return g;
};

/** Text line boxes in mm (page top-left origin). */
function textLines(page: mupdf.Page): { text: string; x0: number; y0: number; x1: number; y1: number }[] {
  const json = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON()) as {
    blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
  };
  return json.blocks.flatMap((b) =>
    (b.lines ?? []).map((l) => ({ text: l.text, x0: l.bbox.x * PT_TO_MM, y0: l.bbox.y * PT_TO_MM, x1: (l.bbox.x + l.bbox.w) * PT_TO_MM, y1: (l.bbox.y + l.bbox.h) * PT_TO_MM })),
  );
}

describe("label encoding", () => {
  it("writes WinAnsi bytes, unknown characters as ?", () => {
    expect(winAnsiHex("A1 · Ä–€")).toBe("413120b720c49680");
    expect(winAnsiHex("中")).toBe("3f");
  });
});

describe.skipIf(!have)("Tiled Export on the Test Plan", () => {
  const bytes = have ? new Uint8Array(readFileSync(PLAN)) : new Uint8Array();
  // Opened fresh per test: a page object kept across many MuPDF documents occasionally
  // re-renders a few glyphs differently (seen once, not reproducible); the app draws
  // from a display list instead, which stays exact.
  let original: mupdf.Page | undefined;
  beforeEach(() => {
    original = mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0);
  });
  const clip: ClipMm = { x: 0, y: 2000, width: 1188.9, height: 600 };
  const date = new Date(2026, 10, 10);

  it("A4 portrait, 10 mm Margin: single files, each Tile exact, Margin clean, only its own text", () => {
    const g = grid(clip, { mode: "paper", format: "A4", orientation: "portrait", marginMm: 10 });
    const all = tiles(g);
    expect(all.length).toBe(21);
    const t0 = performance.now();
    const job = new TiledPdfExport(mupdf, bytes, { clip, sourceName: "test-plan.pdf", date, multipage: false, rows: g.rows.length, columns: g.columns.length, marginMm: 10 });
    const out = all.map((t) => ({ t, pdf: job.tile(t)! }));
    job.destroy();
    console.log(`21 Tiles: ${((performance.now() - t0) / 1000).toFixed(1)} s, ${(out.reduce((n, o) => n + o.pdf.length, 0) / 1e6).toFixed(2)} MB`);
    mkdirSync("samples/out/tiles", { recursive: true });
    for (const o of out) writeFileSync(`samples/out/tiles/test-plan_Ausschnitt_Kachel_${o.t.name}.pdf`, o.pdf);

    for (const name of ["A1", "B4", "C7"]) {
      const { t, pdf } = out.find((o) => o.t.name === name)!;
      const doc = mupdf.Document.openDocument(pdf, "application/pdf") as mupdf.PDFDocument;
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const [x0, y0, x1, y1] = page.getBounds();
      expect((x1! - x0!) * PT_TO_MM).toBeCloseTo(210, 1);
      expect((y1! - y0!) * PT_TO_MM).toBeCloseTo(297, 1);
      expect(page.getObject().get("UserUnit").isNull()).toBe(true);

      // The Tile on the Sheet looks exactly like that area of the Plan.
      const a = render(original!, clip.x + t.x, clip.y + t.y, t.width, t.height, 4);
      const b = render(page, 10, 10, t.width, t.height, 4);
      expect(diffShare(a, b)).toBeLessThan(0.001);

      // Margin strips away from the corner marks hold nothing: lines crossing the
      // Tile edge are kept whole by the redaction but must be clipped.
      expect(inked(render(page, 10 + t.width + 0.3, 17, 9.5 - 0.3, t.height - 14, 6))).toBe(false); // right of the Tile
      expect(inked(render(page, 17, 0, t.width - 14, 9.7, 6))).toBe(false); // above
      // ...while the cut marks are there (top-left corner, left of the Tile).
      expect(inked(render(page, 3.5, 9.8, 5.5, 0.4, 20))).toBe(true);

      // All text lies inside the Tile (removed per Tile, not just hidden), except the label.
      const lines = textLines(page);
      // C7 is only 48.9 mm wide: the full label does not fit, the short one does.
      const expected = name === "C7" ? "C7" : `${name} · Zeile ${name[0]} von C, Spalte ${name.slice(1)} von 7 · test-plan.pdf · 10.11.2026`;
      const label = lines.filter((l) => l.text.trim() === expected);
      expect(label.length).toBe(1);
      expect((label[0]!.y0 + label[0]!.y1) / 2).toBeGreaterThan(10 + t.height + 1);
      for (const l of lines.filter((l) => !label.includes(l))) {
        const cx = (l.x0 + l.x1) / 2;
        const cy = (l.y0 + l.y1) / 2;
        expect(cx > 10 && cx < 10 + t.width && cy > 10 && cy < 10 + t.height, `"${l.text}" outside Tile ${name}`).toBe(true);
      }
      expect(doc.getMetaData("info:Title")).toBe(`test-plan.pdf – Kachel ${name}`);
      doc.destroy();
    }
  }, 300_000);

  it("multipage: one page per Tile, row by row, and Margin 0 has no marks or label", () => {
    const g = grid(clip, { mode: "free", columns: { lead: "count", count: 3, lengthMm: 0 }, rows: { lead: "length", count: 0, lengthMm: 250 }, marginMm: 0 });
    const job = new TiledPdfExport(mupdf, bytes, { clip, sourceName: "test-plan.pdf", date, multipage: true, rows: g.rows.length, columns: g.columns.length, marginMm: 0 });
    for (const t of tiles(g)) expect(job.tile(t)).toBeUndefined();
    const pdf = job.finish()!;
    job.destroy();
    writeFileSync("samples/out/test-plan_Ausschnitt_Kacheln.pdf", pdf);
    const doc = mupdf.Document.openDocument(pdf, "application/pdf") as mupdf.PDFDocument;
    expect(doc.countPages()).toBe(9);
    expect(doc.getMetaData("info:Title")).toBe("test-plan.pdf – Kacheln");
    const last = tiles(g).at(-1)!; // C3: 396.3 × 100 mm
    const page = doc.loadPage(8);
    const [x0, y0, x1, y1] = page.getBounds();
    expect((x1! - x0!) * PT_TO_MM).toBeCloseTo(396.3, 1);
    expect((y1! - y0!) * PT_TO_MM).toBeCloseTo(100, 1);
    expect(diffShare(render(original!, clip.x + last.x, clip.y + last.y, last.width, last.height, 4), render(page, 0, 0, last.width, last.height, 4))).toBeLessThan(0.001);
    expect(page.toStructuredText("preserve-whitespace").asText()).not.toContain("Zeile C von C");
    doc.destroy();
  }, 300_000);

  it("Sheets longer than 5,080 mm keep the UserUnit and still render exactly", () => {
    const tall: ClipMm = { x: 100, y: 1000, width: 600, height: 6000 };
    const g = grid(tall, { mode: "free", marginMm: 10 });
    const job = new TiledPdfExport(mupdf, bytes, { clip: tall, sourceName: "test-plan.pdf", date, multipage: false, rows: 1, columns: 1, marginMm: 10 });
    const pdf = job.tile(tiles(g)[0]!)!;
    job.destroy();
    const page = mupdf.Document.openDocument(pdf, "application/pdf").loadPage(0) as mupdf.PDFPage;
    const [x0, y0, x1, y1] = page.getBounds();
    expect((x1! - x0!) * PT_TO_MM).toBeCloseTo(620, 1);
    expect((y1! - y0!) * PT_TO_MM).toBeCloseTo(6020, 1);
    expect(page.getObject().get("UserUnit").asNumber()).toBeCloseTo(2.809, 2);
    expect(diffShare(render(original!, 100, 1000, 600, 6000, 0.5), render(page, 10, 10, 600, 6000, 0.5))).toBeLessThan(0.001);
    expect(page.toStructuredText("preserve-whitespace").asText()).toContain("A1 · Zeile A von A, Spalte 1 von 1");
  }, 300_000);
});
