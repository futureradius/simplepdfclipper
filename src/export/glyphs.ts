// Glyph outlines for "Text als Pfade". MuPDF.js has no direct glyph-outline API,
// but its own SVG writer emits each glyph as a reusable <path> in em units. We
// render one glyph at a time through it and cache the parsed outline.

import type * as MuPDF from "mupdf";
import type { Matrix } from "./geometry";
import type { PathData } from "./ir";
import { parseGlyphPath } from "./pathdata";

export class GlyphOutlines {
  private cache = new Map<string, string>();
  private readonly black: MuPDF.Color = [0, 0, 0];

  constructor(private readonly mupdf: typeof MuPDF) {}

  /** Outline of glyph `gid` (em space, y up), transformed by m. */
  get(font: MuPDF.Font, gid: number, m: Matrix): PathData {
    const key = `${font.pointer as unknown as number}:${gid}`;
    let d = this.cache.get(key);
    if (d === undefined) {
      d = this.extract(font, gid);
      this.cache.set(key, d);
    }
    return d === "" ? [] : parseGlyphPath(d, m);
  }

  private extract(font: MuPDF.Font, gid: number): string {
    const { mupdf } = this;
    const buf = new mupdf.Buffer();
    const text = new mupdf.Text();
    const writer = new mupdf.DocumentWriter(buf, "svg", "text=path");
    try {
      text.showGlyph(font, [1, 0, 0, 1, 0, 0], gid, 65);
      const dev = writer.beginPage([0, 0, 10, 10]);
      dev.fillText(text, [1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, this.black, 1);
      writer.endPage();
      writer.close();
      const m = /<path id="font_[^"]*" d="([^"]*)"/.exec(buf.asString());
      return m?.[1] ?? "";
    } finally {
      writer.destroy();
      text.destroy();
      buf.destroy();
    }
  }

  destroy(): void {
    this.cache.clear();
  }
}
