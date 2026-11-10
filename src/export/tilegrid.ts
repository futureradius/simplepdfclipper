// Tile grid of a Tiled Export (ADR 0013): how the Clip is cut into Tiles and
// how large each Sheet is. Pure geometry in mm, no PDF.

export type PaperFormat = "A4" | "A3" | "A2" | "A1" | "A0" | "custom";
export type Orientation = "auto" | "portrait" | "landscape";

/** Portrait width × height in mm. */
export const PAPER_SIZES: Record<Exclude<PaperFormat, "custom">, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
};

/** One axis of a free Tile grid: the field edited last leads, the other is derived. */
export interface AxisSetting {
  lead: "count" | "length";
  count: number;
  lengthMm: number;
}

export interface TileSettings {
  enabled: boolean;
  mode: "paper" | "free";
  format: PaperFormat;
  customWidthMm: number;
  customHeightMm: number;
  orientation: Orientation;
  columns: AxisSetting;
  rows: AxisSetting;
  marginMm: number;
  output: "files" | "multipage";
}

export const DEFAULT_TILE_SETTINGS: TileSettings = {
  enabled: false,
  mode: "paper",
  format: "A4",
  customWidthMm: 500,
  customHeightMm: 700,
  orientation: "auto",
  columns: { lead: "count", count: 1, lengthMm: 1000 },
  rows: { lead: "count", count: 1, lengthMm: 1000 },
  marginMm: 10,
  output: "files",
};

/** Smallest Tile side. */
export const MIN_TILE_MM = 10;
/** A last row/column shorter than this is not a Tile of its own (it joins the one before). */
export const SLIVER_MM = 0.1;
/** Above this many Sheets the UI warns (never refuses). */
export const MANY_SHEETS = 100;

/** A piece of one axis, relative to the Clip's top-left corner. */
export interface Span {
  start: number;
  length: number;
}

export interface TileGrid {
  columns: Span[];
  rows: Span[];
  /** Sheet width per column and height per row, in mm. */
  sheetWidths: number[];
  sheetHeights: number[];
  marginMm: number;
  /** Paper format mode: the orientation used (after "auto"). */
  orientation?: "portrait" | "landscape";
  /** Notes about values that were adjusted, for the UI. */
  hints: string[];
}

export interface Tile {
  /** Grid name: row letter(s), column number (A1, B3, AA12). */
  name: string;
  row: number;
  column: number;
  /** The Tile, relative to the Clip's top-left corner (mm). */
  x: number;
  y: number;
  width: number;
  height: number;
  sheetWidth: number;
  sheetHeight: number;
}

/** Spreadsheet-style row letters: A … Z, AA, AB … */
export function rowName(index: number): string {
  let s = "";
  for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Equal shares. */
export function splitByCount(total: number, count: number): Span[] {
  const len = total / count;
  return Array.from({ length: count }, (_, i) => ({ start: i * len, length: i === count - 1 ? total - i * len : len }));
}

/** Pieces of a fixed length; the last one is shorter. A sliver under SLIVER_MM joins the piece before. */
export function splitByLength(total: number, length: number): Span[] {
  if (length >= total - SLIVER_MM) return [{ start: 0, length: total }];
  const n = Math.floor(total / length + 1e-9);
  const spans: Span[] = Array.from({ length: n }, (_, i) => ({ start: i * length, length }));
  const rest = total - n * length;
  if (rest >= SLIVER_MM) spans.push({ start: n * length, length: rest });
  else spans[n - 1]!.length += rest;
  return spans;
}

/** Most Tiles an axis can have while every Tile is at least MIN_TILE_MM. */
export const maxCount = (total: number) => Math.max(1, Math.floor(total / MIN_TILE_MM + 1e-9));

function freeAxis(total: number, a: AxisSetting, margin: number, what: [string, string], hints: string[]): { spans: Span[]; sheets: number[] } {
  let spans: Span[];
  if (a.lead === "count") {
    const max = maxCount(total);
    let n = Math.round(a.count);
    if (!(n >= 1)) n = 1;
    if (n > max) {
      hints.push(`Höchstens ${max} ${what[0]} (Kacheln mindestens ${MIN_TILE_MM} mm).`);
      n = max;
    }
    spans = splitByCount(total, n);
  } else {
    let len = a.lengthMm;
    if (!(len >= MIN_TILE_MM)) {
      hints.push(`${what[1]} mindestens ${MIN_TILE_MM} mm.`);
      len = MIN_TILE_MM;
    }
    spans = splitByLength(total, len);
  }
  return { spans, sheets: spans.map((s) => s.length + 2 * margin) };
}

function paperAxis(total: number, sheet: number, margin: number): { spans: Span[]; sheets: number[] } {
  const spans = splitByLength(total, sheet - 2 * margin);
  return { spans, sheets: spans.map(() => sheet) };
}

/** Sheet size (mm, width × height) for a format and orientation. */
export function paperSize(s: TileSettings, orientation: "portrait" | "landscape"): [number, number] {
  const [a, b] = s.format === "custom" ? [s.customWidthMm, s.customHeightMm] : PAPER_SIZES[s.format];
  const short = Math.min(a, b);
  const long = Math.max(a, b);
  return orientation === "portrait" ? [short, long] : [long, short];
}

/**
 * Cuts a Clip of `width` × `height` mm into Tiles. Returns an error message instead
 * when the settings leave no room for a Tile (e.g. Margin larger than the paper).
 */
export function computeTileGrid(width: number, height: number, s: TileSettings): TileGrid | { error: string } {
  const margin = Math.max(0, Number.isFinite(s.marginMm) ? s.marginMm : 0);
  const hints: string[] = [];
  if (s.mode === "free") {
    const c = freeAxis(width, s.columns, margin, ["Spalten", "Breite"], hints);
    const r = freeAxis(height, s.rows, margin, ["Zeilen", "Höhe"], hints);
    return { columns: c.spans, rows: r.spans, sheetWidths: c.sheets, sheetHeights: r.sheets, marginMm: margin, hints };
  }

  const options = s.orientation === "auto" ? (["portrait", "landscape"] as const) : [s.orientation];
  let best: TileGrid | undefined;
  for (const o of options) {
    const [w, h] = paperSize(s, o);
    if (!(w > 0 && h > 0)) return { error: "Bitte ein gültiges Papierformat angeben." };
    if (Math.min(w, h) - 2 * margin < MIN_TILE_MM) return { error: `Der Rand ist zu groß für dieses Papierformat (Kacheln mindestens ${MIN_TILE_MM} mm).` };
    const c = paperAxis(width, w, margin);
    const r = paperAxis(height, h, margin);
    const g: TileGrid = { columns: c.spans, rows: r.spans, sheetWidths: c.sheets, sheetHeights: r.sheets, marginMm: margin, orientation: o, hints };
    // "auto": fewer Sheets wins, portrait on a tie (it comes first).
    if (!best || sheetCount(g) < sheetCount(best)) best = g;
  }
  return best!;
}

export const sheetCount = (g: TileGrid) => g.columns.length * g.rows.length;

/** All Tiles, row by row (the page order of the multipage file). */
export function tiles(g: TileGrid): Tile[] {
  const out: Tile[] = [];
  g.rows.forEach((r, ri) =>
    g.columns.forEach((c, ci) =>
      out.push({
        name: rowName(ri) + String(ci + 1),
        row: ri,
        column: ci,
        x: c.start,
        y: r.start,
        width: c.length,
        height: r.length,
        sheetWidth: g.sheetWidths[ci]!,
        sheetHeight: g.sheetHeights[ri]!,
      }),
    ),
  );
  return out;
}
