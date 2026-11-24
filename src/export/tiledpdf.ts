// Tiled Export (ADR 0013): the Clip as a grid of Tiles, one Sheet per page.
//
// Two stages, so the big Plan is redacted only once:
//  1. the Clip is exported as usual (everything outside it removed),
//  2. each Tile is cut out of that Clip PDF the same way (removal per Tile,
//     ADR 0005), placed on its Sheet with Margin, cut marks and Tile label.
// Tiles are produced one call at a time so the UI can show progress and cancel.

import type * as MuPDF from "mupdf";
import { exportPdf } from "./pdf";
import { asRegions, clipSize, type ClipShape } from "./regions";
import { describeRegions, exportClipPdf } from "./stitchpdf";
import { rowName, type Tile } from "./tilegrid";

export interface TiledJob {
  /** The Clip: a rectangle, or Regions with their Layout (stitched first, ADR 0016). */
  clip: ClipShape;
  /** Page of the Document (0-based). */
  page: number;
  sourceName: string;
  date: Date;
  multipage: boolean;
  rows: number;
  columns: number;
  marginMm: number;
}

const mm = (v: number) => v.toFixed(1).replace(".", ",");

export function tileLabel(t: Tile, job: Pick<TiledJob, "rows" | "columns" | "sourceName" | "date">): string {
  return (
    `${t.name} · Zeile ${rowName(t.row)} von ${rowName(job.rows - 1)}, Spalte ${t.column + 1} von ${job.columns}` +
    ` · ${job.sourceName} · ${job.date.toLocaleDateString("de-DE")}`
  );
}

export class TiledPdfExport {
  private readonly clipBytes: Uint8Array;
  private readonly book: MuPDF.PDFDocument | undefined;
  /** Content streams not cut at the edge since the last takeUncut() (pdf.ts). */
  private uncut = 0;

  constructor(
    private readonly mupdf: typeof MuPDF,
    planBytes: Uint8Array,
    private readonly job: TiledJob,
  ) {
    const clip = exportClipPdf(mupdf, planBytes, { clip: job.clip, page: job.page, sourceName: job.sourceName, date: job.date });
    this.clipBytes = clip.pdf;
    this.uncut = clip.uncut;
    this.book = job.multipage ? new mupdf.PDFDocument() : undefined;
  }

  /** Exports one Tile. Returns its PDF, or nothing in multipage mode (it is added to the book). */
  tile(t: Tile): Uint8Array | undefined {
    const { job } = this;
    const day = job.date.toLocaleDateString("de-DE");
    const where = `Zeile ${rowName(t.row)} von ${rowName(job.rows - 1)}, Spalte ${t.column + 1} von ${job.columns}`;
    const regions = asRegions(job.clip);
    // One Region: where the Tile is on the Plan; several: where it is in the stitched Clip.
    const pos =
      regions.length === 1
        ? `links ${mm(regions[0]!.x + t.x)} mm, oben ${mm(regions[0]!.y + t.y)} mm`
        : `im Ausschnitt aus ${regions.length} Bereichen links ${mm(t.x)} mm, oben ${mm(t.y)} mm`;
    const r = exportPdf(this.mupdf, this.clipBytes, {
      clip: { x: t.x, y: t.y, width: t.width, height: t.height },
      sourceName: job.sourceName,
      date: job.date,
      sheet: { widthMm: t.sheetWidth, heightMm: t.sheetHeight, marginMm: job.marginMm, label: tileLabel(t, job), shortLabel: t.name },
      title: `${job.sourceName} – Kachel ${t.name}`,
      subject:
        `Kachel ${t.name} (${where}) aus ${job.sourceName}: ${pos}, ` +
        `${mm(t.width)} × ${mm(t.height)} mm. Exportiert am ${day}. Inhalte außerhalb der Kachel wurden entfernt.`,
    });
    this.uncut += r.uncut;
    if (!this.book) return r.pdf;
    const src = this.mupdf.Document.openDocument(r.pdf, "application/pdf") as MuPDF.PDFDocument;
    try {
      this.book.graftPage(-1, src, 0);
    } finally {
      src.destroy();
    }
    return undefined;
  }

  /** Content streams whose paths could not be cut since the last call. */
  takeUncut(): number {
    const n = this.uncut;
    this.uncut = 0;
    return n;
  }

  /** The multipage file (multipage mode only). */
  finish(): Uint8Array | undefined {
    const { book, job } = this;
    if (!book) return undefined;
    const regions = asRegions(job.clip);
    const c = regions[0]!;
    const size = clipSize(regions);
    const clipText =
      regions.length === 1
        ? `Ausschnitt links ${mm(c.x)} mm, oben ${mm(c.y)} mm, ${mm(c.width)} × ${mm(c.height)} mm`
        : `Ausschnitt aus ${regions.length} Bereichen, ${mm(size.width)} × ${mm(size.height)} mm (${describeRegions(regions)})`;
    book.setMetaData("info:Title", `${job.sourceName} – Kacheln`);
    book.setMetaData(
      "info:Subject",
      `${job.rows * job.columns} Kacheln (${job.rows} Zeilen × ${job.columns} Spalten, zeilenweise) aus ${job.sourceName}: ` +
        `${clipText}. ` +
        `Exportiert am ${job.date.toLocaleDateString("de-DE")}. Inhalte außerhalb der jeweiligen Kachel wurden entfernt.`,
    );
    book.setMetaData("info:Creator", "simplepdfclipper");
    book.setMetaData("info:Producer", "simplepdfclipper (MuPDF)");
    return book.saveToBuffer("garbage=deduplicate,compress").asUint8Array().slice();
  }

  destroy(): void {
    this.book?.destroy();
  }
}
