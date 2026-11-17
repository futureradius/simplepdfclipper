// Multi-page Documents (ADR 0014): choosing a page, cancelling, exporting only that page.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as mupdf from "mupdf";
import * as core from "./core";
import { exportPdf } from "../export/pdf";
import { TiledPdfExport } from "../export/tiledpdf";
import { makeMultiPageDocument, MULTIPAGE_PAGES } from "../testing/multipage";
import { exportBase, sourceLabel, thumbSize } from "../ui/pagepicker";

const PT_TO_MM = 25.4 / 72;
const bytes = makeMultiPageDocument();
const buffer = () => bytes.slice().buffer;

function pdfText(pdf: Uint8Array): { pages: number; text: string; widthMm: number; heightMm: number } {
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const page = doc.loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();
  const text = page.toStructuredText("preserve-whitespace").asText();
  return { pages: doc.countPages(), text, widthMm: (x1 - x0) * PT_TO_MM, heightMm: (y1 - y0) * PT_TO_MM };
}

/** A one-page PDF of the given size in mm. */
function singlePage(widthMm: number, heightMm: number): ArrayBuffer {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, widthMm / PT_TO_MM, heightMm / PT_TO_MM], 0, doc.newDictionary(), "0 g 10 10 50 50 re f"));
  return doc.saveToBuffer("compress").asUint8Array().slice().buffer;
}

describe("PDF export of one page of a multi-page Document", () => {
  const clip = { x: 10, y: 10, width: 150, height: 60 };

  it("keeps only the chosen page", () => {
    const r = pdfText(exportPdf(mupdf, bytes, { clip, page: 1, sourceName: "mehrseitig.pdf, Seite 2", date: new Date(2026, 10, 17) }).pdf);
    expect(r.pages).toBe(1);
    expect(r.text).toContain("SEITE ZWEI");
    expect(r.text).not.toContain("EINS");
    expect(r.text).not.toContain("DREI");
    expect(r.widthMm).toBeCloseTo(150, 1);
    expect(r.heightMm).toBeCloseTo(60, 1);
  });

  it("drops the other pages also for page 1 (they must not travel along unredacted)", () => {
    const r = pdfText(exportPdf(mupdf, bytes, { clip, sourceName: "mehrseitig.pdf", date: new Date() }).pdf);
    expect(r.pages).toBe(1);
    expect(r.text).toContain("SEITE EINS");
    const raw = new TextDecoder("latin1").decode(exportPdf(mupdf, bytes, { clip, sourceName: "x", date: new Date() }).pdf);
    expect(raw).not.toMatch(/\/Count\s+3/);
  });

  it("names the page in the document properties", () => {
    const pdf = exportPdf(mupdf, bytes, { clip, page: 2, sourceName: sourceLabel("mehrseitig.pdf", 2, 3), date: new Date() }).pdf;
    const doc = mupdf.Document.openDocument(pdf, "application/pdf");
    expect(doc.getMetaData("info:Title")).toBe("mehrseitig.pdf, Seite 3 – Ausschnitt");
    expect(doc.getMetaData("info:Subject")).toContain("Ausschnitt aus mehrseitig.pdf, Seite 3:");
  });

  it("rejects a page that does not exist", () => {
    expect(() => exportPdf(mupdf, bytes, { clip, page: 3, sourceName: "x", date: new Date() })).toThrow(/no page 4/);
  });

  it("Tiled Export cuts the Tiles from the chosen page", () => {
    const job = new TiledPdfExport(mupdf, bytes, {
      clip,
      page: 2,
      sourceName: sourceLabel("mehrseitig.pdf", 2, 3),
      date: new Date(2026, 10, 17),
      multipage: false,
      rows: 1,
      columns: 1,
      marginMm: 10,
    });
    const t = { name: "A1", row: 0, column: 0, x: 0, y: 0, width: clip.width, height: clip.height, sheetWidth: clip.width + 20, sheetHeight: clip.height + 20 };
    const r = pdfText(job.tile(t)!);
    job.destroy();
    expect(r.pages).toBe(1);
    expect(r.text).toContain("SEITE DREI");
    expect(r.text).toContain("mehrseitig.pdf, Seite 3"); // Tile label
  });
});

