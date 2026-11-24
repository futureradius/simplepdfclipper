// Runs the Plan's page through a custom MuPDF device and records everything that
// is visible inside the Clip as IR items (see ir.ts), in paint order.

import type * as MuPDF from "mupdf";
import {
  apply,
  concat,
  contains,
  emptyRect,
  expand,
  expansion,
  extend,
  intersect,
  isEmpty,
  meets,
  transformRect,
  union,
  type Matrix,
  type Rect,
} from "./geometry";
import { fontStyleFor } from "./fonts";
import { GlyphOutlines } from "./glyphs";
import {
  Op,
  UNITS_PER_MM,
  type ClipDef,
  type Collected,
  type FontStyle,
  type Item,
  type PathData,
  type PatternDef,
  type StrokeStyle,
} from "./ir";
import { encodeVisibleImage } from "./imagecrop";
import { encodePath } from "./pathdata";
import { clipFill, cutStroke, fromPathData, rectHalfPlanes, toPathData, type HalfPlane, type LineCap } from "./pathcut";
import { GlyphBoxes } from "./glyphbox";

export interface ClipMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CollectOptions {
  clip: ClipMm;
  textAsPaths: boolean;
  /**
   * For one Region of a stitched Clip (ADR 0016): where the Region's top-left corner
   * sits in the export (mm), the export's size, a prefix that keeps its clip and pattern
   * ids apart from the other Regions', and a clip to the Region for whatever reaches
   * past its edge (glyphs kept whole, image pixels).
   */
  region?: { at: { x: number; y: number }; size: { width: number; height: number }; idPrefix: string };
  /** Original font family -> installed substitute (font dialog). */
  fontSubstitutions?: Record<string, string>;
}

const PT_TO_UNITS = (25.4 / 72) * UNITS_PER_MM;
/** Text bounds come from font boxes; this much slack (2 mm) keeps the glyph-centre rule in charge at the edge. */
const TEXT_SLACK = 2 * UNITS_PER_MM;
/** PDF line width 0 means "thinnest visible line"; SVG would hide it. */
const HAIRLINE = 0.05 * UNITS_PER_MM;
const CAPS = ["butt", "round", "square", "round"] as const; // Triangle -> round
const JOINS = ["miter", "round", "bevel", "miter"] as const; // MiterXPS -> miter
const CAP_NUMBER: Record<StrokeStyle["cap"], LineCap> = { butt: 0, round: 1, square: 2 };

/** Bounding box of the points of path data. */
function walkData(d: PathData): Rect {
  const r = emptyRect();
  let i = 0;
  while (i < d.length) {
    const op = d[i++];
    const n = op === Op.Curve ? 3 : op === Op.Close ? 0 : 1;
    for (let k = 0; k < n; k++) {
      extend(r, d[i]!, d[i + 1]!);
      i += 2;
    }
  }
  return r;
}

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");

export function colorToHex(cs: MuPDF.ColorSpace, color: number[]): string {
  let r: number, g: number, b: number;
  const n = color.length;
  if (n === 1 || cs.isGray()) {
    r = g = b = color[0] ?? 0;
  } else if (n === 4 || cs.isCMYK()) {
    const [c, m, y, k] = color as [number, number, number, number];
    r = (1 - c) * (1 - k);
    g = (1 - m) * (1 - k);
    b = (1 - y) * (1 - k);
  } else if (n >= 3) {
    [r, g, b] = color as [number, number, number];
  } else {
    r = g = b = 0;
  }
  const h = hex2(r) + hex2(g) + hex2(b);
  // #rrggbb -> #rgb when possible
  if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5]) return `#${h[0]}${h[2]}${h[4]}`;
  return `#${h}`;
}

function walkPath(path: MuPDF.Path, ctm: Matrix): { d: PathData; bbox: Rect; rect: Rect | null } {
  const d: PathData = [];
  const bbox = emptyRect();
  const pts: [number, number][] = [];
  let curves = false;
  let subpaths = 0;
  const pt = (x: number, y: number) => {
    const p = apply(ctm, x, y);
    extend(bbox, p[0], p[1]);
    pts.push(p);
    return p;
  };
  path.walk({
    moveTo(x, y) {
      subpaths++;
      d.push(Op.Move, ...pt(x, y));
    },
    lineTo(x, y) {
      d.push(Op.Line, ...pt(x, y));
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      curves = true;
      d.push(Op.Curve, ...pt(x1, y1), ...pt(x2, y2), ...pt(x3, y3));
    },
    closePath() {
      d.push(Op.Close);
    },
  });
  // Axis-aligned rectangle? (Used to turn clip paths into exact clip rects.)
  let rect: Rect | null = null;
  if (!curves && subpaths === 1 && (pts.length === 4 || pts.length === 5)) {
    const eps = 0.5;
    const xs = new Set(pts.map((p) => Math.round(p[0] / eps)));
    const ys = new Set(pts.map((p) => Math.round(p[1] / eps)));
    if (xs.size <= 2 && ys.size <= 2) rect = { ...bbox };
  }
  return { d, bbox, rect };
}

