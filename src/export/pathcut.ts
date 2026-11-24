// Cuts paths geometrically at the Clip (ADR 0005, #35). Pure geometry, shared by the
// PDF pass (which cuts in each path's own user space, so it stays exact under any
// transformation) and the SVG collector (which cuts in export units).
//
// The Clip is given as half-planes (a convex area; a rectangle in some space becomes
// a parallelogram in user space). Fills and clip paths are clipped exactly, curves
// included (Béziers are split, never flattened). Strokes are cut along their centre
// line; a cut end gets no cap, original ends keep theirs, dash patterns continue with
// the right phase.

import { Op, type PathData } from "./ir";
import type { Matrix, Rect } from "./geometry";

export type Pt = [number, number];
/** A line (2 points) or a cubic Bézier (4 points), from its start point on. */
export type Seg = Pt[];
export interface SubPath {
  start: Pt;
  segs: Seg[];
  closed: boolean;
}
/** Half-plane a·x + b·y + c ≥ 0 with |(a, b)| = 1, so the value is the distance inside. */
export type HalfPlane = [number, number, number];

export type LineCap = 0 | 1 | 2; // butt, round, square (PDF numbering)

/** The half-planes of `r` (in target space), seen from a space that `m` maps to the target. */
export function rectHalfPlanes(r: Rect, m: Matrix = [1, 0, 0, 1, 0, 0]): HalfPlane[] {
  const [a, b, c, d, e, f] = m;
  const norm = (h: HalfPlane): HalfPlane => {
    const l = Math.hypot(h[0], h[1]);
    return l > 0 ? [h[0] / l, h[1] / l, h[2] / l] : h;
  };
  return [norm([a, c, e - r.x0]), norm([-a, -c, r.x1 - e]), norm([b, d, f - r.y0]), norm([-b, -d, r.y1 - f])];
}

const gval = (h: HalfPlane, p: Pt) => h[0] * p[0] + h[1] * p[1] + h[2];
const lerp = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
const same = (p: Pt, q: Pt, eps: number) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;
const endOf = (s: SubPath): Pt => (s.segs.length ? s.segs[s.segs.length - 1]!.at(-1)! : s.start);

/** Tolerance for "on the edge", relative to the size of the coordinates. */
function tolerance(subs: SubPath[]): number {
  let m = 1;
  for (const s of subs) {
    m = Math.max(m, Math.abs(s.start[0]), Math.abs(s.start[1]));
    for (const g of s.segs) for (const p of g) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  }
  return m * 1e-9;
}

const points = (s: SubPath) => [s.start, ...s.segs.flat()];
const allInside = (s: SubPath, hs: HalfPlane[], eps: number) => points(s).every((p) => hs.every((h) => gval(h, p) >= -eps));
/** Entirely outside one half-plane (control points included: the curve is in their hull). */
const allOutside = (s: SubPath, hs: HalfPlane[], eps: number) => hs.some((h) => points(s).every((p) => gval(h, p) < -eps));

/** True if no control point of the path lies outside. */
export function isInside(subs: SubPath[], hs: HalfPlane[]): boolean {
  const eps = tolerance(subs);
  return subs.every((s) => allInside(s, hs, eps));
}

// ---- curves -----------------------------------------------------------------

function splitCubic(P: Seg, t: number): [Seg, Seg] {
  const [p0, p1, p2, p3] = P as [Pt, Pt, Pt, Pt];
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
  return [[p0, a, d, f], [f, e, c, p3]];
}

/** Part of a segment between parameters t0 < t1. */
function subSeg(s: Seg, t0: number, t1: number): Seg {
  if (s.length === 2) return [lerp(s[0]!, s[1]!, t0), lerp(s[0]!, s[1]!, t1)];
  let c = s;
  if (t1 < 1) c = splitCubic(c, t1)[0];
  if (t0 > 0) c = splitCubic(c, t0 / t1)[1];
  return c;
}

/** Splits a segment at sorted parameters in (0, 1). */
function splitAt(s: Seg, ts: number[]): Seg[] {
  const out: Seg[] = [];
  let prev = 0;
  for (const t of ts) {
    out.push(subSeg(s, prev, t));
    prev = t;
  }
  out.push(subSeg(s, prev, 1));
  return out;
}

