// SVG export entry point: collect -> merge -> serialise.

import type * as MuPDF from "mupdf";
import { collect, type CollectOptions } from "./collect";
import { mergeItems, type MergeMode } from "./merge";
import { toSvg } from "./svg";

export type { ClipMm } from "./collect";
export type { MergeMode } from "./merge";

export interface SvgExportOptions extends CollectOptions {
  mergeMode: MergeMode;
}

export interface SvgExport {
  svg: string;
  elements: number;
  /** Items collected from the PDF before merging. */
  sourceItems: number;
  unsupported: Record<string, number>;
}

export function exportSvg(mupdf: typeof MuPDF, page: MuPDF.Page, opts: SvgExportOptions): SvgExport {
  const c = collect(mupdf, page, opts);
  const groups = mergeItems(c.items, opts.mergeMode, c.width, c.height);
  const { svg, elements } = toSvg(groups, c.clips, c.patterns, c.width, c.height);
  return { svg, elements, sourceItems: c.items.length, unsupported: c.unsupported };
}
