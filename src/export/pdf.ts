// PDF export of the Clip (ADR 0005, 0006, 0009):
//  1. everything outside the Clip is removed from the file by MuPDF redaction
//     (not just hidden by a smaller page box),
//  2. the page becomes exactly the Clip, at 1:1,
//  3. if the Clip fits the normal PDF page size limit, the page is normalised to
//     UserUnit 1 so every viewer shows it at the right size,
//  4. provenance goes into the document properties.
// For a Tiled Export (ADR 0013) the page is a Sheet instead: the Clip (= Tile) sits
// inside a Margin, clipped to its own area, with cut marks and a label in the Margin.

import type * as MuPDF from "mupdf";
import type { ClipMm } from "./collect";

const MM_TO_PT = 72 / 25.4;
/** PDF page size limit per side in units (at UserUnit 1: 200 in = 5,080 mm). */
const MAX_UNITS = 14400;

/** Page = Sheet with the Clip placed on it (Tiled Export, ADR 0013). */
export interface SheetLayout {
  widthMm: number;
  heightMm: number;
  /** Top-left corner of the Clip on the Sheet = the Margin. */
  marginMm: number;
  /** Tile label for the Margin; shortened or left out if there is no room. */
  label?: string;
  /** Fallback when the label is too long for the Tile's width. */
  shortLabel?: string;
}

export interface PdfExportOptions {
  clip: ClipMm;
  /** File name of the Plan, for the document properties. */
  sourceName: string;
  date: Date;
  sheet?: SheetLayout;
  /** Override the document properties written from `clip` (e.g. for Tiles). */
  title?: string;
  subject?: string;
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
    const sheet = opts.sheet;
    const widthPt = (sheet?.widthMm ?? clip.width) * MM_TO_PT;
    const heightPt = (sheet?.heightMm ?? clip.height) * MM_TO_PT;
    const normalised = widthPt <= MAX_UNITS && heightPt <= MAX_UNITS;
    /** pt per unit of the new page. */
    const k = normalised ? 1 : uu;
    const unit = (mm: number) => (mm * MM_TO_PT) / k;
    // Where the Clip's lower-left corner lands on the page (units).
    const ox = sheet ? unit(sheet.marginMm) : 0;
    const oy = sheet ? unit(sheet.heightMm - sheet.marginMm - clip.height) : 0;
    // New user space: origin at the Clip's lower-left corner (+ Margin); scaled by uu when normalising.
    const s = normalised ? uu : 1;
    const tx = -ux0 * s + ox;
    const ty = -uyBottom * s + oy;
    // On a Sheet, lines kept whole across the Clip edge (ADR 0005) must not show in the Margin.
    const clipPath = sheet ? `${f(ox)} ${f(oy)} ${f(unit(clip.width))} ${f(unit(clip.height))} re W n\n` : "";
    const prefix = `q ${clipPath}${f(s)} 0 0 ${f(s)} ${f(tx)} ${f(ty)} cm\n`;
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
    const main = doc.addStream(joined, doc.newDictionary());
    const overlay = sheet && sheetMarks(doc, obj, sheet, clip, unit);
    if (overlay) {
      const arr = doc.newArray();
      arr.push(main);
      arr.push(overlay);
      obj.put("Contents", arr);
    } else obj.put("Contents", main);

