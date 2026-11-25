import { startEngine } from "./engine/client";
import type { PlanInfo } from "./engine/protocol";
import type { ClipMm } from "./export/index";
import { chooseFolder, chooseSaveTarget, download, writeToFolder, type DirectoryHandle } from "./ui/save";
import { rowName, tiles, type TileGrid } from "./export/tilegrid";
import { TilesPanel } from "./ui/tilespanel";
import { zip, type ZipEntry } from "./ui/zip";
import { loadClipPresets, loadExportSettings, loadStoredRegions, storeClipPresets, storeRegions } from "./ui/storage";
import {
  CLIP_PRESET_NAMES,
  clipPresetsFromJson,
  clipPresetsToJson,
  fitClip,
  sameClip,
  stretchNote,
  type ClipPreset,
  type PlanSize,
  type SavedClip,
  type Stretch,
} from "./ui/clippresets";
import { PresetMenu } from "./ui/presetmenu";
import { PresetsPanel } from "./ui/presetspanel";
import { dragClip, onPlan, type Handle, type Point } from "./ui/clipdrag";
import {
  clipBounds,
  clipSize,
  layoutOffset,
  moveInLayout,
  normaliseLayout,
  placeNew,
  reorderRegion,
  removeRegion,
  setRect,
  single,
  suggestLayout,
  type Region,
} from "./export/regions";
import { Minimap } from "./ui/minimap";
import { BUSY_TIMING, BusyWindow } from "./ui/busy";
import { exportBase, PagePicker, sourceLabel, type PageSize } from "./ui/pagepicker";
import { setUpPanelResize, setUpStepFolding } from "./ui/sidebar";
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
$("about-open").addEventListener("click", () => {
  about.showModal();
  about.querySelector(".body")!.scrollTop = 0;
});
$("about-close").addEventListener("click", () => about.close());
// "Wie geht's?" under the empty Region list opens About at that chapter (#50).
$("howto-link").addEventListener("click", (e) => {
  e.preventDefault();
  about.showModal();
  const howto = $("about-howto");
  howto.scrollIntoView({ block: "start" });
  howto.focus({ preventScroll: true });
});

// ---- Sidebar: width and folded steps (#50) -----------------------------------
setUpPanelResize($("workspace"), $("panel-resize"));
setUpStepFolding($("panel"));

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
const planSize = (): PlanSize | undefined => plan && { widthMm: plan.widthMm, heightMm: plan.heightMm };

/** The Regions as a set, for telling an edit from a mere selection or renumbering. */
const geometry = (rs: readonly Region[]) => rs.map((r) => JSON.stringify([r.x, r.y, r.width, r.height, r.at.x, r.at.y])).sort().join();

// ---- Stretch note (ADR 0007) -------------------------------------------------------
/** Shows how a restored or loaded Clip was stretched to this Plan, or hides the note. */
function showStretch(s: Stretch | undefined): void {
  $("stretch-note").hidden = !s;
  $("stretch-text").textContent = s ? stretchNote(s) : "";
}
$("stretch-close").addEventListener("click", () => showStretch(undefined));

/** Regions restored or loaded onto this Plan: selected first Region, stretch note if stretched. */
function loadRegions(next: { regions: Region[]; stretch?: Stretch }): void {
  drawing = undefined;
  setRegions(next.regions, 0);
  showStretch(next.stretch);
}

// ---- Clip presets (ADR 0015) ------------------------------------------------------
const clipPresets = new PresetMenu<ClipPreset, SavedClip>({
  prefix: "clip-",
  rules: CLIP_PRESET_NAMES,
  plural: "Ausschnitt-Vorlagen",
  fileName: "simplepdfclipper-Ausschnitt-Vorlagen.json",
  overwriteLabel: (name) => `„${name}“ mit dem aktuellen Ausschnitt überschreiben`,
  changedTitle: "Bereiche geändert. Vorlage erneut wählen, um sie wiederherzustellen.",
  sameTitle: "Der aktuelle Ausschnitt entspricht schon dieser Vorlage.",
  current() {
    const size = planSize();
    return size && regions.length > 0
      ? { value: { plan: size, regions: normaliseLayout(regions) } }
      : { problem: "Es gibt keinen Bereich zum Speichern. Ziehe auf dem Plan einen Bereich auf." };
  },
  valueOf: (p) => p.clip,
  make: (name, clip) => ({ name, clip }),
  apply(clip) {
    const size = planSize();
    if (clip && size) loadRegions(fitClip(clip, size));
  },
  same: (current, saved) => !!saved && sameClip(current, saved),
  load: loadClipPresets,
  store: storeClipPresets,
  toJson: clipPresetsToJson,
  fromJson: clipPresetsFromJson,
});

