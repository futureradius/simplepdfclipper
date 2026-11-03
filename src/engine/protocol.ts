// Messages between the UI and the engine (worker or in-thread fallback).

import type { ClipMm, MergeMode } from "../export/index";

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
  /** RGBA pixels. */
  pixels: Uint8ClampedArray;
  widthPx: number;
  heightPx: number;
}

export interface RegionRequest {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  pxPerMm: number;
}

export interface RegionResult extends RegionRequest {
  /** RGBA pixels, width × height. */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface SvgExportRequest {
  clip: ClipMm;
  mergeMode: MergeMode;
  textAsPaths: boolean;
  reuseShapes: boolean;
}

export interface SvgExportResult {
  /** UTF-8 encoded SVG. */
  svg: Uint8Array;
  elements: number;
  sourceItems: number;
  unsupported: Record<string, number>;
  seconds: number;
}

export type Request =
  | { id: number; op: "init"; wasmBinary: ArrayBuffer }
  | { id: number; op: "openPlan"; bytes: ArrayBuffer }
  | { id: number; op: "renderPreview" }
  | { id: number; op: "renderRegion"; region: RegionRequest }
  | { id: number; op: "snapTargets" }
  | { id: number; op: "exportSvg"; options: SvgExportRequest };

/** A Request without its id (distributes over the union). */
export type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
