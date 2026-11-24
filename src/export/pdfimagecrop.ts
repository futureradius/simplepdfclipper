// Raster images in the PDF export (ADR 0005, #22): after redaction, an image that is
// only partly visible still has its full pixel size (the pixels outside are white).
// Each such image XObject is replaced by a Form XObject with BBox [0 0 1 1] that draws
// only the visible pixels (+ 1 px border) in their sub-rectangle of the unit square.
// The content streams stay untouched: only the resource entries are swapped.

import type * as MuPDF from "mupdf";
import { tokenize } from "./contentstream";
import { concat, IDENTITY, type Matrix, type Rect } from "./geometry";
import { cropPixmap, visiblePixels, type PixelWindow } from "./imagecrop";

/** PDF image space has row 0 at the top (v = 1); `visiblePixels` wants it at v = 0. */
const FLIP: Matrix = [1, 0, 0, -1, 0, 1];
const MAX_DEPTH = 16;
const JPEG_QUALITY = 90;

interface Use {
  dict: MuPDF.PDFObject;
  name: string;
}

interface Found {
  ref: MuPDF.PDFObject;
  w: number;
  h: number;
  uses: Use[];
  /** Union of the visible windows; undefined while no use is visible. */
  win?: PixelWindow;
  /** Also drawn somewhere we don't follow (pattern, soft mask, Type 3 glyph): keep whole. */
  keep: boolean;
}

/** "/Im#200" → "Im 0" */
function nameOf(token: string): string {
  return token.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
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

const keyOf = (o: MuPDF.PDFObject) => (o.isIndirect() ? o.asIndirect() : undefined);

const ALL_KINDS = ["XObject", "Pattern", "Font", "ExtGState"];

/** Calls `cb` for every image XObject reachable from the resource dictionary `res`. */
function forEachImage(
  res: MuPDF.PDFObject,
  kinds: string[],
  cb: (ref: MuPDF.PDFObject, img: MuPDF.PDFObject) => void,
  seen: Set<number>,
  depth = 0,
): void {
  if (!res.isDictionary() || depth > MAX_DEPTH) return;
  const visit = (o: MuPDF.PDFObject) => {
    const k = keyOf(o);
    if (k !== undefined) {
      if (seen.has(k)) return;
      seen.add(k);
    }
    const r = o.resolve();
    if (!r.isDictionary()) return;
    const sub = r.get("Subtype");
    if (sub.isName() && sub.asName() === "Image") cb(o, r);
    else forEachImage(r.get("Resources"), ALL_KINDS, cb, seen, depth + 1); // form, pattern, Type 3 font
  };
  for (const kind of kinds) {
    const d = res.get(kind);
    if (!d.isDictionary()) continue;
    d.forEach((o) => {
      if (kind !== "ExtGState") return visit(o);
      const sm = o.resolve().get("SMask");
      if (sm.isDictionary()) visit(sm.get("G"));
    });
  }
}

/**
 * Pixel sizes ("w×h") of the JPEG images on the page. Call before redaction: it rewrites
 * partly covered images losslessly, so afterwards their source encoding is unknown.
 */
export function jpegImageSizes(page: MuPDF.PDFPage): Set<string> {
  const sizes = new Set<string>();
  forEachImage(page.getObject().getInheritable("Resources"), ALL_KINDS, (_, img) => {
    if (filters(img).includes("DCTDecode")) sizes.add(`${img.get("Width").asNumber()}×${img.get("Height").asNumber()}`);
  }, new Set());
  return sizes;
}

/**
 * Crops every image XObject drawn on `page` to the part inside `visible` (MuPDF page
 * space). Returns how many images were replaced.
 */
export function cropPageImages(mupdf: typeof MuPDF, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, visible: Rect, jpegSizes: Set<string>): number {
  const found = new Map<number | MuPDF.PDFObject, Found>();
  const marked = new Set<number>();

  const entry = (ref: MuPDF.PDFObject, img: MuPDF.PDFObject): Found => {
    const key = keyOf(ref) ?? img;
    let f = found.get(key);
    if (!f) {
      f = { ref, w: img.get("Width").asNumber(), h: img.get("Height").asNumber(), uses: [], keep: !croppable(img) };
      found.set(key, f);
    }
    return f;
  };

  const walk = (content: Uint8Array, res: MuPDF.PDFObject, ctm: Matrix, depth: number, open: Set<number>) => {
    // Patterns, soft masks and Type 3 glyphs draw in their own spaces: keep their images whole.
    forEachImage(res, ["Pattern", "Font", "ExtGState"], (ref, img) => (entry(ref, img).keep = true), marked, depth);
    const xobjects = res.get("XObject");
    const stack: Matrix[] = [];
    let m = ctm;
    for (const { op, operands } of tokenize(content)) {
      if (op === "q") stack.push(m);
      else if (op === "Q") m = stack.pop() ?? m;
      else if (op === "cm" && operands.length >= 6) {
        const n = operands.slice(-6).map(Number) as Matrix;
        if (n.every(Number.isFinite)) m = concat(n, m);
      } else if (op === "Do" && operands.length && xobjects.isDictionary()) {
        const name = nameOf(operands[operands.length - 1]!);
        const ref = xobjects.get(name);
        // isStream() is only true on the reference, not on the resolved dictionary.
        if (!ref.isStream()) continue;
        const obj = ref.resolve();
        const sub = obj.get("Subtype").asName();
        if (sub === "Image") {
          const f = entry(ref, obj);
          f.uses.push({ dict: xobjects, name });
          const win = visiblePixels(concat(FLIP, m), f.w, f.h, visible);
          if (win)
            f.win = f.win
              ? { x0: Math.min(f.win.x0, win.x0), y0: Math.min(f.win.y0, win.y0), x1: Math.max(f.win.x1, win.x1), y1: Math.max(f.win.y1, win.y1) }
              : win;
        } else if (sub === "Form") {
          const k = keyOf(ref);
          if (depth >= MAX_DEPTH || (k !== undefined && open.has(k))) continue;
          const fm = obj.get("Matrix");
          const mat = fm.isArray() && fm.length === 6 ? ([0, 1, 2, 3, 4, 5].map((i) => fm.get(i).asNumber()) as Matrix) : IDENTITY;
          const fres = obj.get("Resources");
          if (k !== undefined) open.add(k);
          walk(ref.readStream().asUint8Array(), fres.isDictionary() ? fres : res, concat(mat, m), depth + 1, open);
          if (k !== undefined) open.delete(k);
        }
      }
    }
  };

  const obj = page.getObject();
  walk(readContents(obj.get("Contents")), obj.getInheritable("Resources"), page.getTransform() as Matrix, 0, new Set());

  let replaced = 0;
  for (const f of found.values()) {
    if (f.keep || !f.uses.length) continue;
    const win = f.win;
    if (win && win.x0 === 0 && win.y0 === 0 && win.x1 === f.w && win.y1 === f.h) continue;
    const form = win ? croppedForm(mupdf, doc, f.ref, f.w, f.h, win, jpegSizes.has(`${f.w}×${f.h}`)) : emptyForm(doc);
    if (!form) continue;
    for (const u of f.uses) u.dict.put(u.name, form);
    replaced++;
  }
  return replaced;
}

/** Images we can re-encode without changing how they look. */
function croppable(img: MuPDF.PDFObject): boolean {
  if (img.get("ImageMask").isBoolean() && img.get("ImageMask").asBoolean()) return false; // stencil: drawn in the fill colour
  if (!img.get("Mask").isNull()) return false; // colour key or stencil mask
  if (!img.get("SMaskInData").isNull()) return false;
  if (filters(img).includes("JPXDecode")) return false;
  const sm = img.get("SMask");
  if (sm.isStream() && (sm.get("Width").asNumber() !== img.get("Width").asNumber() || sm.get("Height").asNumber() !== img.get("Height").asNumber())) return false;
  return true;
}

function filters(img: MuPDF.PDFObject): string[] {
  const f = img.get("Filter");
  if (f.isName()) return [f.asName()];
  if (f.isArray()) return Array.from({ length: f.length }, (_, i) => f.get(i)).filter((x) => x.isName()).map((x) => x.asName());
  return [];
}

function emptyForm(doc: MuPDF.PDFDocument): MuPDF.PDFObject {
  return doc.addStream(new Uint8Array(), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] });
}

