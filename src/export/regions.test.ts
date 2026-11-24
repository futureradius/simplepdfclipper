import { describe, expect, it } from "vitest";
import {
  clipSize,
  normaliseLayout,
  overlapsInLayout,
  placeNew,
  readRegions,
  removeRegion,
  setRect,
  single,
  suggestLayout,
  type Region,
} from "./regions";

const r = (x: number, y: number, width: number, height: number, at = { x: 0, y: 0 }): Region => ({ x, y, width, height, at });

describe("clipSize", () => {
  it("reaches from (0, 0) to the far edges", () => {
    expect(clipSize([r(0, 0, 100, 50), r(0, 0, 30, 20, { x: 10, y: 50 })])).toEqual({ width: 100, height: 70 });
    expect(clipSize([])).toEqual({ width: 0, height: 0 });
  });
});

describe("suggestLayout (minimal fit)", () => {
  it("stacks the legend, a time window and the symbols of a tall schedule", () => {
    // Full-width legend at the top, a slice from the middle, the symbol legend at the bottom.
    const regions = [r(0, 13_000, 1188.9, 200), r(0, 0, 1188.9, 150), r(300, 5000, 400, 600)];
    const out = suggestLayout(regions);
    // Plan order top to bottom: legend (y 0), window (y 5000), symbols (y 13000). List order kept.
    expect(out[1]!.at).toEqual({ x: 0, y: 0 });
    expect(out[2]!.at).toEqual({ x: 300, y: 150 });
    expect(out[0]!.at).toEqual({ x: 0, y: 750 });
    expect(clipSize(out)).toEqual({ width: 1188.9, height: 950 });
    expect(overlapsInLayout(out)).toBe(false);
  });

  it("puts tall narrow Regions side by side, keeping their vertical offsets", () => {
    // Two columns of a Plan whose time axis runs left to right.
    const out = suggestLayout([r(800, 110, 100, 1000), r(0, 100, 100, 1000)]);
    expect(out[1]!.at).toEqual({ x: 0, y: 0 });
    expect(out[0]!.at).toEqual({ x: 100, y: 10 });
    expect(clipSize(out)).toEqual({ width: 200, height: 1010 });
  });

  it("stacks on a tie", () => {
    const out = suggestLayout([r(0, 0, 100, 100), r(500, 500, 100, 100)]);
    // stacked: 600 wide (offset kept) × 200; side by side: 200 × 600. Same area.
    expect(out[1]!.at).toEqual({ x: 500, y: 100 });
  });

  it("leaves a one-Region Clip at the origin", () => {
    expect(suggestLayout([r(40, 50, 10, 10, { x: 3, y: 4 })])[0]!.at).toEqual({ x: 0, y: 0 });
  });
});

describe("placeNew", () => {
  it("starts the Clip with the first Region", () => {
    expect(placeNew([], { x: 5, y: 6, width: 7, height: 8 }).at).toEqual({ x: 0, y: 0 });
  });

  it("goes below a wide Layout, keeping its horizontal offset, without moving the others", () => {
    const existing = [r(0, 0, 1000, 100)];
    const n = placeNew(existing, { x: 200, y: 5000, width: 300, height: 100 });
    expect(n.at).toEqual({ x: 200, y: 100 });
    expect(existing[0]!.at).toEqual({ x: 0, y: 0 });
  });

  it("goes to the right of a tall Layout", () => {
    const n = placeNew([r(0, 0, 100, 1000)], { x: 900, y: 20, width: 100, height: 900 });
    expect(n.at).toEqual({ x: 100, y: 20 });
  });

  it("never starts before the Clip", () => {
    const n = placeNew([r(500, 0, 1000, 100)], { x: 0, y: 300, width: 200, height: 50 });
    expect(n.at).toEqual({ x: 0, y: 100 });
  });
});

describe("editing", () => {
  const layout = suggestLayout([r(0, 0, 100, 50), r(0, 1000, 100, 30), r(0, 2000, 100, 20)]);

  it("removes a Region and shifts the rest so the Clip starts at (0, 0)", () => {
    const out = removeRegion(layout, 0);
    expect(out.map((x) => x.at)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 30 },
    ]);
    expect(removeRegion(single({ x: 1, y: 2, width: 3, height: 4 }), 0)).toEqual([]);
  });

  it("keeps the Layout when a Region is moved on the Plan", () => {
    const out = setRect(layout, 1, { x: 50, y: 500, width: 100, height: 30 });
    expect(out.map((x) => x.at)).toEqual(layout.map((x) => x.at));
    expect(out[1]).toMatchObject({ x: 50, y: 500 });
  });

  it("keeps the place of a shrunk Region (a gap is fine)", () => {
    const out = setRect(layout, 0, { x: 0, y: 0, width: 100, height: 40 });
    expect(out.map((x) => x.at)).toEqual(layout.map((x) => x.at));
  });

  it("suggests the Layout anew when a grown Region would overlap", () => {
    const out = setRect(layout, 0, { x: 0, y: 0, width: 100, height: 70 });
    expect(overlapsInLayout(out)).toBe(false);
    expect(out[1]!.at).toEqual({ x: 0, y: 70 });
  });

  it("normalises a Layout that starts late", () => {
    expect(normaliseLayout([r(0, 0, 10, 10, { x: 5, y: 7 })])[0]!.at).toEqual({ x: 0, y: 0 });
  });
});

describe("readRegions", () => {
  it("accepts stored Regions and rejects malformed ones", () => {
    const ok = [r(1, 2, 3, 4), r(1, 2, 3, 4, { x: 0, y: 4 })];
    expect(readRegions(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    expect(readRegions([])).toEqual([]);
    expect(readRegions({ x: 1 })).toBeUndefined();
    expect(readRegions([{ x: 1, y: 2, width: 3, height: 4 }])).toBeUndefined();
    expect(readRegions([r(1, 2, 0, 4)])).toBeUndefined();
  });

  it("repairs an overlapping Layout", () => {
    const out = readRegions([r(0, 0, 10, 10), r(0, 100, 10, 10)])!;
    expect(overlapsInLayout(out)).toBe(false);
  });
});
