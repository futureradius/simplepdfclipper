// Precision view (ADR 0003): zoomable, pannable view of the Plan with the Regions of
// the Clip on top, the selected one with handles (ADR 0016). In "Anordnen" it shows the
// Clip as exported instead: each Region with its Plan content at its place in the Layout.
//
// Mouse (ADR 0012): the left button selects and edits (drag on empty Plan: new Region,
// click there: deselect, click on a Region: select, edges: resize, inside: move; in
// "Anordnen" a drag moves a Region in the Clip); right drag, middle drag and Space +
// left drag pan; the wheel zooms.
//
// Rendering works like a map: while zooming/panning, already available images
// are scaled (the overview as a base layer, plus recent sharp renders); once the
// view rests, the visible area is rendered sharp in one pass by the engine.

import type { ClipMm } from "../export/index";
import { clipBounds, placed, type Region } from "../export/regions";
import { regionAt, type Handle, type Point } from "./clipdrag";

/** A snap line to draw: x (vertical) or y, in view mm. */
export interface GuideLine {
  vertical: boolean;
  pos: number;
}

/** What the view shows: the Plan ("Bereiche wählen") or the Clip as exported ("Anordnen"). */
export type ViewMode = "plan" | "arrange";

/** Tile grid preview (ADR 0013): cut positions in mm from the Plan origin, and Tile names. */
export interface TileOverlay {
  /** Column edges, left to right, including both Clip edges (view mm). */
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
  ): GuideLine[];
  /**
   * "Anordnen": Region `index`, whose top-left corner in the Layout was `startAt` when
   * the drag began, is being dragged from `from` to `to` (Layout mm). Returns guides.
   */
  arrangeRegion(index: number, startAt: Point, from: Point, to: Point, altKey: boolean, tolMm: number): GuideLine[];
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
/** Sharp renders kept for reuse: at least this many, more while they hold few pixels. */
const KEEP_LAYERS = 4;
const KEEP_PIXELS = 4 * MAX_RENDER_PIXELS;

const COLORS = {
  background: "#e9e9ec",
  outside: "rgba(30, 30, 40, 0.28)",
  clip: "#2563eb",
  other: "rgba(37, 99, 235, 0.55)",
  guide: "#f59e0b",
  checker: "#e4e6eb",
};

