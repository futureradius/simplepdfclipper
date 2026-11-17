// Page picker (ADR 0014): thumbnails of every page of a multi-page Document, three
// side by side, drawn lazily as they scroll into view. Picking one makes it the Plan.

import type { Preview } from "../engine/protocol";

export interface PageSize {
  widthPt: number;
  heightPt: number;
}

/** Room for one thumbnail, CSS px. */
export const THUMB_BOX = { width: 200, height: 220 };

/** Size of a page's thumbnail fit into the box, keeping its proportions (at least 1 px per side). */
export function thumbSize(page: PageSize, box = THUMB_BOX): { width: number; height: number } {
  const s = Math.min(box.width / page.widthPt, box.height / page.heightPt);
  return { width: Math.max(1, Math.round(page.widthPt * s)), height: Math.max(1, Math.round(page.heightPt * s)) };
}

/** Start of every export file name: the page is named only for multi-page Documents. */
export function exportBase(name: string, page: number, pageCount: number): string {
  return pageCount > 1 ? `${name}_S${page + 1}_Ausschnitt` : `${name}_Ausschnitt`;
}

/** The source as written into exported files (document properties, Tile labels). */
export function sourceLabel(fileName: string, page: number, pageCount: number): string {
  return pageCount > 1 ? `${fileName}, Seite ${page + 1}` : fileName;
}

export interface PagePickerElements {
  dialog: HTMLDialogElement;
  info: HTMLElement;
  grid: HTMLElement;
  cancel: HTMLButtonElement;
}

export type ThumbnailRenderer = (page: number, maxWidthPx: number, maxHeightPx: number) => Promise<Preview>;

export class PagePicker {
  private finish: ((page: number | undefined) => void) | undefined;
  private observer: IntersectionObserver | undefined;
  /** Bumped on every open and close, so late thumbnails of an old picker are dropped. */
  private generation = 0;
  private queue: number[] = [];
  private rendering = false;
  private canvases: HTMLCanvasElement[] = [];
  private drawn = new Set<number>();

  constructor(
    private readonly el: PagePickerElements,
    private readonly render: ThumbnailRenderer,
  ) {
    el.cancel.addEventListener("click", () => this.close(undefined));
    el.dialog.addEventListener("cancel", (e) => {
      e.preventDefault(); // Escape: same as "Abbrechen"
      this.close(undefined);
    });
  }

  get isOpen(): boolean {
    return this.finish !== undefined;
  }

  /** Shows the pages; resolves with the picked page (0-based), or undefined on cancel. */
  pick(pages: PageSize[], fileName: string, current?: number): Promise<number | undefined> {
    this.close(undefined);
    const gen = ++this.generation;
    this.queue = [];
    this.drawn = new Set();
    this.el.info.textContent = `${fileName} · ${pages.length.toLocaleString("de-DE")} Seiten`;

    this.observer = new IntersectionObserver(
      (entries) => {
        if (gen !== this.generation) return;
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (!e.isIntersecting || this.drawn.has(i) || this.queue.includes(i)) continue;
          this.queue.push(i);
        }
        this.queue.sort((a, b) => a - b);
        void this.drain(gen);
      },
      { root: this.el.grid, rootMargin: "300px 0px" },
    );

    this.canvases = pages.map((p, i) => {
      const size = thumbSize(p);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.dataset.page = String(i);
      if (i === current) {
        button.classList.add("current");
        button.setAttribute("aria-current", "page");
      }
      const frame = document.createElement("span");
      frame.className = "frame";
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      frame.append(canvas);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = `Seite ${i + 1}`;
      button.append(frame, label);
      button.addEventListener("click", () => this.close(i));
      return canvas;
    });
    this.el.grid.replaceChildren(...this.canvases.map((c) => c.closest(".thumb")!));

    const result = new Promise<number | undefined>((resolve) => (this.finish = resolve));
    this.el.dialog.showModal();
    this.el.grid.scrollTop = 0;
    const start = this.el.grid.children[current ?? 0] as HTMLElement | undefined;
    start?.scrollIntoView({ block: "center" });
    start?.focus();
    for (const child of this.el.grid.children) this.observer.observe(child);
    return result;
  }

  private close(page: number | undefined): void {
    const finish = this.finish;
    if (!finish) return;
    this.finish = undefined;
    this.generation++;
    this.observer?.disconnect();
    this.observer = undefined;
    this.queue = [];
    this.el.dialog.close();
    this.el.grid.replaceChildren();
    this.canvases = [];
    finish(page);
  }

  /** One thumbnail at a time: the engine is shared, and opening the picked page must not wait long. */
  private async drain(gen: number): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (gen === this.generation && this.queue.length > 0) {
        const i = this.queue.shift()!;
        if (this.drawn.has(i)) continue;
        this.drawn.add(i);
        const canvas = this.canvases[i]!;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(parseFloat(canvas.style.width) * dpr);
        const h = Math.round(parseFloat(canvas.style.height) * dpr);
        try {
          const t = await this.render(i, w, h);
          if (gen !== this.generation) break;
          canvas.width = t.widthPx;
          canvas.height = t.heightPx;
          canvas.getContext("2d")!.putImageData(new ImageData(t.pixels as Uint8ClampedArray<ArrayBuffer>, t.widthPx, t.heightPx), 0, 0);
          canvas.closest(".thumb")!.classList.add("ready");
        } catch (e) {
          console.warn(`thumbnail of page ${i + 1} failed`, e);
        }
      }
    } finally {
      this.rendering = false;
    }
    // Pages that scrolled into view while the last thumbnail of an older picker was drawn.
    if (gen !== this.generation && this.queue.length > 0) void this.drain(this.generation);
  }
}
