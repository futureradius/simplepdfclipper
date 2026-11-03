// 2D affine matrices (fitz convention: [a b c d e f], points are row vectors,
// p' = p × M) and axis-aligned rectangles.

export type Matrix = [number, number, number, number, number, number];

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Apply m1 first, then m2. */
export function concat(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/** Average scale factor of a matrix (for line widths). */
export function expansion(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function emptyRect(): Rect {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

export function isEmpty(r: Rect): boolean {
  return !(r.x0 <= r.x1 && r.y0 <= r.y1);
}

export function extend(r: Rect, x: number, y: number): void {
  if (x < r.x0) r.x0 = x;
  if (y < r.y0) r.y0 = y;
  if (x > r.x1) r.x1 = x;
  if (y > r.y1) r.y1 = y;
}

export function union(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function expand(r: Rect, d: number): Rect {
  return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d };
}

export function intersect(a: Rect, b: Rect): Rect {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

/** True if the rectangles share an area (touching edges do not count). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** True if the rectangles overlap or touch. */
export function meets(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

export function transformRect(m: Matrix, r: Rect): Rect {
  const out = emptyRect();
  for (const [x, y] of [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x0, r.y1],
    [r.x1, r.y1],
  ] as const) {
    const [tx, ty] = apply(m, x, y);
    extend(out, tx, ty);
  }
  return out;
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) return [1, 0, 0, 1, -e, -f];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
