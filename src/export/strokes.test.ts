import { describe, expect, it } from "vitest";
import { compactStrokes } from "./strokes";
import { Op, type StrokeStyle } from "./ir";
import { encodePath } from "./pathdata";

const style = (over: Partial<StrokeStyle> = {}): StrokeStyle => ({
  width: 10,
  cap: "butt",
  join: "miter",
  miterLimit: 10,
  dashes: null,
  dashPhase: 0,
  ...over,
});
const len = (d: number[]) => encodePath(d).length;
const line = (x0: number, y0: number, x1: number, y1: number) => [Op.Move, x0, y0, Op.Line, x1, y1];
const rect = (x: number, y: number, w: number, h: number) => [
  Op.Move, x, y, Op.Line, x + w, y, Op.Line, x + w, y + h, Op.Line, x, y + h, Op.Close,
];

describe("compactStrokes", () => {
  it("joins a grid line drawn row by row into one line", () => {
    const pieces = [line(100, 0, 100, 500), line(100, 500, 100, 1000), line(100, 1000, 100, 1500)];
    expect(encodePath(compactStrokes(pieces, style(), len))).toBe("m100 0v1500");
  });

  it("joins overlapping pieces but keeps real gaps", () => {
    const pieces = [line(0, 50, 300, 50), line(200, 50, 400, 50), line(600, 50, 700, 50)];
    expect(encodePath(compactStrokes(pieces, style(), len))).toBe("m0 50h400m200 0h100");
  });

  it("splits a table of cell rectangles into shared, extended edges (butt caps keep mitred corners)", () => {
    // 2 x 2 cells of 100 x 50: 4 rectangles -> 3 horizontal + 3 vertical lines
    const cells = [rect(0, 0, 100, 50), rect(100, 0, 100, 50), rect(0, 50, 100, 50), rect(100, 50, 100, 50)];
    const out = encodePath(compactStrokes(cells, style(), len));
    // horizontals at y 0/50/100 from x -5 to 205, verticals at x 0/100/200 from y -5 to 105
    expect(out).toBe("m-5 0h210m-210 50h210m-210 50h210m-205-105v110m100-110v110m100-110v110");
  });

  it("keeps an isolated rectangle as a rectangle (shorter)", () => {
    const out = encodePath(compactStrokes([rect(0, 0, 100, 50), line(500, 0, 500, 100)], style(), len));
    expect(out).toContain("z");
  });

  it("does not split rectangles where corners would change (round caps or joins)", () => {
    const cells = [rect(0, 0, 100, 50), rect(100, 0, 100, 50)];
    for (const s of [style({ cap: "round" }), style({ join: "round" })])
      expect(encodePath(compactStrokes(cells, s, len)).match(/z/g)?.length).toBe(2);
  });
});
