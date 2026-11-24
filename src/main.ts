import { startEngine } from "./engine/client";
import type { PlanInfo } from "./engine/protocol";
import type { ClipMm } from "./export/index";
import { chooseFolder, chooseSaveTarget, download, writeToFolder, type DirectoryHandle } from "./ui/save";
import { rowName, tiles, type TileGrid } from "./export/tilegrid";
import { TilesPanel } from "./ui/tilespanel";
import { zip, type ZipEntry } from "./ui/zip";
import { loadExportSettings, loadStoredRegions, storeRegions } from "./ui/storage";
import { PresetsPanel } from "./ui/presetspanel";
import { dragClip, onPlan, type Handle, type Point } from "./ui/clipdrag";
import {
  clipBounds,
  clipSize,
  layoutOffset,
  moveInLayout,
  normaliseLayout,
  placeNew,
  removeRegion,
  setRect,
  single,
  suggestLayout,
  type Region,
} from "./export/regions";
import { Minimap } from "./ui/minimap";
import { BUSY_TIMING, BusyWindow } from "./ui/busy";
import { exportBase, PagePicker, sourceLabel, type PageSize } from "./ui/pagepicker";
import { snapClip, type SnapIndex } from "./ui/snap";
import { Viewer, type GuideLine, type ViewMode, type ViewRect } from "./ui/viewer";

const PT_TO_MM = 25.4 / 72;
const MB = 1_000_000;
/** Typical whiteboard tools: above this, boards get sluggish (ADR 0009). */
const WHITEBOARD_RECOMMENDED = 2 * MB;
/** Typical whiteboard tools reject files above this. */
const WHITEBOARD_LIMIT = 45 * MB;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number) => v.toFixed(1);
const de = (v: number, digits = 1) => v.toLocaleString("de-DE", { maximumFractionDigits: digits });

$("version").textContent = `Version ${__APP_VERSION__} vom ${__BUILD_DATE__.split("-").reverse().join(".")}`;

// ---- About -----------------------------------------------------------------
const about = $<HTMLDialogElement>("about");
$("about-open").addEventListener("click", () => about.showModal());
$("about-close").addEventListener("click", () => about.close());

// ---- Busy window (ADR 0012) --------------------------------------------------
// Tests set `__busyDelayMs` to see the window even for fast jobs.
const busyDelay = (window as unknown as { __busyDelayMs?: number }).__busyDelayMs;
const busyWindow = new BusyWindow(
  {
    dialog: $<HTMLDialogElement>("busy"),
    text: $("busy-text"),
    time: $("busy-time"),
    bar: $<HTMLProgressElement>("busy-bar"),
    cancel: $<HTMLButtonElement>("busy-cancel"),
  },
  busyDelay === undefined ? BUSY_TIMING : { ...BUSY_TIMING, delayMs: busyDelay },
);

// ---- Engine ----------------------------------------------------------------
await busyWindow.start("PDF-Engine wird geladen…");
const engine = await startEngine().catch(async (e: unknown) => {
  await busyWindow.end();
  $("start-error").textContent = `Die PDF-Engine konnte nicht geladen werden: ${String(e)}`;
  throw e;
});
void busyWindow.end();
busyWindow.immediate = engine.mode === "main-thread";
document.body.dataset.engine = engine.mode;

// ---- State ---------------------------------------------------------------
/** The Plan: one page of the opened Document (ADR 0014). */
let plan:
  | {
      name: string;
      fileName: string;
      /** Every page of the Document. */
      pages: PageSize[];
      /** The chosen page, 0-based. */
      page: number;
      widthMm: number;
      heightMm: number;
    }
  | undefined;
/** The Clip: its Regions with their Layout (ADR 0016), and the Region being edited. */
let regions: Region[] = [];
let selected: number | undefined;
/** While a drag draws a new Region: its index, once it exists. */
let drawing: number | undefined;
/** Step 2's mode (ADR 0016): "Bereiche wählen" (the Plan) or "Anordnen" (the Clip as exported). */
let mode: ViewMode = "plan";
let snapIndex: SnapIndex | undefined;
const snapToggle = $<HTMLInputElement>("snap");

// ---- Minimap (ADR 0012) ----------------------------------------------------
const minimap = new Minimap(
  {
    root: $("minimap"),
    canvas: $<HTMLCanvasElement>("overview-canvas"),
    regions: $("region-boxes"),
    viewBox: $("view-box"),
    tileGrid: document.getElementById("tile-grid") as unknown as SVGSVGElement,
    collapse: $<HTMLButtonElement>("minimap-collapse"),
    expand: $<HTMLButtonElement>("minimap-expand"),
  },
  $("viewer"),
  (p) => viewer.centerOn(p),
);