describe("engine: candidate Document and page choice", () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasm = readFileSync(join(dirname(require.resolve("mupdf")), "mupdf-wasm.wasm"));
    await core.init(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  });

  it("lists every page's size when a Document is opened", () => {
    const info = core.openDocument(buffer());
    expect(info.pages.map((p) => [Math.round(p.widthPt * PT_TO_MM), Math.round(p.heightPt * PT_TO_MM)])).toEqual(
      MULTIPAGE_PAGES.map((p) => [p.widthMm, p.heightMm]),
    );
    core.discardDocument();
  });

  it("keeps the current Plan while a candidate is open and after it is discarded", () => {
    const first = core.openPlan(singlePage(100, 50));
    expect(first.pageCount).toBe(1);
    core.openDocument(buffer());
    // Thumbnails come from the candidate ...
    const thumb = core.renderThumbnail({ page: 1, maxWidthPx: 200, maxHeightPx: 200 });
    expect([thumb.widthPx, thumb.heightPx]).toEqual([200, Math.round((200 * 297) / 420)]);
    // ... while the Plan is still the old one.
    expect(core.renderRegion({ xMm: 0, yMm: 0, widthMm: 100, heightMm: 50, pxPerMm: 1 }).width).toBe(100);
    core.discardDocument();
    const svg = new TextDecoder().decode(core.exportSvg({ clip: { x: 0, y: 0, width: 100, height: 50 }, page: 0, mergeMode: "balanced", textAsPaths: false, reuseShapes: false }).svg);
    expect(svg).toContain('width="100mm" height="50mm"');
  });

  it("opening a page of the candidate makes it the Plan; exports come from that page only", () => {
    core.openPlan(singlePage(100, 50));
    core.openDocument(buffer());
    const info = core.openPage(1);
    expect(info).toMatchObject({ pageCount: 3, pageIndex: 1 });
    expect(info.widthPt * PT_TO_MM).toBeCloseTo(420, 1);
    const clip = { x: 0, y: 0, width: 420, height: 297 };
    const svg = new TextDecoder().decode(core.exportSvg({ clip, page: 1, mergeMode: "balanced", textAsPaths: false, reuseShapes: false }).svg);
    expect(svg).toContain("ZWEI");
    expect(pdfText(core.exportPdf({ clip, page: 1, sourceName: "x" }).pdf).text).toContain("SEITE ZWEI");
    // An export for another page than the one shown is refused.
    expect(() => core.exportPdf({ clip, page: 0, sourceName: "x" })).toThrow(/not the open Plan/);

    // Switching pages within the Document (no candidate).
    const third = core.openPage(2);
    expect(third.widthPt * PT_TO_MM).toBeCloseTo(297, 1);
    expect(pdfText(core.exportPdf({ clip: { x: 0, y: 0, width: 200, height: 100 }, page: 2, sourceName: "x" }).pdf).text).toContain("SEITE DREI");
    expect(() => core.openPage(3)).toThrow(/no page 4/);
  });
});

describe("page picker helpers", () => {
  it("fits thumbnails into the box, keeping proportions", () => {
    expect(thumbSize({ widthPt: 595, heightPt: 842 })).toEqual({ width: 155, height: 220 });
    expect(thumbSize({ widthPt: 1191, heightPt: 842 })).toEqual({ width: 200, height: 141 });
    // The reference schedule: very tall, still at least 1 px wide.
    const tall = thumbSize({ widthPt: 3370, heightPt: 40453 });
    expect(tall.height).toBe(220);
    expect(tall.width).toBe(18);
    expect(thumbSize({ widthPt: 1, heightPt: 1e6 }).width).toBe(1);
  });

  it("names the page in export file names only for multi-page Documents", () => {
    expect(exportBase("Plan", 0, 1)).toBe("Plan_Ausschnitt");
    expect(exportBase("Plan", 2, 12)).toBe("Plan_S3_Ausschnitt");
    expect(sourceLabel("Plan.pdf", 0, 1)).toBe("Plan.pdf");
    expect(sourceLabel("Plan.pdf", 2, 12)).toBe("Plan.pdf, Seite 3");
  });
});
