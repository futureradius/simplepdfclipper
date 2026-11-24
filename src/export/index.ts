// SVG export entry point: collect -> merge -> serialise.

import type * as MuPDF from "mupdf";
import { collect, collectAll, type ClipMm, type CollectOptions } from "./collect";
import type { Collected } from "./ir";
import { mergeItems, type MergeMode } from "./merge";
import { asRegions, clipSize, type ClipShape } from "./regions";
import { toSvg } from "./svg";
import { UNITS_PER_MM } from "./ir";

export type { ClipMm } from "./collect";
export type { MergeMode } from "./merge";
export type { ClipShape, Region } from "./regions";

export interface SvgExportOptions extends Omit<CollectOptions, "clip" | "region"> {
  /** The Clip: a rectangle, or Regions with their Layout (ADR 0016). */
  clip: ClipShape;
  mergeMode: MergeMode;
  /** Store repeated shapes once and place them with <use> (fewer bytes, more elements). */
  reuseShapes?: boolean;
}

export interface SvgExport {
  svg: string;
  elements: number;
  /** Items collected from the PDF before merging. */
  sourceItems: number;
  unsupported: Record<string, number>;
}

export function exportSvg(mupdf: typeof MuPDF, page: MuPDF.Page, opts: SvgExportOptions): SvgExport {
  const regions = asRegions(opts.clip);
  if (regions.length === 0) throw new Error("no Region");
  let c: Collected;
  let background: { x0: number; y0: number; x1: number; y1: number }[] | undefined;
  if (regions.length === 1) {
    c = collect(mupdf, page, { ...opts, clip: plain(regions[0]!) });
  } else {
    // Each Region is collected on its own (in one shared pass), already placed in the
    // stitched Clip; the items then go through merging together, as one picture (ADR 0016).
    const size = clipSize(regions);
    const parts = collectAll(
      mupdf,
      page,
      regions.map((r, i) => ({ ...opts, clip: plain(r), region: { at: r.at, size, idPrefix: `r${i + 1}` } })),
    );
    c = {
      items: parts.flatMap((p) => p.items),
      clips: new Map(parts.flatMap((p) => [...p.clips])),
      patterns: parts.flatMap((p) => p.patterns),
      width: parts[0]!.width,
      height: parts[0]!.height,
      unsupported: {},
    };
    for (const p of parts) for (const [k, n] of Object.entries(p.unsupported)) c.unsupported[k] = (c.unsupported[k] ?? 0) + n;
    const u = (v: number) => Math.round(v * UNITS_PER_MM);
    background = regions.map((r) => ({ x0: u(r.at.x), y0: u(r.at.y), x1: u(r.at.x) + u(r.width), y1: u(r.at.y) + u(r.height) }));
  }
  const groups = mergeItems(c.items, opts.mergeMode, c.width, c.height);
  const { svg, elements } = toSvg(groups, c.clips, c.patterns, c.width, c.height, { reuseShapes: opts.reuseShapes, background });
  return { svg, elements, sourceItems: c.items.length, unsupported: c.unsupported };
}

const plain = (r: ClipMm): ClipMm => ({ x: r.x, y: r.y, width: r.width, height: r.height });