function strokeStyleOf(stroke: MuPDF.StrokeState, ctm: Matrix): StrokeStyle {
  const s = expansion(ctm);
  const dashes = stroke.getDashes();
  return {
    width: Math.max(HAIRLINE, stroke.getLineWidth() * s),
    cap: CAPS[stroke.getLineCap()] ?? "butt",
    join: JOINS[stroke.getLineJoin()] ?? "miter",
    miterLimit: stroke.getMiterLimit(),
    dashes: dashes && dashes.length > 0 && dashes.some((v) => v > 0) ? dashes.map((v) => v * s) : null,
    dashPhase: stroke.getDashPhase() * s,
  };
}

interface Glyph {
  font: MuPDF.Font;
  m: Matrix; // glyph space (1 em, y up) -> export units
  gid: number;
  uni: number;
  adv: number; // advance in em
  /** Set when a space-width gap precedes this glyph (a space is inserted). */
  spaceBefore?: boolean;
}

function glyphBox(g: Glyph): Rect {
  return transformRect(g.m, { x0: 0, y0: -0.25, x1: Math.max(g.adv, 0.3), y1: 0.85 });
}

/** The callbacks a JS device takes (MuPDF.js does not export the type; first constructor overload). */
type DeviceFunctions = typeof MuPDF.Device extends { new (callbacks: infer C): unknown; new (pointer: never): unknown } ? C : never;

interface Collector {
  /** The callbacks of a MuPDF device that records into this collector. */
  device: DeviceFunctions;
  /** The page transformation the device expects (page space -> export units). */
  pageToUnits: Matrix;
  /** Ends collecting and returns what was recorded. */
  finish(): Collected;
}

