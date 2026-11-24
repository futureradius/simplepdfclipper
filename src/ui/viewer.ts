// Precision view (ADR 0003): zoomable, pannable view of the Plan with the Regions of
// the Clip on top, the selected one with handles (ADR 0016).
//
// Mouse (ADR 0012): the left button selects and edits (drag on empty Plan: new Region,
// click there: deselect, click on a Region: select, edges: resize, inside: move); right
// drag, middle drag and Space + left drag pan; the wheel zooms.
//
// Rendering works like a map: while zooming/panning, already available images
// are scaled (the overview as a base layer, plus recent sharp renders); once the
// view rests, the visible area is rendered sharp in one pass by the engine.

import type { ClipMm } from "../export/index";
import { regionAt, type Handle, type Point } from "./clipdrag";
import type { Guide } from "./snap";

/** Tile grid preview (ADR 0013): cut positions in mm from the Plan origin, and Tile names. */
export interface TileOverlay {
  /** Column edges, left to right, including both Clip edges. */
  xs: number[];
  /** Row edges, top to bottom, including both Clip edges. */
  ys: number[];
  name(row: number, column: number): string;
}

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
  /**
   * Region `index` is being dragged by `handle` (edges resize, "move" moves), or a new
   * Region is being drawn (`index` undefined, handle "new"). Returns snap guides to show.
   */
  dragRegion(
    index: number | undefined,
    handle: Handle,
    start: ClipMm | undefined,
    from: Point,
    to: Point,
    altKey: boolean,
    visible: ViewRect,
    tolMm: number,
  ): Guide[];
  /** The drag that changed a Region is over. */
  dragEnd(): void;
  /** A Region was clicked (its index) or empty Plan (undefined). */
  select(index: number | undefined): void;
  /** The visible area changed (to update the overview). */
  viewChanged(visible: ViewRect, zoomPercent: number): void;
}

/** CSS pixels per mm at 100 % (96 dpi). */
export const PX_PER_MM_100 = 96 / 25.4;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
const GRAB_PX = 8;
/** A press that moves less than this (CSS px) is a click, not a drag. */
const CLICK_PX = 4;
const RENDER_DELAY_MS = 120;
const MAX_RENDER_PIXELS = 16_000_000;
const KEEP_LAYERS = 4;

const COLORS = {
  background: "#e9e9ec",
  outside: "rgba(30, 30, 40, 0.28)",
  clip: "#2563eb",
  other: "rgba(37, 99, 235, 0.55)",
  guide: "#f59e0b",
};

export class Viewer {
  private ctx: CanvasRenderingContext2D;
  private plan = { width: 1, height: 1 };
  private base: Layer | undefined;
  private layers: Layer[] = [];
  /** The Regions on the Plan, in list order; `selected` has the handles. */
  private regions: ClipMm[] = [];
  private selected: number | undefined;
  private guides: Guide[] = [];
  /** Space is held: a left drag pans (touchpads). */
  private space = false;
  /** Scratch canvas for dimming everything outside the Regions. */
  private dim = document.createElement("canvas");
  private tiles: TileOverlay | undefined;
  /** View: mm at the canvas centre, CSS px per mm. */
  private cx = 0;
  private cy = 0;
  private zoom = 1;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private drag:
    | {
        mode: "pan" | Handle;
        /** The Region dragged; undefined for "new" and "pan". */
        index: number | undefined;
        from: Point;
        screen: Point;
        start: ClipMm | undefined;
        cx: number;
        cy: number;
        /** Not moved far enough yet to count as a drag. */
        pending: boolean;
      }
    | undefined;
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
    canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // the right button pans
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

  setRegions(regions: ClipMm[], selected: number | undefined, guides: Guide[] = []): void {
    this.regions = regions;
    this.selected = selected;
    this.guides = guides;
    this.requestDraw();
  }

  /** Space held or released: while held, a left drag pans. */
  setSpace(down: boolean): void {
    if (this.space === down) return;
    this.space = down;
    if (!this.drag) this.canvas.style.cursor = down ? "grab" : "";
  }

  setTiles(t: TileOverlay | undefined): void {
    this.tiles = t;
    this.requestDraw();
  }

