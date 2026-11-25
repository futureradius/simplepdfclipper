import { describe, expect, it } from "vitest";
import {
  clipBounds,
  clipSize,
  moveInLayout,
  normaliseLayout,
  overlapsInLayout,
  placeNew,
  readRegions,
  removeRegion,
  reorderRegion,
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

describe("placeNew (where it lies on the Plan)", () => {
  it("starts the Clip with the first Region", () => {
    expect(placeNew([], { x: 5, y: 6, width: 7, height: 8 }).at).toEqual({ x: 0, y: 0 });
  });

  it("goes below a Region it lies below, keeping its offset along it, without moving the others", () => {
    const existing = [r(0, 0, 1000, 100)];
    const n = placeNew(existing, { x: 200, y: 5000, width: 300, height: 100 });
    expect(n.at).toEqual({ x: 200, y: 100 });
    expect(existing[0]!.at).toEqual({ x: 0, y: 0 });
  });

  it("goes above the body when the header is drawn second, growing the Clip upward", () => {
    // The body first, then the Plan's header above it.
    const body = r(0, 100, 1000, 3000);
    const n = placeNew([body], { x: 0, y: 0, width: 1000, height: 80 });
    expect(n.at).toEqual({ x: 0, y: -80 });
    const out = normaliseLayout([body, n]);
    expect(out[1]!.at).toEqual({ x: 0, y: 0 });
    expect(out[0]!.at).toEqual({ x: 0, y: 80 });
  });

  it("goes to the left or right of a Region beside it, keeping the vertical offset", () => {
    expect(placeNew([r(0, 0, 100, 1000)], { x: 900, y: 20, width: 100, height: 900 }).at).toEqual({ x: 100, y: 20 });
    expect(placeNew([r(900, 0, 100, 1000, { x: 40, y: 0 })], { x: 0, y: 30, width: 50, height: 500 }).at).toEqual({ x: -10, y: 30 });
  });

  it("sides with the Region closest on the Plan, wherever that one sits in the Layout", () => {
    // Legend (far top) at the Clip's start, body stacked below it.
    const legend = r(0, 0, 500, 50);
    const body = r(0, 5000, 500, 1000, { x: 0, y: 50 });
    // A footnote just right of the body.
    const n = placeNew([legend, body], { x: 520, y: 5100, width: 200, height: 300 });
    expect(n.at).toEqual({ x: 500, y: 150 });
  });

  it("touches at the corner when it lies off both edges", () => {
    expect(placeNew([r(0, 0, 100, 100)], { x: 300, y: 400, width: 50, height: 50 }).at).toEqual({ x: 100, y: 100 });
  });

  it("moves on, away from its closest Region, while that place is taken", () => {
    // B was arranged below A; C lies below A on the Plan, so it goes below B.
    const a = r(0, 0, 100, 100);
    const b = r(500, 0, 100, 200, { x: 0, y: 100 });
    const n = placeNew([a, b], { x: 0, y: 150, width: 100, height: 50 });
    expect(n.at).toEqual({ x: 0, y: 300 });
    expect(overlapsInLayout([a, b, n])).toBe(false);
  });

  it("goes beside the Layout when it overlaps its closest Region on the Plan", () => {
    // Below: 1000 × 110; to the right: 1300 × 105. The smaller Clip wins.
    const n = placeNew([r(0, 0, 1000, 10)], { x: 200, y: 5, width: 300, height: 100 });
    expect(n.at).toEqual({ x: 200, y: 10 });
  });
});

describe("reorderRegion", () => {
  const list = [r(0, 0, 1, 1), r(10, 0, 1, 1, { x: 1, y: 0 }), r(20, 0, 1, 1, { x: 2, y: 0 })];

  it("changes only the numbering", () => {
    expect(reorderRegion(list, 2, 0).map((x) => x.x)).toEqual([20, 0, 10]);
    expect(reorderRegion(list, 0, 2).map((x) => x.x)).toEqual([10, 20, 0]);
    expect(reorderRegion(list, 1, 1)).toEqual(list);
    // Plan rectangles and places in the Clip travel with their Region.
    expect(reorderRegion(list, 2, 0)[0]).toEqual(list[2]);
    expect(list.map((x) => x.x)).toEqual([0, 10, 20]);
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

  it("normalises a Layout that starts late", () => {
    expect(normaliseLayout([r(0, 0, 10, 10, { x: 5, y: 7 })])[0]!.at).toEqual({ x: 0, y: 0 });
  });
});

describe("semi-automatic Layout (setRect)", () => {
  // Three Regions side by side, touching: A | B | C, plus D below A, not touching B.
  //   A at (0,0) 100×50, B at (100,0) 50×50, C at (150,0) 30×50, D at (0,60) 100×20.
  const A = r(0, 0, 100, 50, { x: 0, y: 0 });
  const B = r(500, 0, 50, 50, { x: 100, y: 0 });
  const C = r(800, 0, 30, 50, { x: 150, y: 0 });
  const D = r(0, 900, 100, 20, { x: 0, y: 60 });
  const base = [A, B, C, D];
  const ats = (rs: Region[]) => rs.map((x) => x.at);

  it("moving on the Plan without resizing keeps the Layout", () => {
    const out = setRect(base, 1, { x: 520, y: 30, width: 50, height: 50 });
    expect(ats(out)).toEqual(ats(base));
    expect(out[1]).toMatchObject({ x: 520, y: 30 });
  });

  it("growing the right edge moves the touching chain along", () => {
    const out = setRect(base, 0, { x: 0, y: 0, width: 110, height: 50 });
    expect(ats(out)).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 160, y: 0 },
      { x: 0, y: 60 },
    ]);
    expect(out[0]!.width).toBe(110);
  });

  it("shrinking the right edge pulls the touching chain along", () => {
    const out = setRect(base, 0, { x: 0, y: 0, width: 80, height: 50 });
    expect(ats(out).slice(0, 3)).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 130, y: 0 },
    ]);
  });

  it("shrinking the left edge moves it in the Layout, and what touches it there", () => {
    // B's left edge moves right by 10: A (touching it) follows; C and D stay.
    const out = setRect(base, 1, { x: 510, y: 0, width: 40, height: 50 });
    expect(ats(out)).toEqual([
      { x: 10, y: 0 },
      { x: 110, y: 0 },
      { x: 150, y: 0 },
      { x: 0, y: 60 },
    ]);
  });

  it("the Clip starts at (0, 0) again when its first column shrinks away", () => {
    const out = setRect([A, B], 0, { x: 10, y: 0, width: 90, height: 50 });
    expect(ats(out)).toEqual([
      { x: 0, y: 0 },
      { x: 90, y: 0 },
    ]);
  });

  it("growing the left edge past the Clip's start grows the Clip to the left", () => {
    // A grows 20 mm to the left: everything else shifts right by 20 (D is not touching A's left edge).
    const grown = setRect([{ ...A, x: 20 }, B, C, D], 0, { x: 0, y: 0, width: 120, height: 50 });
    expect(ats(grown)).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 170, y: 0 },
      { x: 20, y: 60 },
    ]);
    expect(clipSize(grown)).toEqual({ width: 200, height: 80 });
  });

  it("growing the bottom edge pushes a non-touching Region just enough; it touches from then on", () => {
    // A grows 15 mm down: D (10 mm below) is pushed by 5 and then touches A.
    const out = setRect(base, 0, { x: 0, y: 0, width: 100, height: 65 });
    expect(out[3]!.at).toEqual({ x: 0, y: 65 });
    expect(overlapsInLayout(out)).toBe(false);
    // Shrinking back pulls D along now, since it touches.
    const back = setRect(out, 0, { x: 0, y: 0, width: 100, height: 50 });
    expect(back[3]!.at).toEqual({ x: 0, y: 50 });
  });

  it("a pushed Region pushes the next one", () => {
    const E = r(0, 2000, 100, 10, { x: 0, y: 85 }); // 5 mm below D
    const out = setRect([...base, E], 0, { x: 0, y: 0, width: 100, height: 80 });
    expect(out[3]!.at.y).toBe(80);
    expect(out[4]!.at.y).toBe(100);
    expect(overlapsInLayout(out)).toBe(false);
  });

  it("a chain member moving back pushes what it would overlap", () => {
    // M sits left of B, below A, and touches B (B is tall). Shrinking A's right edge pulls B left onto M: M is pushed.
    const a = r(0, 0, 100, 50, { x: 0, y: 0 });
    const b = r(500, 0, 50, 100, { x: 100, y: 0 });
    const m = r(900, 0, 100, 50, { x: 0, y: 50 });
    const out = setRect([a, b, m], 0, { x: 0, y: 0, width: 80, height: 50 });
    // B follows to 80, M is pushed to -20, so the Clip grows left and everything shifts by 20.
    expect(ats(out)).toEqual([
      { x: 20, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 50 },
    ]);
    expect(overlapsInLayout(out)).toBe(false);
    expect(clipBounds(out).x0).toBe(0);
  });

  it("a corner resize moves both edges", () => {
    const out = setRect(base, 0, { x: 0, y: 0, width: 110, height: 65 });
    expect(out[1]!.at).toEqual({ x: 110, y: 0 });
    expect(out[3]!.at).toEqual({ x: 0, y: 65 });
    expect(overlapsInLayout(out)).toBe(false);
  });
});

