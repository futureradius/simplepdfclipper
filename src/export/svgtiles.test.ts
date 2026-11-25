// SVG Tiled Export (ADR 0013, #46): a Tile is exported like a Clip of the Regions that
// fall inside it, bare (no Margin), all Tiles from one shared pass; empty Tiles skipped.

import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { exportSvg, exportSvgTiles, tileRegions, type SvgExport } from "./index";
import { clipSize, single, type Region } from "./regions";
import { computeTileGrid, DEFAULT_TILE_SETTINGS, tiles, type TileGrid } from "./tilegrid";

const PT = 72 / 25.4;
const PAGE_H = 150 * PT;
const X = (mm: number) => (mm * PT).toFixed(3);
const Y = (mm: number) => (PAGE_H - mm * PT).toFixed(3);

/** A 200 × 150 mm Plan: a bar, a diagonal line, a grid of thin lines, two words. */
function makePlan(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  const text = (s: string, x: number, y: number) => `0 g BT /F1 14 Tf ${X(x)} ${Y(y)} Td (${s}) Tj ET`;
  const grid: string[] = [];
  for (let v = 0; v <= 200; v += 10) grid.push(`${X(v)} ${Y(0)} m ${X(v)} ${Y(150)} l`);
  for (let v = 0; v <= 150; v += 10) grid.push(`${X(0)} ${Y(v)} m ${X(200)} ${Y(v)} l`);
  const content = [
    `0.5 G 0.3 w ${grid.join(" ")} S`,
    `0 0 1 rg ${X(20)} ${Y(60)} ${(100 * PT).toFixed(3)} ${(40 * PT).toFixed(3)} re f`,
    `1 0 0 RG 2 w ${X(0)} ${Y(0)} m ${X(200)} ${Y(150)} l S`,
    text("LINKS", 15, 90),
    text("RECHTS", 130, 90),
  ];
  doc.insertPage(-1, doc.addPage([0, 0, 200 * PT, PAGE_H], 0, res, content.join("\n")));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** A 200 × 150 mm Plan with a single small square at 5..15 mm: most of it is empty. */
function makeSparsePlan(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 200 * PT, PAGE_H], 0, doc.addObject({}), `0 g ${X(5)} ${Y(15)} ${X(10)} ${X(10)} re f`));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

const plan = makePlan();
const page = () => mupdf.Document.openDocument(plan, "application/pdf").loadPage(0);
const OPTS = { textAsPaths: false, mergeMode: "balanced" as const };

function freeGrid(width: number, height: number, columns: number, rows: number): TileGrid {
  const g = computeTileGrid(width, height, {
    ...DEFAULT_TILE_SETTINGS,
    enabled: true,
    mode: "free",
    columns: { lead: "count", count: columns, lengthMm: 0 },
    rows: { lead: "count", count: rows, lengthMm: 0 },
    marginMm: 10, // shapes only the PDF Sheets in free mode; SVG Tiles stay bare
  });
  if ("error" in g) throw new Error(g.error);
  return g;
}

const size = (svg: string) => {
  const m = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg)!;
  return [Number(m[1]), Number(m[2])];
};
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]).sort();

describe("tileRegions", () => {
  const r = (x: number, y: number, width: number, height: number, ax: number, ay: number): Region => ({ x, y, width, height, at: { x: ax, y: ay } });

  it("cuts a one-Region Clip to the Tile, placed at the Tile's corner", () => {
    expect(tileRegions(single({ x: 30, y: 40, width: 100, height: 60 }), { x: 50, y: 20, width: 50, height: 40 })).toEqual([
      r(80, 60, 50, 40, 0, 0),
    ]);
    // The last Tile reaches past the Clip: only the Clip's part counts.
    expect(tileRegions(single({ x: 30, y: 40, width: 100, height: 60 }), { x: 75, y: 30, width: 50, height: 40 })).toEqual([
      r(105, 70, 25, 30, 0, 0),
    ]);
  });

  it("keeps the pieces of every Region in the Tile, each where it is in the Tile", () => {
    // A left of B in the Layout, B lower and shorter: a gap under A's right neighbour.
    const clip = [r(0, 0, 40, 60, 0, 0), r(100, 0, 40, 30, 40, 0)];
    const parts = tileRegions(clip, { x: 20, y: 10, width: 40, height: 40 });
    expect(parts).toEqual([r(20, 10, 20, 40, 0, 0), r(100, 10, 20, 20, 20, 0)]);
    // Below B, right of A: no Region there (it only touches A's right and B's bottom edge).
    expect(tileRegions(clip, { x: 40, y: 30, width: 40, height: 30 })).toEqual([]);
  });
});

