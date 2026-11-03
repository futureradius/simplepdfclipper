// Engine core: everything that touches MuPDF. Runs inside the worker, or on the
// main thread as a fallback when workers are unavailable from file:// (ADR 0010).

import type * as MuPDF from "mupdf";
import type { PlanInfo, PageBoxName, Preview } from "./protocol";

let mupdf: typeof MuPDF | undefined;
let doc: MuPDF.Document | undefined;

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
  doc?.destroy();
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
  page.destroy();
  return { pageCount, widthPt: x1 - x0, heightPt: y1 - y0, boxes, userUnit, rotate };
}

/** Small overview image of the whole Plan, fit to a fixed width. */
export function renderPreview(): Preview {
  const page = openDoc().loadPage(0);
  const [x0, , x1] = page.getBounds();
  const s = PREVIEW_WIDTH_PX / (x1 - x0);
  const pix = page.toPixmap([s, 0, 0, s, 0, 0], lib().ColorSpace.DeviceRGB, false, false);
  const png = pix.asPNG().slice();
  const result = { png, widthPx: pix.getWidth(), heightPx: pix.getHeight() };
  pix.destroy();
  page.destroy();
  return result;
}