/** x, y, width, height of the selected Region. */
const fields = {
  x: $<HTMLInputElement>("clip-x"),
  y: $<HTMLInputElement>("clip-y"),
  width: $<HTMLInputElement>("clip-w"),
  height: $<HTMLInputElement>("clip-h"),
};

/** A Region's rectangle kept on the Plan, at least 1 mm in each direction. */
function clampRect(c: ClipMm): ClipMm {
  if (!plan) return c;
  const x = Math.min(Math.max(0, c.x), plan.widthMm - 1);
  const y = Math.min(Math.max(0, c.y), plan.heightMm - 1);
  return {
    x,
    y,
    width: Math.min(Math.max(1, c.width), plan.widthMm - x),
    height: Math.min(Math.max(1, c.height), plan.heightMm - y),
  };
}

const rectOf = (r: Region): ClipMm => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/**
 * Shows the Regions everywhere (view, minimap, list, fields, Tile grid) and remembers
 * them (ADR 0007). With `from: "fields"` the fields keep what is being typed.
 */
function setRegions(next: Region[], sel: number | undefined, from: "fields" | "other" = "other", guides: GuideLine[] = []): void {
  regions = next;
  selected = sel !== undefined && sel < next.length ? sel : undefined;
  // "Anordnen" needs at least two Regions (ADR 0016).
  if (mode === "arrange" && regions.length < 2) return setMode("plan");
  const cur = selected === undefined ? undefined : regions[selected];
  // On the Plan: the Region's rectangle; in "Anordnen": its place in the Clip (size read-only).
  const shown = cur && (mode === "plan" ? rectOf(cur) : { x: cur.at.x - clipBounds(regions).x0, y: cur.at.y - clipBounds(regions).y0, width: cur.width, height: cur.height });
  for (const [k, input] of Object.entries(fields) as [keyof ClipMm, HTMLInputElement][]) {
    input.disabled = !shown;
    input.readOnly = mode === "arrange" && (k === "width" || k === "height");
    if (!shown) input.value = "";
    else if (from !== "fields") input.value = fmt(shown[k]);
  }
  $("fields-caption").textContent = cur ? `Bereich ${selected! + 1} ${mode === "plan" ? "auf dem Plan" : "im Ausschnitt"}` : "";
  viewer.setRegions(regions, selected, guides);
  minimap.setRegions(regions, selected);
  storeRegions(regions);
  tilesPanel.update({ x: 0, y: 0, ...clipSize(regions) });
  showRegionList();
  showTileGrid();
  updateButtons();
}

/** The list "Bereich 1, 2, …" with a remove button each, and the Clip's size. */
function showRegionList(): void {
  $("regions").replaceChildren(
    ...regions.map((_, i) => {
      const li = document.createElement("li");
      li.classList.toggle("selected", i === selected);
      const pick = document.createElement("button");
      pick.className = "pick";
      pick.textContent = `Bereich ${i + 1}`;
      pick.addEventListener("click", () => setRegions(regions, i));
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.textContent = "×";
      remove.title = `Bereich ${i + 1} entfernen`;
      remove.setAttribute("aria-label", `Bereich ${i + 1} entfernen`);
      remove.addEventListener("click", () => removeAt(i));
      li.append(pick, remove);
      return li;
    }),
  );
  $("regions").hidden = regions.length === 0;
  $("no-region").hidden = regions.length > 0;
  const size = clipSize(regions);
  $("clip-size").textContent =
    regions.length === 0 ? "" : `Ausschnitt: ${de(size.width)} × ${de(size.height)} mm${regions.length > 1 ? ` aus ${regions.length} Bereichen` : ""}`;
  $("relayout").hidden = regions.length < 2;
  $("modes").hidden = regions.length < 2;
}

/** Switches step 2 between "Bereiche wählen" and "Anordnen" (ADR 0016). */
function setMode(next: ViewMode): void {
  if (next === "arrange" && regions.length < 2) next = "plan";
  if (next !== mode) {
    mode = next;
    drawing = undefined;
    viewer.setMode(mode);
    minimap.setMode(mode === "arrange");
  }
  const arranging = mode === "arrange";
  $("mode-plan").setAttribute("aria-pressed", String(!arranging));
  $("mode-arrange").setAttribute("aria-pressed", String(arranging));
  $("hint-plan").hidden = arranging;
  $("hint-arrange").hidden = !arranging;
  document.body.dataset.mode = mode;
  $("zoom-plan").textContent = arranging ? "Ganzer Ausschnitt" : "Ganzer Plan";
  $("zoom-width").textContent = arranging ? "Ausschnittbreite" : "Planbreite";
  setRegions(regions, selected);
}

