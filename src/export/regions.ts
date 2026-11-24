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

/**
 * Where the Clip lies in Layout coordinates: from (0, 0), or from further up or left
 * while a Region is dragged past the Clip's start, to the far edges of its Regions.
 */
export function clipBounds(regions: readonly Region[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;
  for (const r of regions) {
    x0 = Math.min(x0, r.at.x);
    y0 = Math.min(y0, r.at.y);
    x1 = Math.max(x1, r.at.x + r.width);
    y1 = Math.max(y1, r.at.y + r.height);
  }
  return { x0, y0, x1, y1 };
}

/** Size of the Clip: from its start to the right and bottom edges of its Regions. */
export function clipSize(regions: readonly Region[]): { width: number; height: number } {
  const b = clipBounds(regions);
  return { width: b.x1 - b.x0, height: b.y1 - b.y0 };
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

/** How far normaliseLayout shifts the Layout (subtracted from every `at`). */
export function layoutOffset(regions: readonly Region[]): { x: number; y: number } {
  if (regions.length === 0) return { x: 0, y: 0 };
  return { x: Math.min(...regions.map((r) => r.at.x)), y: Math.min(...regions.map((r) => r.at.y)) };
}

/** Shifts the Layout so the Clip starts at its top-left corner (nothing empty before it). */
export function normaliseLayout(regions: readonly Region[]): Region[] {
  if (regions.length === 0) return [];
  const { x: dx, y: dy } = layoutOffset(regions);
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return [...regions];
  return regions.map((r) => ({ ...r, at: { x: r.at.x - dx, y: r.at.y - dy } }));
}

/** Removes Region `index`; the others keep their places, shifted so the Clip starts at (0, 0). */
export function removeRegion(regions: readonly Region[], index: number): Region[] {
  return normaliseLayout(regions.filter((_, i) => i !== index));
}

// ---- Semi-automatic Layout (ADR 0016) -------------------------------------------------

type Axis = "x" | "y";
const cross = (ax: Axis): Axis => (ax === "x" ? "y" : "x");
const lo = (r: Region, ax: Axis) => r.at[ax];
const len = (r: Region, ax: Axis) => (ax === "x" ? r.width : r.height);
const hi = (r: Region, ax: Axis) => lo(r, ax) + len(r, ax);
/** Do a and b share more than a point across `ax` (their extents along the other axis overlap)? */
const alongside = (a: Region, b: Region, ax: Axis) => {
  const o = cross(ax);
  return lo(a, o) < hi(b, o) - EPS && lo(b, o) < hi(a, o) - EPS;
};
const copy = (r: Region): Region => ({ ...r, at: { ...r.at } });

/**
 * The Regions touching `start`'s edge on `side` along `ax` (edges coincide and overlap
 * along their length), and those touching them in turn, further on that side.
 */
function chain(regions: readonly Region[], start: number, ax: Axis, side: "lo" | "hi"): Set<number> {
  const found = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const a = regions[queue.pop()!]!;
    regions.forEach((b, j) => {
      if (j === start || found.has(j) || !alongside(a, b, ax)) return;
      const touching = side === "hi" ? Math.abs(lo(b, ax) - hi(a, ax)) < EPS : Math.abs(hi(b, ax) - lo(a, ax)) < EPS;
      if (touching) {
        found.add(j);
        queue.push(j);
      }
    });
  }
  return found;
}

/**
 * Pushes every Region that overlaps one of `fixed` along `ax` in direction `dir`, just
 * far enough to touch; pushed Regions push in turn. Mutates `regions`.
 */
function push(regions: Region[], fixed: Set<number>, ax: Axis, dir: number): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j < regions.length; j++) {
      if (fixed.has(j)) continue;
      const r = regions[j]!;
      if (![...fixed].some((f) => overlap(placed(r), placed(regions[f]!)))) continue;
      // Slide on until no fixed Region is in the way.
      for (let hit = true; hit; ) {
        hit = false;
        for (const f of fixed) {
          const o = regions[f]!;
          if (!overlap(placed(r), placed(o))) continue;
          r.at[ax] = dir > 0 ? hi(o, ax) : lo(o, ax) - len(r, ax);
          hit = true;
        }
      }
      fixed.add(j);
      changed = true;
    }
  }
}

/**
 * Moves one edge of Region `index` by `d` along `ax` in the Layout: the Regions touching
 * that edge (and those touching them) move with it, anything now overlapped is pushed.
 */
function moveEdge(regions: Region[], index: number, ax: Axis, side: "lo" | "hi", d: number): void {
  if (Math.abs(d) < EPS) return;
  const followers = chain(regions, index, ax, side);
  const r = regions[index]!;
  if (side === "lo") r.at[ax] += d;
  if (ax === "x") r.width += side === "hi" ? d : -d;
  else r.height += side === "hi" ? d : -d;
  for (const j of followers) regions[j]!.at[ax] += d;
  push(regions, new Set([index, ...followers]), ax, Math.sign(d));
}

