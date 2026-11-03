// Messages between the UI and the engine (worker or in-thread fallback).

export interface PlanInfo {
  pageCount: number;
  widthPt: number;
  heightPt: number;
}

export type Request =
  | { id: number; op: "init"; wasmBinary: ArrayBuffer }
  | { id: number; op: "openPlan"; bytes: ArrayBuffer };

/** A Request without its id (distributes over the union). */
export type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