$("mode-plan").addEventListener("click", () => setMode("plan"));
$("mode-arrange").addEventListener("click", () => setMode("arrange"));

/**
 * Shifts the Layout so the Clip starts at (0, 0) again after a Region went past its
 * start or left it; the view follows, so nothing jumps on screen.
 */
function normaliseNow(): void {
  const off = layoutOffset(regions);
  if (Math.abs(off.x) < 1e-9 && Math.abs(off.y) < 1e-9) return;
  setRegions(normaliseLayout(regions), selected);
  if (mode === "arrange") viewer.shiftView(-off.x, -off.y);
}

/** "Anordnen": moves the selected Region in the Clip to `want` (see moveInLayout). */
function arrangeTo(index: number, want: { x: number; y: number }, opts: { snapMm?: number; jump?: boolean }, from: "fields" | "other" = "other"): GuideLine[] {
  const r = moveInLayout(regions, index, want, opts);
  setRegions(r.regions, index, from, r.guides);
  return r.guides;
}

/** Removes a Region; the others are renumbered without gaps (ADR 0016). */
function removeAt(i: number): void {
  const sel = selected === undefined || selected === i ? undefined : selected > i ? selected - 1 : selected;
  setRegions(removeRegion(regions, i), sel);
}

$("relayout").addEventListener("click", () => setRegions(suggestLayout(regions), selected));

for (const input of Object.values(fields)) {
  input.addEventListener("input", () => {
    if (selected === undefined || input.readOnly) return;
    const v = { x: Number(fields.x.value), y: Number(fields.y.value), width: Number(fields.width.value), height: Number(fields.height.value) };
    if (!Object.values(v).every(Number.isFinite)) return;
    if (mode === "plan") setRegions(setRect(regions, selected, clampRect(v)), selected, "fields");
    else {
      // The Layout is normalised only when the field is left, so a typed value means the same throughout.
      arrangeTo(selected, { x: v.x, y: v.y }, { jump: true }, "fields");
    }
  });
  input.addEventListener("change", () => {
    normaliseNow();
    setRegions(regions, selected); // normalise display on blur
  });
}

/**
 * A drag in the precision view, with snapping: Region `index` by `handle`, or a new
 * Region drawn on empty Plan (`index` undefined). A new Region is placed beside the
 * existing Layout (ADR 0016) as it grows.
 */
function applyDrag(
  index: number | undefined,
  handle: Handle,
  start: ClipMm | undefined,
  from: Point,
  to: Point,
  altKey: boolean,
  visible: ViewRect,
  tolMm: number,
): GuideLine[] {
  if (!plan) return [];
  const size = { width: plan.widthMm, height: plan.heightMm };
  let c = dragClip(start ?? { x: from.x, y: from.y, width: 0, height: 0 }, handle, from, to, size);
  let guides: GuideLine[] = [];
  if (snapIndex && snapToggle.checked && !altKey) {
    const r = snapClip(c, handle, snapIndex, tolMm, visible, { from, to });
    // A snap line outside the Plan (content can overhang the page) must not push an edge off it.
    if (onPlan(r.clip, size)) {
      c = r.clip;
      guides = r.guides;
    }
  }
  const rect = clampRect(c);
  if (index !== undefined) {
    setRegions(setRect(regions, index, rect), index, "other", guides);
  } else if (drawing === undefined) {
    drawing = regions.length;
    setRegions([...regions, placeNew(regions, rect)], drawing, "other", guides);
  } else {
    const others = regions.filter((_, i) => i !== drawing);
    setRegions(regions.map((r, i) => (i === drawing ? placeNew(others, rect) : r)), drawing, "other", guides);
  }
  return guides;
}

// ---- Export settings, Presets (ADR 0015), Tile grid preview (ADR 0013) ------------
const exportSettings = loadExportSettings();
const tilesPanel = new TilesPanel(exportSettings.tiles, () => {
  presets.changed();
  showTileGrid();
  updateButtons();
});
const presets = new PresetsPanel(tilesPanel, exportSettings.svg);

/** The current Tile grid, if Tiled Export is on and the settings are valid. */
function currentGrid(): TileGrid | undefined {
  const g = tilesPanel.grid;
  return g && !("error" in g) ? g : undefined;
}

