// Mouse interaction for the Clip rectangle: draw, move, and resize by edges/corners.
// Pure functions in mm, so they are easy to test.

import type { ClipMm } from "../export/index";

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move" | "new";

export interface Point {
  x: number;
  y: number;
}

export const CURSORS: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  move: "move",
  new: "crosshair",
};

/** Which part of the Clip is under point p? tol is the grab distance in mm. */
export function hitTest(c: ClipMm, p: Point, tol: number): Handle {
  const x1 = c.x + c.width;
  const y1 = c.y + c.height;
  const insideX = p.x >= c.x - tol && p.x <= x1 + tol;
  const insideY = p.y >= c.y - tol && p.y <= y1 + tol;
  if (!insideX || !insideY) return "new";
  const nearW = Math.abs(p.x - c.x) <= tol;
  const nearE = Math.abs(p.x - x1) <= tol;
  const nearN = Math.abs(p.y - c.y) <= tol;
  const nearS = Math.abs(p.y - y1) <= tol;
  const v = nearN ? "n" : nearS ? "s" : "";
  const h = nearW ? "w" : nearE ? "e" : "";
  if (v || h) return (v + h) as Handle;
  return "move";
}

/** The Clip after dragging `handle` from `from` to `to`, kept inside the Plan. */
export function dragClip(start: ClipMm, handle: Handle, from: Point, to: Point, plan: { width: number; height: number }): ClipMm {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (handle === "new") {
    return normalise({ x: from.x, y: from.y, width: dx, height: dy });
  }
  if (handle === "move") {
    return {
      ...start,
      x: Math.min(Math.max(0, start.x + dx), Math.max(0, plan.width - start.width)),
      y: Math.min(Math.max(0, start.y + dy), Math.max(0, plan.height - start.height)),
    };
  }
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.width;
  let y1 = start.y + start.height;
  if (handle.includes("w")) x0 += dx;
  if (handle.includes("e")) x1 += dx;
  if (handle.includes("n")) y0 += dy;
  if (handle.includes("s")) y1 += dy;
  return normalise({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** Dragging an edge past the opposite one flips the rectangle instead of breaking it. */
function normalise(c: ClipMm): ClipMm {
  return {
    x: Math.min(c.x, c.x + c.width),
    y: Math.min(c.y, c.y + c.height),
    width: Math.abs(c.width),
    height: Math.abs(c.height),
  };
}
