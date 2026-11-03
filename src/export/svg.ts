// Serialises merged groups as a compact SVG (ADR 0011). No CSS: shared styles
// are inherited attributes on <g>, which every SVG renderer understands.

import { invert, type Matrix } from "./geometry";
import { Op, UNITS_PER_MM, type ClipDef, type ImageItem, type PathData, type PathItem, type PatternDef, type TextItem } from "./ir";
import type { Group } from "./merge";
import { encodePath, PathEncoder } from "./pathdata";
import { compactStrokes } from "./strokes";

export interface SvgResult {
  svg: string;
  /** Number of SVG elements (start tags), a proxy for rendering cost in the whiteboard tool. */
  elements: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => String(Math.round(v));
/** Numbers that need sub-unit precision (matrix scale terms, opacity). */
const fine = (v: number) => String(Math.round(v * 1e5) / 1e5);
const matrix = (m: Matrix) => `matrix(${fine(m[0])} ${fine(m[1])} ${fine(m[2])} ${fine(m[3])} ${num(m[4])} ${num(m[5])})`;

export function toSvg(
  groups: Group[],
  clips: Map<string, ClipDef>,
  patterns: PatternDef[],
  width: number,
  height: number,
  options: { reuseShapes?: boolean } = {},
): SvgResult {
  const out: string[] = [];
  let elements = 0;
  const el = (s: string) => {
    elements++;
    out.push(s);
  };

  const alias = dedupePatterns(patterns);
  const shapes = options.reuseShapes ? findShapes(groups) : undefined;
  const patternById = new Map(patterns.map((p) => [p.id, p]));

  // Only clip regions and patterns that are actually referenced (plus what they depend on).
  const usedClips = new Set<string>();
  const usedPatterns = new Set<string>();
  const imageUses = new Map<string, number>();
  for (const g of groups)
    for (const it of g.items) {
      for (let c = it.clip; c && !usedClips.has(c); c = clips.get(c)?.parent ?? null) usedClips.add(c);
      if (it.kind === "path" && it.fill?.startsWith("url(#")) {
        const id = it.fill.slice(5, -1);
        const canonical = alias.get(id);
        if (canonical) it.fill = `url(#${canonical})`;
        let p = patternById.get(canonical ?? id);
        for (; p && !usedPatterns.has(p.id); p = p.base ? patternById.get(p.base) : undefined) usedPatterns.add(p.id);
      }
      if (it.kind === "image") imageUses.set(it.href, (imageUses.get(it.href) ?? 0) + 1);
    }
  // Images used more than once are stored once and placed with <use>.
  const sharedImages = new Map<string, string>();
  for (const [href, n] of imageUses) if (n > 1) sharedImages.set(href, `i${sharedImages.size + 1}`);
  const xlink = ' xmlns:xlink="http://www.w3.org/1999/xlink"';

  el(
    `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${width / UNITS_PER_MM}mm" height="${height / UNITS_PER_MM}mm" viewBox="0 0 ${width} ${height}">`,
  );

  if (usedClips.size > 0 || usedPatterns.size > 0 || sharedImages.size > 0 || (shapes?.ids.size ?? 0) > 0) {
    el("<defs>");
    // Map order is creation order, so parents come before children.
    for (const [id, c] of clips) {
      if (!usedClips.has(id)) continue;
      el(`<clipPath id="${id}"${c.parent ? ` clip-path="url(#${c.parent})"` : ""}>`);
      if (c.rect) {
        const r = c.rect;
        el(`<rect x="${num(r.x0)}" y="${num(r.y0)}" width="${num(r.x1 - r.x0)}" height="${num(r.y1 - r.y0)}"/>`);
      } else {
        el(`<path d="${encodePath(c.d!)}"${c.evenOdd ? ' clip-rule="evenodd"' : ""}/>`);
      }
      out.push("</clipPath>");
    }
    for (const p of patterns) if (usedPatterns.has(p.id)) writePattern(p, el, out);
    for (const [form, id] of shapes?.ids ?? []) el(`<path id="${id}" d="${form}"/>`);
    for (const [href, id] of sharedImages)
      el(`<image id="${id}" width="1" height="1" preserveAspectRatio="none" xlink:href="${href}"/>`);
    out.push("</defs>");
  }

  // White background exactly the size of the Clip, at the very back (ADR 0009).
  el(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  for (const g of groups) {
    const first = g.items[0]!;
    const clipAttr = first.clip ? ` clip-path="url(#${first.clip})"` : "";
    if (first.kind === "path") writePath(g.items as PathItem[], clipAttr, el, out, shapes);
    else if (first.kind === "text") writeText(g.items as TextItem[], clipAttr, el, out);
    else writeImage(first as ImageItem, clipAttr, el, sharedImages.get((first as ImageItem).href));
  }
  out.push("</svg>");
  return { svg: out.join("\n"), elements };
}

/**
 * The schedule contains a separate PDF pattern for every hatched area, mostly with the same
 * tile but its own origin. Compares tile content in pattern space (independent
 * of the matrix): repeated content becomes a reference (base) to the first
 * pattern, and patterns that end up identical including the matrix are merged.
 * Returns pattern id -> id to use instead. Mutates the pattern list.
 */
export function dedupePatterns(patterns: PatternDef[]): Map<string, string> {
  const byId = new Map(patterns.map((p) => [p.id, p]));
  const firstWithContent = new Map<string, string>();
  for (const p of patterns) {
    if (p.base) continue;
    const sig = patternSignature(p);
    if (sig === null) continue;
    const first = firstWithContent.get(sig);
    if (first) {
      p.base = first;
      p.items = [];
    } else {
      firstWithContent.set(sig, p.id);
    }
  }
  // Point every reference at a pattern that holds the content (no chains).
  const root = (id: string): string => {
    const p = byId.get(id)!;
    return p.base ? root(p.base) : p.id;
  };
  for (const p of patterns) if (p.base) p.base = root(p.base);
  // Same content and same matrix: one pattern is enough.
  const alias = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const p of patterns) {
    const key = `${p.base ?? p.id}|${p.matrix.map((v) => Math.round(v * 1e5)).join(" ")}`;
    const first = byKey.get(key);
    if (first) alias.set(p.id, first);
    else byKey.set(key, p.id);
  }
  return alias;
}

/** Tile content in pattern space as a string, or null if it cannot be compared. */
function patternSignature(p: PatternDef): string | null {
  const inv = invert(p.matrix);
  const parts = [p.view.x0, p.view.y0, p.view.x1, p.view.y1, p.xstep, p.ystep].map((v) => Math.round(v * 1000)).join(" ");
  const items: string[] = [];
  for (const it of p.items) {
    if (it.kind !== "path") return null;
    const d: number[] = [];
    for (let i = 0; i < it.d.length; ) {
      const op = it.d[i++]!;
      d.push(op);
      const n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : 0;
      for (let k = 0; k < n; k += 2) {
        const x = it.d[i++]!;
        const y = it.d[i++]!;
        d.push(Math.round((x * inv[0] + y * inv[2] + inv[4]) * 1000), Math.round((x * inv[1] + y * inv[3] + inv[5]) * 1000));
      }
    }
    const s = it.strokeStyle;
    const scale = Math.sqrt(Math.abs(inv[0] * inv[3] - inv[1] * inv[2]));
    items.push(
      [it.fill, it.evenOdd, it.stroke, it.alpha, s && Math.round(s.width * scale * 1000), s?.cap, s?.join, s?.dashes?.join(","), d.join(",")].join("|"),
    );
  }
  return `${parts}#${items.join(";")}`;
}

/**
 * A PDF tiling pattern as an SVG <pattern> in pattern space. The tile content
 * was recorded in export units, so it is mapped back with the inverse matrix.
 * Patterns that reuse another's content only set their own matrix.
 */
function writePattern(p: PatternDef, el: (s: string) => void, out: string[]): void {
  const transform = `patternTransform="matrix(${p.matrix.map(fine).join(" ")})"`;
  if (p.base) {
    el(`<pattern id="${p.id}" xlink:href="#${p.base}" ${transform}/>`);
    return;
  }
  el(
    `<pattern id="${p.id}" patternUnits="userSpaceOnUse" x="${fine(p.view.x0)}" y="${fine(p.view.y0)}" ` +
      `width="${fine(Math.abs(p.xstep))}" height="${fine(Math.abs(p.ystep))}" ${transform}>`,
  );
  el(`<g transform="matrix(${invert(p.matrix).map(fine).join(" ")})">`);
  for (const it of p.items) {
    if (it.kind === "path") writePath([it], "", el);
    else if (it.kind === "text") writeText([it], "", el, out);
    else writeImage(it, "", el);
  }
  out.push("</g>", "</pattern>");
}

/** Repeated shapes stored once (`<defs>`), by translation-independent form. */
interface Shapes {
  /** form (path data starting at 0,0) -> id */
  ids: Map<string, string>;
  /** item -> its form and position */
  of: Map<PathItem, { form: string; dx: number; dy: number }>;
}

/** Only shapes at least this long (characters of path data) are worth a <use>. */
const MIN_SHAPE_LENGTH = 60;

/** The item's path moved so it starts at (0, 0), encoded; null for empty paths. */
function shapeForm(d: PathData): { form: string; dx: number; dy: number } | null {
  if (d[0] !== Op.Move) return null;
  const dx = Math.round(d[1]!);
  const dy = Math.round(d[2]!);
  const moved: PathData = [];
  for (let i = 0; i < d.length; ) {
    const op = d[i++]!;
    moved.push(op);
    const n = op === Op.Move || op === Op.Line ? 2 : op === Op.Curve ? 6 : 0;
    for (let k = 0; k < n; k += 2) moved.push(Math.round(d[i++]!) - dx, Math.round(d[i++]!) - dy);
  }
  return { form: encodePath(moved), dx, dy };
}

function findShapes(groups: Group[]): Shapes {
  const of = new Map<PathItem, { form: string; dx: number; dy: number }>();
  const counts = new Map<string, number>();
  for (const g of groups)
    for (const it of g.items) {
      if (it.kind !== "path" || it.fill?.startsWith("url(")) continue;
      const f = shapeForm(it.d);
      if (!f || f.form.length < MIN_SHAPE_LENGTH) continue;
      of.set(it, f);
      counts.set(f.form, (counts.get(f.form) ?? 0) + 1);
    }
  const ids = new Map<string, string>();
  for (const [form, n] of counts) if (n > 1) ids.set(form, `s${ids.size + 1}`);
  return { ids, of };
}

function paintAttrs(p: PathItem): string {
  let attrs = "";
  if (p.fill) {
    attrs += ` fill="${p.fill}"`;
    if (p.evenOdd) attrs += ` fill-rule="evenodd"`;
    if (p.alpha !== 1) attrs += ` fill-opacity="${fine(p.alpha)}"`;
  } else {
    attrs += ` fill="none"`;
  }
  const s = p.strokeStyle;
  if (p.stroke && s) {
    attrs += ` stroke="${p.stroke}" stroke-width="${fine(Math.round(s.width * 10) / 10)}"`;
    if (s.cap !== "butt") attrs += ` stroke-linecap="${s.cap}"`;
    if (s.join !== "miter") attrs += ` stroke-linejoin="${s.join}"`;
    else if (s.miterLimit !== 4) attrs += ` stroke-miterlimit="${fine(Math.max(1, s.miterLimit))}"`;
    if (s.dashes) {
      attrs += ` stroke-dasharray="${s.dashes.map((v) => fine(Math.round(v * 10) / 10)).join(" ")}"`;
      if (s.dashPhase) attrs += ` stroke-dashoffset="${fine(Math.round(s.dashPhase * 10) / 10)}"`;
    }
    if (p.alpha !== 1) attrs += ` stroke-opacity="${fine(p.alpha)}"`;
  }
  return attrs;
}

function pathData(items: PathItem[]): string {
  const p = items[0]!;
  const enc = new PathEncoder();
  const s0 = p.strokeStyle;
  if (!p.fill && p.stroke && s0 && !s0.dashes && p.alpha === 1 && items.length > 1) {
    // Join touching collinear pieces of the same stroke (exact, see strokes.ts).
    enc.add(compactStrokes(items.map((it) => it.d), s0, (d) => encodePath(d).length));
  } else {
    for (const it of items) enc.add(it.d);
  }
  return enc.toString();
}

/**
 * One merged group as SVG. With shapes, items whose form repeats elsewhere become
 * <use> references inside a <g> that carries the paint attributes (inherited by
 * the referenced shape), next to one <path> for the rest of the group. All items
 * of a group are interchangeable in paint order, so the picture is unchanged.
 */
function writePath(items: PathItem[], clipAttr: string, el: (s: string) => void, out?: string[], shapes?: Shapes): void {
  const attrs = paintAttrs(items[0]!);
  const reused = shapes ? items.filter((it) => shapes.ids.has(shapes.of.get(it)?.form ?? "")) : [];
  if (reused.length === 0 || !shapes || !out) {
    el(`<path d="${pathData(items)}"${attrs}${clipAttr}/>`);
    return;
  }
  const reusedSet = new Set(reused);
  const rest = items.filter((it) => !reusedSet.has(it));
  el(`<g${attrs}${clipAttr}>`);
  if (rest.length > 0) el(`<path d="${pathData(rest)}"/>`);
  for (const it of reused) {
    const f = shapes.of.get(it)!;
    el(`<use xlink:href="#${shapes.ids.get(f.form)}" x="${f.dx}" y="${f.dy}"/>`);
  }
  out.push("</g>");
}

function writeText(items: TextItem[], clipAttr: string, el: (s: string) => void, out: string[]): void {
  const t = items[0]!;
  let attrs = ` font-family="${t.font.family}" font-size="${num(t.size)}" fill="${t.fill}"`;
  if (t.font.bold) attrs += ` font-weight="bold"`;
  if (t.font.italic) attrs += ` font-style="italic"`;
  if (t.alpha !== 1) attrs += ` fill-opacity="${fine(t.alpha)}"`;
  const single = items.length === 1;
  const open = `<g${attrs}${clipAttr}>`;
  if (!single) el(open);
  for (const it of items) {
    const pos = it.transform ? ` transform="${matrix(it.transform)}"` : ` x="${num(it.x)}" y="${num(it.y)}"`;
    // Metric-compatible fonts (e.g. Arial for Helvetica) need no width correction.
    const len =
      !it.font.metricCompatible && [...it.str].length > 1
        ? ` textLength="${num(it.length)}" lengthAdjust="spacingAndGlyphs"`
        : "";
    const inner = `${pos}${len}>${esc(it.str)}</text>`;
    el(single ? `<text${attrs}${clipAttr}${inner}` : `<text${inner}`);
  }
  if (!single) out.push("</g>");
}

/** xlink:href (not SVG 2 href) so older renderers and editors understand it. */
function writeImage(img: ImageItem, clipAttr: string, el: (s: string) => void, sharedId?: string): void {
  const op = img.alpha !== 1 ? ` opacity="${fine(img.alpha)}"` : "";
  const t = `transform="${matrixFine(img.matrix)}"`;
  if (sharedId) el(`<use xlink:href="#${sharedId}" ${t}${op}${clipAttr}/>`);
  else el(`<image width="1" height="1" preserveAspectRatio="none" ${t} xlink:href="${img.href}"${op}${clipAttr}/>`);
}

/** Image matrices map a unit square, so translation needs no rounding either. */
function matrixFine(m: Matrix): string {
  return `matrix(${m.map(fine).join(" ")})`;
}