function showTileGrid(): void {
  const g = currentGrid();
  // On the Plan only for a one-Region Clip; a stitched Clip's grid is drawn in "Anordnen" (ADR 0016).
  const b = clipBounds(regions);
  const clip = mode === "arrange" ? { x: b.x0, y: b.y0 } : regions.length === 1 ? regions[0]! : undefined;
  if (!g || !plan || !clip) {
    viewer.setTiles(undefined);
    minimap.setTiles(undefined);
    return;
  }
  const xs = [clip.x, ...g.columns.map((c) => clip.x + c.start + c.length)];
  const ys = [clip.y, ...g.rows.map((r) => clip.y + r.start + r.length)];
  viewer.setTiles({ xs, ys, name: (r, c) => rowName(r) + String(c + 1) });
  minimap.setTiles({ xs, ys });
}

// ---- Precision view ------------------------------------------------------
const viewer = new Viewer($<HTMLCanvasElement>("viewer-canvas"), {
  async render(rect, pxPerMm) {
    const r = await engine.renderRegion({
      xMm: rect.x0,
      yMm: rect.y0,
      widthMm: rect.x1 - rect.x0,
      heightMm: rect.y1 - rect.y0,
      pxPerMm,
    });
    return createImageBitmap(new ImageData(r.pixels as Uint8ClampedArray<ArrayBuffer>, r.width, r.height));
  },
  dragRegion: applyDrag,
  arrangeRegion(index, startAt, from, to, altKey, tolMm) {
    const snap = snapToggle.checked && !altKey ? tolMm : undefined;
    return arrangeTo(index, { x: startAt.x + to.x - from.x, y: startAt.y + to.y - from.y }, { snapMm: snap });
  },
  dragEnd() {
    drawing = undefined;
    normaliseNow();
  },
  select(index) {
    drawing = undefined;
    setRegions(regions, index);
  },
  viewChanged(visible, zoomPercent) {
    $("zoom-label").textContent = `${zoomPercent < 10 ? de(zoomPercent, 1) : Math.round(zoomPercent)} %`;
    if (!plan) return;
    minimap.setView(visible);
  },
});
const showPlanWidth = () => viewer.fitWidth(viewer.visible().y0);
$("zoom-plan").addEventListener("click", () => viewer.fitPlan());
$("zoom-in").addEventListener("click", () => viewer.zoomBy(1.5));
$("zoom-out").addEventListener("click", () => viewer.zoomBy(1 / 1.5));
$("zoom-100").addEventListener("click", () => viewer.zoomTo100());
$("zoom-clip").addEventListener("click", () => viewer.fitClip());
$("zoom-width").addEventListener("click", showPlanWidth);

// ---- Keyboard ----------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (!plan || document.querySelector("dialog[open]") || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select")) return; // typing in a field
  const step = e.shiftKey ? 1 : 0.1;
  const move = (dx: number, dy: number) => {
    if (selected === undefined) return;
    const r = regions[selected]!;
    if (mode === "plan") setRegions(setRect(regions, selected, clampRect({ ...rectOf(r), x: r.x + dx, y: r.y + dy })), selected);
    else {
      arrangeTo(selected, { x: r.at.x + dx, y: r.at.y + dy }, {});
      normaliseNow();
    }
  };
  switch (e.key) {
    case " ":
      viewer.setSpace(true); // Space + left drag pans (touchpads, ADR 0012)
      break;
    case "Delete":
      // In "Anordnen" Regions are only moved (ADR 0016).
      if (selected !== undefined && mode === "plan") removeAt(selected);
      break;
    case "b":
    case "B":
      setMode("plan");
      break;
    case "a":
    case "A":
      if (regions.length < 2) return;
      setMode("arrange");
      break;
    case "+":
    case "=":
      viewer.zoomBy(1.5);
      break;
    case "-":
      viewer.zoomBy(1 / 1.5);
      break;
    case "1":
      viewer.fitPlan();
      break;
    case "2":
      showPlanWidth();
      break;
    case "3":
      viewer.zoomTo100();
      break;
    case "f":
    case "F":
      viewer.fitClip();
      break;
    case "ArrowLeft":
      move(-step, 0);
      break;
    case "ArrowRight":
      move(step, 0);
      break;
    case "ArrowUp":
      move(0, -step);
      break;
    case "ArrowDown":
      move(0, step);
      break;
    default:
      return;
  }
  e.preventDefault();
});

