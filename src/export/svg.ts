// Serialises merged groups as a compact SVG (ADR 0011). No CSS: shared styles
// are inherited attributes on <g>, which every SVG renderer understands.

import { invert, type Matrix } from "./geometry";
import { UNITS_PER_MM, type ClipDef, type ImageItem, type PathItem, type PatternDef, type TextItem } from "./ir";
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
): SvgResult {
  const out: string[] = [];
  let elements = 0;
  const el = (s: string) => {
    elements++;
    out.push(s);
  };

  // Only clip regions and patterns that are actually referenced (plus what they depend on).
  const usedClips = new Set<string>();
  const usedPatterns = new Set<string>();
  const patternById = new Map(patterns.map((p) => [p.id, p]));
  for (const g of groups)
    for (const it of g.items) {
      for (let c = it.clip; c && !usedClips.has(c); c = clips.get(c)?.parent ?? null) usedClips.add(c);
      if (it.kind === "path" && it.fill?.startsWith("url(#")) {
        let p = patternById.get(it.fill.slice(5, -1));
        for (; p && !usedPatterns.has(p.id); p = p.base ? patternById.get(p.base) : undefined) usedPatterns.add(p.id);
      }
    }
  const xlink = [...usedPatterns].some((id) => patternById.get(id)?.base) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : "";

  el(
    `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${width / UNITS_PER_MM}mm" height="${height / UNITS_PER_MM}mm" viewBox="0 0 ${width} ${height}">`,
  );

  if (usedClips.size > 0 || usedPatterns.size > 0) {
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
    out.push("</defs>");
  }

  // White background exactly the size of the Clip, at the very back (ADR 0009).
  el(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  for (const g of groups) {
    const first = g.items[0]!;
    const clipAttr = first.clip ? ` clip-path="url(#${first.clip})"` : "";
    if (first.kind === "path") writePath(g.items as PathItem[], clipAttr, el);
    else if (first.kind === "text") writeText(g.items as TextItem[], clipAttr, el, out);
    else writeImage(first as ImageItem, clipAttr, el);
  }
  out.push("</svg>");
  return { svg: out.join("\n"), elements };
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

function writePath(items: PathItem[], clipAttr: string, el: (s: string) => void): void {
  const p = items[0]!;
  const enc = new PathEncoder();
  const s0 = p.strokeStyle;
  if (!p.fill && p.stroke && s0 && !s0.dashes && p.alpha === 1 && items.length > 1) {
    // Join touching collinear pieces of the same stroke (exact, see strokes.ts).
    enc.add(compactStrokes(items.map((it) => it.d), s0, (d) => encodePath(d).length));
  } else {
    for (const it of items) enc.add(it.d);
  }
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
  el(`<path d="${enc.toString()}"${attrs}${clipAttr}/>`);
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

function writeImage(img: ImageItem, clipAttr: string, el: (s: string) => void): void {
  const op = img.alpha !== 1 ? ` opacity="${fine(img.alpha)}"` : "";
  el(
    `<image width="1" height="1" preserveAspectRatio="none" transform="${matrixFine(img.matrix)}" href="${img.href}"${op}${clipAttr}/>`,
  );
}

/** Image matrices map a unit square, so translation needs no rounding either. */
function matrixFine(m: Matrix): string {
  return `matrix(${m.map(fine).join(" ")})`;
}