export class Viewer {
  private ctx: CanvasRenderingContext2D;
  private plan = { width: 1, height: 1 };
  private base: Layer | undefined;
  private layers: Layer[] = [];
  /** The Regions, in list order; `selected` has the handles. */
  private regions: Region[] = [];
  private selected: number | undefined;
  private guides: GuideLine[] = [];
  private mode: ViewMode = "plan";
  /** The view last used in each mode, restored when switching back. */
  private saved: Partial<Record<ViewMode, { cx: number; cy: number; zoom: number }>> = {};
  /** Pattern for the empty (transparent) part of the Clip in "Anordnen". */
  private checker: CanvasPattern | null = null;
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
        start: Region | undefined;
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
    this.saved = {};
    this.plan = { width: widthMm, height: heightMm };
    this.base = { bitmap: overview, rect: { x0: 0, y0: 0, x1: widthMm, y1: heightMm }, pxPerMm: overview.width / widthMm };
  }

  setRegions(regions: Region[], selected: number | undefined, guides: GuideLine[] = []): void {
    this.regions = regions;
    this.selected = selected;
    this.guides = guides;
    this.requestDraw();
    // In "Anordnen" moving a Region brings other parts of the Plan into view.
    if (this.mode === "arrange") this.scheduleRender();
  }

  get currentMode(): ViewMode {
    return this.mode;
  }

  /**
   * Switches between the Plan and the Clip as exported. Each mode keeps its own view;
   * the first time, it shows everything.
   */
  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.saved[this.mode] = { cx: this.cx, cy: this.cy, zoom: this.zoom };
    this.mode = mode;
    this.drag = undefined;
    this.guides = [];
    this.canvas.style.cursor = "";
    const v = this.saved[mode];
    if (!v) return this.fitPlan();
    this.cx = v.cx;
    this.cy = v.cy;
    this.zoom = v.zoom;
    this.viewUpdated();
  }

  /** Moves the view by (dx, dy) mm, e.g. to follow the Layout when it is shifted. */
  shiftView(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.cx += dx;
    this.cy += dy;
    this.viewUpdated();
  }

  /** What the view shows in full: the Plan, or in "Anordnen" the Clip. */
  private world(): ViewRect {
    return this.mode === "arrange" ? clipBounds(this.regions) : { x0: 0, y0: 0, x1: this.plan.width, y1: this.plan.height };
  }

  /** Where a Region lies in the view: on the Plan, or at its place in the Clip. */
  private box(r: Region): ClipMm {
    return this.mode === "arrange" ? placed(r) : r;
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
    const all = this.regions.map((r) => this.box(r));
    const shown = this.selected !== undefined && all[this.selected] ? [all[this.selected]!] : all;
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

  /** Show the whole Plan (in "Anordnen": the whole Clip), centred (the start view, ADR 0012). */
  fitPlan(): void {
    this.fitRect(this.world(), 0.02);
  }

  /** Fit the Plan's (Clip's) width into the view, with `topMm` near the top edge. */
  fitWidth(topMm = 0): void {
    this.measure();
    const w = this.world();
    this.zoom = clamp(this.cssW / (Math.max(1, w.x1 - w.x0) * 1.02), MIN_ZOOM, MAX_ZOOM);
    this.cx = (w.x0 + w.x1) / 2;
    const halfH = this.cssH / 2 / this.zoom;
    this.cy = Math.max(Math.min(topMm, w.y1) - 0.03 * 2 * halfH + halfH, w.y0 + halfH * 0.98);
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

  /** What a left press at screen point `s` grabs (see regionAt); in "Anordnen" a Region to move. */
  private targetAt(s: Point): { index: number; handle: Handle } | undefined {
    const p = this.toMm(s.x, s.y);
    if (this.mode === "plan") return regionAt(this.regions, this.selected, p, GRAB_PX / this.zoom);
    const inside = (i: number) => {
      const b = placed(this.regions[i]!);
      return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    };
    if (this.selected !== undefined && this.regions[this.selected] && inside(this.selected)) return { index: this.selected, handle: "move" };
    for (let i = this.regions.length - 1; i >= 0; i--) if (inside(i)) return { index: i, handle: "move" };
    return undefined;
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
      this.canvas.style.cursor = this.space ? "grab" : t ? CURSOR[t.handle] : this.mode === "plan" ? "crosshair" : "default";
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
    const to = this.toMm(s.x, s.y);
    const tol = GRAB_PX / this.zoom;
    let guides: GuideLine[];
    if (this.mode === "plan") guides = this.cb.dragRegion(d.index, d.mode, d.start, d.from, to, e.altKey, this.visible(), tol);
    else if (d.index !== undefined && d.start) guides = this.cb.arrangeRegion(d.index, d.start.at, d.from, to, e.altKey, tol);
    else return; // a drag on the empty Clip does nothing
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
    this.scheduleRender();
  }

  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.renderSharp(), RENDER_DELAY_MS);
  }

  /**
   * The parts of the Plan the view shows, in Plan mm, each with the area a render for
   * it may reach into: the visible part of the Plan, or in "Anordnen" the visible part
   * of each Region.
   */
  private visibleParts(): { need: ViewRect; bound: ViewRect }[] {
    const vis = this.visible();
    if (this.mode === "plan") {
      const page: ViewRect = { x0: 0, y0: 0, x1: this.plan.width, y1: this.plan.height };
      const need = intersect(vis, page);
      return need ? [{ need, bound: page }] : [];
    }
    const parts: { need: ViewRect; bound: ViewRect }[] = [];
    for (const r of this.regions) {
      const bound = { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
      const need = intersect(shift(vis, r.x - r.at.x, r.y - r.at.y), bound);
      if (need) parts.push({ need, bound });
    }
    return parts;
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
    if (want <= this.base.pxPerMm * 1.01) return; // overview is already sharp enough
    const todo = this.visibleParts().filter((p) => !this.layers.some((l) => l.pxPerMm >= want * 0.99 && covers(l.rect, p.need)));
    if (todo.length === 0) return;

    // Margin around the view so small pans stay sharp; shrink it if the images would be huge.
    let margin = 0.25;
    const rects = () => todo.map((p) => intersect(expand(p.need, margin), p.bound)!);
    let parts = rects();
    const total = () => parts.reduce((sum, r) => sum + area(r), 0);
    while (margin > 0 && total() * want * want > MAX_RENDER_PIXELS) {
      margin = Math.max(0, margin - 0.1);
      parts = rects();
    }
    const pxPerMm = Math.min(want, Math.sqrt(MAX_RENDER_PIXELS / total()));

    this.rendering = true;
    try {
      const base = this.base;
      for (const rect of parts) {
        const bitmap = await this.cb.render(rect, pxPerMm);
        // Another page or Plan was opened meanwhile: this image belongs to the old one.
        if (this.base !== base) {
          bitmap.close();
          this.renderAgain = true;
          break;
        }
        // Use the actual image size (pixel counts are rounded) so nothing shifts.
        this.layers.push({ bitmap, rect, pxPerMm: bitmap.width / (rect.x1 - rect.x0) });
        const pixels = () => this.layers.reduce((sum, l) => sum + l.bitmap.width * l.bitmap.height, 0);
        while (this.layers.length > KEEP_LAYERS && pixels() > KEEP_PIXELS) this.layers.shift()!.bitmap.close();
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

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (this.mode === "arrange") {
      this.drawArranged();
    } else {
      const tl = this.toScreen(0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(tl.x, tl.y, this.plan.width * this.zoom, this.plan.height * this.zoom);
      this.drawPlan(this.visible(), { x: 0, y: 0 });
      this.drawTiles();
      this.drawRegions();
    }
    this.drawGuides();
  }

  /** The Plan images within `vis` (Plan mm), drawn shifted by `off` mm. */
  private drawPlan(vis: ViewRect, off: Point): void {
    // Base first, then sharper layers on top (older first, so the newest wins).
    for (const layer of [this.base!, ...[...this.layers].sort((a, b) => a.pxPerMm - b.pxPerMm)]) this.drawLayer(layer, vis, off);
  }

  private drawLayer(l: Layer, vis: ViewRect, off: Point): void {
    const part = intersect(l.rect, vis);
    if (!part) return;
    const sx = (part.x0 - l.rect.x0) * l.pxPerMm;
    const sy = (part.y0 - l.rect.y0) * l.pxPerMm;
    const sw = (part.x1 - part.x0) * l.pxPerMm;
    const sh = (part.y1 - part.y0) * l.pxPerMm;
    const d = this.toScreen(part.x0 + off.x, part.y0 + off.y);
    this.ctx.drawImage(l.bitmap, sx, sy, sw, sh, d.x, d.y, (part.x1 - part.x0) * this.zoom, (part.y1 - part.y0) * this.zoom);
  }

  /** "Anordnen": the Clip as exported, each Region with its content at its place, empty space checkered. */
  private drawArranged(): void {
    const { ctx } = this;
    const vis = this.visible();
    const w = this.world();
    const a = this.toScreen(w.x0, w.y0);
    const cw = (w.x1 - w.x0) * this.zoom;
    const ch = (w.y1 - w.y0) * this.zoom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(a.x, a.y, cw, ch);
    this.checker ??= checkerPattern(ctx);
    if (this.checker) {
      ctx.fillStyle = this.checker;
      ctx.fillRect(a.x, a.y, cw, ch);
    }
    for (const r of this.regions) {
      const b = this.toScreen(r.at.x, r.at.y);
      const bw = r.width * this.zoom;
      const bh = r.height * this.zoom;
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, bw, bh);
      ctx.clip();
      ctx.fillStyle = "#fff";
      ctx.fillRect(b.x, b.y, bw, bh);
      const off = { x: r.at.x - r.x, y: r.at.y - r.y };
      const part = intersect(shift(vis, -off.x, -off.y), { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
      if (part) this.drawPlan(part, off);
      ctx.restore();
    }
    // The Clip's outline.
    ctx.save();
    ctx.strokeStyle = "rgba(30, 30, 40, 0.6)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(a.x) - 0.5, Math.round(a.y) - 0.5, Math.round(cw) + 1, Math.round(ch) + 1);
    ctx.restore();
    this.drawTiles();
    this.drawRegions();
  }

  private drawRegions(): void {
    const { ctx } = this;
    const boxes = this.regions.map((r) => {
      const c = this.box(r);
      const a = this.toScreen(c.x, c.y);
      return { x: a.x, y: a.y, w: c.width * this.zoom, h: c.height * this.zoom };
    });
    const arranging = this.mode === "arrange";
    // Dim everything outside the Regions on the Plan (they may overlap, so they are cut out of a layer).
    if (!arranging) this.dimOutside(boxes);

    // The others lighter, the selected one last (on top) with its handles; numbered if several.
    const order = boxes.map((_, i) => i).filter((i) => i !== this.selected);
    if (this.selected !== undefined && boxes[this.selected]) order.push(this.selected);
    for (const i of order) {
      const b = boxes[i]!;
      const sel = i === this.selected;
      ctx.strokeStyle = sel ? COLORS.clip : COLORS.other;
      ctx.lineWidth = sel ? 2 : arranging ? 1 : 1.5;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      // In "Anordnen" a Region is only moved, so it has no handles.
      if (sel && !arranging) {
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

  private dimOutside(boxes: { x: number; y: number; w: number; h: number }[]): void {
    const { ctx } = this;
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

function shift(r: ViewRect, dx: number, dy: number): ViewRect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/** A small checkerboard, the usual sign for "transparent". */
function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = COLORS.checker;
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  return ctx.createPattern(c, "repeat");
}

function expand(r: ViewRect, f: number): ViewRect {
  const dx = (r.x1 - r.x0) * f;
  const dy = (r.y1 - r.y0) * f;
  return { x0: r.x0 - dx, y0: r.y0 - dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

function area(r: ViewRect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}