window.addEventListener("keyup", (e) => {
  if (e.key !== " ") return;
  viewer.setSpace(false);
  // A focused button would otherwise be pressed by the Space used for panning.
  if (!(e.target as HTMLElement).closest("input, textarea, select")) e.preventDefault();
});
window.addEventListener("blur", () => viewer.setSpace(false));

// ---- Open a Plan -----------------------------------------------------------
function showDetails(info: PlanInfo): void {
  const rows: [string, string][] = [["Seiten", String(info.pageCount)]];
  for (const [name, b] of Object.entries(info.boxes)) rows.push([name, `${fmt(b.widthPt * PT_TO_MM)} × ${fmt(b.heightPt * PT_TO_MM)} mm`]);
  rows.push(["UserUnit", String(info.userUnit)], ["Drehung", `${info.rotate}°`]);
  $<HTMLTableElement>("plan-details").replaceChildren(
    ...rows.map(([k, v]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      const td = document.createElement("td");
      th.textContent = k;
      td.textContent = v;
      tr.append(th, td);
      return tr;
    }),
  );
}

// ---- Page picker and page switching (ADR 0014) ---------------------------------
const picker = new PagePicker(
  { dialog: $<HTMLDialogElement>("pages"), info: $("pages-info"), grid: $("pages-grid"), cancel: $<HTMLButtonElement>("pages-cancel") },
  (page, maxWidthPx, maxHeightPx) => engine.renderThumbnail({ page, maxWidthPx, maxHeightPx }),
);
/** Bumped for every page shown, so the results of an older one are dropped. */
let loadGeneration = 0;
let loading = false;

function updatePager(): void {
  const multi = !!plan && plan.pages.length > 1;
  $("pager").hidden = !multi;
  if (!plan || !multi) return;
  $("page-no").textContent = String(plan.page + 1);
  $("page-count").textContent = String(plan.pages.length);
  const off = loading || busy;
  $<HTMLButtonElement>("page-prev").disabled = off || plan.page === 0;
  $<HTMLButtonElement>("page-next").disabled = off || plan.page === plan.pages.length - 1;
  $<HTMLButtonElement>("page-pick").disabled = off;
}

/** Makes a page of the (candidate or current) Document the Plan. */
async function showPage(doc: { name: string; fileName: string; pages: PageSize[] }, index: number, t0 = performance.now()): Promise<void> {
  const gen = ++loadGeneration;
  loading = true;
  updateButtons();
  await busyWindow.start(doc.pages.length > 1 ? `Seite ${index + 1} wird geöffnet…` : "Plan wird geöffnet…");
  snapIndex = undefined;
  delete document.body.dataset.snapReady;
  const snapStatus = $("snap-status");
  try {
    const info = await engine.openPage(index);
    const preview = await engine.renderPreview();
    const bitmap = await createImageBitmap(new ImageData(preview.pixels as Uint8ClampedArray<ArrayBuffer>, preview.widthPx, preview.heightPx));
    if (gen !== loadGeneration) return;
    const sameFile = plan?.fileName === doc.fileName && plan.pages === doc.pages;
    plan = { ...doc, page: index, widthMm: info.widthPt * PT_TO_MM, heightMm: info.heightPt * PT_TO_MM };
    showDetails(info);

    $("start").hidden = true;
    $("workspace").hidden = false;
    $("plan-chip").hidden = false;
    $("plan-name").textContent = doc.fileName;
    if (!sameFile) {
      $("export-status").replaceChildren();
      $("result-img").hidden = true;
    }
    viewer.setPlan(plan.widthMm, plan.heightMm, bitmap);
    minimap.setPlan(plan.widthMm, plan.heightMm, bitmap);
    if (mode !== "plan") {
      mode = "plan";
      viewer.setMode("plan");
    }

    // Restore the last Regions if they fit this page (ADR 0007), else one sensible Region.
    const stored = loadStoredRegions();
    const { widthMm, heightMm } = plan;
    const fits =
      stored &&
      stored.length > 0 &&
      stored.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= widthMm + 0.05 && r.y + r.height <= heightMm + 0.05);
    drawing = undefined;
    setRegions(
      fits ? stored.map((r) => ({ ...clampRect(r), at: r.at })) : single({ x: 0, y: 0, width: widthMm, height: Math.min(600, heightMm) }),
      0,
    );
    setMode("plan");
    // Start with the whole Plan in view (ADR 0012): an overview first, not "in the thick of it".
    viewer.fitPlan();

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("plan-info").textContent = `${de(plan.widthMm)} × ${de(plan.heightMm)} mm · geladen in ${secs.replace(".", ",")} s`;
    document.body.dataset.page = String(index + 1);
    loading = false;
    updateButtons();
    void busyWindow.end();

    // The Plan is usable meanwhile; only snapping waits, so a small inline spinner.
    snapStatus.textContent = "Einrasten wird vorbereitet…";
    snapStatus.classList.add("loading");
    const t1 = performance.now();
    const targets = await engine.snapTargets();
    if (gen !== loadGeneration) return;
    snapIndex = targets;
    const n = snapIndex.vertical.pos.length + snapIndex.horizontal.pos.length;
    snapStatus.classList.remove("loading");
    snapStatus.textContent = `${n.toLocaleString("de-DE")} Linien zum Einrasten gefunden (${de((performance.now() - t1) / 1000)} s).`;
    document.body.dataset.snapReady = "1";
  } catch (e) {
    if (gen !== loadGeneration) return;
    void busyWindow.end();
    snapStatus.classList.remove("loading");
    const msg = `${doc.pages.length > 1 ? `Seite ${index + 1}` : "Der Plan"} konnte nicht geöffnet werden: ${String(e)}`;
    if (plan) $("plan-info").textContent = msg;
    else $("start-error").textContent = msg;
  } finally {
    if (gen === loadGeneration) {
      loading = false;
      updateButtons();
    }
  }
}

