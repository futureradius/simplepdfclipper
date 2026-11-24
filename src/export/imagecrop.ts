// Raster images in the SVG export: keep only the pixels inside the visible area
// (ADR 0005: the SVG never contains content outside the Clip), and pick a compact
// encoding. Scans are the main case: one image covering the whole page.

import type * as MuPDF from "mupdf";
import { apply, concat, emptyRect, extend, intersect, invert, isEmpty, type Matrix, type Rect } from "./geometry";

/** Pixels kept beyond the visible area on each side, so resampling at the edge matches. */
const BORDER_PX = 1;
/** JPEG is used only when it is at most this share of the PNG size (photo-like content). */
const JPEG_SHARE = 1 / 3;
const JPEG_QUALITY = 85;

export interface PixelWindow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The pixel columns/rows of a w × h image (drawn by `matrix` from the unit square,
 * row 0 at v = 0) that are needed to cover `visible`. Undefined if nothing is visible.
 */
export function visiblePixels(matrix: Matrix, w: number, h: number, visible: Rect): PixelWindow | undefined {
  if (isEmpty(visible)) return undefined;
  const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (det === 0) return undefined;
  if (![visible.x0, visible.y0, visible.x1, visible.y1].every(Number.isFinite)) return { x0: 0, y0: 0, x1: w, y1: h };
  const inv = invert(matrix);
  const uv = emptyRect();
  for (const [x, y] of [
    [visible.x0, visible.y0],
    [visible.x1, visible.y0],
    [visible.x0, visible.y1],
    [visible.x1, visible.y1],
  ] as const)
    extend(uv, ...apply(inv, x, y));
  const r = intersect(uv, { x0: 0, y0: 0, x1: 1, y1: 1 });
  if (isEmpty(r)) return undefined;
  const win = {
    x0: Math.max(0, Math.floor(r.x0 * w) - BORDER_PX),
    y0: Math.max(0, Math.floor(r.y0 * h) - BORDER_PX),
    x1: Math.min(w, Math.ceil(r.x1 * w) + BORDER_PX),
    y1: Math.min(h, Math.ceil(r.y1 * h) + BORDER_PX),
  };
  return win.x1 > win.x0 && win.y1 > win.y0 ? win : undefined;
}

/** Matrix that draws the pixel window of a w × h image at the same place as `matrix` draws the whole. */
export function windowMatrix(matrix: Matrix, w: number, h: number, win: PixelWindow): Matrix {
  const s: Matrix = [(win.x1 - win.x0) / w, 0, 0, (win.y1 - win.y0) / h, win.x0 / w, win.y0 / h];
  return concat(s, matrix);
}

/** Copies a window out of a pixmap. */
export function cropPixmap(mupdf: typeof MuPDF, pix: MuPDF.Pixmap, win: PixelWindow): MuPDF.Pixmap {
  // Bytes per pixel, alpha included (getNumberOfComponents() already counts alpha).
  const n = pix.getStride() / pix.getWidth();
  const cw = win.x1 - win.x0;
  const ch = win.y1 - win.y0;
  const out = new mupdf.Pixmap(pix.getColorSpace()!, [0, 0, cw, ch], pix.getAlpha() !== 0);
  const src = pix.getPixels();
  const dst = out.getPixels();
  const stride = pix.getStride();
  const outStride = out.getStride();
  for (let y = 0; y < ch; y++) {
    const from = (win.y0 + y) * stride + win.x0 * n;
    dst.set(src.subarray(from, from + cw * n), y * outStride);
  }
  return out;
}

export interface EncodedImage {
  href: string;
  matrix: Matrix;
  /** Pixel size actually embedded. */
  width: number;
  height: number;
}

/**
 * Encodes the visible part of `image` (drawn by `matrix`, in export units) as a data URL.
 * Undefined if no pixel of it is visible.
 */
export function encodeVisibleImage(
  mupdf: typeof MuPDF,
  image: MuPDF.Image,
  matrix: Matrix,
  visible: Rect,
  base64: (bytes: Uint8Array) => string,
): EncodedImage | undefined {
  let pix = image.toPixmap();
  try {
    const w = pix.getWidth();
    const h = pix.getHeight();
    const win = visiblePixels(matrix, w, h, visible);
    if (!win) return undefined;
    if (win.x0 > 0 || win.y0 > 0 || win.x1 < w || win.y1 < h) {
      const cropped = cropPixmap(mupdf, pix, win);
      pix.destroy();
      pix = cropped;
    }
    const cs = pix.getColorSpace();
    if (cs && !cs.isRGB() && !cs.isGray()) {
      const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
      pix.destroy();
      pix = rgb;
    }
    const png = pix.asPNG();
    let href = `data:image/png;base64,${base64(png)}`;
    if (!pix.getAlpha() && image.getBitsPerComponent() >= 8) {
      const jpeg = pix.asJPEG(JPEG_QUALITY, false);
      if (jpeg.length <= png.length * JPEG_SHARE) href = `data:image/jpeg;base64,${base64(jpeg)}`;
    }
    return { href, matrix: windowMatrix(matrix, w, h, win), width: win.x1 - win.x0, height: win.y1 - win.y0 };
  } finally {
    pix.destroy();
  }
}
