import { describe, expect, it } from "vitest";
import { computeTileGrid, DEFAULT_TILE_SETTINGS, rowName, sheetCount, splitByLength, tiles, type TileGrid, type TileSettings } from "./tilegrid";

const settings = (s: Partial<TileSettings>): TileSettings => ({ ...DEFAULT_TILE_SETTINGS, enabled: true, ...s });
const grid = (w: number, h: number, s: Partial<TileSettings>): TileGrid => {
  const g = computeTileGrid(w, h, settings(s));
  if ("error" in g) throw new Error(g.error);
  return g;
};
const lengths = (spans: { length: number }[]) => spans.map((s) => Math.round(s.length * 10) / 10);

describe("row names", () => {
  it("continue like a spreadsheet after Z", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(rowName)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("free Tile grid", () => {
  it("defaults to one Tile: the whole Clip plus Margin", () => {
    const g = grid(1188.9, 600, { mode: "free" });
    expect(sheetCount(g)).toBe(1);
    expect(g.sheetWidths).toEqual([1208.9]);
    expect(g.sheetHeights).toEqual([620]);
  });

  it("3 columns by count, rows of 3 m by length (the reference Plan)", () => {
    const g = grid(1188.9, 14270.9, {
      mode: "free",
      columns: { lead: "count", count: 3, lengthMm: 0 },
      rows: { lead: "length", count: 0, lengthMm: 3000 },
    });
    expect(lengths(g.columns)).toEqual([396.3, 396.3, 396.3]);
    expect(lengths(g.rows)).toEqual([3000, 3000, 3000, 3000, 2270.9]);
    // The last row's Sheet shrinks to fit its Tile.
    expect(g.sheetHeights.map((h) => Math.round(h * 10) / 10)).toEqual([3020, 3020, 3020, 3020, 2290.9]);
    const t = tiles(g);
    expect(t.map((x) => x.name).slice(0, 4)).toEqual(["A1", "A2", "A3", "B1"]);
    expect(t.at(-1)!.name).toBe("E3");
  });

  it("neighbouring Tiles meet exactly and cover the Clip", () => {
    const g = grid(1000, 777.7, { mode: "free", columns: { lead: "count", count: 7, lengthMm: 0 }, rows: { lead: "length", count: 0, lengthMm: 123.4 } });
    for (const spans of [g.columns, g.rows])
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeCloseTo(spans[i - 1]!.start + spans[i - 1]!.length, 9);
    expect(g.columns.reduce((n, s) => n + s.length, 0)).toBeCloseTo(1000, 9);
    expect(g.rows.reduce((n, s) => n + s.length, 0)).toBeCloseTo(777.7, 9);
  });

  it("a length longer than the Clip gives one Tile", () => {
    expect(grid(500, 500, { mode: "free", rows: { lead: "length", count: 0, lengthMm: 3000 } }).rows).toEqual([{ start: 0, length: 500 }]);
  });

  it("a remainder under 0.1 mm joins the last Tile instead of becoming a sliver", () => {
    expect(lengths(splitByLength(3000.05, 1000))).toEqual([1000, 1000, 1000.1]);
    expect(lengths(splitByLength(3000.2, 1000))).toEqual([1000, 1000, 1000, 0.2]);
    expect(lengths(splitByLength(3000, 1000))).toEqual([1000, 1000, 1000]);
  });

  it("clamps to Tiles of at least 10 mm, with a hint", () => {
    const g = grid(55, 100, { mode: "free", columns: { lead: "count", count: 9, lengthMm: 0 }, rows: { lead: "length", count: 0, lengthMm: 2 } });
    expect(g.columns.length).toBe(5);
    expect(lengths(g.rows)).toEqual(Array(10).fill(10));
    expect(g.hints.join(" ")).toContain("Höchstens 5 Spalten");
    expect(g.hints.join(" ")).toContain("Höhe mindestens 10 mm");
  });
});

describe("paper format Tile grid", () => {
  it("A4 portrait, 10 mm Margin: Tile = 190 × 277 mm, last row and column partly filled, full Sheets", () => {
    const g = grid(1188.9, 600, { mode: "paper", format: "A4", orientation: "portrait", marginMm: 10 });
    expect(lengths(g.columns)).toEqual([190, 190, 190, 190, 190, 190, 48.9]);
    expect(lengths(g.rows)).toEqual([277, 277, 46]);
    expect(new Set(g.sheetWidths)).toEqual(new Set([210]));
    expect(new Set(g.sheetHeights)).toEqual(new Set([297]));
  });

  it("auto picks the orientation with fewer Sheets, portrait on a tie", () => {
    // 1188.9 × 600: portrait 7 × 3 = 21, landscape 5 × 4 = 20.
    expect(grid(1188.9, 600, { mode: "paper", format: "A4", orientation: "auto" }).orientation).toBe("landscape");
    // 150 × 150 fits one Sheet either way.
    expect(grid(150, 150, { mode: "paper", format: "A4", orientation: "auto" }).orientation).toBe("portrait");
  });

  it("the whole reference Plan on A4 portrait is 52 rows × 7 columns", () => {
    const g = grid(1188.9, 14270.9, { mode: "paper", format: "A4", orientation: "portrait" });
    expect(g.rows.length).toBe(52);
    expect(tiles(g).at(-1)!.name).toBe("AZ7");
  });

  it("custom format follows the orientation like the A sizes", () => {
    const g = grid(1000, 1000, { mode: "paper", format: "custom", customWidthMm: 700, customHeightMm: 500, orientation: "portrait" });
    expect(g.sheetWidths[0]).toBe(500);
    expect(g.sheetHeights[0]).toBe(700);
  });

  it("refuses a Margin that leaves no room for a Tile", () => {
    expect(computeTileGrid(100, 100, settings({ mode: "paper", format: "A4", marginMm: 102 }))).toHaveProperty("error");
  });

  it("Margin 0: Tile = Sheet", () => {
    const g = grid(420, 297, { mode: "paper", format: "A4", orientation: "portrait", marginMm: 0 });
    expect(lengths(g.columns)).toEqual([210, 210]);
    expect(lengths(g.rows)).toEqual([297]);
  });
});
