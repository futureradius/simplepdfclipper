// Engine core: everything that touches MuPDF. Runs inside the worker, or on the
// main thread as a fallback when workers are unavailable from file:// (ADR 0010).

import type * as MuPDF from "mupdf";
import type { PlanInfo } from "./protocol";

let mupdf: typeof MuPDF | undefined;
let doc: MuPDF.Document | undefined;

export async function init(wasmBinary: ArrayBuffer): Promise<void> {
  (globalThis as Record<string, unknown>)["$libmupdf_wasm_Module"] = { wasmBinary };
  mupdf = await import("mupdf");
}

function lib(): typeof MuPDF {
  if (!mupdf) throw new Error("engine not initialised");
  return mupdf;
}

export function openPlan(bytes: ArrayBuffer): PlanInfo {
  doc?.destroy();
  doc = lib().Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const pageCount = doc.countPages();
  const page = doc.loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();
  page.destroy();
  return { pageCount, widthPt: x1 - x0, heightPt: y1 - y0 };
}
