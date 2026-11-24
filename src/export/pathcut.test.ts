import { describe, expect, it } from "vitest";
import { clipFill, cutStroke, isInside, rectHalfPlanes, type Pt, type Seg, type SubPath } from "./pathcut";

const rect = (x: number, y: number, w: number, h: number, ccw = false): SubPath => {
  const pts: Pt[] = ccw
    ? [[x, y], [x, y + h], [x + w, y + h], [x + w, y]]
    : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  return { start: pts[0]!, segs: pts.map((p, i) => [p, pts[(i + 1) % 4]!] as Seg), closed: true };
};
const line = (a: Pt, b: Pt): SubPath => ({ start: a, segs: [[a, b]], closed: false });
const CLIP = rectHalfPlanes({ x0: 0, y0: 0, x1: 100, y1: 100 });

/** Points along every segment (curves sampled). */
function flatten(s: SubPath, n = 32): Pt[] {
  const out: Pt[] = [s.start];
  for (const g of s.segs) {
    if (g.length === 2) out.push(g[1]!);
    else
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        const [p0, p1, p2, p3] = g as [Pt, Pt, Pt, Pt];
        out.push([
          u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
      }
  }
  return out;
}

/** Winding number of p for the (implicitly closed) subpaths. */
function winding(subs: SubPath[], p: Pt): number {
  let w = 0;
  for (const s of subs) {
    const pts = flatten(s, 64);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      if (a[1] <= p[1]) {
        if (b[1] > p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) > 0) w++;
      } else if (b[1] <= p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) < 0) w--;
    }
  }
  return w;
}

const coords = (subs: SubPath[]) => subs.flatMap((s) => [s.start, ...s.segs.flat()]);
const inClip = (p: Pt) => p[0] >= -1e-9 && p[0] <= 100 + 1e-9 && p[1] >= -1e-9 && p[1] <= 100 + 1e-9;

