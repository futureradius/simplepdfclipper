// The box of a glyph as MuPDF sees it: its advance across, the font's descender to
// ascender up. A glyph at the Clip edge is kept whole if the centre of this box is
// inside the Clip, else removed (ADR 0005, #35), in the PDF and the SVG alike.
//
// MuPDF's redaction removes a glyph if this box, shrunk by 10 % of its width and
// height on each side, touches a redaction area (measured on MuPDF 1.28). MuPDF.js has
// no ascender/descender call, so they are read once per font from structured text.

import type * as MuPDF from "mupdf";
import { concat, type Matrix, type Rect } from "./geometry";

export interface GlyphBox {
  centre: [number, number];
  /** What redaction tests (device space). */
  redact: Rect;
}

const SHRINK = 0.1;

export class GlyphBoxes {
  private metrics = new Map<number, { asc: number; desc: number }>();

  constructor(private readonly mupdf: typeof MuPDF) {}

  private metricsOf(font: MuPDF.Font): { asc: number; desc: number } {
    const key = font.pointer as unknown as number;
    let m = this.metrics.get(key);
    if (m) return m;
    m = { asc: 0.8, desc: -0.2 };
    const { mupdf } = this;
    // One glyph, 100 units large, through a display list into structured text: its
    // quad spans the descender to the ascender.
    const list = new mupdf.DisplayList([0, 0, 1000, 1000]);
    const dev = new mupdf.DisplayListDevice(list);
    const text = new mupdf.Text();
    try {
      const gid = Math.max(0, font.encodeCharacter(72)); // "H"
      text.showGlyph(font, [100, 0, 0, -100, 100, 500], gid, 72, 0);
      dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
      dev.close();
      const st = list.toStructuredText("preserve-whitespace");
      st.walk({
        onChar(_c, _origin, _font, _size, quad) {
          const top = Math.min(quad[1]!, quad[3]!);
          const bottom = Math.max(quad[5]!, quad[7]!);
          if (bottom > top) m = { asc: (500 - top) / 100, desc: (500 - bottom) / 100 };
        },
      });
      st.destroy();
    } catch {
      // keep the defaults
    } finally {
      text.destroy();
      dev.destroy();
      list.destroy();
    }
    this.metrics.set(key, m);
    return m;
  }

  /** Box of glyph `gid` drawn with text matrix `trm` under `ctm`. */
  get(font: MuPDF.Font, trm: Matrix, gid: number, wmode: number, ctm: Matrix): GlyphBox {
    const { asc, desc } = this.metricsOf(font);
    const adv = font.advanceGlyph(gid, wmode);
    const m = concat(trm, ctm);
    const at = (x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    const dx = adv * SHRINK;
    const dy = (asc - desc) * SHRINK;
    const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const [x, y] of [[dx, desc + dy], [adv - dx, desc + dy], [dx, asc - dy], [adv - dx, asc - dy]] as const) {
      const [px, py] = at(x, y);
      r.x0 = Math.min(r.x0, px);
      r.y0 = Math.min(r.y0, py);
      r.x1 = Math.max(r.x1, px);
      r.y1 = Math.max(r.y1, py);
    }
    return { centre: at(adv / 2, (asc + desc) / 2), redact: r };
  }
}
