// The minimap (ADR 0012): the whole Plan, small, floating over the bottom-right corner
// of the precision view. Shows the visible area (red frame), the Regions (blue boxes,
// the selected one stronger) and the Tile grid (thin lines). Click or drag to move the
// view; no editing here. In "Anordnen" it shows what the view shows: the Clip with each
// Region's content at its place (ADR 0016).

import { clipBounds, placed, type Region } from "../export/regions";
import type { Point } from "./clipdrag";
import type { ViewRect } from "./viewer";

/** Largest side of the composed Clip picture in "Anordnen" (pixels). */
const MAX_ARRANGED_PX = 2048;

/** Largest share of the precision view's height and width the minimap may take. */
export const MINIMAP_SHARE = 1 / 3;

/** CSS size of the minimap for a Plan in a view of the given size: the whole Plan, within both limits. */
export function minimapSize(planW: number, planH: number, viewW: number, viewH: number): { width: number; height: number; scale: number } {
  const scale = Math.min((viewH * MINIMAP_SHARE) / planH, (viewW * MINIMAP_SHARE) / planW);
  return { width: planW * scale, height: planH * scale, scale };
}

/** True if the view shows the whole Plan (then the minimap would only repeat it); `x0`, `y0`: where it starts. */
export function showsWholePlan(visible: ViewRect, planW: number, planH: number, x0 = 0, y0 = 0): boolean {
  const tol = 1e-6 * Math.max(planW, planH); // float rounding only
  return visible.x0 <= x0 + tol && visible.y0 <= y0 + tol && visible.x1 >= x0 + planW - tol && visible.y1 >= y0 + planH - tol;
}

export interface MinimapElements {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Holds one box per Region. */
  regions: HTMLElement;
  viewBox: HTMLElement;
  tileGrid: SVGSVGElement;
  collapse: HTMLButtonElement;
  expand: HTMLButtonElement;
}

export class Minimap {
  private plan: { width: number; height: number } | undefined;
  private preview: ImageBitmap | undefined;
  /** "Anordnen": the minimap shows the Clip instead of the Plan. */
  private arranging = false;
  /** What the minimap shows, in view mm: the Plan, or the Clip. */
  private world = { x0: 0, y0: 0, width: 1, height: 1 };
  private scale = 1;
  private collapsed = false;
  private whole = false;
  private regions: Region[] = [];
  private selected: number | undefined;
  private view: ViewRect | undefined;
  private tiles: { xs: number[]; ys: number[] } | undefined;
  private dragging = false;

  constructor(
    private readonly el: MinimapElements,
    /** The precision view, whose size limits the minimap. */
    private readonly area: HTMLElement,
    private readonly centerOn: (p: Point) => void,
  ) {
    new ResizeObserver(() => this.layout()).observe(area);
    el.collapse.addEventListener("click", () => this.setCollapsed(true));
    el.expand.addEventListener("click", () => this.setCollapsed(false));
    const surface = el.canvas.parentElement!;
    surface.addEventListener("pointerdown", (e) => {
      if (!this.plan || e.button !== 0) return;
      this.dragging = true;
      surface.setPointerCapture(e.pointerId);
      this.centerOn(this.point(e));
      e.preventDefault();
    });
    surface.addEventListener("pointermove", (e) => {
      if (this.dragging) this.centerOn(this.point(e));
    });
    const stop = () => (this.dragging = false);
    surface.addEventListener("pointerup", stop);
    surface.addEventListener("pointercancel", stop);
  }

  /** A new Plan: draw its preview; the minimap always starts expanded. */
  setPlan(widthMm: number, heightMm: number, preview: ImageBitmap): void {
    this.plan = { width: widthMm, height: heightMm };
    this.preview = preview;
    this.arranging = false;
    this.collapsed = false;
    this.drawPicture();
  }

  /** Shows the Plan, or (`arranging`) the Clip as the view does in "Anordnen". */
  setMode(arranging: boolean): void {
    if (arranging === this.arranging) return;
    this.arranging = arranging;
    this.drawPicture();
  }

  setRegions(regions: Region[], selected: number | undefined): void {
    this.regions = regions;
    this.selected = selected;
    const boxes = this.el.regions;
    while (boxes.children.length > regions.length) boxes.lastElementChild!.remove();
    while (boxes.children.length < regions.length) boxes.append(document.createElement("div"));
    if (this.arranging) this.drawPicture();
    else this.placeBoxes();
  }