function collector(mupdf: typeof MuPDF, page: MuPDF.Page, opts: CollectOptions): Collector {
  const [bx0, by0] = page.getBounds();
  const { clip, region } = opts;
  const ox = region ? Math.round(region.at.x * UNITS_PER_MM) : 0;
  const oy = region ? Math.round(region.at.y * UNITS_PER_MM) : 0;
  const area: Rect = { x0: ox, y0: oy, x1: ox + Math.round(clip.width * UNITS_PER_MM), y1: oy + Math.round(clip.height * UNITS_PER_MM) };
  const width = region ? Math.round(region.size.width * UNITS_PER_MM) : area.x1;
  const height = region ? Math.round(region.size.height * UNITS_PER_MM) : area.y1;
  const prefix = region?.idPrefix ?? "";
  /** Paths are cut at the area (ADR 0005, #35). */
  const areaPlanes: HalfPlane[] = rectHalfPlanes(area);
  const pageToUnits: Matrix = [
    PT_TO_UNITS,
    0,
    0,
    PT_TO_UNITS,
    -(bx0 * PT_TO_UNITS) - clip.x * UNITS_PER_MM + ox,
    -(by0 * PT_TO_UNITS) - clip.y * UNITS_PER_MM + oy,
  ];

  const items: Item[] = [];
  /** Where drawing calls go: the page, or the pattern tile being recorded. */
  let sink: Item[] = items;
  let pageSink: Item[] = items;
  const clips = new Map<string, ClipDef>();
  const clipIds = new Map<string, string>();
  const patterns: PatternDef[] = [];
  const patternIds = new Map<string, string>();
  const unsupported: Record<string, number> = {};
  const warn = (what: string) => (unsupported[what] = (unsupported[what] ?? 0) + 1);

  // Clip stack. rect: visible bounds (intersected); id: SVG clip to apply;
  // exact: the whole chain consists of rectangles, so rect is the exact region.
  const clipStack: { rect: Rect; id: string | null; exact: boolean }[] = [{ rect: area, id: null, exact: true }];
  const top = () => clipStack[clipStack.length - 1]!;
  let suppress = 0; // inside mask definitions / skipped tiles: draw nothing
  let recording = 0; // inside a pattern tile being recorded
  const tileStack: ("record" | "skip")[] = [];

  const clipId = (key: string, def: ClipDef) => {
    let id = clipIds.get(key);
    if (!id) {
      id = prefix + "c" + (clipIds.size + 1);
      clipIds.set(key, id);
      clips.set(id, def);
    }
    return id;
  };

  const pushRectClip = (r: Rect) => {
    const t = top();
    // Clips inside pattern tiles are not reproduced; no-op clips need no SVG.
    if (recording || contains(r, t.rect)) {
      clipStack.push({ ...t });
      return;
    }
    const rect = intersect(t.rect, r);
    const def: ClipDef = t.exact
      ? { rect, d: null, evenOdd: false, parent: null }
      : { rect: intersect(r, area), d: null, evenOdd: false, parent: t.id };
    const key = "r" + [def.rect!.x0, def.rect!.y0, def.rect!.x1, def.rect!.y1].map(Math.round).join(" ") + "|" + def.parent;
    clipStack.push({ rect, id: clipId(key, def), exact: t.exact });
  };

  const pushPathClip = (d: PathData, evenOdd: boolean, bbox: Rect) => {
    const t = top();
    if (recording) {
      clipStack.push({ ...t });
      return;
    }
    const cut = clipFill(fromPathData(d), areaPlanes);
    if (cut && !cut.length) {
      pushRectClip({ x0: 1, y0: 1, x1: 0, y1: 0 }); // nothing of it inside: an empty clip hides everything
      return;
    }
    if (cut) {
      d = toPathData(cut);
      bbox = intersect(bbox, area);
    }
    const def: ClipDef = { rect: null, d, evenOdd, parent: t.id };
    const key = "p" + (evenOdd ? 1 : 0) + encodePath(d) + "|" + t.id;
    clipStack.push({ rect: intersect(t.rect, bbox), id: clipId(key, def), exact: false });
  };

  /**
   * In a stitched Clip, whatever reaches past the Region's edge (a glyph kept whole, the
   * last image pixels) must not show in its neighbour: such items get this clip. Alone,
   * the SVG's own edge does that.
   */
  let areaClip: string | null = null;
  const edgeClip = (bbox: Rect): string | null => {
    if (!region || contains(area, bbox)) return null;
    areaClip ??= clipId("area", { rect: area, d: null, evenOdd: false, parent: null });
    return areaClip;
  };

  /** Clip id an item with this bbox needs, or undefined if it is invisible. */
  const clipFor = (bbox: Rect): string | null | undefined => {
    if (recording) return null; // tile content: positioned in pattern space, never culled
    const t = top();
    if (isEmpty(t.rect) || !meets(bbox, t.rect)) return undefined;
    if (t.id === null) return edgeClip(bbox);
    if (t.exact && contains(t.rect, intersect(bbox, area))) return edgeClip(bbox);
    return t.id;
  };

  /**
   * True if a path cannot show: MuPDF's bounds (stroke included) miss the visible area.
   * Checked before the path is walked point by point in JS, which is what most of an
   * export's time goes into: most of a Plan is outside the Clip.
   */
  const missed = (shape: MuPDF.Path | MuPDF.Text, stroke: MuPDF.StrokeState | null, ctm: Matrix, slack = 1): boolean => {
    if (recording) return false; // tile content: positioned in pattern space
    const [x0, y0, x1, y1] = shape.getBounds(stroke as MuPDF.StrokeState, ctm);
    const t = top().rect;
    return isEmpty(t) || x1! < t.x0 - slack || x0! > t.x1 + slack || y1! < t.y0 - slack || y0! > t.y1 + slack;
  };

  const fontCache = new Map<number, FontStyle>();
  const styleOf = (font: MuPDF.Font): FontStyle => {
    const key = font.pointer as unknown as number;
    let s = fontCache.get(key);
    if (!s) {
      s = fontStyleFor(
        { name: font.getName(), bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono() },
        opts.fontSubstitutions,
      );
      fontCache.set(key, s);
    }
    return s;
  };
  const outlines = opts.textAsPaths ? new GlyphOutlines(mupdf) : null;

  const addText = (text: MuPDF.Text, ctm: Matrix, cs: MuPDF.ColorSpace, color: number[], alpha: number) => {
    if (suppress || missed(text, null, ctm, TEXT_SLACK)) return;
    const fill = colorToHex(cs, color);
    let run: Glyph[] = [];
    const flush = () => {
      if (run.length > 0) emitRun(run, fill, alpha);
      run = [];
    };
    text.walk({
      showGlyph(font, trm, gid, uni, wmode) {
        const m = concat(trm as Matrix, ctm);
        const g: Glyph = { font, m, gid, uni, adv: font.advanceGlyph(gid, wmode) };
        const box = glyphBox(g);
        // A glyph is kept whole if the centre of its box (glyphbox.ts) is inside the Clip, else
        // removed (ADR 0005, #35); the same rule as in the PDF.
        if (!recording && (!meets(box, top().rect) || !meets(box, area) || (!contains(area, box) && !centreInside(font, trm as Matrix, gid, wmode, ctm)))) {
          flush();
          return;
        }
        if (run.length > 0 && !continues(run[run.length - 1]!, g)) flush();
        run.push(g);
      },
      endSpan() {
        flush();
      },
    });
    flush();
  };

  const glyphBoxes = new GlyphBoxes(mupdf);
  const centreInside = (font: MuPDF.Font, trm: Matrix, gid: number, wmode: number, ctm: Matrix) => {
    const [x, y] = glyphBoxes.get(font, trm, gid, wmode, ctm).centre;
    return x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
  };

  /** Does glyph g directly follow glyph p on the same baseline? */
  const continues = (p: Glyph, g: Glyph): boolean => {
    if (p.font.pointer !== g.font.pointer) return false;
    const [a, b, c, d] = p.m;
    const s = Math.hypot(a, b);
    const tol = 1e-3 * s;
    if (Math.abs(a - g.m[0]) > tol || Math.abs(b - g.m[1]) > tol || Math.abs(c - g.m[2]) > tol || Math.abs(d - g.m[3]) > tol)
      return false;
    // expected origin of g, in p's text direction
    const ex = p.m[4] + p.adv * a;
    const ey = p.m[5] + p.adv * b;
    const dx = g.m[4] - ex;
    const dy = g.m[5] - ey;
    const along = (dx * a + dy * b) / s / s; // in em
    const across = (-dx * b + dy * a) / s / s;
    if (Math.abs(across) > 0.02) return false;
    if (Math.abs(along) <= 0.02) return true;
    // A gap of exactly one space width: keep in the same run, a space is inserted.
    const spaceAdv = spaceAdvance(g.font);
    if (Math.abs(along - spaceAdv) <= 0.02 && p.uni !== 32 && g.uni !== 32) {
      g.spaceBefore = true;
      return true;
    }
    return false;
  };

  const spaceCache = new Map<number, number>();
  const spaceAdvance = (font: MuPDF.Font): number => {
    const key = font.pointer as unknown as number;
    let v = spaceCache.get(key);
    if (v === undefined) {
      const gid = font.encodeCharacter(32);
      v = gid > 0 ? font.advanceGlyph(gid, 0) : 0.278;
      spaceCache.set(key, v);
    }
    return v;
  };

  const emitRun = (run: Glyph[], fill: string, alpha: number) => {
    if (outlines) {
      let bbox = emptyRect();
      for (const g of run) bbox = union(bbox, glyphBox(g));
      const clipId = clipFor(bbox);
      if (clipId === undefined) return;
      const d: PathData = [];
      for (const g of run) d.push(...outlines.get(g.font, g.gid, g.m));
      if (d.length > 0)
        sink.push({ kind: "path", d, fill, evenOdd: false, stroke: null, strokeStyle: null, alpha, bbox, clip: clipId });
      return;
    }
    for (const piece of splitAtWhitespace(run)) emitTextRun(piece, fill, alpha);
  };

  const emitTextRun = (run: Glyph[], fill: string, alpha: number) => {
    let bbox = emptyRect();
    for (const g of run) bbox = union(bbox, glyphBox(g));
    const clipId = clipFor(bbox);
    if (clipId === undefined) return;

    let str = "";
    for (const [i, g] of run.entries()) {
      if (i > 0 && g.spaceBefore) str += " ";
      const u = g.uni;
      str += u >= 32 && u !== 0xfffe && u !== 0xffff ? String.fromCodePoint(u) : "�";
    }
    if (str.trim() === "") return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const [a, b, c, d, e, f] = first.m;
    const size = Math.sqrt(Math.abs(a * d - b * c));
    const s = Math.hypot(a, b);
    const length = ((last.m[4] - e) * a + (last.m[5] - f) * b) / s + last.adv * s;
    const upright = Math.abs(b) < 1e-3 * s && Math.abs(c) < 1e-3 * s && a > 0 && d < 0 && Math.abs(a + d) < 1e-3 * s;
    sink.push({
      kind: "text",
      str,
      x: upright ? e : 0,
      y: upright ? f : 0,
      size,
      transform: upright ? null : [a / size, b / size, -c / size, -d / size, e, f],
      length,
      font: styleOf(first.font),
      fill,
      alpha,
      bbox,
      clip: clipId,
    });
  };

  const device: DeviceFunctions = {
    fillPath(path, evenOdd, ctm, cs, color, alpha) {
      if (suppress || missed(path, null, ctm as Matrix)) return;
      let { d, bbox } = walkPath(path, ctm as Matrix);
      if (isEmpty(bbox)) return;
      if (!recording) {
        // Pattern tiles repeat in pattern space: only the filled area is cut.
        const cut = clipFill(fromPathData(d), areaPlanes);
        if (cut && !cut.length) return;
        if (cut) {
          d = toPathData(cut);
          bbox = intersect(bbox, area);
        }
      }
      const clipId = clipFor(bbox);
      if (clipId === undefined) return;
      sink.push({ kind: "path", d, fill: colorToHex(cs, color), evenOdd, stroke: null, strokeStyle: null, alpha, bbox, clip: clipId });
    },
    strokePath(path, stroke, ctm, cs, color, alpha) {
      if (suppress || missed(path, stroke, ctm as Matrix)) return;
      const { d, bbox: raw } = walkPath(path, ctm as Matrix);
      if (isEmpty(raw)) return;
      const style = strokeStyleOf(stroke, ctm as Matrix);
      const bbox = expand(raw, style.width * 0.75);
      const clipId = clipFor(bbox);
      if (clipId === undefined) return;
      const color_ = colorToHex(cs, color);
      const paints = recording
        ? null
        : cutStroke(fromPathData(d), areaPlanes, {
            width: style.width,
            cap: CAP_NUMBER[style.cap],
            dashes: style.dashes,
            phase: style.dashPhase,
          });
      if (!paints) {
        sink.push({ kind: "path", d, fill: null, evenOdd: false, stroke: color_, strokeStyle: style, alpha, bbox, clip: clipId });
        return;
      }
      for (const p of paints) {
        if (!p.subs.length) continue;
        const s: StrokeStyle = { ...style };
        if (p.cap !== undefined) s.cap = CAPS[p.cap]!;
        if (p.dash === null) s.dashes = null;
        else if (p.dash) s.dashPhase = p.dash.phase;
        const pd = toPathData(p.subs);
        const pb = expand(walkData(pd), s.width * 0.75);
        sink.push({ kind: "path", d: pd, fill: null, evenOdd: false, stroke: color_, strokeStyle: s, alpha, bbox: pb, clip: clipId });
      }
    },
    clipPath(path, evenOdd, ctm) {
      const { d, bbox, rect } = walkPath(path, ctm as Matrix);
      if (rect) pushRectClip(rect);
      else pushPathClip(d, evenOdd, bbox);
    },
    clipStrokePath(path, stroke, ctm) {
      const { bbox } = walkPath(path, ctm as Matrix);
      warn("Beschneidung durch Linie (angenähert)");
      pushRectClip(expand(bbox, stroke.getLineWidth() * expansion(ctm as Matrix)));
    },
    clipText(text, ctm) {
      warn("Beschneidung durch Text (angenähert)");
      pushRectClip(textBounds(text, ctm as Matrix));
    },
    clipStrokeText(text, _stroke, ctm) {
      warn("Beschneidung durch Text (angenähert)");
      pushRectClip(textBounds(text, ctm as Matrix));
    },
    clipImageMask(_image, ctm) {
      warn("Bildmaske als Beschneidung (angenähert)");
      pushRectClip(transformRect(ctm as Matrix, { x0: 0, y0: 0, x1: 1, y1: 1 }));
    },
    popClip() {
      if (clipStack.length > 1) clipStack.pop();
    },
    fillText(text, ctm, cs, color, alpha) {
      addText(text, ctm as Matrix, cs, color, alpha);
    },
    strokeText(text, _stroke, ctm, cs, color, alpha) {
      warn("Konturtext (als gefüllter Text übernommen)");
      addText(text, ctm as Matrix, cs, color, alpha);
    },
    ignoreText() {
      // invisible text (e.g. OCR layer): not drawn
    },
    fillShade() {
      if (!suppress) warn("Farbverlauf");
    },
    fillImage(image, ctm, alpha) {
      if (suppress) return;
      const m = ctm as Matrix;
      const bbox = transformRect(m, { x0: 0, y0: 0, x1: 1, y1: 1 });
      const clipId = clipFor(bbox);
      if (clipId === undefined) return;
      // Only the visible pixels are embedded (ADR 0005). Pattern tiles are drawn in
      // pattern space and repeat, so their images are kept whole.
      const visible = recording ? { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity } : intersect(top().rect, area);
      const img = encodeVisibleImage(mupdf, image, m, visible, base64);
      if (!img) return;
      const shown = transformRect(img.matrix, { x0: 0, y0: 0, x1: 1, y1: 1 });
      sink.push({ kind: "image", href: img.href, matrix: img.matrix, alpha, bbox: shown, clip: clipId });
    },
    fillImageMask() {
      if (!suppress) warn("Bildmaske");
    },
    beginMask() {
      suppress++;
      warn("Weiche Maske (ignoriert)");
    },
    endMask() {
      suppress--;
      clipStack.push({ ...top() }); // balanced by the popClip that ends the mask
    },
    beginGroup(_bbox, _cs, _isolated, _knockout, blendmode, alpha) {
      if (alpha < 1 || blendmode !== "Normal") warn("Transparenzgruppe (vereinfacht)");
    },
    beginTile(areaIn, viewIn, xstep, ystep, ctm, id, docId) {
      // Nested patterns or patterns inside masks are not reproduced.
      if (suppress || recording) {
        suppress++;
        tileStack.push("skip");
        if (recording) warn("Verschachtelte Musterfüllung (ausgelassen)");
        return 1;
      }
      const m = ctm as Matrix;
      // MuPDF gives the area to fill in pattern space; ctm maps it to export units.
      const fillArea = intersect(intersect(transformRect(m, rectOf(areaIn)), top().rect), area);
      const clip = isEmpty(fillArea) ? undefined : clipFor(fillArea);
      if (clip === undefined) {
        suppress++;
        tileStack.push("skip");
        return 1;
      }
      // One SVG pattern per PDF pattern and matrix; same pattern with a new matrix
      // references the first one's content (href) instead of repeating it.
      const contentKey = id ? docId + ":" + id : null;
      const fullKey = contentKey ? contentKey + "|" + m.map((v) => Math.round(v * 1e4)).join(" ") : null;
      let pid = fullKey ? patternIds.get(fullKey) : undefined;
      let record = false;
      if (!pid) {
        const base = contentKey ? patternIds.get(contentKey) : undefined;
        pid = prefix + "p" + (patterns.length + 1);
        patterns.push({ id: pid, base: base ?? null, xstep, ystep, view: rectOf(viewIn), matrix: m, items: [] });
        if (fullKey) patternIds.set(fullKey, pid);
        if (contentKey && !base) patternIds.set(contentKey, pid);
        record = !base;
      }
      const { x0, y0, x1, y1 } = fillArea;
      sink.push({
        kind: "path",
        d: [Op.Move, x0, y0, Op.Line, x1, y0, Op.Line, x1, y1, Op.Line, x0, y1, Op.Close],
        fill: "url(#" + pid + ")",
        evenOdd: false,
        stroke: null,
        strokeStyle: null,
        alpha: 1,
        bbox: fillArea,
        clip,
      });
      if (!record) {
        suppress++;
        tileStack.push("skip");
        return 1;
      }
      recording++;
      tileStack.push("record");
      pageSink = sink;
      sink = patterns[patterns.length - 1]!.items;
      return 0;
    },
    endTile() {
      const kind = tileStack.pop();
      if (kind === "record") {
        recording--;
        sink = pageSink;
      } else if (kind === "skip") {
        suppress--;
      }
    },
  };

  return {
    device,
    pageToUnits,
    finish() {
      outlines?.destroy();
      return { items, clips, patterns, width, height, unsupported };
    },
  };
}

