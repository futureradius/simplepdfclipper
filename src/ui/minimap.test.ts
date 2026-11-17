import { describe, expect, it } from "vitest";
import { minimapSize, showsWholePlan } from "./minimap";

describe("minimapSize", () => {
  it("a tall Plan is limited by 1/3 of the view height", () => {
    const s = minimapSize(1188.9, 14270.9, 1080, 850);
    expect(s.height).toBeCloseTo(850 / 3);
    expect(s.width / s.height).toBeCloseTo(1188.9 / 14270.9);
  });

  it("a wide Plan is limited by 1/3 of the view width", () => {
    const s = minimapSize(5000, 800, 1080, 850);
    expect(s.width).toBeCloseTo(360);
    expect(s.height).toBeLessThan(850 / 3);
  });
});

describe("showsWholePlan", () => {
  it("is true only when the whole Plan is inside the visible area", () => {
    expect(showsWholePlan({ x0: -100, y0: -10, x1: 1300, y1: 14300 }, 1188.9, 14270.9)).toBe(true);
    expect(showsWholePlan({ x0: 0, y0: 0, x1: 1188.9, y1: 14000 }, 1188.9, 14270.9)).toBe(false);
    expect(showsWholePlan({ x0: 10, y0: -10, x1: 1300, y1: 14300 }, 1188.9, 14270.9)).toBe(false);
  });
});
