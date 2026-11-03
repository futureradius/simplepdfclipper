// Precision view (ADR 0003): zoomable, pannable view of the Plan with the Clip
// and its handles on top.
//
// Rendering works like a map: while zooming/panning, already available images
// are scaled (the overview as a base layer, plus recent sharp renders); once the
// view rests, the visible area is rendered sharp in one pass by the engine.

import type { ClipMm } from "../export/index";
import { hitTest, type Handle, type Point } from "./clipdrag";
import type { Guide } from "./snap";

export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Layer {
  bitmap: ImageBitmap;
  /** Area covered, in mm. */
  rect: ViewRect;
  pxPerMm: number;
}

export interface ViewerCallbacks {
  /** Render part of the Plan; resolves to an image covering exactly `rect`. */
  render(rect: ViewRect, pxPerMm: number): Promise<ImageBitmap>;
  /** A handle of the Clip is being dragged. Returns snap guides to show. */
  dragClip(handle: Handle, start: ClipMm, from: Point, to: Point, altKey: boolean, visible: ViewRect, tolMm: number): Guide[];
  /** The visible area changed (to update the overview). */
  viewChanged(visible: ViewRect, zoomPercent: number): void;
}

/** CSS pixels per mm at 100 % (96 dpi). */
export const PX_PER_MM_100 = 96 / 25.4;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
const GRAB_PX = 8;
const RENDER_DELAY_MS = 120;
const MAX_RENDER_PIXELS = 16_000_000;
const KEEP_LAYERS = 4;

const COLORS = {
  background: "#e9e9ec",
  outside: "rgba(30, 30, 40, 0.28)",
  clip: "#2563eb",
  guide: "#f59e0b",
};