  /** Draws the Plan's preview, or in "Anordnen" each Region's part of it at its place in the Clip. */
  private drawPicture(): void {
    const preview = this.preview;
    if (!this.plan || !preview) return;
    const canvas = this.el.canvas;
    const ctx = canvas.getContext("2d")!;
    if (!this.arranging) {
      this.world = { x0: 0, y0: 0, width: this.plan.width, height: this.plan.height };
      canvas.width = preview.width;
      canvas.height = preview.height;
      ctx.drawImage(preview, 0, 0);
    } else {
      const b = clipBounds(this.regions);
      this.world = { x0: b.x0, y0: b.y0, width: Math.max(1, b.x1 - b.x0), height: Math.max(1, b.y1 - b.y0) };
      const src = preview.width / this.plan.width;
      const k = Math.min(src, MAX_ARRANGED_PX / Math.max(this.world.width, this.world.height));
      canvas.width = Math.max(1, Math.round(this.world.width * k));
      canvas.height = Math.max(1, Math.round(this.world.height * k));
      ctx.fillStyle = "#e4e6eb"; // empty (transparent) part of the Clip
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const r of this.regions) {
        const x = (r.at.x - b.x0) * k;
        const y = (r.at.y - b.y0) * k;
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, y, r.width * k, r.height * k);
        ctx.drawImage(preview, r.x * src, r.y * src, r.width * src, r.height * src, x, y, r.width * k, r.height * k);
      }
    }
    this.layout();
  }

  /** Tile grid cut positions in Plan mm, or none. */
  setTiles(t: { xs: number[]; ys: number[] } | undefined): void {
    this.tiles = t;
    this.drawTiles();
  }

  setView(visible: ViewRect): void {
    this.view = visible;
    if (this.plan) this.whole = showsWholePlan(visible, this.world.width, this.world.height, this.world.x0, this.world.y0);
    this.updateVisibility();
    this.placeBoxes();
  }

  private setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.updateVisibility();
  }

  private updateVisibility(): void {
    this.el.root.hidden = !this.plan || this.collapsed || this.whole;
    this.el.expand.hidden = !this.plan || !this.collapsed || this.whole;
  }

  private layout(): void {
    if (!this.plan) return;
    const s = minimapSize(this.world.width, this.world.height, this.area.clientWidth, this.area.clientHeight);
    this.scale = s.scale;
    this.el.canvas.style.width = `${s.width}px`;
    this.el.canvas.style.height = `${s.height}px`;
    this.placeBoxes();
    this.drawTiles();
  }

  private point(e: MouseEvent): Point {
    const r = this.el.canvas.getBoundingClientRect();
    return { x: this.world.x0 + (e.clientX - r.left) / this.scale, y: this.world.y0 + (e.clientY - r.top) / this.scale };
  }

  private place(el: HTMLElement, r: ViewRect): void {
    const s = this.scale;
    const { x0: ox, y0: oy } = this.world;
    const w = this.world.width * s;
    const h = this.world.height * s;
    const x0 = Math.min(w, Math.max(0, (r.x0 - ox) * s));
    const y0 = Math.min(h, Math.max(0, (r.y0 - oy) * s));
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    el.style.width = `${Math.max(3, Math.min((r.x1 - ox) * s, w) - x0)}px`;
    el.style.height = `${Math.max(3, Math.min((r.y1 - oy) * s, h) - y0)}px`;
  }

  private placeBoxes(): void {
    if (!this.plan) return;
    this.regions.forEach((r, i) => {
      const c = this.arranging ? placed(r) : r;
      const box = this.el.regions.children[i] as HTMLElement;
      box.className = i === this.selected ? "region-box selected" : "region-box";
      this.place(box, { x0: c.x, y0: c.y, x1: c.x + c.width, y1: c.y + c.height });
    });
    if (this.view) this.place(this.el.viewBox, this.view);
  }

  private drawTiles(): void {
    const t = this.tiles;
    const ns = "http://www.w3.org/2000/svg";
    const lines: SVGElement[] = [];
    if (t && this.plan) {
      const k = this.scale;
      const { x0: ox, y0: oy } = this.world;
      const line = (x1: number, y1: number, x2: number, y2: number) => {
        const l = document.createElementNS(ns, "line");
        l.setAttribute("x1", String((x1 - ox) * k));
        l.setAttribute("y1", String((y1 - oy) * k));
        l.setAttribute("x2", String((x2 - ox) * k));
        l.setAttribute("y2", String((y2 - oy) * k));
        lines.push(l);
      };
      for (const x of t.xs.slice(1, -1)) line(x, t.ys[0]!, x, t.ys.at(-1)!);
      for (const y of t.ys.slice(1, -1)) line(t.xs[0]!, y, t.xs.at(-1)!, y);
    }
    this.el.tileGrid.replaceChildren(...lines);
  }
}
