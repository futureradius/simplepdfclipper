// Engine core: everything that touches MuPDF. Runs inside the worker, or on the
// main thread as a fallback when workers are unavailable from file:// (ADR 0010).

import type * as MuPDF from "mupdf";
import type {
  PdfExportRequest,
  PdfExportResult,
  PlanInfo,
  PageBoxName,
  Preview,
  RegionRequest,
  RegionResult,
  SvgExportRequest,
  SvgExportResult,
} from "./protocol";
import { exportPdf as runPdfExport } from "../export/pdf";
import type { SnapIndex } from "../ui/snap";
import { extractSnapTargets } from "./snaptargets";
import type { Matrix } from "../export/geometry";
import { exportSvg as runSvgExport } from "../export/index";

let mupdf: typeof MuPDF | undefined;
let doc: MuPDF.Document | undefined;
/** The page pre-processed once: much faster to draw repeatedly than the PDF content. */
let list: MuPDF.DisplayList | undefined;
/** Page bounds origin (pt); the Plan's top-left corner. */
let origin: [number, number] = [0, 0];
/** The Plan file as opened; the PDF export works on a fresh copy of it. */
let planBytes: Uint8Array | undefined;

const PT_TO_MM = 25.4 / 72;

const BOXES: PageBoxName[] = ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"];
const PREVIEW_WIDTH_PX = 800;

export async function init(wasmBinary: ArrayBuffer): Promise<void> {
  (globalThis as Record<string, unknown>)["$libmupdf_wasm_Module"] = { wasmBinary };
  mupdf = await import("mupdf");
}

function lib(): typeof MuPDF {
  if (!mupdf) throw new Error("engine not initialised");
  return mupdf;
}

function openDoc(): MuPDF.Document {
  if (!doc) throw new Error("no Plan open");
  return doc;
}

export function openPlan(bytes: ArrayBuffer): PlanInfo {
  list?.destroy();
  list = undefined;
  doc?.destroy();
  planBytes = new Uint8Array(bytes.slice(0));
  doc = lib().Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const pageCount = doc.countPages();
  const page = doc.loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();

  // Diagnostics: which page boxes the file declares, and any scale factor.
  const boxes: PlanInfo["boxes"] = {};
  let userUnit = 1;
  let rotate = 0;
  const pdfPage = doc.asPDF() ? (page as MuPDF.PDFPage) : undefined;
  if (pdfPage) {
    const obj = pdfPage.getObject();
    for (const name of BOXES) {
      if (obj.getInheritable(name).isNull()) continue;
      const [bx0, by0, bx1, by1] = pdfPage.getBounds(name);
      boxes[name] = { widthPt: bx1 - bx0, heightPt: by1 - by0 };
    }
    const uu = obj.get("UserUnit");
    if (uu.isNumber()) userUnit = uu.asNumber();
    const rot = obj.getInheritable("Rotate");
    if (rot.isNumber()) rotate = rot.asNumber();
  }
  origin = [x0, y0];
  list = page.toDisplayList(false);
  page.destroy();
  return { pageCount, widthPt: x1 - x0, heightPt: y1 - y0, boxes, userUnit, rotate };
}

function displayList(): MuPDF.DisplayList {
  if (!list) throw new Error("no Plan open");
  return list;
}

/** Draws part of the Plan (mm, from its top-left corner) at a given resolution, as RGBA pixels. */
export function renderRegion(r: RegionRequest): RegionResult {
  const m = lib();
  const width = Math.max(1, Math.round(r.widthMm * r.pxPerMm));
  const height = Math.max(1, Math.round(r.heightMm * r.pxPerMm));
  const s = r.pxPerMm * PT_TO_MM;
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, width, height], true);
  pix.clear(255);
  const dev = new m.DrawDevice([s, 0, 0, s, -origin[0] * s - r.xMm * r.pxPerMm, -origin[1] * s - r.yMm * r.pxPerMm], pix);
  try {
    displayList().run(dev, m.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  const pixels = pix.getPixels().slice();
  pix.destroy();
  return { ...r, pixels, width, height };
}

/** Small overview image of the whole Plan, fit to a fixed width. */
export function renderPreview(): Preview {
  const [x0, , x1] = displayList().getBounds();
  const pxPerMm = PREVIEW_WIDTH_PX / ((x1 - x0) * PT_TO_MM);
  const [, y0, , y1] = displayList().getBounds();
  const r = renderRegion({ xMm: 0, yMm: 0, widthMm: (x1 - x0) * PT_TO_MM, heightMm: (y1 - y0) * PT_TO_MM, pxPerMm });
  return { pixels: r.pixels, widthPx: r.width, heightPx: r.height };
}

/** Lines and text edges the Clip can snap to (ADR 0003). */
export function snapTargets(): SnapIndex {
  const pageToMm: Matrix = [PT_TO_MM, 0, 0, PT_TO_MM, -origin[0] * PT_TO_MM, -origin[1] * PT_TO_MM];
  return extractSnapTargets(lib(), displayList(), pageToMm);
}

export function exportSvg(options: SvgExportRequest): SvgExportResult {
  const t0 = performance.now();
  const page = openDoc().loadPage(0);
  try {
    const r = runSvgExport(lib(), page, options);
    return {
      svg: new TextEncoder().encode(r.svg),
      elements: r.elements,
      sourceItems: r.sourceItems,
      unsupported: r.unsupported,
      seconds: (performance.now() - t0) / 1000,
    };
  } finally {
    page.destroy();
  }
}

export function exportPdf(options: PdfExportRequest): PdfExportResult {
  if (!planBytes) throw new Error("no Plan open");
  const t0 = performance.now();
  const r = runPdfExport(lib(), planBytes, { clip: options.clip, sourceName: options.sourceName, date: new Date() });
  return { pdf: r.pdf, normalised: r.normalised, seconds: (performance.now() - t0) / 1000 };
}