/**
 * Region `index` gets a new rectangle on the Plan (ADR 0016). Moving it without resizing
 * only changes its content; the Layout stays. A resize moves each changed edge the same
 * way in the Layout, Regions touching it move along (touching stays touching), and a
 * Region that would be overlapped is pushed just enough. The Clip grows up and left if
 * needed, so it still starts at (0, 0).
 */
export function setRect(regions: readonly Region[], index: number, rect: ClipMm): Region[] {
  const old = regions[index]!;
  const out = regions.map(copy);
  const resized = Math.abs(rect.width - old.width) > EPS || Math.abs(rect.height - old.height) > EPS;
  if (resized) {
    for (const ax of ["x", "y"] as const) {
      const size = ax === "x" ? "width" : "height";
      if (Math.abs(rect[size] - old[size]) <= EPS) continue;
      moveEdge(out, index, ax, "lo", rect[ax] - old[ax]);
      moveEdge(out, index, ax, "hi", rect[ax] + rect[size] - (old[ax] + old[size]));
    }
  }
  const r = out[index]!;
  out[index] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, at: r.at };
  return resized ? normaliseLayout(out) : out;
}

// ---- Arranging in the Clip (ADR 0016) ---------------------------------------------------

/** A line a Region snapped to in the Layout: x (vertical) or y, in Layout mm. */
export interface LayoutGuide {
  vertical: boolean;
  pos: number;
}

/** Slides Region `index` along `ax` towards `target`, stopping at the first Region in the way. */
function slide(regions: Region[], index: number, ax: Axis, target: number): void {
  const r = regions[index]!;
  let d = target - lo(r, ax);
  regions.forEach((o, j) => {
    if (j === index || !alongside(r, o, ax)) return;
    if (d > 0 && lo(o, ax) >= hi(r, ax) - EPS) d = Math.min(d, lo(o, ax) - hi(r, ax));
    if (d < 0 && hi(o, ax) <= lo(r, ax) + EPS) d = Math.max(d, hi(o, ax) - lo(r, ax));
  });
  r.at[ax] += d;
}

/** The nearest snap of a Region at `pos` (its edges `pos` and `pos + size`) to `lines`, within `tol`. */
function snapAxis(pos: number, size: number, lines: number[], tol: number): number | undefined {
  let best: number | undefined;
  let bestDist = tol;
  for (const t of lines)
    for (const edge of [pos, pos + size]) {
      const dist = Math.abs(edge - t);
      if (dist <= bestDist) {
        bestDist = dist;
        best = pos + (t - edge);
      }
    }
  return best;
}

/**
 * Moves Region `index` in the Layout towards `want` (its new top-left corner). With
 * `snapMm` its edges first snap to the other Regions' edges and the Clip's start. It
 * never overlaps another Region: it slides there and stops at the first one in its way
 * (unless `jump` is set and `want` is free). The Layout is not normalised here, so a
 * Region dragged past the Clip's start shows where the Clip will grow.
 */
export function moveInLayout(
  regions: readonly Region[],
  index: number,
  want: { x: number; y: number },
  opts: { snapMm?: number; jump?: boolean } = {},
): { regions: Region[]; guides: LayoutGuide[] } {
  const r = regions[index]!;
  const target = { ...want };
  if (opts.snapMm !== undefined) {
    const others = regions.filter((_, i) => i !== index);
    for (const ax of ["x", "y"] as const) {
      const lines = [0, ...others.flatMap((o) => [lo(o, ax), hi(o, ax)])];
      const s = snapAxis(target[ax], len(r, ax), lines, opts.snapMm);
      if (s !== undefined) target[ax] = s;
    }
  }
  const free = (at: { x: number; y: number }) => {
    const moved = { ...r, at };
    return regions.every((o, i) => i === index || !overlap(placed(moved), placed(o)));
  };
  let out: Region[];
  if (opts.jump && free(target)) {
    out = regions.map((o, i) => (i === index ? { ...o, at: { ...target } } : o));
  } else {
    // Slide one axis, then the other; of both orders take the one that gets closer.
    const tries = (["x", "y"] as const).map((first) => {
      const t = regions.map(copy);
      slide(t, index, first, target[first]);
      slide(t, index, cross(first), target[cross(first)]);
      return t;
    });
    const miss = (t: Region[]) => Math.hypot(t[index]!.at.x - target.x, t[index]!.at.y - target.y);
    out = miss(tries[1]!) < miss(tries[0]!) - EPS ? tries[1]! : tries[0]!;
  }
  // Guides for the lines the Region now lies on.
  const guides: LayoutGuide[] = [];
  if (opts.snapMm !== undefined) {
    const m = out[index]!;
    const others = out.filter((_, i) => i !== index);
    for (const ax of ["x", "y"] as const) {
      const lines = new Set([0, ...others.flatMap((o) => [lo(o, ax), hi(o, ax)])]);
      for (const edge of [lo(m, ax), hi(m, ax)])
        if ([...lines].some((t) => Math.abs(t - edge) < EPS)) guides.push({ vertical: ax === "x", pos: edge });
    }
  }
  return { regions: out, guides };
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
