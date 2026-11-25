// SVG export entry point: collect -> merge -> serialise.

import type * as MuPDF from "mupdf";
import { collect, collectAll, type ClipMm, type CollectOptions } from "./collect";
import type { Collected } from "./ir";
import { mergeItems, type MergeMode } from "./merge";
import { asRegions, clipBounds, clipSize, type ClipShape, type Region } from "./regions";
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

/**
 * One SVG to write: the Regions in it, placed in it (`at`), and its size (mm). `whole`:
 * a single Region filling the SVG, collected like a plain Clip (no Region edge clip).
 */
interface Piece {
  parts: Region[];
  size: { width: number; height: number };
  whole: boolean;
}

const EPS = 1e-6;

export function exportSvg(mupdf: typeof MuPDF, page: MuPDF.Page, opts: SvgExportOptions): SvgExport {
  const regions = asRegions(opts.clip);
  if (regions.length === 0) throw new Error("no Region");
  const piece: Piece = { parts: [...regions], size: clipSize(regions), whole: regions.length === 1 };
  const all = partOptions(opts, piece);
  // Several Regions are collected in one shared pass, each already placed in the
  // stitched Clip; the items then go through merging together, as one picture (ADR 0016).
  const parts = all.length === 1 ? [collect(mupdf, page, all[0]!)] : collectAll(mupdf, page, all);
  return assemble(piece, parts, opts);
}

/** A Tile of a Tiled Export (ADR 0013): its place in the Clip (mm, from the Clip's top-left). */
export interface TileRect extends ClipMm {
  name: string;
}

/**
 * The Regions of a Clip that fall inside a Tile, cut to it and placed in it: a Tile is
 * exported like a Clip of these Regions. Empty if no Region reaches into the Tile.
 */
export function tileRegions(regions: readonly Region[], tile: ClipMm): Region[] {
  const b = clipBounds(regions);
  const tx0 = b.x0 + tile.x;
  const ty0 = b.y0 + tile.y;
  const tx1 = tx0 + tile.width;
  const ty1 = ty0 + tile.height;
  const out: Region[] = [];
  for (const r of regions) {
    const x0 = Math.max(r.at.x, tx0);
    const y0 = Math.max(r.at.y, ty0);
    const x1 = Math.min(r.at.x + r.width, tx1);
    const y1 = Math.min(r.at.y + r.height, ty1);
    if (x1 - x0 <= EPS || y1 - y0 <= EPS) continue;
    out.push({ x: r.x + (x0 - r.at.x), y: r.y + (y0 - r.at.y), width: x1 - x0, height: y1 - y0, at: { x: x0 - tx0, y: y0 - ty0 } });
  }
  return out;
}

/**
 * The SVG Tiled Export: one bare SVG per Tile (no Margin), all from one shared pass over
 * the page. A Tile with nothing of the Plan in it gives null (it is skipped).
 */
export function exportSvgTiles(mupdf: typeof MuPDF, page: MuPDF.Page, opts: SvgExportOptions, tiles: readonly ClipMm[]): (SvgExport | null)[] {
  const regions = asRegions(opts.clip);
  const pieces = tiles.map((t): Piece => {
    const parts = tileRegions(regions, t);
    const size = { width: t.width, height: t.height };
    const p = parts[0];
    const whole =
      parts.length === 1 && Math.abs(p!.at.x) < EPS && Math.abs(p!.at.y) < EPS && Math.abs(p!.width - t.width) < EPS && Math.abs(p!.height - t.height) < EPS;
    return { parts, size, whole };
  });
  const all = pieces.map((p) => partOptions(opts, p));
  const flat = all.flat();
  const collected = flat.length === 0 ? [] : flat.length === 1 ? [collect(mupdf, page, flat[0]!)] : collectAll(mupdf, page, flat);
  let next = 0;
  return pieces.map((p, i) => {
    const parts = collected.slice(next, (next += all[i]!.length));
    if (parts.every((c) => c.items.length === 0)) return null;
    return assemble(p, parts, opts);
  });
}

function partOptions(opts: SvgExportOptions, piece: Piece): CollectOptions[] {
  if (piece.whole) return [{ ...opts, clip: plain(piece.parts[0]!) }];
  return piece.parts.map((r, i) => ({ ...opts, clip: plain(r), region: { at: r.at, size: piece.size, idPrefix: `r${i + 1}` } }));
}

function assemble(piece: Piece, parts: Collected[], opts: SvgExportOptions): SvgExport {
  const c: Collected =
    parts.length === 1
      ? parts[0]!
      : {
          items: parts.flatMap((p) => p.items),
          clips: new Map(parts.flatMap((p) => [...p.clips])),
          patterns: parts.flatMap((p) => p.patterns),
          width: parts[0]!.width,
          height: parts[0]!.height,
          unsupported: {},
        };
  if (parts.length > 1)
    for (const p of parts) for (const [k, n] of Object.entries(p.unsupported)) c.unsupported[k] = (c.unsupported[k] ?? 0) + n;
  // A stitched Clip (or a Tile not filled by one Region) whitens only its Regions.
  const u = (v: number) => Math.round(v * UNITS_PER_MM);
  const background = piece.whole
    ? undefined
    : piece.parts.map((r) => ({ x0: u(r.at.x), y0: u(r.at.y), x1: u(r.at.x) + u(r.width), y1: u(r.at.y) + u(r.height) }));
  const groups = mergeItems(c.items, opts.mergeMode, c.width, c.height);
  const { svg, elements } = toSvg(groups, c.clips, c.patterns, c.width, c.height, { reuseShapes: opts.reuseShapes, background });
  return { svg, elements, sourceItems: c.items.length, unsupported: c.unsupported };
}

const plain = (r: ClipMm): ClipMm => ({ x: r.x, y: r.y, width: r.width, height: r.height });