/** Opens a file: straight away if it has one page, else after the page picker. */
async function openFile(file: File): Promise<void> {
  if (picker.isOpen || loading || busyWindow.active) return;
  const t0 = performance.now();
  await busyWindow.start("Plan wird geöffnet…");
  $("start-error").textContent = "";
  let pages: PageSize[];
  try {
    pages = (await engine.openDocument(await file.arrayBuffer())).pages;
    if (pages.length === 0) throw new Error("keine Seiten");
  } catch (e) {
    await busyWindow.end();
    const msg = `Der Plan konnte nicht geöffnet werden: ${String(e)}`;
    if (plan) $("plan-info").textContent = msg;
    else $("start-error").textContent = msg;
    return;
  }
  const doc = { name: file.name.replace(/\.pdf$/i, ""), fileName: file.name, pages };
  // One page: the same window carries on with opening it.
  if (pages.length === 1) return showPage(doc, 0, t0);

  await busyWindow.end();
  const index = await picker.pick(pages, file.name);
  if (index === undefined) {
    // Cancelled: keep the current Plan, or stay on the start screen.
    await engine.discardDocument();
    return;
  }
  return showPage(doc, index);
}

async function pickPage(): Promise<void> {
  if (!plan || picker.isOpen || loading || busy) return;
  const index = await picker.pick(plan.pages, plan.fileName, plan.page);
  if (index !== undefined && plan && index !== plan.page) await showPage(plan, index);
}

$("page-pick").addEventListener("click", () => void pickPage());
$("page-prev").addEventListener("click", () => plan && plan.page > 0 && void showPage(plan, plan.page - 1));
$("page-next").addEventListener("click", () => plan && plan.page < plan.pages.length - 1 && void showPage(plan, plan.page + 1));

const input = $<HTMLInputElement>("file");
input.disabled = false;
$<HTMLButtonElement>("choose").disabled = false;
$("choose").addEventListener("click", () => input.click());
$("open-other").addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void openFile(file);
  input.value = ""; // allow re-opening the same file
});

// Drag & drop a PDF anywhere onto the window.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) document.body.classList.remove("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (busyWindow.active) return; // blocked while busy
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (file) void openFile(file);
  else if (!plan) $("start-error").textContent = "Bitte eine PDF-Datei ablegen.";
});

// ---- Export ----------------------------------------------------------------
const exportButton = $<HTMLButtonElement>("export-svg");
const pdfButton = $<HTMLButtonElement>("export-pdf");
const status = $("export-status");
let busy = false;

/** SVG is not available while tiling (ADR 0013); nothing runs twice at once. */
function updateButtons(): void {
  const tiling = tilesPanel.settings.enabled;
  // The last Region can be removed: then there is nothing to export (ADR 0016).
  const none = regions.length === 0;
  exportButton.disabled = busy || loading || tiling || none;
  pdfButton.disabled = busy || loading || (tiling && !currentGrid()) || none;
  $("export-hint").hidden = !none;
  const why = none ? "Ziehe auf dem Plan einen Bereich auf." : tiling ? "SVG-Export ist beim Aufteilen auf Blätter nicht verfügbar." : "";
  pdfButton.title = none ? why : "";
  $("svg-wrap").title = why;
  exportButton.title = why;
  $("svg-note").hidden = !tiling;
  pdfButton.textContent = tiling ? "Kacheln exportieren" : "PDF exportieren";
  exportButton.classList.toggle("primary", !tiling);
  pdfButton.classList.toggle("primary", tiling);
  pdfButton.parentElement!.classList.toggle("tiling", tiling);
  updatePager();
}
updateButtons();