function pointAt(s: Seg, t: number): Pt {
  if (s.length === 2) return lerp(s[0]!, s[1]!, t);
  const u = 1 - t;
  const [p0, p1, p2, p3] = s as [Pt, Pt, Pt, Pt];
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [k0 * p0[0] + k1 * p1[0] + k2 * p2[0] + k3 * p3[0], k0 * p0[1] + k1 * p1[1] + k2 * p2[1] + k3 * p3[1]];
}

function derivAt(s: Seg, t: number): Pt {
  if (s.length === 2) return [s[1]![0] - s[0]![0], s[1]![1] - s[0]![1]];
  const u = 1 - t;
  const [p0, p1, p2, p3] = s as [Pt, Pt, Pt, Pt];
  return [
    3 * (u * u * (p1[0] - p0[0]) + 2 * u * t * (p2[0] - p1[0]) + t * t * (p3[0] - p2[0])),
    3 * (u * u * (p1[1] - p0[1]) + 2 * u * t * (p2[1] - p1[1]) + t * t * (p3[1] - p2[1])),
  ];
}

/** Unit tangent at t; at a degenerate end the direction towards the next distinct control point. */
function tangentAt(s: Seg, t: number): Pt | null {
  let d = derivAt(s, t);
  if (Math.hypot(d[0], d[1]) === 0 && s.length === 4) {
    const from = t < 0.5 ? s[0]! : s[3]!;
    const order = t < 0.5 ? [s[1]!, s[2]!, s[3]!] : [s[2]!, s[1]!, s[0]!];
    const q = order.find((p) => p[0] !== from[0] || p[1] !== from[1]);
    if (q) d = t < 0.5 ? [q[0] - from[0], q[1] - from[1]] : [from[0] - q[0], from[1] - q[1]];
  }
  const l = Math.hypot(d[0], d[1]);
  return l > 0 ? [d[0] / l, d[1] / l] : null;
}

/** Real roots in (0, 1) of a + b t + c t² + d t³, sorted. */
function cubicRoots(a: number, b: number, c: number, d: number): number[] {
  const out: number[] = [];
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d)) || 1;
  const f = (t: number) => a + t * (b + t * (c + t * d));
  const df = (t: number) => b + t * (2 * c + 3 * t * d);
  const push = (t: number) => {
    if (!Number.isFinite(t)) return;
    // Polish: Cardano and the quadratic formula lose digits near double roots.
    for (let k = 0; k < 3; k++) {
      const g = df(t);
      if (g === 0) break;
      t -= f(t) / g;
    }
    if (t > 1e-12 && t < 1 - 1e-12) out.push(t);
  };
  if (Math.abs(d) < 1e-12 * scale) {
    if (Math.abs(c) < 1e-12 * scale) {
      if (Math.abs(b) > 1e-14 * scale) push(-a / b);
    } else {
      const D = b * b - 4 * c * a;
      if (D >= 0) {
        const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(D));
        push(q / c);
        if (q !== 0) push(a / q);
      }
    }
  } else {
    const A = c / d, B = b / d, C = a / d;
    const Q = (3 * B - A * A) / 9;
    const R = (9 * A * B - 27 * C - 2 * A * A * A) / 54;
    const D = Q * Q * Q + R * R;
    if (D >= 0) {
      const sD = Math.sqrt(D);
      const S = Math.cbrt(R + sD), T = Math.cbrt(R - sD);
      push(-A / 3 + S + T);
      if (Math.abs(S - T) < 1e-9 * (Math.abs(S) + Math.abs(T) + 1e-300)) push(-A / 3 - (S + T) / 2);
    } else {
      const th = Math.acos(Math.max(-1, Math.min(1, R / Math.sqrt(-Q * Q * Q))));
      const r = 2 * Math.sqrt(-Q);
      for (const k of [0, 1, 2]) push(r * Math.cos((th + 2 * Math.PI * k) / 3) - A / 3);
    }
  }
  out.sort((x, y) => x - y);
  return out.filter((t, i) => i === 0 || t - out[i - 1]! > 1e-12);
}

