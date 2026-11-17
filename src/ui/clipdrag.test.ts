import { describe, expect, it } from "vitest";
import { dragClip, hitTest, onPlan } from "./clipdrag";

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

  it("stops a dragged edge at the Plan edge without moving the opposite edge", () => {
    // n past the top: the bottom edge (y = 300) stays put
    expect(dragClip(clip, "n", { x: 250, y: 200 }, { x: 250, y: -150 }, plan)).toEqual({ x: 100, y: 0, width: 300, height: 300 });
    // w past the left: the right edge (x = 400) stays put
    expect(dragClip(clip, "w", { x: 100, y: 250 }, { x: -80, y: 250 }, plan)).toEqual({ x: 0, y: 200, width: 400, height: 100 });
    // nw corner past both
    expect(dragClip(clip, "nw", { x: 100, y: 200 }, { x: -50, y: -50 }, plan)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    // e and s past the right and bottom
    expect(dragClip(clip, "se", { x: 400, y: 300 }, { x: 5000, y: 20000 }, plan)).toEqual({ x: 100, y: 200, width: plan.width - 100, height: plan.height - 200 });
  });

  it("still flips when an edge is dragged past the opposite one and off the Plan", () => {
    expect(dragClip(clip, "e", { x: 400, y: 250 }, { x: -300, y: 250 }, plan)).toEqual({ x: 0, y: 200, width: 100, height: 100 });
  });

  it("keeps a new Clip on the Plan", () => {
    expect(dragClip(clip, "new", { x: 50, y: 60 }, { x: -20, y: -30 }, plan)).toEqual({ x: 0, y: 0, width: 50, height: 60 });
  });

  it("draws a new Clip in any direction", () => {
    expect(dragClip(clip, "new", { x: 600, y: 900 }, { x: 500, y: 800 }, plan)).toEqual({ x: 500, y: 800, width: 100, height: 100 });
  });
});

describe("onPlan", () => {
  it("is true only when every edge lies on the Plan", () => {
    expect(onPlan(clip, plan)).toBe(true);
    expect(onPlan({ x: 0, y: 0, width: plan.width, height: plan.height }, plan)).toBe(true);
    expect(onPlan({ ...clip, y: -0.5 }, plan)).toBe(false);
    expect(onPlan({ ...clip, x: plan.width - 10 }, plan)).toBe(false);
  });
});
