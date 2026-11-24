// Cuts paths at the Clip in the PDF export (ADR 0005, #35). MuPDF's redaction keeps
// line art that crosses the edge whole; this pass runs over the redacted page content
// and its Form XObjects and replaces every path that reaches outside the Clip with
// its cut geometry (src/export/pathcut.ts), in the path's own user space. Everything
// else is copied byte for byte.
//
// After redaction every Form XObject is a fresh copy for its one place of use, so a
// form is rewritten in place; a form drawn again anyway gets its own copy.
// Patterns, soft masks and Type 3 glyphs are not followed: they draw in their own
// spaces, and only show through paths that are cut here.

import type * as MuPDF from "mupdf";
import { pdfNumber as f, tokenize } from "./contentstream";
import { apply, concat, IDENTITY, invert, type Matrix, type Rect } from "./geometry";
import { clipFill, cutStroke, isInside, rectHalfPlanes, type LineCap, type Pt, type StrokePaint, type SubPath } from "./pathcut";

const MAX_DEPTH = 16;
const CONSTRUCT = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

export interface PathCutStats {
  /** Paths that reached outside and were cut (or removed). */
  cut: number;
  /** Content streams that could not be read and were left as they were. */
  failed: number;
}

interface GState {
  ctm: Matrix;
  lw: number;
  cap: LineCap;
  ml: number;
  dash: { arr: number[]; phase: number } | null;
  /** Stroke and fill alpha, blend mode Normal, no soft mask. */
  CA: number;
  ca: number;
  blend: boolean;
}

const nameOf = (token: string) => token.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const pdfName = (name: string) => "/" + name.replace(/[^A-Za-z0-9_.\-]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
const keyOf = (o: MuPDF.PDFObject) => (o.isIndirect() ? o.asIndirect() : undefined);

function num(s: string | undefined): number {
  const v = Number(s);
  if (s === undefined || !Number.isFinite(v)) throw new Error(`bad number "${s}"`);
  return v;
}

function numbers(arr: MuPDF.PDFObject): number[] {
  return Array.from({ length: arr.length }, (_, i) => arr.get(i).asNumber());
}

function readContents(contents: MuPDF.PDFObject): Uint8Array {
  const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
  const parts = streams.filter((s) => s.isStream()).map((s) => s.readStream().asUint8Array());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    out[o + p.length] = 10;
    o += p.length + 1;
  }
  return out;
}

function pathText(subs: SubPath[]): string {
  let t = "";
  const pt = (p: Pt) => `${f(p[0])} ${f(p[1])}`;
  for (const s of subs) {
    t += `${pt(s.start)} m\n`;
    for (const g of s.segs) t += g.length === 2 ? `${pt(g[1]!)} l\n` : `${pt(g[1]!)} ${pt(g[2]!)} ${pt(g[3]!)} c\n`;
    if (s.closed) t += "h\n";
  }
  return t;
}

function boundsOf(subs: SubPath[]): Rect {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of subs)
    for (const p of [s.start, ...s.segs.flat()]) {
      r.x0 = Math.min(r.x0, p[0]);
      r.y0 = Math.min(r.y0, p[1]);
      r.x1 = Math.max(r.x1, p[0]);
      r.y1 = Math.max(r.y1, p[1]);
    }
  return r;
}

/**
 * Cuts the paths on `page` at `clip` (MuPDF page space). Call after redaction.
 */
