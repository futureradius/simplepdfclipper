import { describe, expect, it } from "vitest";
import { encodePath, parseGlyphPath } from "./pathdata";
import { familyOf, fontStyleFor } from "./fonts";
import { mergeItems } from "./merge";
import { Op, type PathItem, type TextItem } from "./ir";
import type { Rect } from "./geometry";

describe("encodePath", () => {
  it("uses relative h/v commands and rounds to whole units", () => {
    // rectangle 10,20 -> 110,70
    const d = [Op.Move, 10.2, 19.8, Op.Line, 110, 20, Op.Line, 110, 70, Op.Line, 10, 70, Op.Close];
    expect(encodePath(d)).toBe("m10 20h100v50h-100z");
  });

  it("omits repeated letters and separators before negatives", () => {
    const d = [Op.Move, 0, 0, Op.Line, 5, 5, Op.Line, 10, 2, Op.Line, 15, 7];
    expect(encodePath(d)).toBe("m0 0l5 5 5-3 5 5");
  });

  it("returns to the subpath start after z", () => {
    const d = [Op.Move, 100, 100, Op.Line, 200, 100, Op.Close, Op.Move, 100, 150, Op.Line, 200, 150];
    expect(encodePath(d)).toBe("m100 100h100zm0 50h100");
  });
});

describe("parseGlyphPath", () => {
  it("parses MuPDF glyph syntax with implicit repeats and applies the matrix", () => {
    const d = parseGlyphPath("M.5 0 1 1H0Z", [10, 0, 0, -10, 100, 200]);
    expect(d).toEqual([Op.Move, 105, 200, Op.Line, 110, 190, Op.Line, 100, 190, Op.Close]);
  });
});

describe("fonts", () => {
  it("derives readable family names", () => {
    expect(familyOf("ABCDEF+ArialMT")).toBe("Arial");
    expect(familyOf("ABCDEF+Arial-BoldMT")).toBe("Arial");
    expect(familyOf("TimesNewRomanPS-BoldMT")).toBe("Times New Roman");
    expect(familyOf("Arial,Bold")).toBe("Arial");
    expect(familyOf("Helvetica")).toBe("Helvetica");
  });

  it("marks Helvetica/Arial as metric-compatible and lists fallbacks", () => {
    const s = fontStyleFor({ name: "Helvetica-Bold", bold: false, italic: false, serif: false, mono: false });
    expect(s).toEqual({ family: "Helvetica,Arial,sans-serif", bold: true, italic: false, metricCompatible: true });
    const u = fontStyleFor({ name: "XYZABC+PDFSpecial", bold: false, italic: false, serif: false, mono: false });
    expect(u.family).toBe("PDFSpecial,Arial,sans-serif");
    expect(u.metricCompatible).toBe(false);
  });
});

const box = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });
const stroke = (b: Rect, color = "#000"): PathItem => ({
  kind: "path",
  d: [Op.Move, b.x0, b.y0, Op.Line, b.x1, b.y1],
  fill: null,
  evenOdd: false,
  stroke: color,
  strokeStyle: { width: 10, cap: "butt", join: "miter", miterLimit: 10, dashes: null, dashPhase: 0 },
  alpha: 1,
  bbox: b,
  clip: null,
});
const fill = (b: Rect, color = "#f00"): PathItem => ({ ...stroke(b), fill: color, stroke: null, strokeStyle: null });
const text = (b: Rect): TextItem => ({
  kind: "text",
  str: "x",
  x: b.x0,
  y: b.y1,
  size: 250,
  transform: null,
  length: 100,
  font: { family: "Arial", bold: false, italic: false, metricCompatible: true },
  fill: "#000",
  alpha: 1,
  bbox: b,
  clip: null,
});
const shape = (groups: { items: unknown[] }[]) => groups.map((g) => g.items.length);

describe("mergeItems", () => {
  // grid line, bar overlapping it, grid line elsewhere, bar elsewhere
  const items = [
    stroke(box(0, 0, 10, 1000)),
    fill(box(0, 100, 500, 200)),
    stroke(box(800, 0, 810, 1000)),
    fill(box(0, 300, 500, 400)),
  ];

  it("exact: merges only consecutive items", () => {
    expect(shape(mergeItems(items, "exact", 1000, 1000))).toEqual([1, 1, 1, 1]);
    const consecutive = [stroke(box(0, 0, 10, 1000)), stroke(box(800, 0, 810, 1000))];
    expect(shape(mergeItems(consecutive, "exact", 1000, 1000))).toEqual([2]);
  });

  it("balanced: merges across items that do not overlap", () => {
    // 2nd grid line does not touch the first bar -> joins the first grid line;
    // 2nd bar does not overlap the grid line group painted after the 1st bar? It
    // overlaps the first grid line (x 0..10), which is painted *before* the bar
    // group, so it may join the bar group.
    expect(shape(mergeItems(items, "balanced", 1000, 1000))).toEqual([2, 2]);
  });

  it("balanced: keeps order where an overlapping item lies in between", () => {
    const layered = [
      fill(box(0, 0, 100, 100), "#f00"),
      stroke(box(50, 0, 60, 200)), // crosses the first red box
      fill(box(40, 150, 140, 250), "#f00"), // overlaps the stroke -> must stay above it
    ];
    expect(shape(mergeItems(layered, "balanced", 1000, 1000))).toEqual([1, 1, 1]);
    expect(shape(mergeItems(layered, "max", 1000, 1000))).toEqual([2, 1]);
  });

  it("never merges overlapping fills (fill-rule holes)", () => {
    const overlappingFills = [fill(box(0, 0, 100, 100)), fill(box(50, 50, 150, 150))];
    for (const mode of ["exact", "balanced", "max"] as const)
      expect(shape(mergeItems(overlappingFills, mode, 1000, 1000))).toEqual([1, 1]);
  });

  it("groups text runs of the same style", () => {
    const t = [text(box(0, 0, 100, 30)), fill(box(500, 500, 600, 600)), text(box(0, 40, 100, 70))];
    expect(shape(mergeItems(t, "balanced", 1000, 1000))).toEqual([2, 1]);
  });

  it("keeps translucent and dashed items on their own", () => {
    const solo = [{ ...stroke(box(0, 0, 10, 10)), alpha: 0.5 }, { ...stroke(box(20, 0, 30, 10)), alpha: 0.5 }];
    expect(shape(mergeItems(solo, "max", 1000, 1000))).toEqual([1, 1]);
  });
});