    // Patterns (hatching, shading patterns) are anchored to the page's default
    // coordinate space, not to the current transformation: give them the same
    // transformation as the content, or they would shift and scale.
    const patterns = obj.getInheritable("Resources").get("Pattern");
    if (patterns.isDictionary()) {
      const t: [number, number, number, number, number, number] = [s, 0, 0, s, tx, ty];
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
    for (const v of [0, 0, widthPt / k, heightPt / k]) box.push(Math.round(v * 10000) / 10000);
    obj.put("MediaBox", box);
    for (const k of ["CropBox", "TrimBox", "BleedBox", "ArtBox", "Annots"]) obj.delete(k);
    if (normalised) obj.delete("UserUnit");

    // 4. Provenance (ADR 0009).
    const mm = (v: number) => v.toFixed(1).replace(".", ",");
    const day = opts.date.toLocaleDateString("de-DE");
    doc.setMetaData("info:Title", opts.title ?? `${opts.sourceName} – Ausschnitt`);
    doc.setMetaData(
      "info:Subject",
      opts.subject ??
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

// ---- Sheet marks (ADR 0013) ---------------------------------------------------

/** Cut marks need this much Margin, the label this much. */
const MARKS_MIN_MM = 2;
const LABEL_MIN_MM = 4;
const LABEL_PT = 7;
const FONT_KEY = "FTileLabel";
const PT_MM = 25.4 / 72;

/**
 * Corner cut marks at the Tile corners and the Tile label, all inside the Margin.
 * Returns the content stream, or undefined if the Margin is too narrow for either.
 */
function sheetMarks(doc: MuPDF.PDFDocument, page: MuPDF.PDFObject, sheet: SheetLayout, clip: ClipMm, unit: (mm: number) => number): MuPDF.PDFObject | undefined {
  const m = sheet.marginMm;
  if (m < MARKS_MIN_MM) return undefined;
  // Tile corners in page units (y up).
  const x0 = unit(m);
  const x1 = unit(m + clip.width);
  const y1 = unit(sheet.heightMm - m); // top
  const y0 = unit(sheet.heightMm - m - clip.height); // bottom
  const gap = unit(1);
  const len = unit(Math.min(5, m - 1));
  const ops: string[] = ["q", "0 G", `${f(unit(0.1))} w`];
  for (const [x, y, dx, dy] of [
    [x0, y1, -1, 1],
    [x1, y1, 1, 1],
    [x0, y0, -1, -1],
    [x1, y0, 1, -1],
  ] as const) {
    ops.push(`${f(x + dx * gap)} ${f(y)} m ${f(x + dx * (gap + len))} ${f(y)} l`);
    ops.push(`${f(x)} ${f(y + dy * gap)} m ${f(x)} ${f(y + dy * (gap + len))} l`);
  }
  ops.push("S", "Q");

  if (m >= LABEL_MIN_MM) {
    // Room between the two bottom cut marks, 3 mm clear of each.
    const room = clip.width - 6;
    const text = [sheet.label, sheet.shortLabel].find((t): t is string => !!t && helveticaWidthMm(t, LABEL_PT) <= room);
    if (text) {
      addLabelFont(doc, page);
      const baseline = y0 - unit(1.3 + LABEL_PT * 0.72 * PT_MM);
      ops.push("BT", `/${FONT_KEY} ${f(unit(LABEL_PT * PT_MM))} Tf`, "0.45 g", `${f(x0 + unit(3))} ${f(baseline)} Td`, `<${winAnsiHex(text)}> Tj`, "ET");
    }
  }
  return doc.addStream(new TextEncoder().encode(ops.join("\n") + "\n"), doc.newDictionary());
}

/** Base-14 Helvetica, not embedded: every viewer has it, and it adds a few bytes only. */
function addLabelFont(doc: MuPDF.PDFDocument, page: MuPDF.PDFObject): void {
  let res = page.get("Resources");
  if (res.isNull()) {
    const inherited = page.getInheritable("Resources");
    res = inherited.isNull() ? doc.newDictionary() : inherited;
    page.put("Resources", res);
  }
  let fonts = res.get("Font");
  if (fonts.isNull()) {
    fonts = doc.newDictionary();
    res.put("Font", fonts);
  }
  fonts.put(FONT_KEY, doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
}

/** WinAnsi differs from Latin-1 in 0x80–0x9F; only characters a label may contain are mapped. */
const WIN_ANSI_EXTRA: Record<string, number> = { "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "€": 0x80, "…": 0x85 };

export function winAnsiHex(text: string): string {
  let hex = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const b = WIN_ANSI_EXTRA[ch] ?? ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) ? c : 0x3f);
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Generous Helvetica width estimate (digits and most letters are 0.5–0.72 em). */
function helveticaWidthMm(text: string, pt: number): number {
  let em = 0;
  for (const ch of text) em += /[A-ZÄÖÜmw]/.test(ch) ? 0.72 : /[\s.,:;·il|']/.test(ch) ? 0.28 : 0.56;
  return em * pt * PT_MM;
}
