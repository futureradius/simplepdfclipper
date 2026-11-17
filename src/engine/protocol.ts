// Messages between the UI and the engine (worker or in-thread fallback).

import type { ClipMm, MergeMode } from "../export/index";
import type { Tile } from "../export/tilegrid";
import type { TiledJob } from "../export/tiledpdf";

export type PageBoxName = "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox";

/** A Document as opened: its pages, before one is chosen as the Plan. */
export interface DocumentInfo {
  /** Displayed size of every page (CropBox, UserUnit and rotation applied). */
  pages: { widthPt: number; heightPt: number }[];
}

export interface PlanInfo {
  pageCount: number;
  /** The chosen page (0-based). */
  pageIndex: number;
  /** Size of the page as MuPDF displays it (CropBox, UserUnit and rotation applied). */
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

/** A page of the Document as a small picture, fit into maxWidthPx × maxHeightPx. */
export interface ThumbnailRequest {
  page: number;
  maxWidthPx: number;
  maxHeightPx: number;
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
  page: number;
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

export interface PdfExportRequest {
  clip: ClipMm;
  /** Page of the Document (0-based); the export contains only this page. */
  page: number;
  sourceName: string;
}

export interface PdfExportResult {
  pdf: Uint8Array;
  /** Page rescaled to UserUnit 1 (false: Clip longer than 5,080 mm). */
  normalised: boolean;
  seconds: number;
}

/** Tiled Export (ADR 0013): begin, then one call per Tile, then finish (or abort). */
export type TilesBeginRequest = TiledJob;

export interface TileResult {
  /** The Tile as its own PDF (single files); absent in multipage mode. */
  pdf?: Uint8Array;
}

export type Request =
  | { id: number; op: "init"; wasmBinary: ArrayBuffer }
  | { id: number; op: "openDocument"; bytes: ArrayBuffer }
  | { id: number; op: "discardDocument" }
  | { id: number; op: "openPage"; page: number }
  | { id: number; op: "renderThumbnail"; thumb: ThumbnailRequest }
  | { id: number; op: "renderPreview" }
  | { id: number; op: "renderRegion"; region: RegionRequest }
  | { id: number; op: "snapTargets" }
  | { id: number; op: "exportSvg"; options: SvgExportRequest }
  | { id: number; op: "exportPdf"; options: PdfExportRequest }
  | { id: number; op: "tilesBegin"; job: TilesBeginRequest }
  | { id: number; op: "tile"; tile: Tile }
  | { id: number; op: "tilesFinish" }
  | { id: number; op: "tilesAbort" };

/** A Request without its id (distributes over the union). */
export type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
