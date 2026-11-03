// Groups items that can share one SVG element (paths) or one <g> (text),
// without changing what the picture looks like (ADR 0011).
//
// Merging item i into an earlier group G moves i back in paint order to G's
// position. That is invisible unless i overlaps something painted between G and
// i. Modes:
//   exact:    only merge into the most recent group (nothing in between).
//   balanced: merge into the latest same-style group if nothing painted after it
//             overlaps i (checked with a spatial index).
//   max:      merge into the latest same-style group regardless of order.
// In every mode, filled paths only merge if they do not overlap members of the
// group: overlapping subpaths in one path can cancel out (fill-rule holes).

import { overlaps, type Rect } from "./geometry";
import type { Item, PathItem, TextItem } from "./ir";

export type MergeMode = "exact" | "balanced" | "max";

export interface Group {
  key: string;
  items: Item[];
}

function pathKey(p: PathItem): string | null {
  if (p.alpha !== 1) return null; // overlapping translucent parts would blend differently
  if (p.strokeStyle?.dashes) return null; // dash patterns restart per subpath differently
  const s = p.strokeStyle;
  return [
    "p",
    p.fill ?? "",
    p.evenOdd ? 1 : 0,
    p.stroke ?? "",
    s ? `${s.width}|${s.cap}|${s.join}|${s.miterLimit}` : "",
    p.clip ?? "",
  ].join("|");
}

function textKey(t: TextItem): string | null {
  if (t.alpha !== 1) return null;
  return ["t", t.font.family, t.font.bold ? 1 : 0, t.font.italic ? 1 : 0, Math.round(t.size), t.fill, t.clip ?? ""].join("|");
}

/** Merge key, or null if the item must stay on its own. */
export function mergeKey(item: Item): string | null {
  if (item.kind === "path") return pathKey(item);
  if (item.kind === "text") return textKey(item);
  return null;
}

/** Uniform grid over the export area; stores member bboxes with their group index. */
class SpatialIndex {
  private cells = new Map<number, { bbox: Rect; group: number }[]>();
  private readonly cols: number;

  constructor(
    width: number,
    private readonly height: number,
    private readonly cell: number,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
  }

  private range(r: Rect): [number, number, number, number] {
    const c = this.cell;
    const maxCol = this.cols - 1;
    const maxRow = Math.max(0, Math.ceil(this.height / c) - 1);
    const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
    return [
      clamp(Math.floor(r.x0 / c), maxCol),
      clamp(Math.floor(r.y0 / c), maxRow),
      clamp(Math.floor(r.x1 / c), maxCol),
      clamp(Math.floor(r.y1 / c), maxRow),
    ];
  }

  insert(bbox: Rect, group: number): void {
    const [c0, r0, c1, r1] = this.range(bbox);
    const entry = { bbox, group };
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const k = r * this.cols + c;
        const list = this.cells.get(k);
        if (list) list.push(entry);
        else this.cells.set(k, [entry]);
      }
  }

  /** Calls fn for every stored bbox overlapping r; stops early if fn returns true. */
  someOverlapping(r: Rect, fn: (group: number) => boolean): boolean {
    const [c0, r0, c1, r1] = this.range(r);
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const list = this.cells.get(row * this.cols + col);
        if (!list) continue;
        for (const e of list) if (overlaps(e.bbox, r) && fn(e.group)) return true;
      }
    return false;
  }
}

export function mergeItems(items: Item[], mode: MergeMode, width: number, height: number): Group[] {
  const groups: Group[] = [];
  const lastByKey = new Map<string, number>();
  // ~200k cells over the area keeps both memory and per-item work small.
  const cell = Math.max(100, Math.sqrt((width * height) / 200_000));
  const index = new SpatialIndex(width, height, cell);

  for (const item of items) {
    const key = mergeKey(item);
    const candidate = key === null ? undefined : lastByKey.get(key);
    let target = -1;

    if (candidate !== undefined && (mode !== "exact" || candidate === groups.length - 1)) {
      const isFill = item.kind === "path" && item.fill !== null;
      const blocked = index.someOverlapping(item.bbox, (g) => {
        if (g === candidate) return isFill; // fills must not overlap their own group
        return mode !== "max" && g > candidate; // something in between overlaps
      });
      if (!blocked) target = candidate;
    }

    if (target === -1) {
      target = groups.length;
      groups.push({ key: key ?? `solo${target}`, items: [item] });
      if (key !== null) lastByKey.set(key, target);
    } else {
      groups[target]!.items.push(item);
    }
    index.insert(item.bbox, target);
  }
  return groups;
}