function note(text: string, cls = ""): void {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  status.append(p);
}

exportButton.addEventListener("click", async () => {
  if (!plan) return;
  const { mergeMode, textAsPaths } = presets.current().svg;
  // Ask where to save first: the dialog needs the click, which a long export outlasts.
  const save = await chooseSaveTarget(`${exportBase(plan.name, plan.page, plan.pages.length)}.svg`, "SVG-Grafik", "image/svg+xml", ".svg");
  if (!save) return; // cancelled
  busy = true;
  updateButtons();
  status.replaceChildren();
  await busyWindow.start("SVG wird berechnet…", { button: exportButton });
  try {
    const r = await engine.exportSvg({ clip: normaliseLayout(regions), page: plan.page, mergeMode, textAsPaths, reuseShapes: false });
    const blob = new Blob([r.svg as BlobPart], { type: "image/svg+xml" });
    const size = blob.size;
    void busyWindow.end();

    note(
      `SVG: ${de(size / MB, 2)} MB · ${r.elements.toLocaleString("de-DE")} Elemente ` +
        `(aus ${r.sourceItems.toLocaleString("de-DE")} PDF-Objekten) · ${de(r.seconds)} s`,
    );
    if (size > WHITEBOARD_LIMIT) {
      note(
        "Achtung: größer als 45 MB. Gängige Whiteboard-Programme nehmen Dateien dieser Größe nicht an. " +
          "Bitte den Ausschnitt verkleinern oder in mehrere Ausschnitte aufteilen.",
        "severe",
      );
    } else if (size > WHITEBOARD_RECOMMENDED) {
      note("Hinweis: größer als 2 MB. In Whiteboard-Programmen kann das Board dadurch träge werden.", "warn");
    }
    const unsupported = Object.entries(r.unsupported);
    if (unsupported.length > 0)
      note("Nicht vollständig übernommen: " + unsupported.map(([k, n]) => `${k} (${n}×)`).join(", "), "warn");

    const resultImg = $<HTMLImageElement>("result-img");
    URL.revokeObjectURL(resultImg.src);
    resultImg.src = URL.createObjectURL(blob);
    resultImg.hidden = false;

    await save(blob);
  } catch (e) {
    void busyWindow.end();
    status.textContent = `SVG-Export fehlgeschlagen: ${String(e)}`;
  } finally {
    busy = false;
    updateButtons();
  }
});

/** A content stream the path cut could not read (ADR 0005, #35). */
const UNCUT_HINT =
  "Hinweis: Ein Teil des Plans ließ sich nicht vollständig lesen. Linien, die dort über den Rand des Ausschnitts reichen, " +
  "wurden nicht an der Kante abgeschnitten (sie sind nur verdeckt).";

// PDF export (for documentation; ADR 0005)
pdfButton.addEventListener("click", async () => {
  if (!plan) return;
  if (tilesPanel.settings.enabled) return exportTiles();
  // Ask where to save first: the dialog needs the click, which a long export outlasts.
  const save = await chooseSaveTarget(`${exportBase(plan.name, plan.page, plan.pages.length)}.pdf`, "PDF-Dokument", "application/pdf", ".pdf");
  if (!save) return; // cancelled
  busy = true;
  updateButtons();
  status.replaceChildren();
  await busyWindow.start("PDF wird erstellt…", { button: pdfButton });
  try {
    const r = await engine.exportPdf({ clip: normaliseLayout(regions), page: plan.page, sourceName: sourceLabel(plan.fileName, plan.page, plan.pages.length) });
    const blob = new Blob([r.pdf as BlobPart], { type: "application/pdf" });
    void busyWindow.end();
    note(`PDF: ${de(blob.size / MB, 2)} MB · ${de(r.seconds)} s · Inhalte außerhalb des Ausschnitts entfernt`);
    if (r.uncut > 0) note(UNCUT_HINT, "warn");
    if (!r.normalised)
      note(
        "Der Ausschnitt ist länger als 5,08 m. Das PDF behält deshalb den Maßstabsfaktor (UserUnit) des Plans; " +
          "manche Programme zeigen es dadurch verkleinert an.",
        "warn",
      );
    $("result-img").hidden = true;
    await save(blob);
  } catch (e) {
    void busyWindow.end();
    status.textContent = `PDF-Export fehlgeschlagen: ${String(e)}`;
  } finally {
    busy = false;
    updateButtons();
  }
});

