// Messages between the UI and the engine (worker or in-thread fallback).

export type PageBoxName = "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox";

export interface PlanInfo {
  pageCount: number;
  /** Size of page 1 as MuPDF displays it (CropBox, UserUnit and rotation applied). */
  widthPt: number;
  heightPt: number;
  /** Page boxes explicitly declared in the file, for diagnostics. */
  boxes: Partial<Record<PageBoxName, { widthPt: number; heightPt: number }>>;
  userUnit: number;
  rotate: number;
}

export interface Preview {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}

export type Request =
  | { id: number; op: "init"; wasmBinary: ArrayBuffer }
  | { id: number; op: "openPlan"; bytes: ArrayBuffer }
  | { id: number; op: "renderPreview" };

/** A Request without its id (distributes over the union). */
export type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
