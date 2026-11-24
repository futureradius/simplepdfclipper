// The Clip as one or more Regions with their Layout (ADR 0016). Pure functions in mm,
// shared by the UI and the exports.
//
// A Region is a rectangle on the Plan (x, y, width, height) plus where its top-left
// corner sits in the Clip (`at`). Regions are only moved in the Clip, never scaled, and
// never overlap there. The Clip reaches from (0, 0) to the far edges of its Regions.

import type { ClipMm } from "./collect";

export interface Region extends ClipMm {
  /** Top-left corner in the Clip (Layout), mm. */
  at: { x: number; y: number };
}

/** Rounding slack for touching edges (mm). */
const EPS = 1e-6;

/** Size of the Clip: from (0, 0) to the right and bottom edges of its Regions. */
export function clipSize(regions: readonly Region[]): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const r of regions) {
    width = Math.max(width, r.at.x + r.width);
    height = Math.max(height, r.at.y + r.height);
  }
  return { width, height };
}

/** The Region's rectangle in the Clip. */
export function placed(r: Region): ClipMm {
  return { x: r.at.x, y: r.at.y, width: r.width, height: r.height };
}

/** Do two rectangles overlap by more than a touching edge? */
function overlap(a: ClipMm, b: ClipMm): boolean {
  return a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS;
}

/** True if any two Regions overlap in the Clip. */
export function overlapsInLayout(regions: readonly Region[]): boolean {
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++) if (overlap(placed(regions[i]!), placed(regions[j]!))) return true;
  return false;
}

type Direction = "stacked" | "side";

/**
 * Lays out `regions` one after another in Plan order: stacked top to bottom (sorted by
 * top edge) or side by side (sorted by left edge). In the other direction each Region
 * keeps its offset from the leftmost (topmost) Region on the Plan.
 */
function lineUp(regions: readonly Region[], dir: Direction): Region[] {
  const minX = Math.min(...regions.map((r) => r.x));
  const minY = Math.min(...regions.map((r) => r.y));
  const order = regions
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (dir === "stacked" ? a.r.y - b.r.y || a.r.x - b.r.x : a.r.x - b.r.x || a.r.y - b.r.y) || a.i - b.i);
  const out: Region[] = [...regions];
  let pos = 0;
  for (const { r, i } of order) {
    out[i] = { ...r, at: dir === "stacked" ? { x: r.x - minX, y: pos } : { x: pos, y: r.y - minY } };
    pos += dir === "stacked" ? r.height : r.width;
  }
  return out;
}

const area = (regions: readonly Region[]) => {
  const s = clipSize(regions);
  return s.width * s.height;
};

/**
 * The suggested Layout ("minimal fit", ADR 0016): stacked and side by side, both in
 * Plan order; the smaller Clip wins, a tie stacks. The list order is kept.
 */
export function suggestLayout(regions: readonly Region[]): Region[] {
  if (regions.length === 0) return [];
  const stacked = lineUp(regions, "stacked");
  const side = lineUp(regions, "side");
  return area(side) < area(stacked) - EPS ? side : stacked;
}

/**
 * Places a new Region beside the existing Layout, which stays: below it or to its
 * right, keeping its Plan offset in the other direction (from the leftmost or topmost
 * Region, never before the Clip's start). The smaller Clip wins, a tie goes below.
 */
export function placeNew(existing: readonly Region[], rect: ClipMm): Region {
  if (existing.length === 0) return { ...rect, at: { x: 0, y: 0 } };
  const size = clipSize(existing);
  const minX = Math.min(...existing.map((r) => r.x));
  const minY = Math.min(...existing.map((r) => r.y));
  const below: Region = { ...rect, at: { x: Math.max(0, rect.x - minX), y: size.height } };
  const right: Region = { ...rect, at: { x: size.width, y: Math.max(0, rect.y - minY) } };
  return area([...existing, right]) < area([...existing, below]) - EPS ? right : below;
}

/** Shifts the Layout so the Clip starts at its top-left corner (nothing empty before it). */
export function normaliseLayout(regions: readonly Region[]): Region[] {
  if (regions.length === 0) return [];
  const dx = Math.min(...regions.map((r) => r.at.x));
  const dy = Math.min(...regions.map((r) => r.at.y));
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return [...regions];
  return regions.map((r) => ({ ...r, at: { x: r.at.x - dx, y: r.at.y - dy } }));
}

/** Removes Region `index`; the others keep their places, shifted so the Clip starts at (0, 0). */
export function removeRegion(regions: readonly Region[], index: number): Region[] {
  return normaliseLayout(regions.filter((_, i) => i !== index));
}

/**
 * Region `index` gets a new rectangle on the Plan. Moving it keeps the Layout. Until
 * the semi-automatic Layout (#37), a resize keeps its place in the Clip, and if it now
 * overlaps another Region the whole Layout is suggested anew.
 */
export function setRect(regions: readonly Region[], index: number, rect: ClipMm): Region[] {
  const out = regions.map((r, i) => (i === index ? { ...rect, at: r.at } : r));
  return overlapsInLayout(out) ? suggestLayout(out) : out;
}

/** What the exports take: one rectangle (a one-Region Clip) or Regions with their Layout. */
export type ClipShape = ClipMm | readonly Region[];

/** The Regions of a Clip given either way. */
export function asRegions(clip: ClipShape): readonly Region[] {
  return Array.isArray(clip) ? (clip as readonly Region[]) : single(clip as ClipMm);
}

/** A one-Region Clip from a plain rectangle. */
export function single(rect: ClipMm): Region[] {
  return [{ ...rect, at: { x: 0, y: 0 } }];
}

/** Reads Regions from untrusted data (storage); undefined if malformed. */
export function readRegions(data: unknown): Region[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const out: Region[] = [];
  for (const d of data as Partial<Region>[]) {
    const nums = [d?.x, d?.y, d?.width, d?.height, d?.at?.x, d?.at?.y];
    if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
    if (d.width! <= 0 || d.height! <= 0) return undefined;
    out.push({ x: d.x!, y: d.y!, width: d.width!, height: d.height!, at: { x: d.at!.x, y: d.at!.y } });
  }
  return overlapsInLayout(out) ? suggestLayout(out) : normaliseLayout(out);
}