function croppedForm(
  mupdf: typeof MuPDF,
  doc: MuPDF.PDFDocument,
  ref: MuPDF.PDFObject,
  w: number,
  h: number,
  win: PixelWindow,
  wasJpeg: boolean,
): MuPDF.PDFObject | undefined {
  const src = ref.resolve();
  const image = doc.loadImage(ref);
  const pix = image.toPixmap();
  let cropped: MuPDF.Pixmap | undefined;
  try {
    if (pix.getWidth() !== w || pix.getHeight() !== h) return undefined;
    cropped = cropPixmap(mupdf, pix, win);
    // JPEG stays JPEG (re-encoded), everything else is stored losslessly.
    const cs = cropped.getColorSpace();
    const jpeg = (wasJpeg || filters(src).includes("DCTDecode")) && !cropped.getAlpha() && cs && (cs.isRGB() || cs.isGray());
    const newRef = doc.addImage(jpeg ? new mupdf.Image(cropped.asJPEG(JPEG_QUALITY, false)) : new mupdf.Image(cropped));
    const out = newRef.resolve();
    out.delete("SMask");
    const mask = image.getMask();
    if (mask) {
      const mpix = mask.toPixmap();
      try {
        const mcrop = cropPixmap(mupdf, mpix, win);
        out.put("SMask", doc.addImage(new mupdf.Image(mcrop)));
        mcrop.destroy();
      } finally {
        mpix.destroy();
      }
    }
    if (src.get("Interpolate").isBoolean()) out.put("Interpolate", src.get("Interpolate"));
    const f = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(Number(v.toPrecision(12))));
    const sw = (win.x1 - win.x0) / w;
    const sh = (win.y1 - win.y0) / h;
    const draw = `q ${f(sw)} 0 0 ${f(sh)} ${f(win.x0 / w)} ${f(1 - win.y1 / h)} cm /I Do Q\n`;
    return doc.addStream(new TextEncoder().encode(draw), {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 1, 1],
      Resources: { XObject: { I: newRef } },
    });
  } finally {
    cropped?.destroy();
    pix.destroy();
  }
}
