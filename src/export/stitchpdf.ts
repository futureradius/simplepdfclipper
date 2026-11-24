// PDF export of a Clip made of several Regions (ADR 0016).
//
// Each Region is exported on its own, exactly like a one-Region Clip (pdf.ts: everything
// outside it removed, paths cut at its edges, images cropped). The stitched page then
// draws each Region's page as a Form XObject at its place in the Layout, clipped to the
// Region so a glyph kept whole at an edge cannot reach into its neighbour. The space
// between Regions stays empty (transparent).

import type * as MuPDF from "mupdf";
import type { ClipMm } from "./collect";
import { pdfNumber as f } from "./contentstream";
import { exportPdf, type PdfExport } from "./pdf";
import { asRegions, clipSize, type ClipShape, type Region } from "./regions";

const MM_TO_PT = 72 / 25.4;
/** PDF page size limit per side in units (as in pdf.ts). */
const MAX_UNITS = 14400;

export interface ClipPdfOptions {
  /** The Clip: a rectangle, or Regions with their Layout. */
  clip: ClipShape;
  /** Page of the Document (0-based, default 0). */
  page?: number;
  sourceName: string;
  date: Date;
}

const mm = (v: number) => v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plain = (r: ClipMm): ClipMm => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/** The Regions for the document properties: where each comes from and where it sits. */
export function describeRegions(regions: readonly Region[]): string {
  return regions
    .map(
      (r, i) =>
        `Bereich ${i + 1}: links ${mm(r.x)} mm, oben ${mm(r.y)} mm, ${mm(r.width)} × ${mm(r.height)} mm, ` +
        `im Ausschnitt bei ${mm(r.at.x)} / ${mm(r.at.y)} mm`,
    )
    .join("; ");
}

/** Exports the Clip as one page; a one-Region Clip goes straight through pdf.ts. */
export function exportClipPdf(mupdf: typeof MuPDF, planBytes: Uint8Array, opts: ClipPdfOptions): PdfExport {
  const regions = asRegions(opts.clip);
  if (regions.length === 0) throw new Error("no Region");
  const base = { page: opts.page, sourceName: opts.sourceName, date: opts.date };
  if (regions.length === 1) return exportPdf(mupdf, planBytes, { ...base, clip: plain(regions[0]!) });

  const parts = regions.map((r) => exportPdf(mupdf, planBytes, { ...base, clip: plain(r) }));
  const uu = parts[0]!.planUserUnit;
  const size = clipSize(regions);
  const normalised = size.width * MM_TO_PT <= MAX_UNITS && size.height * MM_TO_PT <= MAX_UNITS;
  /** pt per unit of the stitched page. */
  const k = normalised ? 1 : uu;
  const unit = (v: number) => (v * MM_TO_PT) / k;

  const out = new mupdf.PDFDocument();
  try {
    const xobjects = out.newDictionary();
    let content = "";
    parts.forEach((part, i) => {
      const r = regions[i]!;
      const src = mupdf.Document.openDocument(part.pdf, "application/pdf").asPDF()!;
      try {
        const page = src.findPage(0);
        const box = page.getInheritable("MediaBox");
        const bbox = [0, 1, 2, 3].map((j) => box.get(j).asNumber());
        const res = page.getInheritable("Resources");
        const form = out.addStream(readContents(page.get("Contents")), {
          Type: "XObject",
          Subtype: "Form",
          BBox: bbox,
          Resources: res.isNull() ? out.newDictionary() : out.graftObject(res),
        });
        const name = `R${i + 1}`;
        xobjects.put(name, form);
        // Region page units -> stitched page units; lower-left corner of the Region (y up).
        const s = part.userUnit / k;
        const x = unit(r.at.x);
        const y = unit(size.height - r.at.y - r.height);
        content += `q ${f(x)} ${f(y)} ${f(unit(r.width))} ${f(unit(r.height))} re W n ${f(s)} 0 0 ${f(s)} ${f(x)} ${f(y)} cm /${name} Do Q\n`;
      } finally {
        src.destroy();
      }
    });
    const resources = out.newDictionary();
    resources.put("XObject", xobjects);
    out.insertPage(-1, out.addPage([0, 0, unit(size.width), unit(size.height)], 0, resources, content));
    if (!normalised) out.findPage(0).put("UserUnit", uu);

    const day = opts.date.toLocaleDateString("de-DE");
    out.setMetaData("info:Title", `${opts.sourceName} – Ausschnitt`);
    out.setMetaData(
      "info:Subject",
      `Ausschnitt aus ${opts.sourceName} aus ${regions.length} Bereichen, ${mm(size.width)} × ${mm(size.height)} mm. ` +
        `${describeRegions(regions)}. Exportiert am ${day}. Inhalte außerhalb der Bereiche wurden entfernt.`,
    );
    out.setMetaData("info:Creator", "simplepdfclipper");
    out.setMetaData("info:Producer", "simplepdfclipper (MuPDF)");
    const pdf = out.saveToBuffer("garbage=deduplicate,compress").asUint8Array().slice();
    return { pdf, normalised, userUnit: normalised ? 1 : uu, planUserUnit: uu, uncut: parts.reduce((n, p) => n + p.uncut, 0) };
  } finally {
    out.destroy();
  }
}

function readContents(contents: MuPDF.PDFObject): Uint8Array {
  const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
  const parts = streams.filter((s) => !s.isNull()).map((s) => s.readStream().asUint8Array());
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    joined[o + p.length] = 10;
    o += p.length + 1;
  }
  return joined;
}