/** Parameters where the segment crosses the half-plane's edge. */
function roots(s: Seg, h: HalfPlane): number[] {
  const v = s.map((p) => gval(h, p));
  if (s.length === 2) {
    const [v0, v1] = v as [number, number];
    if (v0 < 0 === v1 < 0 || v0 === v1) return [];
    const t = v0 / (v0 - v1);
    return t > 1e-12 && t < 1 - 1e-12 ? [t] : [];
  }
  const [a, b, c, d] = v as [number, number, number, number];
  if (Math.min(a, b, c, d) >= 0 || Math.max(a, b, c, d) < 0) return [];
  return cubicRoots(a, 3 * (b - a), 3 * (a - 2 * b + c), -a + 3 * b - 3 * c + d);
}

// Gauss–Legendre, 8 points: arc length of a cubic.
const GL: [number, number][] = [
  [-0.1834346424956498, 0.362683783378362], [0.1834346424956498, 0.362683783378362],
  [-0.525532409916329, 0.3137066458778873], [0.525532409916329, 0.3137066458778873],
  [-0.7966664774136267, 0.2223810344533745], [0.7966664774136267, 0.2223810344533745],
  [-0.9602898564975363, 0.1012285362903763], [0.9602898564975363, 0.1012285362903763],
];

/** Arc length of the segment from 0 to t. */
function lengthTo(s: Seg, t = 1): number {
  if (s.length === 2) return t * Math.hypot(s[1]![0] - s[0]![0], s[1]![1] - s[0]![1]);
  let L = 0;
  for (const [x, w] of GL) {
    const d = derivAt(s, ((x + 1) / 2) * t);
    L += (w / 2) * t * Math.hypot(d[0], d[1]);
  }
  return L;
}

