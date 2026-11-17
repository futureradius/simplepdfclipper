import { startEngine } from "./engine/client";
import type { PlanInfo } from "./engine/protocol";
import type { ClipMm } from "./export/index";
import { chooseFolder, chooseSaveTarget, download, saveFile, writeToFolder, type DirectoryHandle } from "./ui/save";
import { rowName, tiles, type TileGrid } from "./export/tilegrid";
import { TilesPanel } from "./ui/tilespanel";
import { zip, type ZipEntry } from "./ui/zip";
import { loadExportSettings, loadStoredClip, storeClip } from "./ui/storage";
import { PresetsPanel } from "./ui/presetspanel";
import { dragClip, onPlan, type Handle, type Point } from "./ui/clipdrag";
import { Minimap } from "./ui/minimap";
import { exportBase, PagePicker, sourceLabel, type PageSize } from "./ui/pagepicker";
import { snapClip, type Guide, type SnapIndex } from "./ui/snap";
import { Viewer, type ViewRect } from "./ui/viewer";

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

// ---- Engine ----------------------------------------------------------------
const engine = await startEngine().catch((e: unknown) => {
  $("engine-status").textContent = "";
  $("start-error").textContent = `Die PDF-Engine konnte nicht geladen werden: ${String(e)}`;
  throw e;
});
$("engine-status").textContent = "";
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
let clip: ClipMm = { x: 0, y: 0, width: 0, height: 0 };
let snapIndex: SnapIndex | undefined;
const snapToggle = $<HTMLInputElement>("snap");

// ---- Minimap (ADR 0012) ----------------------------------------------------
const minimap = new Minimap(
  {
    root: $("minimap"),
    canvas: $<HTMLCanvasElement>("overview-canvas"),
    clipBox: $("clip-box"),
    viewBox: $("view-box"),
    tileGrid: document.getElementById("tile-grid") as unknown as SVGSVGElement,
    collapse: $<HTMLButtonElement>("minimap-collapse"),
    expand: $<HTMLButtonElement>("minimap-expand"),
  },
  $("viewer"),
  (p) => viewer.centerOn(p),
);

const fields = {
  x: $<HTMLInputElement>("clip-x"),
  y: $<HTMLInputElement>("clip-y"),
  width: $<HTMLInputElement>("clip-w"),
  height: $<HTMLInputElement>("clip-h"),
};

