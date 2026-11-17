// A small multi-page Document for tests (ADR 0014): three pages of different sizes,
// each with its name as text near the top-left and a filled bar below it.

import * as mupdf from "mupdf";

const PT = 72 / 25.4;

export const MULTIPAGE_PAGES = [
  { name: "SEITE EINS", widthMm: 210, heightMm: 297 },
  { name: "SEITE ZWEI", widthMm: 420, heightMm: 297 },
  { name: "SEITE DREI", widthMm: 297, heightMm: 210 },
] as const;

export function makeMultiPageDocument(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  res.put("Font", fonts);
  for (const p of MULTIPAGE_PAGES) {
    const w = p.widthMm * PT;
    const h = p.heightMm * PT;
    // Text 20 mm from the left, 30 mm from the top; a bar 40..60 mm from the top.
    const content =
      `BT 0 g /F1 24 Tf ${20 * PT} ${h - 30 * PT} Td (${p.name}) Tj ET\n` +
      `0.2 0.4 0.8 rg ${20 * PT} ${h - 60 * PT} ${w - 40 * PT} ${20 * PT} re f`;
    doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, res, content));
  }
  return doc.saveToBuffer("compress").asUint8Array().slice();
}