/** Parameter at which the arc length from 0 reaches `l`. */
function paramAt(s: Seg, l: number, total: number): number {
  if (total <= 0) return 0;
  if (s.length === 2) return Math.min(1, Math.max(0, l / total));
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (lengthTo(s, mid) < l) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---- fills and clip paths ---------------------------------------------------

/** Closed segment list of a subpath (implicit closing line added). */
function closedSegs(s: SubPath, eps: number): Seg[] {
  const segs = [...s.segs];
  const last = endOf(s);
  if (!same(last, s.start, eps)) segs.push([last, s.start]);
  return segs;
}

function clipFillHalf(s: SubPath, h: HalfPlane, eps: number): SubPath | null {
  const pieces = closedSegs(s, eps).flatMap((g) => splitAt(g, roots(g, h)));
  const out: Seg[] = [];
  let start: Pt | null = null;
  let cur: Pt | null = null;
  for (const p of pieces) {
    if (gval(h, pointAt(p, 0.5)) < -eps) continue;
    const a = p[0]!;
    if (!start) start = cur = a;
    else if (!same(cur!, a, eps)) out.push([cur!, a]); // along the edge
    out.push(p);
    cur = p.at(-1)!;
  }
  if (!start || out.length === 0) return null;
  return { start, segs: out, closed: true };
}

/**
 * The fill (or clip) area of `subs` within the half-planes, as new subpaths, or null
 * if nothing lies outside. Each subpath is clipped on its own, so every point inside
 * keeps its winding number: non-zero and even-odd fills both stay correct. An
 * excursion outside becomes a straight line along the edge.
 */
export function clipFill(subs: SubPath[], hs: HalfPlane[]): SubPath[] | null {
  const eps = tolerance(subs);
  if (subs.every((s) => allInside(s, hs, eps))) return null;
  const out: SubPath[] = [];
  for (const s of subs) {
    if (allInside(s, hs, eps)) out.push(s);
    else if (s.segs.length && !allOutside(s, hs, eps)) {
      let c: SubPath | null = s;
      for (const h of hs) if (c) c = clipFillHalf(c, h, eps);
      if (c) out.push(c);
    }
  }
  return out;
}

// ---- strokes ----------------------------------------------------------------

/** A piece of a stroked subpath, with where it sits on the original (arc length). */
export interface Run extends SubPath {
  /** Arc length of the original subpath where each segment starts. */
  at: number[];
  /** Arc length at the start of the run and at its end. */
  from: number;
  to: number;
  startCut: boolean;
  endCut: boolean;
  /** Tangents at the ends, for pieces whose geometry has none (zero length). */
  dir0?: Pt | null;
  dir1?: Pt | null;
}

/**
 * Cuts the centre lines at the edge. Consecutive pieces inside stay one subpath, so
 * their joins stay. A closed subpath that crosses the edge becomes open, starting
 * after a piece outside; with `splitAtStart` (dashed strokes: the pattern restarts
 * there) it is also split where it passes its original start.
 */
function cutRuns(subs: SubPath[], hs: HalfPlane[], splitAtStart: boolean): Run[] {
  const eps = tolerance(subs);
  const runs: Run[] = [];
  const inside = (p: Pt) => hs.every((h) => gval(h, p) >= -eps);
  for (const sub of subs) {
    const segs = sub.closed ? closedSegs(sub, eps) : sub.segs;
    if (segs.length === 0 || allInside(sub, hs, eps)) {
      if (segs.length === 0 && !inside(sub.start)) continue;
      const at: number[] = [];
      let l = 0;
      for (const g of segs) {
        at.push(l);
        l += lengthTo(g);
      }
      runs.push({ start: sub.start, segs, closed: sub.closed, at, from: 0, to: l, startCut: false, endCut: false });
      continue;
    }
    if (allOutside(sub, hs, eps)) continue;
    const pieces: { p: Seg; inside: boolean; s: number; l: number }[] = [];
    let s = 0;
    for (const g of segs) {
      const ts = [...new Set(hs.flatMap((h) => roots(g, h)))].sort((a, b) => a - b);
      for (const p of splitAt(g, ts)) {
        const l = lengthTo(p);
        pieces.push({ p, inside: inside(pointAt(p, 0.5)), s, l });
        s += l;
      }
    }
    if (pieces.every((x) => x.inside)) {
      runs.push({ start: sub.start, segs, closed: sub.closed, at: pieces.map((x) => x.s), from: 0, to: s, startCut: false, endCut: false });
      continue;
    }
    let order = pieces;
    let leadingCut = false;
    if (sub.closed) {
      const k = pieces.findIndex((x) => !x.inside);
      order = [...pieces.slice(k + 1), ...pieces.slice(0, k + 1)];
      leadingCut = true;
    }
    let run: Run | null = null;
    let prevOutside = leadingCut;
    const close = (cut: boolean) => {
      if (run) {
        run.endCut = cut;
        runs.push(run);
      }
      run = null;
    };
    for (let k = 0; k < order.length; k++) {
      const x = order[k]!;
      if (!x.inside) {
        close(true);
        prevOutside = true;
        continue;
      }
      const wrapped = run !== null && splitAtStart && x.s === 0;
      if (wrapped) close(false);
      if (!run) {
        run = { start: x.p[0]!, segs: [], closed: false, at: [], from: x.s, to: x.s, startCut: prevOutside, endCut: false };
      }
      const r: Run = run;
      r.segs.push(x.p);
      r.at.push(x.s);
      r.to = x.s + x.l;
      prevOutside = false;
    }
    close(false);
  }
  return runs;
}

/** Part of a run between arc lengths a ≤ b (absolute, as in `at`). */
function slice(run: Run, a: number, b: number): Run {
  const segs: Seg[] = [];
  const at: number[] = [];
  let start: Pt | null = null;
  let dir0: Pt | null = null;
  let dir1: Pt | null = null;
  for (let i = 0; i < run.segs.length; i++) {
    const g = run.segs[i]!;
    const s0 = run.at[i]!;
    const total = lengthTo(g);
    const s1 = s0 + total;
    if (s1 < a || s0 > b) continue;
    if (b > a && (s1 <= a || s0 >= b)) continue; // touches the range only at an end
    if (b === a && start) break; // a single point: the first segment holding it
    const t0 = a > s0 ? paramAt(g, a - s0, total) : 0;
    const t1 = b < s1 ? paramAt(g, b - s0, total) : 1;
    if (!start) {
      start = pointAt(g, t0);
      dir0 = tangentAt(g, t0);
    }
    dir1 = tangentAt(g, t1);
    if (t1 > t0) {
      segs.push(subSeg(g, t0, t1));
      at.push(Math.max(a, s0));
    }
  }
  return {
    start: start ?? run.start,
    segs,
    closed: false,
    at,
    from: a,
    to: b,
    startCut: a === run.from && run.startCut,
    endCut: b === run.to && run.endCut,
    dir0,
    dir1,
  };
}

/** Dash state at arc length s: on/off and the interval [from, to) it is in. */
function dashAt(dashes: number[], phase: number, s: number): { on: boolean; from: number; to: number } {
  const arr = dashes.length % 2 ? [...dashes, ...dashes] : dashes;
  const period = arr.reduce((n, v) => n + v, 0);
  let pos = ((((phase + s) % period) + period) % period);
  const base = s - pos;
  let acc = 0;
  for (let i = 0; ; i = (i + 1) % arr.length) {
    const len = arr[i]!;
    if (pos < acc + len) return { on: i % 2 === 0, from: base + acc, to: base + acc + len };
    acc += len;
    if (i === arr.length - 1) {
      // float edge case: pos rounded to the period
      pos = 0;
      acc = 0;
    }
  }
}

export interface StrokeStyleIn {
  width: number;
  cap: LineCap;
  /** Dash array, or null for a solid line. */
  dashes: number[] | null;
  phase: number;
}

/** One stroke to paint. Unset fields mean "as the original stroke". */
export interface StrokePaint {
  subs: SubPath[];
  cap?: LineCap;
  /** New dash phase (same array), or null for a solid line. */
  dash?: { phase: number } | null;
}

function endTangent(r: Run, atStart: boolean): Pt {
  const d = atStart ? (r.dir0 ?? (r.segs.length ? tangentAt(r.segs[0]!, 0) : null)) : (r.dir1 ?? (r.segs.length ? tangentAt(r.segs.at(-1)!, 1) : null));
  return d ?? [1, 0];
}

const dot = (p: Pt): SubPath => ({ start: p, segs: [[p, p]], closed: false });

/**
 * Cuts a stroke at the half-planes. Returns null if nothing lies outside (keep the
 * stroke as it is), else the strokes to paint instead (possibly none).
 *
 * PDF and SVG have one cap style per stroke, so original ends of runs with a cut end
 * are emulated: square caps by extending the end by half the line width (then butt),
 * round caps by a zero-length subpath at the end (a dot, painted with round caps).
 */
export function cutStroke(subs: SubPath[], hs: HalfPlane[], style: StrokeStyleIn): StrokePaint[] | null {
  if (isInside(subs, hs)) return null;
  const dashed = !!style.dashes && style.dashes.length > 0 && style.dashes.some((v) => v > 0) && style.dashes.every((v) => v >= 0);
  const runs = cutRuns(subs, hs, dashed);
  if (runs.length === 0) return [];
  const half = style.width / 2;

  // Runs painted as they are (original cap), dots for round-cap emulation, and runs
  // with a cut end (butt caps, square ends extended).
  const plain: Run[] = [];
  const dots: SubPath[] = [];
  const butt: SubPath[] = [];
  const emulate = (r: Run) => {
    if (style.cap === 0 || (!r.startCut && !r.endCut) || r.closed) {
      plain.push(r);
      return;
    }
    if (r.startCut && r.endCut) {
      butt.push(r);
      return;
    }
    const atStart = !r.startCut;
    const p = atStart ? r.start : endOf(r);
    if (style.cap === 1) {
      butt.push(r);
      dots.push(dot(p));
      return;
    }
    const d = endTangent(r, atStart);
    const segs = [...r.segs];
    let start = r.start;
    if (atStart) {
      start = [p[0] - d[0] * half, p[1] - d[1] * half];
      segs.unshift([start, p]);
    } else segs.push([p, [p[0] + d[0] * half, p[1] + d[1] * half]]);
    butt.push({ start, segs, closed: false });
  };

  const paints: StrokePaint[] = [];
  if (!dashed) {
    for (const r of runs) emulate(r);
    if (plain.length || dots.length) paints.push({ subs: [...plain, ...dots] });
    if (butt.length) paints.push({ subs: butt, cap: 0 });
    return paints;
  }

  // Dashed: each run continues the pattern with its own phase. With round or square
  // caps, a dash that is "on" at a cut is taken out as its own piece (butt at the
  // cut), and the rest of the run starts in the middle of the following gap.
  const dashes = style.dashes!;
  const byPhase = new Map<number, SubPath[]>();
  const add = (r: Run) => {
    const key = r.from;
    const list = byPhase.get(key);
    if (list) list.push(r);
    else byPhase.set(key, [r]);
  };
  for (const r of runs) {
    if (style.cap === 0 || (!r.startCut && !r.endCut)) {
      add(r);
      continue;
    }
    let a = r.from;
    let b = r.to;
    const pieces: Run[] = [];
    if (r.startCut) {
      const st = dashAt(dashes, style.phase, r.from);
      if (st.on) {
        pieces.push(slice(r, r.from, Math.min(st.to, r.to)));
        const gap = dashAt(dashes, style.phase, st.to);
        a = gap.on ? st.to : (gap.from + gap.to) / 2;
      }
    }
    if (r.endCut) {
      const st = dashAt(dashes, style.phase, r.to - Math.min(1e-9 * (1 + Math.abs(r.to)), (r.to - r.from) / 2));
      if (st.on) {
        const from = Math.max(st.from, r.from);
        if (pieces.length && from <= pieces[0]!.to) {
          // one dash covers the whole run
          pieces[0] = slice(r, r.from, r.to);
        } else pieces.push(slice(r, from, r.to));
        const gap = dashAt(dashes, style.phase, st.from - Math.min(1e-9 * (1 + Math.abs(st.from)), 1e-6));
        b = gap.on ? st.from : (gap.from + gap.to) / 2;
      }
    }
    for (const p of pieces) emulate(p);
    if (b > a) add(slice(r, a, b));
  }
  for (const [from, subsAt] of byPhase) paints.push(from === 0 ? { subs: subsAt } : { subs: subsAt, dash: { phase: style.phase + from } });
  if (plain.length || dots.length) paints.push({ subs: [...plain, ...dots], dash: null });
  if (butt.length) paints.push({ subs: butt, cap: 0, dash: null });
  return paints;
}

// ---- IR path data (SVG side) ------------------------------------------------

export function fromPathData(d: PathData): SubPath[] {
  const out: SubPath[] = [];
  let cur: SubPath | null = null;
  let last: Pt = [0, 0];
  const cp = (): Pt => (cur ? endOf(cur) : last);
  let i = 0;
  while (i < d.length) {
    const op = d[i++];
    if (op === Op.Move) {
      last = [d[i++]!, d[i++]!];
      cur = { start: last, segs: [], closed: false };
      out.push(cur);
    } else if (op === Op.Line || op === Op.Curve) {
      if (!cur) {
        cur = { start: last, segs: [], closed: false };
        out.push(cur);
      }
      const p0 = cp();
      if (op === Op.Line) cur.segs.push([p0, [d[i++]!, d[i++]!]]);
      else cur.segs.push([p0, [d[i++]!, d[i++]!], [d[i++]!, d[i++]!], [d[i++]!, d[i++]!]]);
    } else {
      if (cur) {
        cur.closed = true;
        last = cur.start;
      }
      cur = null;
    }
  }
  return out;
}

export function toPathData(subs: SubPath[]): PathData {
  const d: PathData = [];
  for (const s of subs) {
    d.push(Op.Move, s.start[0], s.start[1]);
    for (const g of s.segs) {
      if (g.length === 2) d.push(Op.Line, g[1]![0], g[1]![1]);
      else d.push(Op.Curve, g[1]![0], g[1]![1], g[2]![0], g[2]![1], g[3]![0], g[3]![1]);
    }
    if (s.closed) d.push(Op.Close);
  }
  return d;
}