export class Viewer {
  private ctx: CanvasRenderingContext2D;
  private plan = { width: 1, height: 1 };
  private base: Layer | undefined;
  private layers: Layer[] = [];
  private clip: ClipMm = { x: 0, y: 0, width: 0, height: 0 };
  private guides: Guide[] = [];
  /** View: mm at the canvas centre, CSS px per mm. */
  private cx = 0;
  private cy = 0;
  private zoom = 1;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private drag: { mode: "pan" | Handle; from: Point; screen: Point; start: ClipMm; cx: number; cy: number } | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private rendering = false;
  private renderAgain = false;
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: ViewerCallbacks,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    this.resize();
  }

  // ---- Public API -----------------------------------------------------------

  setPlan(widthMm: number, heightMm: number, overview: ImageBitmap): void {
    for (const l of this.layers) l.bitmap.close();
    this.base?.bitmap.close();
    this.layers = [];
    this.plan = { width: widthMm, height: heightMm };
    this.base = { bitmap: overview, rect: { x0: 0, y0: 0, x1: widthMm, y1: heightMm }, pxPerMm: overview.width / widthMm };
  }

  setClip(c: ClipMm, guides: Guide[] = []): void {
    this.clip = c;
    this.guides = guides;
    this.requestDraw();
  }

  /** Show the whole Clip with a small margin. */
  fitClip(): void {
    const c = this.clip;
    this.fitRect({ x0: c.x, y0: c.y, x1: c.x + c.width, y1: c.y + c.height });
  }

  fitRect(r: ViewRect, margin = 0.08): void {
    this.measure();
    const w = Math.max(1, r.x1 - r.x0);
    const h = Math.max(1, r.y1 - r.y0);
    this.zoom = clamp(Math.min(this.cssW / (w * (1 + 2 * margin)), this.cssH / (h * (1 + 2 * margin))), MIN_ZOOM, MAX_ZOOM);
    this.cx = (r.x0 + r.x1) / 2;
    this.cy = (r.y0 + r.y1) / 2;
    this.viewUpdated();
  }

  /** Fit the Plan's width into the view, with `topMm` near the top edge. */
  fitWidth(topMm = 0): void {
    this.measure();
    this.zoom = clamp(this.cssW / (this.plan.width * 1.02), MIN_ZOOM, MAX_ZOOM);
    this.cx = this.plan.width / 2;
    const halfH = this.cssH / 2 / this.zoom;
    this.cy = Math.max(Math.min(topMm, this.plan.height) - 0.03 * 2 * halfH + halfH, halfH * 0.98);
    this.viewUpdated();
  }

  centerOn(p: Point): void {
    this.cx = p.x;
    this.cy = p.y;
    this.viewUpdated();
  }

  /** Zoom by a factor around the canvas centre. */
  zoomBy(factor: number): void {
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  }

  /** Zoom so that 1 mm on paper is 1 mm on screen (at 96 dpi). */
  zoomTo100(): void {
    this.zoomAt(this.cssW / 2, this.cssH / 2, PX_PER_MM_100 / this.zoom);
  }

  visible(): ViewRect {
    const hw = this.cssW / 2 / this.zoom;
    const hh = this.cssH / 2 / this.zoom;
    return { x0: this.cx - hw, y0: this.cy - hh, x1: this.cx + hw, y1: this.cy + hh };
  }

  // ---- Coordinates ----------------------------------------------------------

  private toMm(sx: number, sy: number): Point {
    const v = this.visible();
    return { x: v.x0 + sx / this.zoom, y: v.y0 + sy / this.zoom };
  }

  private toScreen(x: number, y: number): Point {
    const v = this.visible();
    return { x: (x - v.x0) * this.zoom, y: (y - v.y0) * this.zoom };
  }

  private local(e: MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- Interaction ----------------------------------------------------------

  private zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toMm(sx, sy);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.toMm(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.viewUpdated();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * lines * 0.0015));
  }

  private handleAt(s: Point): Handle {
    if (this.clip.width <= 0) return "new";
    return hitTest(this.clip, this.toMm(s.x, s.y), GRAB_PX / this.zoom);
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    const s = this.local(e);
    const h = e.button === 1 ? "new" : this.handleAt(s);
    // Edges and corners resize; anywhere else (also inside the Clip) pans the view.
    const mode = h === "move" || h === "new" ? "pan" : h;
    this.drag = { mode, from: this.toMm(s.x, s.y), screen: s, start: { ...this.clip }, cx: this.cx, cy: this.cy };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = mode === "pan" ? "grabbing" : this.canvas.style.cursor;
    e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const s = this.local(e);
    if (!this.drag) {
      const h = this.handleAt(s);
      this.canvas.style.cursor = h === "move" || h === "new" ? "grab" : CURSOR[h];
      return;
    }
    if (this.drag.mode === "pan") {
      this.cx = this.drag.cx - (s.x - this.drag.screen.x) / this.zoom;
      this.cy = this.drag.cy - (s.y - this.drag.screen.y) / this.zoom;
      this.viewUpdated();
      return;
    }
    const guides = this.cb.dragClip(
      this.drag.mode,
      this.drag.start,
      this.drag.from,
      this.toMm(s.x, s.y),
      e.altKey,
      this.visible(),
      GRAB_PX / this.zoom,
    );
    this.guides = guides;
    this.requestDraw();
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag) return;
    this.drag = undefined;
    this.guides = [];
    this.canvas.releasePointerCapture(e.pointerId);
    this.onMove(e);
    this.requestDraw();
  }

  // ---- Rendering ------------------------------------------------------------

  private resize(): void {
    this.measure();
    this.viewUpdated();
  }

  /**
   * Reads the current size of the view. Called before every fit calculation:
   * right after the workspace is shown, the ResizeObserver has not reported the
   * real size yet, and fitting against a stale (1 px) size zoomed far out.
   */
  private measure(): void {
    const parent = this.canvas.parentElement!;
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    if (w === this.cssW && h === this.cssH && this.canvas.width === Math.round(w * this.dpr)) return;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  private viewUpdated(): void {
    this.requestDraw();
    this.cb.viewChanged(this.visible(), (this.zoom / PX_PER_MM_100) * 100);
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.renderSharp(), RENDER_DELAY_MS);
  }

  private requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Render the visible area (plus a margin) sharp, unless a sharp enough image already covers it. */
  private async renderSharp(): Promise<void> {
    if (!this.base) return;
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    const want = this.zoom * this.dpr;
    const vis = this.visible();
    const page: ViewRect = { x0: 0, y0: 0, x1: this.plan.width, y1: this.plan.height };
    const needed = intersect(vis, page);
    if (!needed) return;
    if (want <= this.base.pxPerMm * 1.01) return; // overview is already sharp enough
    if (this.layers.some((l) => l.pxPerMm >= want * 0.99 && covers(l.rect, needed))) return;

    // Margin around the view so small pans stay sharp; shrink it if the image would be huge.
    let margin = 0.25;
    let rect = intersect(expand(vis, margin), page)!;
    while (margin > 0 && area(rect) * want * want > MAX_RENDER_PIXELS) {
      margin = Math.max(0, margin - 0.1);
      rect = intersect(expand(vis, margin), page)!;
    }
    const pxPerMm = Math.min(want, Math.sqrt(MAX_RENDER_PIXELS / area(rect)));

    this.rendering = true;
    try {
      const bitmap = await this.cb.render(rect, pxPerMm);
      // Use the actual image size (pixel counts are rounded) so nothing shifts.
      this.layers.push({ bitmap, rect, pxPerMm: bitmap.width / (rect.x1 - rect.x0) });
      while (this.layers.length > KEEP_LAYERS) this.layers.shift()!.bitmap.close();
      this.requestDraw();
    } catch (err) {
      console.warn("render failed", err);
    } finally {
      this.rendering = false;
    }
    if (this.renderAgain) {
      this.renderAgain = false;
      void this.renderSharp();
    }
  }

  private draw(): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.base) return;

    const vis = this.visible();
    const tl = this.toScreen(0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(tl.x, tl.y, this.plan.width * this.zoom, this.plan.height * this.zoom);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Base first, then sharper layers on top (older first, so the newest wins).
    for (const layer of [this.base, ...[...this.layers].sort((a, b) => a.pxPerMm - b.pxPerMm)]) this.drawLayer(layer, vis);

    this.drawClip();
    this.drawGuides();
  }

  private drawLayer(l: Layer, vis: ViewRect): void {
    const part = intersect(l.rect, vis);
    if (!part) return;
    const sx = (part.x0 - l.rect.x0) * l.pxPerMm;
    const sy = (part.y0 - l.rect.y0) * l.pxPerMm;
    const sw = (part.x1 - part.x0) * l.pxPerMm;
    const sh = (part.y1 - part.y0) * l.pxPerMm;
    const d = this.toScreen(part.x0, part.y0);
    this.ctx.drawImage(l.bitmap, sx, sy, sw, sh, d.x, d.y, (part.x1 - part.x0) * this.zoom, (part.y1 - part.y0) * this.zoom);
  }

  private drawClip(): void {
    const c = this.clip;
    if (c.width <= 0 || c.height <= 0) return;
    const { ctx } = this;
    const a = this.toScreen(c.x, c.y);
    const w = c.width * this.zoom;
    const h = c.height * this.zoom;
    // Dim everything outside the Clip.
    ctx.fillStyle = COLORS.outside;
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    ctx.rect(a.x, a.y, w, h);
    ctx.fill("evenodd");
    ctx.strokeStyle = COLORS.clip;
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, w, h);
    ctx.fillStyle = "#fff";
    for (const [fx, fy] of HANDLE_POSITIONS) {
      const x = a.x + fx * w;
      const y = a.y + fy * h;
      ctx.fillRect(x - 5, y - 5, 10, 10);
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
  }

  private drawGuides(): void {
    const { ctx } = this;
    ctx.strokeStyle = COLORS.guide;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    for (const g of this.guides) {
      ctx.beginPath();
      if (g.vertical) {
        const p = this.toScreen(g.pos, 0);
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, this.cssH);
      } else {
        const p = this.toScreen(0, g.pos);
        ctx.moveTo(0, p.y);
        ctx.lineTo(this.cssW, p.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

const CURSOR: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  move: "grab",
  new: "grab",
};

const HANDLE_POSITIONS: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function intersect(a: ViewRect, b: ViewRect): ViewRect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x0 < r.x1 && r.y0 < r.y1 ? r : null;
}

function covers(outer: ViewRect, inner: ViewRect): boolean {
  return outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
}

function expand(r: ViewRect, f: number): ViewRect {
  const dx = (r.x1 - r.x0) * f;
  const dy = (r.y1 - r.y0) * f;
  return { x0: r.x0 - dx, y0: r.y0 - dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

function area(r: ViewRect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}