describe("SVG Tiled Export", () => {
  it("a one-Region Clip: each bare Tile is the plain SVG of its rectangle of the Plan", () => {
    const clip = { x: 10, y: 20, width: 150, height: 100 };
    const g = freeGrid(clip.width, clip.height, 3, 2);
    const list = tiles(g);
    const out = exportSvgTiles(mupdf, page(), { ...OPTS, clip }, list);
    expect(out).toHaveLength(6);
    for (const [i, t] of list.entries()) {
      const s = out[i]!;
      expect(s, t.name).not.toBeNull();
      // Bare Tile: exactly the Tile, not the Sheet (no Margin, no label).
      expect(size(s.svg)).toEqual([t.width, t.height]);
      expect(s.svg).not.toContain(t.name);
      // Cut exactly like a Clip of that rectangle (paths cut at every edge, ADR 0005).
      const rect = { x: clip.x + t.x, y: clip.y + t.y, width: t.width, height: t.height };
      expect(s.svg, t.name).toBe(exportSvg(mupdf, page(), { ...OPTS, clip: rect }).svg);
    }
    // Neighbouring Tiles meet exactly: each starts where the one before ends.
    for (const [i, t] of list.entries()) {
      const left = list[i - 1];
      if (left && left.row === t.row) expect(left.x + left.width).toBeCloseTo(t.x, 9);
    }
    expect(list.filter((t) => t.row === 0).reduce((n, t) => n + size(out[list.indexOf(t)]!.svg)[0]!, 0)).toBeCloseTo(150, 6);
  });

  it("a Tile with nothing of the Plan in it is skipped (null)", () => {
    const sparse = mupdf.Document.openDocument(makeSparsePlan(), "application/pdf").loadPage(0);
    const clip = { x: 0, y: 0, width: 200, height: 150 };
    const list = tiles(freeGrid(clip.width, clip.height, 4, 3));
    const out = exportSvgTiles(mupdf, sparse, { ...OPTS, clip }, list);
    expect(out.map((s, i) => (s ? list[i]!.name : null)).filter(Boolean)).toEqual(["A1"]);
  });

  it("a stitched Clip: a Tile across two Regions holds both, a Tile in the gap is skipped", () => {
    // LINKS (15..~35 mm, y 85..90) and RECHTS (130.., same row) side by side.
    const regions: Region[] = [
      { x: 10, y: 70, width: 40, height: 30, at: { x: 0, y: 0 } },
      { x: 125, y: 75, width: 40, height: 20, at: { x: 40, y: 0 } },
    ];
    expect(clipSize(regions)).toEqual({ width: 80, height: 30 });
    // 2 × 2 Tiles of 40 × 15: B2 lies below the second Region, in the gap.
    const tilesHere = [
      { name: "A1", x: 20, y: 0, width: 40, height: 15 },
      { name: "B2", x: 40, y: 20, width: 40, height: 10 },
      { name: "W", x: 0, y: 0, width: 80, height: 30 },
    ];
    const [across, gap, all] = exportSvgTiles(mupdf, page(), { ...OPTS, clip: regions }, tilesHere);
    expect(gap).toBeNull();
    expect(size(across!.svg)).toEqual([40, 15]);
    // The Tile covering the whole Clip is the stitched SVG itself.
    expect(all!.svg).toBe(exportSvg(mupdf, page(), { ...OPTS, clip: regions }).svg);
    // Ids of the two pieces are kept apart.
    const ids = [...across!.svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    // Text: kept by its centre, so the words land in the Tiles that hold them.
    const words = exportSvgTiles(mupdf, page(), { ...OPTS, clip: regions }, [
      { x: 0, y: 0, width: 40, height: 30 },
      { x: 40, y: 0, width: 40, height: 30 },
    ]);
    expect(texts(words[0]!.svg)).toEqual(["LINKS"]);
    expect(texts(words[1]!.svg)).toEqual(["RECHTS"]);
  });

  it("one shared pass gives the same SVGs as one pass per Tile", () => {
    const clip = { x: 10, y: 20, width: 150, height: 100 };
    const list = tiles(freeGrid(clip.width, clip.height, 3, 2));
    const shared = exportSvgTiles(mupdf, page(), { ...OPTS, clip }, list);
    const alone: (SvgExport | null)[] = list.map((t) => exportSvgTiles(mupdf, page(), { ...OPTS, clip }, [t])[0]!);
    expect(shared.map((s) => s?.svg)).toEqual(alone.map((s) => s?.svg));
  });
});
