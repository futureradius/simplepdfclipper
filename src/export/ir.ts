// Intermediate representation of the Clip's content, in paint order.
// All coordinates are in export units: 0.01 mm, origin at the Clip's top-left
// corner, y pointing down (ADR 0011: fixed 0.01 mm precision).

import type { Matrix, Rect } from "./geometry";

export const UNITS_PER_MM = 100;

/** Path commands, flattened: op code followed by its coordinates. */
export const Op = {
  Move: 0, // x y
  Line: 1, // x y
  Curve: 2, // x1 y1 x2 y2 x3 y3
  Close: 3,
} as const;
export type PathData = number[];

export interface StrokeStyle {
  width: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miterLimit: number;
  dashes: number[] | null;
  dashPhase: number;
}

export interface PathItem {
  kind: "path";
  d: PathData;
  /** Fill colour (#rrggbb) or null for a pure stroke. */
  fill: string | null;
  evenOdd: boolean;
  /** Stroke colour or null for a pure fill. */
  stroke: string | null;
  strokeStyle: StrokeStyle | null;
  alpha: number;
  bbox: Rect;
  clip: string | null;
}

export interface FontStyle {
  /** Value for the SVG font-family attribute. */
  family: string;
  bold: boolean;
  italic: boolean;
  /** True if the original font is metric-compatible with what the SVG asks for,
   * so no textLength correction is needed. */
  metricCompatible: boolean;
}

export interface TextItem {
  kind: "text";
  str: string;
  /** Baseline origin of the first glyph (when transform is null). */
  x: number;
  y: number;
  size: number;
  /** For rotated/skewed text: full matrix applied to text drawn at (0,0). */
  transform: Matrix | null;
  /** Original advance width of the run, for textLength. */
  length: number;
  font: FontStyle;
  fill: string;
  alpha: number;
  bbox: Rect;
  clip: string | null;
}

export interface ImageItem {
  kind: "image";
  href: string;
  /** Maps the unit square to export units. */
  matrix: Matrix;
  alpha: number;
  bbox: Rect;
  clip: string | null;
}

export type Item = PathItem | TextItem | ImageItem;

/** A clip region. Either a rectangle or a path; nested clips chain via parent. */
export interface ClipDef {
  rect: Rect | null;
  d: PathData | null;
  evenOdd: boolean;
  parent: string | null;
}

/**
 * A PDF tiling pattern. Items are the content of one tile in export units, as
 * drawn for the first use; matrix maps pattern space to export units. A def
 * with a base reuses the base's content with its own matrix.
 */
export interface PatternDef {
  id: string;
  base: string | null;
  xstep: number;
  ystep: number;
  view: Rect;
  matrix: Matrix;
  items: Item[];
}

export interface Collected {
  items: Item[];
  /** Clip regions referenced by items, by id, parents before children. */
  clips: Map<string, ClipDef>;
  patterns: PatternDef[];
  /** The export area: (0, 0) to (width, height) in export units. */
  width: number;
  height: number;
  /** Counts of PDF features that could not be reproduced, by name. */
  unsupported: Record<string, number>;
}
