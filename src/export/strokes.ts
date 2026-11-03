// Geometric compaction of merged stroke groups (ADR 0011).
//
// Plan exporters draw grid lines piece by piece (one piece per row) and table
// cells as separate rectangles, so shared edges are drawn twice. Within one
// merged group (same colour, width, caps, joins; opaque; not dashed) the stroked
// area is the union of all pieces, so collinear pieces that touch or overlap can
// be joined into one line without changing a pixel.
//
// Rectangles may be split into their four edges only where that reproduces the
// mitred corners exactly: with butt caps each edge is extended by half the line
// width, with square caps the cap itself does that. Whichever encoding is smaller
// is used.

import { Op, type PathData, type StrokeStyle } from "./ir";

interface Sub {
  pts: [number, number][];
  closed: boolean;
  curves: boolean;
  raw: PathData;
}

function subpaths(d: PathData): Sub[] {
  const out: Sub[] = [];
  let cur: Sub | undefined;
  let i = 0;
  while (i < d.length) {
    const op = d[i++];
    if (op === Op.Move) {
      const p: [number, number] = [Math.round(d[i++]!), Math.round(d[i++]!)];
      cur = { pts: [p], closed: false, curves: false, raw: [Op.Move, ...p] };
      out.push(cur);
    } else if (op === Op.Line) {
      const p: [number, number] = [Math.round(d[i++]!), Math.round(d[i++]!)];
      cur!.pts.push(p);
      cur!.raw.push(Op.Line, ...p);
    } else if (op === Op.Curve) {
      const c = d.slice(i, i + 6);
      i += 6;
      cur!.curves = true;
      cur!.pts.push([Math.round(c[4]!), Math.round(c[5]!)]);
      cur!.raw.push(Op.Curve, ...c);
    } else {
      cur!.closed = true;
      cur!.raw.push(Op.Close);
    }
  }
  return out;
}

/** Axis-aligned rectangle (closed, 4 corners, possibly repeating the first point)? */
function rectCorners(s: Sub): [number, number][] | null {
  if (!s.closed || s.curves) return null;
  let pts = s.pts;
  if (pts.length === 5 && pts[4]![0] === pts[0]![0] && pts[4]![1] === pts[0]![1]) pts = pts.slice(0, 4);
  if (pts.length !== 4) return null;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = pts[k]!;
    const [bx, by] = pts[(k + 1) % 4]!;
    if (ax !== bx && ay !== by) return null;
  }
  return pts;
}

class Lines {
  /** key "h:y" or "v:x" -> intervals */
  private map = new Map<string, [number, number][]>();

  add(x0: number, y0: number, x1: number, y1: number, ext = 0): void {
    if (y0 === y1) this.push(`h:${y0}`, Math.min(x0, x1) - ext, Math.max(x0, x1) + ext);
    else this.push(`v:${x0}`, Math.min(y0, y1) - ext, Math.max(y0, y1) + ext);
  }

  private push(key: string, a: number, b: number): void {
    const list = this.map.get(key);
    if (list) list.push([a, b]);
    else this.map.set(key, [[a, b]]);
  }

  toPath(): PathData {
    const d: PathData = [];
    const keys = [...this.map.keys()].sort((p, q) => {
      const [op, vp] = [p[0], Number(p.slice(2))];
      const [oq, vq] = [q[0], Number(q.slice(2))];
      return op === oq ? vp - vq : op! < oq! ? -1 : 1;
    });
    for (const key of keys) {
      const horizontal = key[0] === "h";
      const pos = Number(key.slice(2));
      const list = this.map.get(key)!.sort((p, q) => p[0] - q[0]);
      let [a, b] = list[0]!;
      const emit = () =>
        horizontal ? d.push(Op.Move, a, pos, Op.Line, b, pos) : d.push(Op.Move, pos, a, Op.Line, pos, b);
      for (let k = 1; k < list.length; k++) {
        const [na, nb] = list[k]!;
        if (na <= b) b = Math.max(b, nb); // touching or overlapping: one line
        else {
          emit();
          [a, b] = [na, nb];
        }
      }
      emit();
    }
    return d;
  }
}

/**
 * Path data covering exactly the same stroked area as all of `ds` together, as
 * compact as possible. `encodedLength` measures candidates in SVG syntax.
 */
export function compactStrokes(ds: PathData[], style: StrokeStyle, encodedLength: (d: PathData) => number): PathData {
  const subs = ds.flatMap(subpaths);
  const rectsSplittable = style.join === "miter" && style.miterLimit >= Math.SQRT2 && (style.cap === "butt" || style.cap === "square");
  const ext = style.cap === "butt" ? style.width / 2 : 0;

  // Variant A: join loose axis-aligned pieces; keep everything else as is.
  const linesA = new Lines();
  const restA: PathData = [];
  // Variant B: additionally split rectangles into (extended) edges.
  const linesB = new Lines();
  const restB: PathData = [];

  for (const s of subs) {
    const open2 = !s.closed && !s.curves && s.pts.length === 2;
    const [p, q] = s.pts as [[number, number], [number, number]];
    if (open2 && (p[0] === q[0] || p[1] === q[1])) {
      linesA.add(p[0], p[1], q[0], q[1]);
      linesB.add(p[0], p[1], q[0], q[1]);
      continue;
    }
    restA.push(...s.raw);
    const corners = rectsSplittable ? rectCorners(s) : null;
    if (corners) {
      for (let k = 0; k < 4; k++) {
        const [ax, ay] = corners[k]!;
        const [bx, by] = corners[(k + 1) % 4]!;
        linesB.add(ax, ay, bx, by, ext);
      }
    } else {
      restB.push(...s.raw);
    }
  }
  const a = [...linesA.toPath(), ...restA];
  if (!rectsSplittable) return a;
  const b = [...linesB.toPath(), ...restB];
  return encodedLength(b) < encodedLength(a) ? b : a;
}
