import { describe, expect, it } from "vitest";
import { buildLines, nearest, snapClip, type SnapIndex } from "./snap";

describe("buildLines", () => {
  it("merges pieces of one grid line drawn row by row", () => {
    // x = 400 drawn in three pieces, plus another line at x = 410
    const lines = buildLines([400, 0, 5, 400, 5, 10, 410, 0, 10, 400.004, 10, 15]);
    expect(Array.from(lines.pos)).toEqual([400, 410]);
    expect([lines.a[0], lines.b[0]]).toEqual([0, 15]);
  });

  it("keeps pieces with a real gap apart", () => {
    const lines = buildLines([100, 0, 5, 100, 50, 60]);
    expect(lines.pos.length).toBe(2);
  });
});

describe("nearest", () => {
  const lines = buildLines([100, 0, 1000, 105, 0, 1000, 200, 500, 600]);
  it("finds the closest line within tolerance", () => {
    expect(nearest(lines, 103.5, 5, { lo: 0, hi: 1000 })?.pos).toBe(105);
    expect(nearest(lines, 150, 5, { lo: 0, hi: 1000 })).toBeNull();
  });
  it("ignores lines outside the relevant range", () => {
    expect(nearest(lines, 199, 5, { lo: 0, hi: 100 })).toBeNull();
    expect(nearest(lines, 199, 5, { lo: 550, hi: 560 })?.pos).toBe(200);
  });
});

describe("snapClip", () => {
  const index: SnapIndex = {
    vertical: buildLines([100, 0, 1000, 300, 0, 1000]),
    horizontal: buildLines([50, 0, 1000, 250, 0, 1000]),
    textVertical: buildLines([600, 0, 1000]),
    textHorizontal: buildLines([51.5, 0, 1000, 700, 0, 1000]),
  };
  const all = { x0: 0, y0: 0, x1: 1000, y1: 1000 };

  it("snaps only the dragged edge", () => {
    const r = snapClip({ x: 103, y: 40, width: 194, height: 200 }, "e", index, 5, all);
    expect(r.clip).toEqual({ x: 103, y: 40, width: 197, height: 200 });
    expect(r.guides).toEqual([{ vertical: true, pos: 300, a: 0, b: 1000 }]);
  });

  it("snaps a corner in both directions", () => {
    const r = snapClip({ x: 103, y: 52, width: 100, height: 100 }, "nw", index, 5, all);
    expect(r.clip).toEqual({ x: 100, y: 50, width: 103, height: 102 });
    expect(r.guides.length).toBe(2);
  });

  it("prefers lines over (estimated) text edges, but uses text edges when no line is near", () => {
    // y0 = 51.2: text edge 51.5 is closer, but the line at 50 is within reach and wins
    expect(snapClip({ x: 400, y: 51.2, width: 100, height: 100 }, "n", index, 5, all).clip.y).toBe(50);
    expect(snapClip({ x: 400, y: 698, width: 100, height: 100 }, "n", index, 5, all).clip.y).toBe(700);
  });

  it("moves the whole box to the nearest line, keeping its size", () => {
    const r = snapClip({ x: 102, y: 400, width: 100, height: 100 }, "move", index, 5, all);
    expect(r.clip).toEqual({ x: 100, y: 400, width: 100, height: 100 });
  });

  it("snaps the dragged corner when drawing a new box", () => {
    const r = snapClip({ x: 10, y: 10, width: 288, height: 243 }, "new", index, 5, all, {
      from: { x: 10, y: 10 },
      to: { x: 298, y: 253 },
    });
    expect(r.clip).toEqual({ x: 10, y: 10, width: 290, height: 240 });
  });
});