/**
 * Shows the Regions everywhere (view, minimap, list, fields, Tile grid) and remembers
 * them (ADR 0007). With `from: "fields"` the fields keep what is being typed.
 */
function setRegions(next: Region[], sel: number | undefined, from: "fields" | "other" = "other", guides: GuideLine[] = []): void {
  // An edited Region ends the stretch note (ADR 0007).
  if (geometry(next) !== geometry(regions)) showStretch(undefined);
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
  const size = planSize();
  if (size) storeRegions(regions, size);
  clipPresets.render();
  tilesPanel.update({ x: 0, y: 0, ...clipSize(regions) });
  showRegionList();
  showTileGrid();
  updateButtons();
}

/** The list "Bereich 1, 2, …" with a remove button each, and the Clip's size. */
function showRegionList(): void {
  const list = $("regions");
  // Same number of Regions: only the selection changes. Rebuilding would swallow a click
  // whose mousedown made a field fire "change" (which shows the Regions again).
  if (list.children.length === regions.length) {
    [...list.children].forEach((li, i) => li.classList.toggle("selected", i === selected));
  } else {
    list.replaceChildren(...regions.map((_, i) => regionItem(i)));
  }
  list.hidden = regions.length === 0;
  $("no-region").hidden = regions.length > 0;
  const size = clipSize(regions);
  $("clip-size").textContent =
    regions.length === 0 ? "" : `Ausschnitt: ${de(size.width)} × ${de(size.height)} mm${regions.length > 1 ? ` aus ${regions.length} Bereichen` : ""}`;
  $("relayout").hidden = regions.length < 2;
  $("modes").hidden = regions.length < 2;
}

/** "Bereich n" in the list: click selects, drag renumbers, × removes. */
function regionItem(i: number): HTMLLIElement {
  const li = document.createElement("li");
  li.classList.toggle("selected", i === selected);
  const pick = document.createElement("button");
  pick.className = "pick";
  pick.textContent = `Bereich ${i + 1}`;
  pick.title = "Klicken: wählen · Ziehen: Reihenfolge ändern";
  pick.addEventListener("click", () => {
    if (!listDragged) setRegions(regions, i);
  });
  pick.addEventListener("pointerdown", (e) => dragInList(e, i, li));
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = `Bereich ${i + 1} entfernen`;
  remove.setAttribute("aria-label", `Bereich ${i + 1} entfernen`);
  remove.addEventListener("click", () => removeAt(i));
  li.append(pick, remove);
  return li;
}

/** True right after a drag in the list, so the click that ends it does not select. */
let listDragged = false;

/**
 * Drags "Bereich n" in the list with the left button to give it another number
 * (ADR 0016): the item moves among the others as the pointer passes their middles, and
 * on release the Regions are renumbered. Plan and Layout stay. A click still selects.
 */
function dragInList(e: PointerEvent, from: number, li: HTMLLIElement): void {
  if (e.button !== 0) return;
  const list = $("regions");
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
    if (!dragging) {
      dragging = true;
      li.classList.add("dragging");
      list.classList.add("reordering");
    }
    // Before the first item the pointer is above (an earlier row) or left of the middle of (same row).
    const others = [...list.children].filter((c) => c !== li) as HTMLElement[];
    const next = others.find((c) => {
      const b = c.getBoundingClientRect();
      return ev.clientY < b.top || (ev.clientY <= b.bottom && ev.clientX < b.left + b.width / 2);
    });
    if (next) {
      if (li.nextElementSibling !== next) list.insertBefore(li, next);
    } else if (list.lastElementChild !== li) list.append(li);
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!dragging) return;
    listDragged = true;
    setTimeout(() => (listDragged = false), 0);
    const to = [...list.children].indexOf(li);
    list.replaceChildren(); // the items were moved: build them anew
    if (ev.type === "pointercancel" || to === from) return setRegions(regions, selected);
    setRegions(reorderRegion(regions, from, to), to);
  };
  // On the window: the item is moved in the DOM while dragged, which would end a pointer capture.
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
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
  document.body.dataset.mode = mode;
  // "Ausschnitt" (F) already shows the whole Clip there; key 1 still does too (#50).
  $("zoom-plan").hidden = arranging;
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
 * Region drawn on empty Plan (`index` undefined). A new Region is placed in the Layout
 * where it lies on the Plan next to its closest Region (ADR 0016), as it grows.
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
    setRegions(normaliseLayout([...regions, placeNew(regions, rect)]), drawing, "other", guides);
  } else {
    const others = regions.filter((_, i) => i !== drawing);
    setRegions(normaliseLayout(regions.map((r, i) => (i === drawing ? placeNew(others, rect) : r))), drawing, "other", guides);
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

    // Restore the last Regions, stretched to this page if it has another size (ADR 0007),
    // else one sensible Region. Regions stored before their Plan size was (#38) are kept
    // only if they fit.
    const stored = loadStoredRegions();
    const { widthMm, heightMm } = plan;
    const fits = (rs: Region[]) => rs.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= widthMm + 0.05 && r.y + r.height <= heightMm + 0.05);
    const restored =
      !stored || stored.regions.length === 0
        ? undefined
        : stored.plan
          ? fitClip({ plan: stored.plan, regions: stored.regions }, { widthMm, heightMm })
          : fits(stored.regions)
            ? { regions: stored.regions.map((r) => ({ ...clampRect(r), at: r.at })) }
            : undefined;
    loadRegions(restored ?? { regions: single({ x: 0, y: 0, width: widthMm, height: Math.min(600, heightMm) }) });
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