describe("clipFill", () => {
  it("leaves paths inside alone", () => {
    expect(clipFill([rect(10, 10, 20, 20)], CLIP)).toBeNull();
  });

  it("clips a rectangle to the Clip", () => {
    const out = clipFill([rect(50, -50, 100, 100)], CLIP)!;
    expect(out).toHaveLength(1);
    expect(coords(out).every(inClip)).toBe(true);
    for (const p of [[60, 10], [99, 49], [51, 1]] as Pt[]) expect(winding(out, p)).not.toBe(0);
    for (const p of [[40, 10], [60, 60]] as Pt[]) expect(winding(out, p)).toBe(0);
  });

  it("drops subpaths outside and keeps curves curves", () => {
    // circle of radius 30 around (100, 50): right half outside
    const k = 0.5523 * 30;
    const c: Pt = [100, 50];
    const circle: SubPath = {
      start: [130, 50],
      segs: [
        [[130, 50], [130, 50 + k], [100 + k, 80], [100, 80]],
        [[100, 80], [100 - k, 80], [70, 50 + k], [70, 50]],
        [[70, 50], [70, 50 - k], [100 - k, 20], [100, 20]],
        [[100, 20], [100 + k, 20], [130, 50 - k], [130, 50]],
      ],
      closed: true,
    };
    const out = clipFill([circle, rect(200, 200, 10, 10)], CLIP)!;
    expect(out).toHaveLength(1);
    expect(coords(out).every(inClip)).toBe(true);
    expect(out[0]!.segs.filter((g) => g.length === 4)).toHaveLength(2);
    // the curve points still lie on the circle
    for (const p of flatten(out[0]!)) {
      const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (p[0] < 99.999) expect(r).toBeCloseTo(30, 1);
    }
    expect(winding(out, [85, 50])).not.toBe(0);
  });

  it.each([
    ["even-odd", true],
    ["non-zero", false],
  ])("keeps the %s area of nested and overlapping subpaths", (_, evenOdd) => {
    const subs = [rect(60, 20, 80, 60), rect(80, 40, 40, 20, true), rect(90, 10, 30, 30)];
    const out = clipFill(subs, CLIP)!;
    expect(coords(out).every(inClip)).toBe(true);
    const filled = (s: SubPath[], p: Pt) => (evenOdd ? winding(s, p) % 2 !== 0 : winding(s, p) !== 0);
    for (let x = 0.5; x < 100; x += 3)
      for (let y = 0.5; y < 100; y += 3) expect(filled(out, [x, y]), `${x},${y}`).toBe(filled(subs, [x, y]));
  });

  it("cuts in user space under a rotated, non-uniform transformation", () => {
    // user -> target: scale x by 2, rotate 30°
    const a = Math.PI / 6;
    const m: [number, number, number, number, number, number] = [2 * Math.cos(a), 2 * Math.sin(a), -Math.sin(a), Math.cos(a), 10, 5];
    const hs = rectHalfPlanes({ x0: 0, y0: 0, x1: 50, y1: 50 }, m);
    const out = clipFill([rect(-100, -100, 300, 300)], hs)!;
    const toTarget = (p: Pt): Pt => [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
    const pts = coords(out).map(toTarget);
    for (const p of pts) {
      expect(p[0]).toBeGreaterThan(-1e-9);
      expect(p[0]).toBeLessThan(50 + 1e-9);
      expect(p[1]).toBeGreaterThan(-1e-9);
      expect(p[1]).toBeLessThan(50 + 1e-9);
    }
    // the four corners of the target rectangle are reached
    for (const c of [[0, 0], [50, 0], [0, 50], [50, 50]]) expect(pts.some((p) => Math.hypot(p[0] - c[0]!, p[1] - c[1]!) < 1e-6)).toBe(true);
  });
});

describe("cutStroke", () => {
  const solid = (cap: 0 | 1 | 2, width = 4) => ({ width, cap, dashes: null, phase: 0 });

  it("keeps strokes inside unchanged", () => {
    expect(cutStroke([line([10, 10], [90, 90])], CLIP, solid(1))).toBeNull();
    expect(isInside([line([10, 10], [90, 90])], CLIP)).toBe(true);
  });

  it("ends butt lines at the edge and drops what is outside", () => {
    const out = cutStroke([line([-50, 50], [150, 50]), line([200, 0], [300, 0])], CLIP, solid(0))!;
    expect(out).toHaveLength(1);
    expect(out[0]!.cap).toBeUndefined();
    expect(out[0]!.subs).toHaveLength(1);
    expect(out[0]!.subs[0]!.start).toEqual([0, 50]);
    expect(out[0]!.subs[0]!.segs[0]![1]).toEqual([100, 50]);
  });

  it("emulates a round cap at the original end with a dot", () => {
    const out = cutStroke([line([20, 50], [150, 50])], CLIP, solid(1))!;
    const butt = out.find((p) => p.cap === 0)!;
    const plain = out.find((p) => p.cap === undefined)!;
    expect(butt.subs[0]!.start).toEqual([20, 50]);
    expect(butt.subs[0]!.segs.at(-1)!.at(-1)).toEqual([100, 50]);
    expect(plain.subs).toEqual([{ start: [20, 50], segs: [[[20, 50], [20, 50]]], closed: false }]);
  });

  it("emulates a square cap by extending the original end", () => {
    const out = cutStroke([line([20, 50], [150, 50])], CLIP, solid(2))!;
    expect(out).toHaveLength(1);
    expect(out[0]!.cap).toBe(0);
    expect(out[0]!.subs[0]!.start).toEqual([18, 50]);
    expect(out[0]!.subs[0]!.segs.at(-1)!.at(-1)).toEqual([100, 50]);
  });

  it("opens a closed subpath after the piece outside, keeping the joins inside", () => {
    const out = cutStroke([rect(50, 20, 100, 60)], CLIP, solid(0))!;
    expect(out).toHaveLength(1);
    const s = out[0]!.subs;
    expect(s).toHaveLength(1);
    expect(s[0]!.closed).toBe(false);
    expect(s[0]!.start).toEqual([100, 80]);
    expect(s[0]!.segs.map((g) => g.at(-1))).toEqual([[50, 80], [50, 20], [100, 20]]);
  });

  it("continues a dash pattern with the right phase", () => {
    const out = cutStroke([line([-10, 50], [50, 50])], CLIP, { width: 1, cap: 0, dashes: [3, 2], phase: 1 })!;
    expect(out).toHaveLength(1);
    expect(out[0]!.dash).toEqual({ phase: 11 });
    expect(out[0]!.subs[0]!.start).toEqual([0, 50]);
  });

  it("takes out the dash on at a cut when caps are round", () => {
    // [4 2]: on 0–4, off 4–6, on 6–10 …; the cut is at arc length 7 (on)
    const out = cutStroke([line([-7, 50], [50, 50])], CLIP, { width: 1, cap: 1, dashes: [4, 2], phase: 0 })!;
    const butt = out.find((p) => p.cap === 0)!;
    expect(butt.dash).toBeNull();
    expect(butt.subs[0]!.start).toEqual([0, 50]);
    expect(butt.subs[0]!.segs.at(-1)!.at(-1)![0]).toBeCloseTo(3, 9); // end of that dash (s = 10)
    const dots = out.find((p) => p.dash === null && p.cap === undefined)!;
    expect(dots.subs[0]!.start[0]).toBeCloseTo(3, 9);
    const rest = out.find((p) => p.dash && p.dash.phase)!;
    expect(rest.dash!.phase).toBeCloseTo(11, 9); // middle of the gap 10–12
    expect(rest.subs[0]!.start[0]).toBeCloseTo(4, 9);
  });

  it("splits dashed closed subpaths where the pattern restarts", () => {
    const out = cutStroke([rect(50, 20, 100, 60)], CLIP, { width: 1, cap: 0, dashes: [5, 5], phase: 0 })!;
    const all = out.flatMap((p) => p.subs.map((s) => ({ s, phase: p.dash?.phase ?? 0 })));
    // from the cut at the top to the start (50, 20) and from the start to the cut
    expect(all).toHaveLength(2);
    const first = all.find((x) => x.s.start[0] === 50 && x.s.start[1] === 20)!;
    expect(first.phase).toBe(0);
    const other = all.find((x) => x !== first)!;
    expect(other.s.start).toEqual([100, 80]);
    expect(other.phase).toBe(100 + 60 + 50);
  });

  it("removes a stroke entirely outside", () => {
    expect(cutStroke([line([120, 0], [120, 100])], CLIP, solid(1))).toEqual([]);
  });
});