// Tiled Export (ADR 0013): one engine call per Tile, with progress and cancel.
async function exportTiles(): Promise<void> {
  const g = currentGrid();
  if (!plan || !g) return;
  const multipage = tilesPanel.settings.output === "multipage";
  const list = tiles(g);
  const base = exportBase(plan.name, plan.page, plan.pages.length);

  // Ask where to save first: the dialogs need the click that started the export.
  let folder: DirectoryHandle | undefined;
  let writeBook: ((blob: Blob) => Promise<void>) | undefined;
  if (multipage) {
    const w = await chooseSaveTarget(`${base}_Kacheln.pdf`, "PDF-Dokument", "application/pdf", ".pdf");
    if (!w) return;
    writeBook = w;
  } else {
    const f = await chooseFolder();
    if (f === null) return; // cancelled
    folder = f; // undefined: no folder picker, the Tiles go into a ZIP download
  }

  busy = true;
  updateButtons();
  $("result-img").hidden = true;
  status.replaceChildren();
  // The engine stops between Tiles, so here (only) the window offers "Abbrechen".
  let cancelled = false;
  await busyWindow.start("Ausschnitt wird vorbereitet…", { button: pdfButton, cancel: () => (cancelled = true) });

  const t0 = performance.now();
  const zipped: ZipEntry[] = [];
  let bytes = 0;
  let done = 0;
  let uncut = 0;
  try {
    await engine.tilesBegin({
      clip: normaliseLayout(regions),
      page: plan.page,
      sourceName: sourceLabel(plan.fileName, plan.page, plan.pages.length),
      date: new Date(),
      multipage,
      rows: g.rows.length,
      columns: g.columns.length,
      marginMm: g.marginMm,
    });
    for (const t of list) {
      if (cancelled) break;
      busyWindow.text(`Kachel ${done + 1} von ${list.length} (${t.name})…`);
      busyWindow.progress(done, list.length);
      const r = await engine.tile(t);
      uncut += r.uncut ?? 0;
      if (r.pdf) {
        bytes += r.pdf.length;
        const name = `${base}_Kachel_${t.name}.pdf`;
        if (folder) await writeToFolder(folder, name, new Blob([r.pdf as BlobPart], { type: "application/pdf" }));
        else zipped.push({ name, data: r.pdf });
      }
      done++;
    }
    if (cancelled) {
      await engine.tilesAbort();
      void busyWindow.end();
      note(
        folder && done > 0
          ? `Abgebrochen. ${done} von ${list.length} Kacheln wurden in den Ordner „${folder.name}“ geschrieben.`
          : "Abgebrochen. Es wurde nichts gespeichert.",
        "warn",
      );
      return;
    }
    busyWindow.cancellable(false);
    busyWindow.progress(done, list.length);
    busyWindow.text("Wird gespeichert…");
    const fin = await engine.tilesFinish();
    const n = list.length.toLocaleString("de-DE");
    const secs = `${de((performance.now() - t0) / 1000)} s`;
    if (writeBook && fin.pdf) {
      const blob = new Blob([fin.pdf as BlobPart], { type: "application/pdf" });
      await writeBook(blob);
      note(`Mehrseitige PDF mit ${n} Seiten: ${de(blob.size / MB, 2)} MB · ${secs}`);
    } else if (folder) {
      note(`${n} Kacheln im Ordner „${folder.name}“ gespeichert: ${de(bytes / MB, 2)} MB · ${secs}`);
    } else {
      download(zip(zipped), `${base}_Kacheln.zip`);
      note(`${n} Kacheln als ZIP-Datei gespeichert (kein Ordner-Dialog verfügbar): ${de(bytes / MB, 2)} MB · ${secs}`);
    }
    void busyWindow.end();
    note(
      g.marginMm >= 2
        ? "Inhalte außerhalb jeder Kachel entfernt. Zum Zusammensetzen den Rand an den Schnittmarken abschneiden."
        : "Inhalte außerhalb jeder Kachel entfernt. Die Blätter ohne Rand Kante an Kante zusammensetzen.",
      "muted",
    );
    if (uncut > 0) note(UNCUT_HINT, "warn");
  } catch (e) {
    await engine.tilesAbort().catch(() => undefined);
    void busyWindow.end();
    status.textContent = `Kachel-Export fehlgeschlagen: ${String(e)}`;
  } finally {
    busy = false;
    updateButtons();
  }
}