  /** Show the selected Region, or all Regions if none is selected, with a small margin. */
  fitClip(): void {
    const shown = this.selected !== undefined ? [this.regions[this.selected]!] : this.regions;
    if (shown.length === 0) return;
    this.fitRect({
      x0: Math.min(...shown.map((c) => c.x)),
      y0: Math.min(...shown.map((c) => c.y)),
      x1: Math.max(...shown.map((c) => c.x + c.width)),
      y1: Math.max(...shown.map((c) => c.y + c.height)),
    });
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

  /** Show the whole Plan, centred (the start view, ADR 0012). */
  fitPlan(): void {
    this.fitRect({ x0: 0, y0: 0, x1: this.plan.width, y1: this.plan.height }, 0.02);
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

  /** What a left press at screen point `s` grabs (see regionAt). */
  private targetAt(s: Point): { index: number; handle: Handle } | undefined {
    return regionAt(this.regions, this.selected, this.toMm(s.x, s.y), GRAB_PX / this.zoom);
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const s = this.local(e);
    const base = { from: this.toMm(s.x, s.y), screen: s, cx: this.cx, cy: this.cy, start: undefined, index: undefined };
    if (e.button !== 0 || this.space) {
      this.drag = { ...base, mode: "pan", pending: false };
      this.canvas.style.cursor = "grabbing";
    } else {
      const t = this.targetAt(s);
      if (t && t.index !== this.selected) this.cb.select(t.index);
      this.drag = t
        ? { ...base, mode: t.handle, index: t.index, start: { ...this.regions[t.index]! }, pending: true }
        : { ...base, mode: "new", pending: true };
    }
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const s = this.local(e);
    const d = this.drag;
    if (!d) {
      const t = this.space ? undefined : this.targetAt(s);
      this.canvas.style.cursor = this.space ? "grab" : t ? CURSOR[t.handle] : "crosshair";
      return;
    }
    if (d.mode === "pan") {
      this.cx = d.cx - (s.x - d.screen.x) / this.zoom;
      this.cy = d.cy - (s.y - d.screen.y) / this.zoom;
      this.viewUpdated();
      return;
    }
    if (d.pending) {
      if (Math.hypot(s.x - d.screen.x, s.y - d.screen.y) < CLICK_PX) return;
      d.pending = false;
    }
    const guides = this.cb.dragRegion(d.index, d.mode, d.start, d.from, this.toMm(s.x, s.y), e.altKey, this.visible(), GRAB_PX / this.zoom);
    this.guides = guides;
    this.requestDraw();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    this.guides = [];
    this.canvas.releasePointerCapture(e.pointerId);
    if (d.mode !== "pan") {
      // A click on empty Plan deselects; a click on a Region has already selected it.
      if (d.pending && d.mode === "new") this.cb.select(undefined);
      else if (!d.pending) this.cb.dragEnd();
    }
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
      const base = this.base;
      const bitmap = await this.cb.render(rect, pxPerMm);
      // Another page or Plan was opened meanwhile: this image belongs to the old one.
      if (this.base !== base) {
        bitmap.close();
        this.renderAgain = true;
      } else {
        // Use the actual image size (pixel counts are rounded) so nothing shifts.
        this.layers.push({ bitmap, rect, pxPerMm: bitmap.width / (rect.x1 - rect.x0) });
        while (this.layers.length > KEEP_LAYERS) this.layers.shift()!.bitmap.close();
        this.requestDraw();
      }
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

    this.drawTiles();
    this.drawRegions();
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

  private drawRegions(): void {
    const { ctx } = this;
    const boxes = this.regions.map((c) => {
      const a = this.toScreen(c.x, c.y);
      return { x: a.x, y: a.y, w: c.width * this.zoom, h: c.height * this.zoom };
    });
    // Dim everything outside the Regions (they may overlap, so they are cut out of a layer).
    const dim = this.dim;
    if (dim.width !== this.canvas.width || dim.height !== this.canvas.height) {
      dim.width = this.canvas.width;
      dim.height = this.canvas.height;
    }
    const dc = dim.getContext("2d")!;
    dc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    dc.clearRect(0, 0, this.cssW, this.cssH);
    dc.fillStyle = COLORS.outside;
    dc.fillRect(0, 0, this.cssW, this.cssH);
    for (const b of boxes) dc.clearRect(b.x, b.y, b.w, b.h);
    ctx.drawImage(dim, 0, 0, this.cssW, this.cssH);

    // The others lighter, the selected one last (on top) with its handles; numbered if several.
    const order = boxes.map((_, i) => i).filter((i) => i !== this.selected);
    if (this.selected !== undefined && boxes[this.selected]) order.push(this.selected);
    for (const i of order) {
      const b = boxes[i]!;
      const sel = i === this.selected;
      ctx.strokeStyle = sel ? COLORS.clip : COLORS.other;
      ctx.lineWidth = sel ? 2 : 1.5;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      if (sel) {
        ctx.fillStyle = "#fff";
        for (const [fx, fy] of HANDLE_POSITIONS) {
          const x = b.x + fx * b.w;
          const y = b.y + fy * b.h;
          ctx.fillRect(x - 5, y - 5, 10, 10);
          ctx.strokeRect(x - 5, y - 5, 10, 10);
        }
      }
      if (this.regions.length > 1) this.drawNumber(i + 1, b, sel);
    }
  }

  /** The Region's number in a small tag in its top-left corner (if it is big enough on screen). */
  private drawNumber(n: number, b: { x: number; y: number; w: number; h: number }, selected: boolean): void {
    if (b.w < 28 || b.h < 22) return;
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = "middle";
    const label = String(n);
    const w = ctx.measureText(label).width + 10;
    const x = Math.max(b.x, 0) + 8;
    const y = Math.max(b.y, 0) + 8;
    ctx.fillStyle = selected ? COLORS.clip : COLORS.other;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + 5, y + 9.5);
    ctx.restore();
  }

  /** Dashed cut lines inside the Clip, Tile names where there is room. */
  private drawTiles(): void {
    const t = this.tiles;
    if (!t) return;
    const { ctx } = this;
    const top = this.toScreen(0, t.ys[0]!).y;
    const bottom = this.toScreen(0, t.ys.at(-1)!).y;
    const left = this.toScreen(t.xs[0]!, 0).x;
    const right = this.toScreen(t.xs.at(-1)!, 0).x;
    ctx.save();
    ctx.strokeStyle = COLORS.clip;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    for (const x of t.xs.slice(1, -1)) {
      const sx = Math.round(this.toScreen(x, 0).x) + 0.5;
      if (sx < 0 || sx > this.cssW) continue;
      ctx.moveTo(sx, Math.max(top, 0));
      ctx.lineTo(sx, Math.min(bottom, this.cssH));
    }
    for (const y of t.ys.slice(1, -1)) {
      const sy = Math.round(this.toScreen(0, y).y) + 0.5;
      if (sy < 0 || sy > this.cssH) continue;
      ctx.moveTo(Math.max(left, 0), sy);
      ctx.lineTo(Math.min(right, this.cssW), sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Names in the top-left corner of each visible Tile that is large enough on screen.
    ctx.font = "600 12px \"Segoe UI\", system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    for (let r = 0; r < t.ys.length - 1; r++) {
      const y0 = this.toScreen(0, t.ys[r]!).y;
      const y1 = this.toScreen(0, t.ys[r + 1]!).y;
      if (y1 < 0 || y0 > this.cssH || y1 - y0 < 22) continue;
      for (let c = 0; c < t.xs.length - 1; c++) {
        const x0 = this.toScreen(t.xs[c]!, 0).x;
        const x1 = this.toScreen(t.xs[c + 1]!, 0).x;
        if (x1 < 0 || x0 > this.cssW || x1 - x0 < 34) continue;
        const label = t.name(r, c);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.strokeText(label, Math.max(x0, 0) + 6, Math.max(y0, 0) + 5);
        ctx.fillStyle = COLORS.clip;
        ctx.fillText(label, Math.max(x0, 0) + 6, Math.max(y0, 0) + 5);
      }
    }
    ctx.restore();
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
  move: "move",
  new: "crosshair",
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