function clampClip(c: ClipMm): ClipMm {
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

function setClip(c: ClipMm, from: "fields" | "other" = "other", guides: Guide[] = []): void {
  clip = clampClip(c);
  if (from !== "fields") {
    fields.x.value = fmt(clip.x);
    fields.y.value = fmt(clip.y);
    fields.width.value = fmt(clip.width);
    fields.height.value = fmt(clip.height);
  }
  minimap.setClip(clip);
  viewer.setClip(clip, guides);
  storeClip(clip);
  tilesPanel.update(clip);
  showTileGrid();
}

for (const input of Object.values(fields)) {
  input.addEventListener("input", () => {
    const v = { x: Number(fields.x.value), y: Number(fields.y.value), width: Number(fields.width.value), height: Number(fields.height.value) };
    if (Object.values(v).every(Number.isFinite)) setClip(v, "fields");
  });
  input.addEventListener("change", () => setClip(clip)); // normalise display on blur
}

/** Drag on a Clip handle in the precision view, with snapping. */
function applyDrag(handle: Handle, start: ClipMm, from: Point, to: Point, altKey: boolean, visible: ViewRect, tolMm: number): Guide[] {
  if (!plan) return [];
  const size = { width: plan.widthMm, height: plan.heightMm };
  let c = dragClip(start, handle, from, to, size);
  let guides: Guide[] = [];
  if (snapIndex && snapToggle.checked && !altKey) {
    const r = snapClip(c, handle, snapIndex, tolMm, visible, { from, to });
    // A snap line outside the Plan (content can overhang the page) must not push an edge off it.
    if (onPlan(r.clip, size)) {
      c = r.clip;
      guides = r.guides;
    }
  }
  setClip(c, "other", guides);
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
  if (!g || !plan) {
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
  dragClip: applyDrag,
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
  const move = (dx: number, dy: number) => setClip({ ...clip, x: clip.x + dx, y: clip.y + dy });
  switch (e.key) {
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
  const status = plan ? $("plan-info") : $("engine-status");
  status.textContent = doc.pages.length > 1 ? `Seite ${index + 1} wird geöffnet…` : "Plan wird geöffnet…";
  snapIndex = undefined;
  delete document.body.dataset.snapReady;
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

    // Restore the last Clip if it fits this page (ADR 0007), else a sensible default.
    const stored = loadStoredClip();
    const fits = stored && stored.x + stored.width <= plan.widthMm + 0.05 && stored.y + stored.height <= plan.heightMm + 0.05;
    setClip(fits ? stored : { x: 0, y: 0, width: plan.widthMm, height: Math.min(600, plan.heightMm) });
    // Start with the whole Plan in view (ADR 0012): an overview first, not "in the thick of it".
    viewer.fitPlan();

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("plan-info").textContent = `${de(plan.widthMm)} × ${de(plan.heightMm)} mm · geladen in ${secs.replace(".", ",")} s`;
    $("engine-status").textContent = "";
    document.body.dataset.page = String(index + 1);
    loading = false;
    updateButtons();

    $("snap-status").textContent = "Einrasten wird vorbereitet…";
    const t1 = performance.now();
    const targets = await engine.snapTargets();
    if (gen !== loadGeneration) return;
    snapIndex = targets;
    const n = snapIndex.vertical.pos.length + snapIndex.horizontal.pos.length;
    $("snap-status").textContent = `${n.toLocaleString("de-DE")} Linien zum Einrasten gefunden (${de((performance.now() - t1) / 1000)} s).`;
    document.body.dataset.snapReady = "1";
  } catch (e) {
    if (gen !== loadGeneration) return;
    status.textContent = "";
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
  if (picker.isOpen || loading) return;
  const t0 = performance.now();
  const status = plan ? $("plan-info") : $("engine-status");
  const before = status.textContent;
  status.textContent = "Plan wird geöffnet…";
  $("start-error").textContent = "";
  let pages: PageSize[];
  try {
    pages = (await engine.openDocument(await file.arrayBuffer())).pages;
    if (pages.length === 0) throw new Error("keine Seiten");
  } catch (e) {
    status.textContent = plan ? before : "";
    const msg = `Der Plan konnte nicht geöffnet werden: ${String(e)}`;
    if (plan) $("plan-info").textContent = msg;
    else $("start-error").textContent = msg;
    return;
  }
  const doc = { name: file.name.replace(/\.pdf$/i, ""), fileName: file.name, pages };
  if (pages.length === 1) return showPage(doc, 0, t0);

  status.textContent = plan ? before : "";
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
  exportButton.disabled = busy || loading || tiling;
  pdfButton.disabled = busy || loading || (tiling && !currentGrid());
  const why = tiling ? "SVG-Export ist beim Aufteilen auf Blätter nicht verfügbar." : "";
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
  busy = true;
  updateButtons();
  status.textContent = "SVG wird berechnet…";
  try {
    const r = await engine.exportSvg({ clip, page: plan.page, mergeMode, textAsPaths, reuseShapes: false });
    const blob = new Blob([r.svg as BlobPart], { type: "image/svg+xml" });
    const size = blob.size;

    status.replaceChildren();
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

    await saveFile(blob, `${exportBase(plan.name, plan.page, plan.pages.length)}.svg`, "SVG-Grafik", "image/svg+xml", ".svg");
  } catch (e) {
    status.textContent = `SVG-Export fehlgeschlagen: ${String(e)}`;
  } finally {
    busy = false;
    updateButtons();
  }
});

// PDF export (for documentation; ADR 0005)
pdfButton.addEventListener("click", async () => {
  if (!plan) return;
  if (tilesPanel.settings.enabled) return exportTiles();
  busy = true;
  updateButtons();
  status.textContent = "PDF wird erstellt…";
  try {
    const r = await engine.exportPdf({ clip, page: plan.page, sourceName: sourceLabel(plan.fileName, plan.page, plan.pages.length) });
    const blob = new Blob([r.pdf as BlobPart], { type: "application/pdf" });
    status.replaceChildren();
    note(`PDF: ${de(blob.size / MB, 2)} MB · ${de(r.seconds)} s · Inhalte außerhalb des Ausschnitts entfernt`);
    if (!r.normalised)
      note(
        "Der Ausschnitt ist länger als 5,08 m. Das PDF behält deshalb den Maßstabsfaktor (UserUnit) des Plans; " +
          "manche Programme zeigen es dadurch verkleinert an.",
        "warn",
      );
    $("result-img").hidden = true;
    await saveFile(blob, `${exportBase(plan.name, plan.page, plan.pages.length)}.pdf`, "PDF-Dokument", "application/pdf", ".pdf");
  } catch (e) {
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
  let cancelled = false;
  const text = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.id = "tiles-cancel";
  cancel.textContent = "Abbrechen";
  cancel.addEventListener("click", () => {
    cancelled = true;
    cancel.disabled = true;
    text.textContent = "Wird abgebrochen…";
  });
  const row = document.createElement("div");
  row.className = "progress";
  row.append(text, cancel);
  status.replaceChildren(row);

  const t0 = performance.now();
  const zipped: ZipEntry[] = [];
  let bytes = 0;
  let done = 0;
  try {
    text.textContent = "Ausschnitt wird vorbereitet…";
    await engine.tilesBegin({
      clip,
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
      text.textContent = `Kachel ${done + 1} von ${list.length} (${t.name})…`;
      const r = await engine.tile(t);
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
      status.replaceChildren();
      note(
        folder && done > 0
          ? `Abgebrochen. ${done} von ${list.length} Kacheln wurden in den Ordner „${folder.name}“ geschrieben.`
          : "Abgebrochen. Es wurde nichts gespeichert.",
        "warn",
      );
      return;
    }
    cancel.disabled = true;
    text.textContent = "Wird gespeichert…";
    const fin = await engine.tilesFinish();
    const n = list.length.toLocaleString("de-DE");
    const secs = `${de((performance.now() - t0) / 1000)} s`;
    status.replaceChildren();
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
    note(
      g.marginMm >= 2
        ? "Inhalte außerhalb jeder Kachel entfernt. Zum Zusammensetzen den Rand an den Schnittmarken abschneiden."
        : "Inhalte außerhalb jeder Kachel entfernt. Die Blätter ohne Rand Kante an Kante zusammensetzen.",
      "muted",
    );
  } catch (e) {
    await engine.tilesAbort().catch(() => undefined);
    status.textContent = `Kachel-Export fehlgeschlagen: ${String(e)}`;
  } finally {
    busy = false;
    updateButtons();
  }
}
