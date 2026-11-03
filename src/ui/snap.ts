// Snap targets (ADR 0003): horizontal and vertical lines and text edges of the
// Plan, in mm. Built once in the engine, queried while dragging Clip edges.

import type { ClipMm } from "../export/index";
import type { Handle, Point } from "./clipdrag";

/**
 * Axis-parallel line segments at fixed positions, sorted by position.
 * For vertical lines pos is x and [a, b] the y-extent; for horizontal lines the reverse.
 */
export interface SnapLines {
  pos: Float64Array;
  a: Float64Array;
  b: Float64Array;
}

/**
 * Lines are exact (drawn paths); text edges are estimated from font metrics, so
 * they only count when no line is within reach.
 */
export interface SnapIndex {
  vertical: SnapLines;
  horizontal: SnapLines;
  textVertical: SnapLines;
  textHorizontal: SnapLines;
}

export interface Range {
  lo: number;
  hi: number;
}

/** A line the Clip snapped to, for drawing a guide. */
export interface Guide {
  vertical: boolean;
  pos: number;
  a: number;
  b: number;
}

/**
 * Builds sorted, merged lines from raw segments (flat triples pos, a, b).
 * Segments at the same position (within posTol) whose extents touch or are
 * closer than `gap` are merged, so 2,800 row-by-row pieces of one grid line
 * become one entry.
 */
export function buildLines(raw: ArrayLike<number>, posTol = 0.01, gap = 0.5): SnapLines {
  const n = Math.floor(raw.length / 3);
  const order = Array.from({ length: n }, (_, i) => i);
  const P = (i: number) => Math.round(raw[i * 3]! / posTol);
  order.sort((i, j) => P(i) - P(j) || raw[i * 3 + 1]! - raw[j * 3 + 1]!);
  const pos: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  for (const i of order) {
    const p = P(i) * posTol;
    const s = raw[i * 3 + 1]!;
    const e = raw[i * 3 + 2]!;
    const last = pos.length - 1;
    if (last >= 0 && Math.abs(pos[last]! - p) < posTol / 2 && s <= b[last]! + gap) {
      if (e > b[last]!) b[last] = e;
    } else {
      pos.push(p);
      a.push(s);
      b.push(e);
    }
  }
  return { pos: Float64Array.from(pos), a: Float64Array.from(a), b: Float64Array.from(b) };
}

/** First index with pos >= v. */
function lowerBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The line closest to `value` within `tol` whose extent overlaps `range`, or null. */
export function nearest(lines: SnapLines, value: number, tol: number, range: Range): Guide | null {
  let best: Guide | null = null;
  let bestDist = Infinity;
  for (let i = lowerBound(lines.pos, value - tol); i < lines.pos.length && lines.pos[i]! <= value + tol; i++) {
    if (lines.a[i]! > range.hi || lines.b[i]! < range.lo) continue;
    const d = Math.abs(lines.pos[i]! - value);
    if (d < bestDist) {
      bestDist = d;
      best = { vertical: false, pos: lines.pos[i]!, a: lines.a[i]!, b: lines.b[i]! };
    }
  }
  return best;
}

const overlap = (lo1: number, hi1: number, lo2: number, hi2: number): Range =>
  Math.max(lo1, lo2) <= Math.min(hi1, hi2)
    ? { lo: Math.max(lo1, lo2), hi: Math.min(hi1, hi2) }
    : { lo: lo2, hi: hi2 };

/**
 * Snaps the edges that `handle` moves. `visible` is the part of the Plan the user
 * sees: only lines there count. For "new" the dragged corner is derived from
 * the drag direction.
 */
export function snapClip(
  c: ClipMm,
  handle: Handle,
  index: SnapIndex,
  tol: number,
  visible: { x0: number; y0: number; x1: number; y1: number },
  drag?: { from: Point; to: Point },
): { clip: ClipMm; guides: Guide[] } {
  let h: string = handle;
  if (handle === "new" && drag) h = (drag.to.y >= drag.from.y ? "s" : "n") + (drag.to.x >= drag.from.x ? "e" : "w");
  let x0 = c.x;
  let x1 = c.x + c.width;
  let y0 = c.y;
  let y1 = c.y + c.height;
  const yRange = overlap(y0, y1, visible.y0, visible.y1);
  const xRange = overlap(x0, x1, visible.x0, visible.x1);
  const guides: Guide[] = [];
  const v = (x: number) => nearest(index.vertical, x, tol, yRange) ?? nearest(index.textVertical, x, tol, yRange);
  const hz = (y: number) => nearest(index.horizontal, y, tol, xRange) ?? nearest(index.textHorizontal, y, tol, xRange);
  const add = (g: Guide | null, vertical: boolean) => g && guides.push({ ...g, vertical });

  if (h === "move") {
    const gx0 = v(x0);
    const gx1 = v(x1);
    const dx0 = gx0 ? gx0.pos - x0 : Infinity;
    const dx1 = gx1 ? gx1.pos - x1 : Infinity;
    const dx = Math.abs(dx0) <= Math.abs(dx1) ? dx0 : dx1;
    if (Number.isFinite(dx)) {
      add(Math.abs(dx0) <= Math.abs(dx1) ? gx0 : gx1, true);
      x0 += dx;
      x1 += dx;
    }
    const gy0 = hz(y0);
    const gy1 = hz(y1);
    const dy0 = gy0 ? gy0.pos - y0 : Infinity;
    const dy1 = gy1 ? gy1.pos - y1 : Infinity;
    const dy = Math.abs(dy0) <= Math.abs(dy1) ? dy0 : dy1;
    if (Number.isFinite(dy)) {
      add(Math.abs(dy0) <= Math.abs(dy1) ? gy0 : gy1, false);
      y0 += dy;
      y1 += dy;
    }
  } else {
    if (h.includes("w")) {
      const g = v(x0);
      if (g) (x0 = g.pos), add(g, true);
    }
    if (h.includes("e")) {
      const g = v(x1);
      if (g) (x1 = g.pos), add(g, true);
    }
    if (h.includes("n")) {
      const g = hz(y0);
      if (g) (y0 = g.pos), add(g, false);
    }
    if (h.includes("s")) {
      const g = hz(y1);
      if (g) (y1 = g.pos), add(g, false);
    }
  }
  return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, guides };
}