/** Runs the Plan's page through the collector for `opts`. */
export function collect(mupdf: typeof MuPDF, page: MuPDF.Page, opts: CollectOptions): Collected {
  const c = collector(mupdf, page, opts);
  const dev = new mupdf.Device(c.device);
  try {
    page.run(dev, c.pageToUnits);
    dev.close();
  } finally {
    dev.destroy();
  }
  return c.finish();
}

/** Where each device callback gets its transformation (argument index). */
const CTM_ARG: Partial<Record<keyof DeviceFunctions, number>> = {
  fillPath: 2,
  strokePath: 2,
  clipPath: 2,
  clipStrokePath: 2,
  fillText: 1,
  strokeText: 2,
  clipText: 1,
  clipStrokeText: 2,
  ignoreText: 1,
  fillShade: 1,
  fillImage: 1,
  fillImageMask: 1,
  clipImageMask: 1,
  beginTile: 4,
};

/**
 * Collects several Regions of a stitched Clip (ADR 0016) in one pass over the page:
 * parsing the page and handing every drawing call to JS is most of an export's time, so
 * each call is shared by all Regions, shifted to each Region's place in the Clip.
 */
export function collectAll(mupdf: typeof MuPDF, page: MuPDF.Page, all: CollectOptions[]): Collected[] {
  const cs = all.map((o) => collector(mupdf, page, o));
  if (cs.length === 0) return [];
  const [bx0, by0] = page.getBounds();
  const base: Matrix = [PT_TO_UNITS, 0, 0, PT_TO_UNITS, -bx0! * PT_TO_UNITS, -by0! * PT_TO_UNITS];
  const shift = cs.map((c): Matrix => [1, 0, 0, 1, c.pageToUnits[4] - base[4], c.pageToUnits[5] - base[5]]);
  const fan: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of Object.keys(cs[0]!.device) as (keyof DeviceFunctions)[]) {
    const at = CTM_ARG[name];
    fan[name] = (...args: unknown[]) => {
      let result = 1;
      cs.forEach((c, i) => {
        const a = [...args];
        if (at !== undefined) a[at] = concat(args[at] as Matrix, shift[i]!);
        const r = (c.device[name] as (...x: unknown[]) => unknown)(...a);
        // beginTile: 1 = skip the tile's content. Run it if any Region records it; the
        // others ignore it (they suppress until endTile).
        if (name === "beginTile" && r === 0) result = 0;
      });
      return name === "beginTile" ? result : undefined;
    };
  }
  const dev = new mupdf.Device(fan as DeviceFunctions);
  try {
    page.run(dev, base);
    dev.close();
  } finally {
    dev.destroy();
  }
  return cs.map((c) => c.finish());
}