export function cutPagePaths(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, clip: Rect): PathCutStats {
  const stats: PathCutStats = { cut: 0, failed: 0 };
  const done = new Set<number>();
  const originals = new Map<number, Uint8Array>();
  let names = 0;

  const freshName = (dict: MuPDF.PDFObject, prefix: string) => {
    let name: string;
    do name = `${prefix}${++names}`;
    while (!dict.get(name).isNull());
    return name;
  };

  /** Resource sub-dictionary `kind` of `res`, created if missing. */
  const subDict = (res: MuPDF.PDFObject, kind: string) => {
    let d = res.get(kind);
    if (!d.isDictionary()) {
      d = doc.newDictionary();
      res.put(kind, d);
    }
    return d;
  };

  /** Returns the rewritten stream, or null if nothing changed. */
  const rewrite = (buf: Uint8Array, res: MuPDF.PDFObject, base: Matrix, gs0: GState, depth: number, open: Set<number>): Uint8Array | null => {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    let last = 0;
    let changed = false;
    const replace = (start: number, end: number, text: string) => {
      parts.push(buf.subarray(last, start), enc.encode(text));
      last = end;
      changed = true;
    };

    let g: GState = { ...gs0 };
    const stack: GState[] = [];
    let subs: SubPath[] = [];
    let cur: SubPath | null = null;
    let lastStart: Pt = [0, 0];
    let pathStart = -1;
    let clipOp: string | null = null;
    const cp = (): Pt => (cur ? (cur.segs.length ? cur.segs[cur.segs.length - 1]!.at(-1)! : cur.start) : lastStart);
    const open_ = (): SubPath => {
      if (!cur) {
        cur = { start: lastStart, segs: [], closed: false };
        subs.push(cur);
      }
      return cur;
    };
    const xobjects = res.get("XObject");
    const extg = res.get("ExtGState");

    for (const t of tokenize(buf)) {
      const o = t.operands;
      if (CONSTRUCT.has(t.op)) {
        if (pathStart < 0) pathStart = t.start;
        if (t.op === "m") {
          lastStart = [num(o[0]), num(o[1])];
          cur = { start: lastStart, segs: [], closed: false };
          subs.push(cur);
        } else if (t.op === "l") {
          const p0 = cp();
          open_().segs.push([p0, [num(o[0]), num(o[1])]]);
        } else if (t.op === "c") {
          const p0 = cp();
          open_().segs.push([p0, [num(o[0]), num(o[1])], [num(o[2]), num(o[3])], [num(o[4]), num(o[5])]]);
        } else if (t.op === "v") {
          const p0 = cp();
          open_().segs.push([p0, p0, [num(o[0]), num(o[1])], [num(o[2]), num(o[3])]]);
        } else if (t.op === "y") {
          const p0 = cp();
          const e: Pt = [num(o[2]), num(o[3])];
          open_().segs.push([p0, [num(o[0]), num(o[1])], e, e]);
        } else if (t.op === "h") {
          if (cur) cur.closed = true;
          cur = null;
        } else {
          const [x, y, w, h] = [num(o[0]), num(o[1]), num(o[2]), num(o[3])];
          const p: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
          subs.push({ start: p[0]!, segs: [[p[0]!, p[1]!], [p[1]!, p[2]!], [p[2]!, p[3]!]], closed: true });
          lastStart = p[0]!;
          cur = null;
        }
        continue;
      }
      if (t.op === "W" || t.op === "W*") {
        clipOp = t.op;
        continue;
      }
      if (PAINT.has(t.op)) {
        if (pathStart >= 0) {
          const out = paintPath(t.op, subs, clipOp, g, concat(g.ctm, base), res);
          if (out !== null) replace(pathStart, t.end, "\n" + out);
        }
        subs = [];
        cur = null;
        pathStart = -1;
        clipOp = null;
        continue;
      }
      switch (t.op) {
        case "q":
          stack.push(g);
          g = { ...g };
          break;
        case "Q":
          g = stack.pop() ?? g;
          break;
        case "cm":
          g.ctm = concat(o.slice(-6).map(num) as Matrix, g.ctm);
          break;
        case "w":
          g.lw = num(o[0]);
          break;
        case "J":
          g.cap = Math.min(2, Math.max(0, Math.round(num(o[0])))) as LineCap;
          break;
        case "M":
          g.ml = num(o[0]);
          break;
        case "d": {
          const arr = (o[0] ?? "").replace(/[[\]]/g, " ").trim().split(/\s+/).filter(Boolean).map(num);
          g.dash = arr.length ? { arr, phase: num(o[1]) } : null;
          break;
        }
        case "gs": {
          if (!extg.isDictionary() || !o.length) break;
          const e = extg.get(nameOf(o[o.length - 1]!)).resolve();
          if (!e.isDictionary()) break;
          const lw = e.get("LW");
          if (lw.isNumber()) g.lw = lw.asNumber();
          const lc = e.get("LC");
          if (lc.isNumber()) g.cap = Math.min(2, Math.max(0, Math.round(lc.asNumber()))) as LineCap;
          const ml = e.get("ML");
          if (ml.isNumber()) g.ml = ml.asNumber();
          const d = e.get("D");
          if (d.isArray() && d.length === 2) {
            const arr = numbers(d.get(0));
            g.dash = arr.length ? { arr, phase: d.get(1).asNumber() } : null;
          }
          const CA = e.get("CA");
          if (CA.isNumber()) g.CA = CA.asNumber();
          const ca = e.get("ca");
          if (ca.isNumber()) g.ca = ca.asNumber();
          const bm = e.get("BM");
          if (!bm.isNull()) {
            const first = bm.isArray() ? bm.get(0) : bm;
            g.blend = first.isName() && first.asName() !== "Normal" && first.asName() !== "Compatible";
          }
          const sm = e.get("SMask");
          if (!sm.isNull()) g.blend ||= !(sm.isName() && sm.asName() === "None");
          break;
        }
        case "Do": {
          if (!xobjects.isDictionary() || !o.length) break;
          const name = nameOf(o[o.length - 1]!);
          let ref = xobjects.get(name);
          // isStream() is only true on the reference, not on the resolved dictionary.
          if (!ref.isStream() || depth >= MAX_DEPTH) break;
          const form = ref.resolve();
          if (form.get("Subtype").asName() !== "Form") break;
          const k = keyOf(ref);
          if (k !== undefined && open.has(k)) break;
          const fm = form.get("Matrix");
          const mat = fm.isArray() && fm.length === 6 ? (numbers(fm) as Matrix) : IDENTITY;
          let bytes = k !== undefined ? originals.get(k) : undefined;
          if (!bytes) bytes = ref.readStream().asUint8Array().slice();
          if (k !== undefined && done.has(k)) {
            // Drawn a second time: cut a copy for this place.
            const copy = doc.newDictionary();
            form.forEach((v, key) => {
              if (key !== "Length" && key !== "Filter" && key !== "DecodeParms") copy.put(key as string, v);
            });
            ref = doc.addStream(bytes, copy);
            const fresh = freshName(xobjects, name + "_");
            xobjects.put(fresh, ref);
            replace(t.start, t.end, `${pdfName(fresh)} Do`);
          }
          const fres = form.get("Resources");
          const k2 = keyOf(ref);
          if (k2 !== undefined) {
            done.add(k2);
            originals.set(k2, bytes);
            open.add(k2);
          }
          try {
            const out = rewrite(bytes, fres.isDictionary() ? fres : res, base, { ...g, ctm: concat(mat, g.ctm) }, depth + 1, open);
            if (out) ref.writeStream(out);
          } catch {
            stats.failed++;
          } finally {
            if (k2 !== undefined) open.delete(k2);
          }
          break;
        }
      }
    }
    if (!changed) return null;
    parts.push(buf.subarray(last));
    const res_ = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      res_.set(p, off);
      off += p.length;
    }
    return res_;
  };

  /** Replacement for one painted path, or null to keep it. */
  const paintPath = (op: string, subs: SubPath[], clipOp: string | null, g: GState, m: Matrix, res: MuPDF.PDFObject): string | null => {
    const hs = rectHalfPlanes(clip, m);
    if (isInside(subs, hs)) return null;
    stats.cut++;
    if ((op === "s" || op === "b" || op === "b*") && subs.length) subs[subs.length - 1]!.closed = true;
    const fill = op !== "S" && op !== "s" && op !== "n";
    const stroke = op === "S" || op === "s" || op[0] === "B" || op[0] === "b";
    const evenOdd = op.endsWith("*");

    const pieces: string[] = [];
    let drawn: SubPath[] = [];
    if (fill) {
      const area = clipFill(subs, hs) ?? subs;
      if (area.length) {
        pieces.push(pathText(area) + (evenOdd ? "f*\n" : "f\n"));
        drawn = drawn.concat(area);
      }
    }
    let strokes: StrokePaint[] = [];
    if (stroke) {
      strokes = cutStroke(subs, hs, { width: g.lw, cap: g.cap, dashes: g.dash?.arr ?? null, phase: g.dash?.phase ?? 0 }) ?? [{ subs }];
      for (const p of strokes) {
        if (!p.subs.length) continue;
        let set = "";
        if (p.cap !== undefined && p.cap !== g.cap) set += `${p.cap} J `;
        if (p.dash === null && g.dash) set += "[] 0 d ";
        else if (p.dash && g.dash) set += `[${g.dash.arr.map(f).join(" ")}] ${f(p.dash.phase)} d `;
        pieces.push(set ? `q ${set}\n${pathText(p.subs)}S Q\n` : `${pathText(p.subs)}S\n`);
        drawn = drawn.concat(p.subs);
      }
    }

    let out = pieces.join("");
    // Several overlapping paints instead of one: under transparency the overlaps
    // would show. Paint them opaque inside a transparency group, which gets the
    // alpha, blend mode and soft mask as a whole.
    const transparent = g.blend || (fill && g.ca < 1) || (stroke && g.CA < 1);
    if (transparent && pieces.length > 1 && !(fill && stroke && g.ca !== g.CA)) {
      const b = boundsOf(drawn);
      const pad = (g.lw / 2) * Math.max(g.ml, 2) + 1;
      const groupForm = doc.addStream(enc(out), {
        Type: "XObject",
        Subtype: "Form",
        BBox: [b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad].map((v) => Number(f(v))),
        Group: { S: "Transparency" },
      });
      const xo = subDict(res, "XObject");
      const name = freshName(xo, "Gcut");
      xo.put(name, groupForm);
      let alpha = "";
      if (!fill && g.CA !== g.ca) {
        // A form is painted with the fill alpha; a stroke had the stroke alpha.
        const eg = subDict(res, "ExtGState");
        const gname = freshName(eg, "GScut");
        eg.put(gname, doc.addObject({ ca: g.CA }));
        alpha = `/${gname} gs `;
      }
      out = `q ${alpha}/${name} Do Q\n`;
    }
    if (clipOp) {
      const area = clipFill(subs, hs) ?? subs;
      // Nothing inside: an empty clip, placed on a corner of the Clip (no coordinates outside).
      const [ex, ey] = apply(invert(m), clip.x0, clip.y0);
      out += area.length ? `${pathText(area)}${clipOp} n\n` : `${f(ex)} ${f(ey)} 0 0 re ${clipOp} n\n`;
    }
    return out;
  };

  const obj = page.getObject();
  let res = obj.getInheritable("Resources");
  if (!res.isDictionary()) {
    res = doc.newDictionary();
    obj.put("Resources", res);
  }
  const base = page.getTransform() as Matrix;
  const gs0: GState = { ctm: IDENTITY, lw: 1, cap: 0, ml: 10, dash: null, CA: 1, ca: 1, blend: false };
  try {
    const out = rewrite(readContents(obj.get("Contents")), res, base, gs0, 0, new Set());
    if (out) obj.put("Contents", doc.addStream(out, doc.newDictionary()));
  } catch {
    stats.failed++;
  }
  return stats;
}

const enc = (s: string) => new TextEncoder().encode(s);
