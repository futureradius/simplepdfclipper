// PDF export of the Clip (ADR 0005, 0006, 0009):
//  1. everything outside the Clip is removed from the file by MuPDF redaction
//     (not just hidden by a smaller page box),
//  2. the page becomes exactly the Clip, at 1:1,
//  3. if the Clip fits the normal PDF page size limit, the page is normalised to
//     UserUnit 1 so every viewer shows it at the right size,
//  4. provenance goes into the document properties.

import type * as MuPDF from "mupdf";
import type { ClipMm } from "./collect";

const MM_TO_PT = 72 / 25.4;
/** PDF page size limit per side in units (at UserUnit 1: 200 in = 5,080 mm). */
const MAX_UNITS = 14400;

export interface PdfExportOptions {
  clip: ClipMm;
  /** File name of the Plan, for the document properties. */
  sourceName: string;
  date: Date;
}

export interface PdfExport {
  pdf: Uint8Array;
  /** The page was rescaled to UserUnit 1 (false: Clip too large, UserUnit kept). */
  normalised: boolean;
  userUnit: number;
}

const num = (o: MuPDF.PDFObject, i: number) => o.get(i).asNumber();
/** Matrix numbers need full precision: a scale rounded to 4 decimals shifts content
 * 14 m away from the origin by ~0.15 mm. */
const f = (v: number) => String(Number(v.toPrecision(12)));

export function exportPdf(mupdf: typeof MuPDF, planBytes: Uint8Array, opts: PdfExportOptions): PdfExport {
  const { clip } = opts;
  const doc = mupdf.Document.openDocument(planBytes, "application/pdf").asPDF();
  if (!doc) throw new Error("Kein PDF");
  try {
    const page = doc.loadPage(0) as MuPDF.PDFPage;
    const obj = page.getObject();
    const rotate = obj.getInheritable("Rotate");
    if (rotate.isNumber() && rotate.asNumber() % 360 !== 0) throw new Error("Gedrehte Seiten werden noch nicht unterstützt.");

    // Clip in MuPDF page space (pt, y down, UserUnit applied, origin = top-left of the Plan).
    const [bx0, by0, bx1, by1] = page.getBounds();
    const cx0 = bx0! + clip.x * MM_TO_PT;
    const cy0 = by0! + clip.y * MM_TO_PT;
    const cx1 = cx0 + clip.width * MM_TO_PT;
    const cy1 = cy0 + clip.height * MM_TO_PT;

    // 1. Redact everything outside the Clip: four bands around it, reaching far
    //    beyond the page so content outside the page box goes too.
    const m = Math.max(bx1! - bx0!, by1! - by0!);
    const bands: [number, number, number, number][] = [
      [bx0! - m, by0! - m, bx1! + m, cy0], // above
      [bx0! - m, cy1, bx1! + m, by1! + m], // below
      [bx0! - m, cy0, cx0, cy1], // left
      [cx1, cy0, bx1! + m, cy1], // right
    ];
    for (const r of bands) {
      if (r[2] - r[0] <= 0 || r[3] - r[1] <= 0) continue;
      page.createAnnotation("Redact").setRect(r);
    }
    page.applyRedactions(
      false, // no black boxes
      mupdf.PDFPage.REDACT_IMAGE_PIXELS, // images partly outside: remove those pixels
      mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, // lines crossing the edge stay whole (ADR 0005)
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );

    // 2./3. Rebuild the page around the Clip.
    const uuObj = obj.get("UserUnit");
    const uu = uuObj.isNumber() ? uuObj.asNumber() : 1;
    const mb = obj.getInheritable("MediaBox");
    const mbx0 = num(mb, 0);
    const mby1 = Math.max(num(mb, 1), num(mb, 3));
    // MuPDF page space -> PDF units: x = mbx0 + fx / uu, y = mby1 - fy / uu
    const ux0 = mbx0 + cx0 / uu;
    const uyBottom = mby1 - cy1 / uu;
    const widthPt = clip.width * MM_TO_PT;
    const heightPt = clip.height * MM_TO_PT;
    const normalised = widthPt <= MAX_UNITS && heightPt <= MAX_UNITS;
    // New user space: origin at the Clip's lower-left corner; scaled by uu when normalising.
    const s = normalised ? uu : 1;
    const prefix = `q ${f(s)} 0 0 ${f(s)} ${f(-ux0 * s)} ${f(-uyBottom * s)} cm\n`;
    const contents = obj.get("Contents");
    const parts: Uint8Array[] = [new TextEncoder().encode(prefix)];
    const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
    for (const st of streams) {
      if (st.isNull()) continue;
      parts.push(st.readStream().asUint8Array().slice(), new TextEncoder().encode("\n"));
    }
    parts.push(new TextEncoder().encode("Q\n"));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    obj.put("Contents", doc.addStream(joined, doc.newDictionary()));

    // Patterns (hatching, shading patterns) are anchored to the page's default
    // coordinate space, not to the current transformation: give them the same
    // transformation as the content, or they would shift and scale.
    const patterns = obj.getInheritable("Resources").get("Pattern");
    if (patterns.isDictionary()) {
      const t: [number, number, number, number, number, number] = [s, 0, 0, s, -ux0 * s, -uyBottom * s];
      patterns.forEach((pat) => {
        const p = pat.resolve();
        const old = p.get("Matrix");
        const m = old.isArray() ? [0, 1, 2, 3, 4, 5].map((i) => num(old, i)) : [1, 0, 0, 1, 0, 0];
        // new = old × t (pattern space -> old default space -> new default space)
        const [a, b, c, d, e, g] = m as [number, number, number, number, number, number];
        const nm = [a * t[0], b * t[3], c * t[0], d * t[3], e * t[0] + t[4], g * t[3] + t[5]];
        const arr = doc.newArray();
        for (const v of nm) arr.push(Number(v.toPrecision(12)));
        p.put("Matrix", arr);
      });
    }

    const box = doc.newArray();
    for (const v of normalised ? [0, 0, widthPt, heightPt] : [0, 0, widthPt / uu, heightPt / uu]) box.push(Math.round(v * 10000) / 10000);
    obj.put("MediaBox", box);
    for (const k of ["CropBox", "TrimBox", "BleedBox", "ArtBox", "Annots"]) obj.delete(k);
    if (normalised) obj.delete("UserUnit");

    // 4. Provenance (ADR 0009).
    const mm = (v: number) => v.toFixed(1).replace(".", ",");
    const day = opts.date.toLocaleDateString("de-DE");
    doc.setMetaData("info:Title", `${opts.sourceName} – Ausschnitt`);
    doc.setMetaData(
      "info:Subject",
      `Ausschnitt aus ${opts.sourceName}: links ${mm(clip.x)} mm, oben ${mm(clip.y)} mm, ` +
        `${mm(clip.width)} × ${mm(clip.height)} mm. Exportiert am ${day}. Inhalte außerhalb des Ausschnitts wurden entfernt.`,
    );
    doc.setMetaData("info:Creator", "simplepdfclipper");
    doc.setMetaData("info:Producer", "simplepdfclipper (MuPDF)");

    // Unreferenced objects (old content streams) are dropped.
    const pdf = doc.saveToBuffer("garbage=deduplicate,compress").asUint8Array().slice();
    page.destroy();
    return { pdf, normalised, userUnit: normalised ? 1 : uu };
  } finally {
    doc.destroy();
  }
}