const isWhitespace = (u: number) => u === 32 || u === 9 || u === 0xa0 || (u >= 0x2000 && u <= 0x200b) || u === 0x3000;

/**
 * SVG viewers drop whitespace at the start/end of a <text> and collapse runs of
 * spaces, which shifts the following letters (and, with textLength, stretches
 * them). So: trim whitespace at the edges, keep single inner spaces, and split
 * wherever more than one space would be needed.
 */
export function splitAtWhitespace<G extends { uni: number; spaceBefore?: boolean }>(run: G[]): G[][] {
  const pieces: G[][] = [];
  let cur: G[] = [];
  let pending: G[] = [];
  let spaces = 0;
  for (const g of run) {
    const before = g.spaceBefore ? 1 : 0;
    if (isWhitespace(g.uni)) {
      pending.push(g);
      spaces += 1 + before;
      continue;
    }
    spaces += before;
    if (cur.length > 0) {
      if (spaces >= 2) {
        pieces.push(cur);
        cur = [];
      } else {
        cur.push(...pending);
      }
    }
    pending = [];
    spaces = 0;
    cur.push(g);
  }
  if (cur.length > 0) pieces.push(cur);
  return pieces;
}

function rectOf(r: number[]): Rect {
  return { x0: r[0]!, y0: r[1]!, x1: r[2]!, y1: r[3]! };
}

/** Device-space bounds of a text object (approximate em boxes per glyph). */
function textBounds(text: MuPDF.Text, ctm: Matrix): Rect {
  let r = emptyRect();
  text.walk({
    showGlyph(font, trm, gid, _uni, wmode) {
      const m = concat(trm as Matrix, ctm);
      r = union(r, glyphBox({ font, m, gid, uni: 0, adv: font.advanceGlyph(gid, wmode) }));
    },
  });
  return r;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
