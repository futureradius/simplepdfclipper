// A Clip of several Regions (ADR 0016): each Region looks as on the Plan, at its place in
// the Layout; nothing from between the Regions is in the file; the space between them
// stays empty.

import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { exportSvg } from "./index";
import { collect, collectAll } from "./collect";
import { exportClipPdf } from "./stitchpdf";
import { TiledPdfExport } from "./tiledpdf";
import { clipSize, suggestLayout, type Region } from "./regions";
import { UNITS_PER_MM } from "./ir";
import { diffShare, pathPoints, render } from "../testing/pdfcheck";

const PT = 72 / 25.4;
const PAGE_H = 300;
const X = (mm: number) => (mm * PT).toFixed(3);
const Y = (mm: number) => (PAGE_H - mm * PT).toFixed(3);

/** A Plan with something in each Region, crossing its edges, and a marker between them. */
function makePlan(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const hatch = doc.addStream("0 0 0 RG 0.6 w 0 0 m 10 10 l S\n", {
    Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {},
  });
  const res = doc.addObject({ Font: { F1: font }, Pattern: { P1: hatch } });
  const text = (s: string, x: number, y: number) => `0 g BT /F1 14 Tf ${X(x)} ${Y(y)} Td (${s}) Tj ET`;
  const content = [
    // Region A (10..50 × 10..30 mm): a bar crossing its left edge, a line across it.
    `0 0 1 rg ${X(5)} ${Y(25)} ${X(20)} ${(8 * PT).toFixed(3)} re f`,
    `0 G 2 w ${X(0)} ${Y(12)} m ${X(70)} ${Y(12)} l S`,
    text("ALPHA", 15, 22),
    // Region B (10..40 × 60..90 mm): a circle over its right edge.
    `0 0.6 0 rg ${X(40)} ${Y(75)} m ${X(40)} ${Y(66)} ${X(52)} ${Y(66)} ${X(52)} ${Y(75)} c ${X(52)} ${Y(84)} ${X(40)} ${Y(84)} ${X(40)} ${Y(75)} c f`,
    text("BETA", 14, 80),
    // Region C (80..120 × 20..50 mm): hatching over its bottom edge, a red line.
    `/Pattern cs /P1 scn ${X(85)} ${Y(60)} ${X(20)} ${(20 * PT).toFixed(3)} re f`,
    `1 0 0 RG 3 w ${X(70)} ${Y(30)} m ${X(130)} ${Y(30)} l S`,
    text("GAMMA", 84, 28),
    // Between the Regions: must not be in any export.
    `1 0 1 rg ${X(55)} ${Y(65)} ${X(20)} ${(10 * PT).toFixed(3)} re f`,
    text("ZWISCHEN", 55, 100),
  ];
  doc.insertPage(-1, doc.addPage([0, 0, 400, PAGE_H], 0, res, content.join("\n")));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

const plan = makePlan();
const fresh = () => mupdf.Document.openDocument(plan, "application/pdf").loadPage(0);
const r = (x: number, y: number, width: number, height: number): Region => ({ x, y, width, height, at: { x: 0, y: 0 } });
const REGIONS = suggestLayout([r(10, 10, 40, 20), r(10, 60, 30, 30), r(80, 20, 40, 30)]);
const DATE = new Date(2026, 10, 24);

describe("a Clip of several Regions", () => {
  it("is laid out with empty space between the Regions", () => {
    expect(REGIONS.map((x) => x.at)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 70, y: 20 },
    ]);
    expect(clipSize(REGIONS)).toEqual({ width: 110, height: 80 });
  });

  it("PDF: one page the size of the Clip, every Region as on the Plan, nothing else", () => {
    const out = exportClipPdf(mupdf, plan, { clip: REGIONS, sourceName: "plan.pdf", date: DATE });
    expect(out.uncut).toBe(0);
    expect(out.normalised).toBe(true);
    const doc = mupdf.Document.openDocument(out.pdf, "application/pdf");
    expect(doc.countPages()).toBe(1);
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const [x0, y0, x1, y1] = page.getBounds();
    expect((x1! - x0!) / PT).toBeCloseTo(110, 3);
    expect((y1! - y0!) / PT).toBeCloseTo(80, 3);

    for (const [i, reg] of REGIONS.entries()) {
      const a = render(fresh(), reg.x, reg.y, reg.width, reg.height, 8);
      const b = render(mupdf.Document.openDocument(out.pdf, "application/pdf").loadPage(0), reg.at.x, reg.at.y, reg.width, reg.height, 8);
      const ink = a.filter((v) => v < 128).length / a.length;
      expect(ink, `Bereich ${i + 1} has content`).toBeGreaterThan(0.005);
      const inner = diffShare(a, b, reg.width * 8, 12);
      const all = diffShare(a, b, reg.width * 8);
      console.log(`stitched PDF, Bereich ${i + 1}: ${(all * 100).toFixed(3)} % of pixels differ, ${(inner * 100).toFixed(3)} % away from the edge`);
      expect(inner, `Bereich ${i + 1}`).toBeLessThan(0.0005);
      expect(all, `Bereich ${i + 1}`).toBeLessThan(0.01);
    }

    // The space right of A and above C, and below C right of B, is empty.
    for (const [x, y, w, h] of [
      [40, 0, 70, 20],
      [30, 50, 80, 30],
    ] as const) {
      const px = render(page, x, y, w, h, 4);
      expect(px.every((v) => v === 255), `empty at ${x}, ${y}`).toBe(true);
    }

    // No path point outside the Regions in the Clip, no text from between them.
    const pts = pathPoints(page);
    expect(pts.length).toBeGreaterThan(10);
    const inSome = ([x, y]: [number, number]) =>
      REGIONS.some((g) => x >= g.at.x * PT - 1e-3 && x <= (g.at.x + g.width) * PT + 1e-3 && y >= g.at.y * PT - 1e-3 && y <= (g.at.y + g.height) * PT + 1e-3);
    expect(pts.filter((p) => !inSome(p))).toEqual([]);
    const text = page.toStructuredText("preserve-whitespace").asText();
    for (const w of ["ALPHA", "BETA", "GAMMA"]) expect(text).toContain(w);
    expect(text).not.toContain("ZWISCHEN");
    // The magenta marker (1 0 1 rg) is gone from every content stream.
    const raw = new TextDecoder("latin1").decode(out.pdf);
    expect(raw).not.toMatch(/\b1 0 1 rg\b/);

    const subject = doc.getMetaData("info:Subject")!;
    expect(subject).toContain("aus 3 Bereichen, 110,0 × 80,0 mm");
    expect(subject).toContain("Bereich 1: links 10,0 mm, oben 10,0 mm, 40,0 × 20,0 mm, im Ausschnitt bei 0,0 / 0,0 mm");
    expect(subject).toContain("Bereich 3: links 80,0 mm, oben 20,0 mm, 40,0 × 30,0 mm, im Ausschnitt bei 70,0 / 20,0 mm");
  });

  it("PDF: a one-Region Clip is the plain export", () => {
    const one = exportClipPdf(mupdf, plan, { clip: [REGIONS[0]!], sourceName: "plan.pdf", date: DATE });
    const subject = mupdf.Document.openDocument(one.pdf, "application/pdf").getMetaData("info:Subject")!;
    expect(subject).toContain("Ausschnitt aus plan.pdf: links 10,0 mm");
  });

  it("SVG: the size of the Clip, white only behind the Regions, nothing from between them", () => {
    const { svg } = exportSvg(mupdf, fresh(), { clip: REGIONS, textAsPaths: false, mergeMode: "balanced" });
    expect(svg).toContain('width="110mm" height="80mm"');
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(texts.sort()).toEqual(["ALPHA", "BETA", "GAMMA"]);
    expect(svg).not.toMatch(/#f0f\b/);
    const whites = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#fff"\/>/g)].map((m) => m.slice(1).map(Number));
    const u = UNITS_PER_MM;
    expect(whites).toEqual(REGIONS.map((g) => [g.at.x * u, g.at.y * u, g.width * u, g.height * u]));
    // Region ids are kept apart.
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id!.startsWith("r3p"))).toBe(true);
  });

  it("SVG: one shared pass records the same as one pass per Region", () => {
    const size = clipSize(REGIONS);
    const opts = REGIONS.map((g, i) => ({
      clip: { x: g.x, y: g.y, width: g.width, height: g.height },
      textAsPaths: false,
      region: { at: g.at, size, idPrefix: `r${i + 1}` },
    }));
    const shared = collectAll(mupdf, fresh(), opts);
    const alone = opts.map((o) => collect(mupdf, fresh(), o));
    // Shifting the shared transformation rounds differently in the last bits; the export
    // writes whole units (0.01 mm), so numbers may differ by 1/100 of that.
    const differences: string[] = [];
    const compare = (a: unknown, b: unknown, path: string): void => {
      if (typeof a === "number" && typeof b === "number") {
        if (Math.abs(a - b) > 0.01) differences.push(`${path}: ${a} ≠ ${b}`);
      } else if (a instanceof Map && b instanceof Map) compare([...a], [...b], path);
      else if (a && b && typeof a === "object" && typeof b === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      } else if (a !== b) differences.push(`${path}: ${String(a)} ≠ ${String(b)}`);
    };
    for (const i of opts.keys()) {
      expect(shared[i]!.items.length, `Bereich ${i + 1}`).toBeGreaterThan(0);
      compare(shared[i], alone[i], `Bereich ${i + 1}`);
    }
    expect(differences).toEqual([]);
  });

  it("Tiled Export: Tiles cut from the stitched Clip, an empty Tile is an empty Sheet", () => {
    const tiled = new TiledPdfExport(mupdf, plan, {
      clip: REGIONS, page: 0, sourceName: "plan.pdf", date: DATE, multipage: false, rows: 2, columns: 2, marginMm: 5,
    });
    try {
      // B2 (55..110 × 40..80 mm) holds only the lower part of C; A2 (55..110 × 0..40) only the top of C.
      const tile = (name: string, x: number, y: number) =>
        tiled.tile({ name, row: y ? 1 : 0, column: x ? 1 : 0, x, y, width: 55, height: 40, sheetWidth: 65, sheetHeight: 50 })!;
      const a1 = mupdf.Document.openDocument(tile("A1", 0, 0), "application/pdf");
      expect(a1.loadPage(0).toStructuredText("preserve-whitespace").asText()).toContain("ALPHA");
      expect(a1.getMetaData("info:Subject")).toContain("im Ausschnitt aus 3 Bereichen links 0,0 mm, oben 0,0 mm");
      // A Tile entirely in empty space: no Plan content, but still a Sheet with its label.
      const empty = tiled.tile({ name: "Z9", row: 0, column: 1, x: 42, y: 1, width: 26, height: 17, sheetWidth: 36, sheetHeight: 27 })!;
      const page = mupdf.Document.openDocument(empty, "application/pdf").loadPage(0);
      expect(page.toStructuredText("preserve-whitespace").asText().trim()).toBe("Z9");
      expect(render(page, 5, 5, 26, 17, 4).every((v) => v === 255)).toBe(true);
    } finally {
      tiled.destroy();
    }
  });
});