describe("moveInLayout (arranging)", () => {
  // A at (0,0) 100×50, B at (0,60) 40×20.
  const A = r(0, 0, 100, 50, { x: 0, y: 0 });
  const B = r(0, 500, 40, 20, { x: 0, y: 60 });

  it("moves freely where there is room", () => {
    const { regions } = moveInLayout([A, B], 1, { x: 30, y: 70 });
    expect(regions[1]!.at).toEqual({ x: 30, y: 70 });
  });

  it("stops at a neighbour instead of overlapping it", () => {
    const { regions } = moveInLayout([A, B], 1, { x: 10, y: 20 });
    expect(regions[1]!.at).toEqual({ x: 10, y: 50 });
    expect(overlapsInLayout(regions)).toBe(false);
  });

  it("slides along a neighbour when the other axis is free", () => {
    // Moving up-right past A's right edge: x is free, y stops at A only while beside it.
    const { regions } = moveInLayout([A, B], 1, { x: 120, y: 10 });
    expect(regions[1]!.at).toEqual({ x: 120, y: 10 });
  });

  it("snaps edges to other Regions' edges and the Clip's start", () => {
    const { regions, guides } = moveInLayout([A, B], 1, { x: 61.5, y: 52 }, { snapMm: 2 });
    // Right edge 101.5 snaps to A's right edge 100; top 52 snaps to A's bottom 50.
    expect(regions[1]!.at).toEqual({ x: 60, y: 50 });
    expect(guides).toContainEqual({ vertical: true, pos: 100 });
    expect(guides).toContainEqual({ vertical: false, pos: 50 });
    expect(moveInLayout([A, B], 1, { x: 1, y: 70 }, { snapMm: 2 }).regions[1]!.at.x).toBe(0);
  });

  it("can go past the Clip's start; the Clip then grows there", () => {
    const { regions } = moveInLayout([A, B], 1, { x: -30, y: 60 });
    expect(regions[1]!.at).toEqual({ x: -30, y: 60 });
    expect(clipBounds(regions)).toEqual({ x0: -30, y0: 0, x1: 100, y1: 80 });
    expect(clipSize(regions)).toEqual({ width: 130, height: 80 });
    expect(normaliseLayout(regions).map((x) => x.at)).toEqual([
      { x: 30, y: 0 },
      { x: 0, y: 60 },
    ]);
  });

  it("jumps to a free place when asked (typed position)", () => {
    const C = r(0, 0, 10, 10, { x: 200, y: 0 });
    const jumped = moveInLayout([A, B, C], 1, { x: 150, y: 0 }, { jump: true }).regions;
    expect(jumped[1]!.at).toEqual({ x: 150, y: 0 });
    const blocked = moveInLayout([A, B, C], 1, { x: 50, y: 10 }, { jump: true }).regions;
    expect(overlapsInLayout(blocked)).toBe(false);
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
