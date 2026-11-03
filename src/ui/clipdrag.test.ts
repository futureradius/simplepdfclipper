import { describe, expect, it } from "vitest";
import { dragClip, hitTest } from "./clipdrag";

const clip = { x: 100, y: 200, width: 300, height: 100 };
const plan = { width: 1188.9, height: 14270.9 };

describe("hitTest", () => {
  it("finds corners, edges, inside and outside", () => {
    expect(hitTest(clip, { x: 100, y: 200 }, 5)).toBe("nw");
    expect(hitTest(clip, { x: 402, y: 298 }, 5)).toBe("se");
    expect(hitTest(clip, { x: 250, y: 201 }, 5)).toBe("n");
    expect(hitTest(clip, { x: 399, y: 250 }, 5)).toBe("e");
    expect(hitTest(clip, { x: 250, y: 250 }, 5)).toBe("move");
    expect(hitTest(clip, { x: 50, y: 250 }, 5)).toBe("new");
  });
});

describe("dragClip", () => {
  it("resizes by an edge", () => {
    expect(dragClip(clip, "e", { x: 400, y: 250 }, { x: 450, y: 260 }, plan)).toEqual({ x: 100, y: 200, width: 350, height: 100 });
    expect(dragClip(clip, "n", { x: 250, y: 200 }, { x: 250, y: 150 }, plan)).toEqual({ x: 100, y: 150, width: 300, height: 150 });
  });

  it("resizes by a corner", () => {
    expect(dragClip(clip, "sw", { x: 100, y: 300 }, { x: 90, y: 320 }, plan)).toEqual({ x: 90, y: 200, width: 310, height: 120 });
  });

  it("flips instead of producing a negative size", () => {
    expect(dragClip(clip, "w", { x: 100, y: 250 }, { x: 500, y: 250 }, plan)).toEqual({ x: 400, y: 200, width: 100, height: 100 });
  });

  it("moves without changing the size and stays on the Plan", () => {
    expect(dragClip(clip, "move", { x: 200, y: 250 }, { x: 250, y: 300 }, plan)).toEqual({ x: 150, y: 250, width: 300, height: 100 });
    expect(dragClip(clip, "move", { x: 200, y: 250 }, { x: -500, y: 250 }, plan)).toEqual({ x: 0, y: 200, width: 300, height: 100 });
  });

  it("draws a new Clip in any direction", () => {
    expect(dragClip(clip, "new", { x: 600, y: 900 }, { x: 500, y: 800 }, plan)).toEqual({ x: 500, y: 800, width: 100, height: 100 });
  });
});
