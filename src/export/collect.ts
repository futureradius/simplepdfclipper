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
import { Op, UNITS_PER_MM, type Collected, type FontStyle, type Item, type PathData, type StrokeStyle } from "./ir";

export interface ClipMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CollectOptions {
  clip: ClipMm;
  textAsPaths: boolean;
  /** Original font family -> installed substitute (font dialog). */
  fontSubstitutions?: Record<string, string>;
}

const PT_TO_UNITS = (25.4 / 72) * UNITS_PER_MM;
/** PDF line width 0 means "thinnest visible line"; SVG would hide it. */
const HAIRLINE = 0.05 * UNITS_PER_MM;
const CAPS = ["butt", "round", "square", "round"] as const; // Triangle -> round
const JOINS = ["miter", "round", "bevel", "miter"] as const; // MiterXPS -> miter

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
}

function glyphBox(g: Glyph): Rect {
  return transformRect(g.m, { x0: 0, y0: -0.25, x1: Math.max(g.adv, 0.3), y1: 0.85 });
}

export function collect(mupdf: typeof MuPDF, page: MuPDF.Page, opts: CollectOptions): Collected {
  const [bx0, by0] = page.getBounds();
  const { clip } = opts;
  const width = Math.round(clip.width * UNITS_PER_MM);
  const height = Math.round(clip.height * UNITS_PER_MM);
  const area: Rect = { x0: 0, y0: 0, x1: width, y1: height };
  const pageToUnits: Matrix = [
    PT_TO_UNITS,
    0,
    0,
    PT_TO_UNITS,
    -(bx0 * PT_TO_UNITS) - clip.x * UNITS_PER_MM,
    -(by0 * PT_TO_UNITS) - clip.y * UNITS_PER_MM,
  ];

  const items: Item[] = [];
  const clips = new Map<string, Rect>();
  const unsupported: Record<string, number> = {};
  const warn = (what: string) => (unsupported[what] = (unsupported[what] ?? 0) + 1);

  // Clip stack: each entry is the effective visible rect (already intersected).
  const clipStack: { rect: Rect; id: string | null }[] = [{ rect: area, id: null }];
  const top = () => clipStack[clipStack.length - 1]!;
  let suppress = 0; // inside mask definitions / tiling patterns: draw nothing

  const pushClip = (r: Rect) => {
    const rect = intersect(top().rect, r);
    let id: string | null = null;
    if (!contains(rect, area)) {
      const key = [rect.x0, rect.y0, rect.x1, rect.y1].map(Math.round).join(",");
      id = `c${key}`;
      if (!clips.has(id)) clips.set(id, rect);
    }
    clipStack.push({ rect, id });
  };

  /** Clip id an item with this bbox needs, or undefined if it is invisible. */
  const clipFor = (bbox: Rect): string | null | undefined => {
    const t = top();
    if (isEmpty(t.rect) || !meets(bbox, t.rect)) return undefined;
    const visiblePart = intersect(bbox, area);
    return contains(t.rect, visiblePart) ? null : t.id;
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
    if (suppress) return;
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
        if (!meets(box, top().rect) || !meets(box, area)) {
          flush(); // glyph outside the Clip: removed (ADR 0005)
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
      (g as Glyph & { spaceBefore?: boolean }).spaceBefore = true;
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
    let bbox = emptyRect();
    for (const g of run) bbox = union(bbox, glyphBox(g));
    const clipId = clipFor(bbox);
    if (clipId === undefined) return;

    if (outlines) {
      const d: PathData = [];
      for (const g of run) d.push(...outlines.get(g.font, g.gid, g.m));
      if (d.length > 0)
        items.push({ kind: "path", d, fill, evenOdd: false, stroke: null, strokeStyle: null, alpha, bbox, clip: clipId });
      return;
    }

    let str = "";
    for (const g of run) {
      if ((g as Glyph & { spaceBefore?: boolean }).spaceBefore) str += " ";
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
    items.push({
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

  const dev = new mupdf.Device({
    fillPath(path, evenOdd, ctm, cs, color, alpha) {
      if (suppress) return;
      const { d, bbox } = walkPath(path, ctm as Matrix);
      if (isEmpty(bbox)) return;
      const clipId = clipFor(bbox);
      if (clipId === undefined) return;
      items.push({ kind: "path", d, fill: colorToHex(cs, color), evenOdd, stroke: null, strokeStyle: null, alpha, bbox, clip: clipId });
    },
    strokePath(path, stroke, ctm, cs, color, alpha) {
      if (suppress) return;
      const { d, bbox: raw } = walkPath(path, ctm as Matrix);
      if (isEmpty(raw)) return;
      const style = strokeStyleOf(stroke, ctm as Matrix);
      const bbox = expand(raw, style.width * 0.75);
      const clipId = clipFor(bbox);
      if (clipId === undefined) return;
      items.push({ kind: "path", d, fill: null, evenOdd: false, stroke: colorToHex(cs, color), strokeStyle: style, alpha, bbox, clip: clipId });
    },
    clipPath(path, _evenOdd, ctm) {
      const { bbox, rect } = walkPath(path, ctm as Matrix);
      if (!rect) warn("Nicht-rechteckige Beschneidung (angenähert)");
      pushClip(rect ?? bbox);
    },
    clipStrokePath(path, stroke, ctm) {
      const { bbox } = walkPath(path, ctm as Matrix);
      warn("Beschneidung durch Linie (angenähert)");
      pushClip(expand(bbox, stroke.getLineWidth() * expansion(ctm as Matrix)));
    },
    clipText(text, ctm) {
      warn("Beschneidung durch Text (angenähert)");
      pushClip(textBounds(text, ctm as Matrix));
    },
    clipStrokeText(text, _stroke, ctm) {
      warn("Beschneidung durch Text (angenähert)");
      pushClip(textBounds(text, ctm as Matrix));
    },
    clipImageMask(_image, ctm) {
      warn("Bildmaske als Beschneidung (angenähert)");
      pushClip(transformRect(ctm as Matrix, { x0: 0, y0: 0, x1: 1, y1: 1 }));
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
      const pix = image.toPixmap();
      const png = pix.asPNG();
      pix.destroy();
      items.push({ kind: "image", href: `data:image/png;base64,${base64(png)}`, matrix: m, alpha, bbox, clip: clipId });
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
    beginTile() {
      suppress++;
      warn("Musterfüllung (ausgelassen)");
      return 0;
    },
    endTile() {
      suppress--;
    },
  });

  try {
    page.run(dev, pageToUnits);
    dev.close();
  } finally {
    dev.destroy();
    outlines?.destroy();
  }
  return { items, clips, width, height, unsupported };
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
