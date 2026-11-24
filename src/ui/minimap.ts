// The minimap (ADR 0012): the whole Plan, small, floating over the bottom-right corner
// of the precision view. Shows the visible area (red frame), the Regions (blue boxes,
// the selected one stronger) and the Tile grid (thin lines). Click or drag to move the
// view; no editing here.

import type { ClipMm } from "../export/collect";
import type { Point } from "./clipdrag";
import type { ViewRect } from "./viewer";

/** Largest share of the precision view's height and width the minimap may take. */
export const MINIMAP_SHARE = 1 / 3;

/** CSS size of the minimap for a Plan in a view of the given size: the whole Plan, within both limits. */
export function minimapSize(planW: number, planH: number, viewW: number, viewH: number): { width: number; height: number; scale: number } {
  const scale = Math.min((viewH * MINIMAP_SHARE) / planH, (viewW * MINIMAP_SHARE) / planW);
  return { width: planW * scale, height: planH * scale, scale };
}

/** True if the view shows the whole Plan (then the minimap would only repeat it). */
export function showsWholePlan(visible: ViewRect, planW: number, planH: number): boolean {
  const tol = 1e-6 * Math.max(planW, planH); // float rounding only
  return visible.x0 <= tol && visible.y0 <= tol && visible.x1 >= planW - tol && visible.y1 >= planH - tol;
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
  private scale = 1;
  private collapsed = false;
  private whole = false;
  private regions: ClipMm[] = [];
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
    this.el.canvas.width = preview.width;
    this.el.canvas.height = preview.height;
    this.el.canvas.getContext("2d")!.drawImage(preview, 0, 0);
    this.collapsed = false;
    this.layout();
  }

  setRegions(regions: ClipMm[], selected: number | undefined): void {
    this.regions = regions;
    this.selected = selected;
    const boxes = this.el.regions;
    while (boxes.children.length > regions.length) boxes.lastElementChild!.remove();
    while (boxes.children.length < regions.length) boxes.append(document.createElement("div"));
    this.placeBoxes();
  }

  /** Tile grid cut positions in Plan mm, or none. */
  setTiles(t: { xs: number[]; ys: number[] } | undefined): void {
    this.tiles = t;
    this.drawTiles();
  }

  setView(visible: ViewRect): void {
    this.view = visible;
    if (this.plan) this.whole = showsWholePlan(visible, this.plan.width, this.plan.height);
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
    const s = minimapSize(this.plan.width, this.plan.height, this.area.clientWidth, this.area.clientHeight);
    this.scale = s.scale;
    this.el.canvas.style.width = `${s.width}px`;
    this.el.canvas.style.height = `${s.height}px`;
    this.placeBoxes();
    this.drawTiles();
  }

  private point(e: MouseEvent): Point {
    const r = this.el.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  private place(el: HTMLElement, r: ViewRect): void {
    const s = this.scale;
    const w = this.plan!.width * s;
    const h = this.plan!.height * s;
    const x0 = Math.min(w, Math.max(0, r.x0 * s));
    const y0 = Math.min(h, Math.max(0, r.y0 * s));
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    el.style.width = `${Math.max(3, Math.min(r.x1 * s, w) - x0)}px`;
    el.style.height = `${Math.max(3, Math.min(r.y1 * s, h) - y0)}px`;
  }

  private placeBoxes(): void {
    if (!this.plan) return;
    this.regions.forEach((c, i) => {
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
      const line = (x1: number, y1: number, x2: number, y2: number) => {
        const l = document.createElementNS(ns, "line");
        l.setAttribute("x1", String(x1 * k));
        l.setAttribute("y1", String(y1 * k));
        l.setAttribute("x2", String(x2 * k));
        l.setAttribute("y2", String(y2 * k));
        lines.push(l);
      };
      for (const x of t.xs.slice(1, -1)) line(x, t.ys[0]!, x, t.ys.at(-1)!);
      for (const y of t.ys.slice(1, -1)) line(t.xs[0]!, y, t.xs.at(-1)!, y);
    }
    this.el.tileGrid.replaceChildren(...lines);
  }
}