/** Both formats export Tiles while tiling (ADR 0013); nothing runs twice at once. */
function updateButtons(): void {
  const tiling = tilesPanel.settings.enabled;
  // The last Region can be removed: then there is nothing to export (ADR 0016).
  const none = regions.length === 0;
  const noGrid = tiling && !currentGrid();
  exportButton.disabled = busy || loading || noGrid || none;
  pdfButton.disabled = busy || loading || noGrid || none;
  $("export-hint").hidden = !none;
  const why = none ? "Ziehe auf dem Plan einen Bereich auf." : "";
  pdfButton.title = why;
  $("svg-wrap").title = why;
  exportButton.title = why;
  exportButton.textContent = tiling ? "SVG-Kacheln exportieren" : "SVG exportieren";
  pdfButton.textContent = tiling ? "PDF-Kacheln exportieren" : "PDF exportieren";
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
  if (tilesPanel.settings.enabled) return exportSvgTiles();
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
    sizeWarning(size);
    unsupportedNote(r.unsupported);

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

/**
 * The whiteboard's limits (ADR 0009), for the SVG or, in a Tiled Export, its largest
 * Tile (`tile`: its name, and whether it is the only one). Warns, never refuses.
 */
function sizeWarning(size: number, tile?: { name: string; only: boolean }): void {
  const subject = tile ? `${tile.only ? "Die Kachel" : "Die größte Kachel"} ${tile.name} ist` : "Achtung:";
  if (size > WHITEBOARD_LIMIT) {
    note(
      `${subject} größer als 45 MB. Gängige Whiteboard-Programme nehmen Dateien dieser Größe nicht an. ` +
        (tile ? "Bitte kleinere Kacheln wählen." : "Bitte den Ausschnitt verkleinern oder in Kacheln aufteilen."),
      "severe",
    );
  } else if (size > WHITEBOARD_RECOMMENDED) {
    note(`${tile ? subject : "Hinweis:"} größer als 2 MB. In Whiteboard-Programmen kann das Board dadurch träge werden.`, "warn");
  }
}

function unsupportedNote(unsupported: Record<string, number>): void {
  const list = Object.entries(unsupported);
  if (list.length > 0) note("Nicht vollständig übernommen: " + list.map(([k, n]) => `${k} (${n}×)`).join(", "), "warn");
}

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
    note(`PDF: ${de(blob.size / MB, 2)} MB · ${de(r.seconds)} s`);
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
        ? "Zum Zusammensetzen den Rand an den Schnittmarken abschneiden."
        : "Die Blätter ohne Rand Kante an Kante zusammensetzen.",
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

/**
 * Tiles per engine call of the SVG Tiled Export. They share one pass over the page, and
 * a pass costs about the same however many Tiles it serves (Test Plan: ~2.5 s for a
 * 2 m Clip, ~4.5 s for the whole 14 m Plan, plus ~0.03 s per Tile). 294 A4 Tiles of the
 * whole Plan: 18.8 s in one call, 20.6 s in calls of 100 (progress and "Abbrechen" about
 * every 7 s), 34.5 s in calls of 50.
 */
const SVG_TILE_BATCH = 100;

// SVG Tiled Export (ADR 0013, #46): one bare SVG per Tile for the whiteboard, empty Tiles skipped.
async function exportSvgTiles(): Promise<void> {
  const g = currentGrid();
  if (!plan || !g) return;
  const { mergeMode, textAsPaths } = presets.current().svg;
  const oneFile = tilesPanel.settings.output === "multipage";
  const list = tiles(g);
  const base = exportBase(plan.name, plan.page, plan.pages.length);

  // Ask where to save first: the dialogs need the click that started the export.
  let folder: DirectoryHandle | undefined;
  let writeZip: ((blob: Blob) => Promise<void>) | undefined;
  if (oneFile) {
    const w = await chooseSaveTarget(`${base}_Kacheln.zip`, "ZIP-Archiv", "application/zip", ".zip");
    if (!w) return;
    writeZip = w;
  } else {
    const f = await chooseFolder();
    if (f === null) return; // cancelled
    folder = f; // undefined: no folder picker, the Tiles go into a ZIP download
  }

  busy = true;
  updateButtons();
  $("result-img").hidden = true;
  status.replaceChildren();
  let cancelled = false;
  await busyWindow.start("SVG-Kacheln werden berechnet…", { button: exportButton, cancel: () => (cancelled = true) });

  const t0 = performance.now();
  const zipped: ZipEntry[] = [];
  const unsupported: Record<string, number> = {};
  let largest: { name: string; size: number; elements: number } | undefined;
  let bytes = 0;
  let done = 0;
  let saved = 0;
  try {
    const clip = normaliseLayout(regions);
    for (let i = 0; i < list.length && !cancelled; i += SVG_TILE_BATCH) {
      const batch = list.slice(i, i + SVG_TILE_BATCH);
      busyWindow.text(
        batch.length === list.length
          ? `${list.length.toLocaleString("de-DE")} Kacheln werden berechnet…`
          : `Kacheln ${done + 1}–${done + batch.length} von ${list.length}…`,
      );
      busyWindow.progress(done, list.length);
      const r = await engine.exportSvgTiles({
        clip,
        page: plan.page,
        mergeMode,
        textAsPaths,
        reuseShapes: false,
        tiles: batch.map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height })),
      });
      for (const [k, t] of batch.entries()) {
        const svg = r.tiles[k];
        if (!svg) continue; // empty Tile: skipped, the names keep the grid
        const name = `${base}_Kachel_${t.name}.svg`;
        bytes += svg.svg.length;
        if (!largest || svg.svg.length > largest.size) largest = { name: t.name, size: svg.svg.length, elements: svg.elements };
        for (const [what, n] of Object.entries(svg.unsupported)) unsupported[what] = (unsupported[what] ?? 0) + n;
        if (folder) await writeToFolder(folder, name, new Blob([svg.svg as BlobPart], { type: "image/svg+xml" }));
        else zipped.push({ name, data: svg.svg });
        saved++;
      }
      done += batch.length;
    }
    if (cancelled) {
      void busyWindow.end();
      note(
        folder && saved > 0
          ? `Abgebrochen. ${saved} Kacheln wurden in den Ordner „${folder.name}“ geschrieben.`
          : "Abgebrochen. Es wurde nichts gespeichert.",
        "warn",
      );
      return;
    }
    if (saved === 0) {
      void busyWindow.end();
      note("Alle Kacheln sind leer. Es wurde nichts gespeichert.", "warn");
      return;
    }
    busyWindow.cancellable(false);
    busyWindow.progress(done, list.length);
    busyWindow.text("Wird gespeichert…");
    const n = saved.toLocaleString("de-DE");
    const empty = list.length - saved;
    const skipped = empty > 0 ? `, ${empty.toLocaleString("de-DE")} leere übersprungen` : "";
    const secs = `${de((performance.now() - t0) / 1000)} s`;
    if (writeZip) {
      await writeZip(zip(zipped));
      note(`${n} SVG-Kacheln als ZIP-Datei gespeichert${skipped}: ${de(bytes / MB, 2)} MB · ${secs}`);
    } else if (folder) {
      note(`${n} SVG-Kacheln im Ordner „${folder.name}“ gespeichert${skipped}: ${de(bytes / MB, 2)} MB · ${secs}`);
    } else {
      download(zip(zipped), `${base}_Kacheln.zip`);
      note(`${n} SVG-Kacheln als ZIP-Datei gespeichert (kein Ordner-Dialog verfügbar)${skipped}: ${de(bytes / MB, 2)} MB · ${secs}`);
    }
    void busyWindow.end();
    if (largest && saved > 1)
      note(`Größte Kachel ${largest.name}: ${de(largest.size / MB, 2)} MB · ${largest.elements.toLocaleString("de-DE")} Elemente`, "muted");
    if (largest) sizeWarning(largest.size, { name: largest.name, only: saved === 1 });
    unsupportedNote(unsupported);
  } catch (e) {
    void busyWindow.end();
    status.textContent = `Kachel-Export fehlgeschlagen: ${String(e)}`;
  } finally {
    busy = false;
    updateButtons();
  }
}
