import { startEngine } from "./engine/client";
import type { PlanInfo } from "./engine/protocol";
import type { ClipMm, MergeMode } from "./export/index";
import { saveFile } from "./ui/save";
import { loadStoredClip, storeClip } from "./ui/storage";
import { CURSORS, dragClip, hitTest, type Handle, type Point } from "./ui/clipdrag";
import { snapClip, type Guide, type SnapIndex } from "./ui/snap";
import { Viewer, type ViewRect } from "./ui/viewer";

const PT_TO_MM = 25.4 / 72;
const MB = 1_000_000;
const WHITEBOARD_RECOMMENDED = 2 * MB;
const WHITEBOARD_LIMIT = 45 * MB;
const GRAB_PX = 8;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number) => v.toFixed(1);

$("version").textContent = `v${__APP_VERSION__} (${__BUILD_DATE__})`;

const engine = await startEngine().catch((e: unknown) => {
  $("engine-status").textContent = `PDF-Engine konnte nicht geladen werden: ${String(e)}`;
  throw e;
});
$("engine-status").textContent = "";
document.body.dataset.engine = engine.mode;

// ---- State ---------------------------------------------------------------
let plan: { name: string; widthMm: number; heightMm: number } | undefined;
let clip: ClipMm = { x: 0, y: 0, width: 0, height: 0 };
let snapIndex: SnapIndex | undefined;
const snapToggle = $<HTMLInputElement>("snap");

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
  placeBox($("clip-box"), { x0: clip.x, y0: clip.y, x1: clip.x + clip.width, y1: clip.y + clip.height });
  viewer.setClip(clip, guides);
  storeClip(clip);
}

for (const input of Object.values(fields)) {
  input.addEventListener("input", () => {
    const v = { x: Number(fields.x.value), y: Number(fields.y.value), width: Number(fields.width.value), height: Number(fields.height.value) };
    if (Object.values(v).every(Number.isFinite)) setClip(v, "fields");
  });
  input.addEventListener("change", () => setClip(clip)); // normalise display on blur
}

/** Drag on a Clip handle (from the viewer or the overview), with snapping. */
function applyDrag(handle: Handle, start: ClipMm, from: Point, to: Point, altKey: boolean, visible: ViewRect, tolMm: number): Guide[] {
  if (!plan) return [];
  let c = dragClip(start, handle, from, to, { width: plan.widthMm, height: plan.heightMm });
  let guides: Guide[] = [];
  if (snapIndex && snapToggle.checked && !altKey) {
    const r = snapClip(c, handle, snapIndex, tolMm, visible, { from, to });
    c = r.clip;
    guides = r.guides;
  }
  setClip(c, "other", guides);
  return guides;
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
    $("zoom-label").textContent = `${zoomPercent < 10 ? zoomPercent.toFixed(1) : Math.round(zoomPercent)} %`;
    if (!plan) return;
    placeBox($("view-box"), visible);
    keepInOverview(visible);
  },
});
$("zoom-in").addEventListener("click", () => viewer.zoomBy(1.5));
$("zoom-out").addEventListener("click", () => viewer.zoomBy(1 / 1.5));
$("zoom-100").addEventListener("click", () => viewer.zoomTo100());
$("zoom-clip").addEventListener("click", () => viewer.fitClip());

// ---- Overview (navigator) --------------------------------------------------
const overview = $("overview");
const overviewCanvas = $<HTMLCanvasElement>("overview-canvas");
/** Overview CSS px per mm (the canvas is scaled to the column width). */
const overviewScale = () => (plan ? overviewCanvas.clientWidth / plan.widthMm : 1);

function placeBox(el: HTMLElement, r: ViewRect): void {
  const s = overviewScale();
  const x0 = Math.max(0, r.x0) * s;
  const y0 = Math.max(0, r.y0) * s;
  el.style.left = `${x0}px`;
  el.style.top = `${y0}px`;
  el.style.width = `${Math.max(3, Math.min(r.x1 * s, overviewCanvas.clientWidth) - x0)}px`;
  el.style.height = `${Math.max(3, Math.min(r.y1 * s, overviewCanvas.clientHeight) - y0)}px`;
}

function keepInOverview(r: ViewRect): void {
  const s = overviewScale();
  const top = r.y0 * s;
  const bottom = r.y1 * s;
  if (top < overview.scrollTop || bottom > overview.scrollTop + overview.clientHeight)
    overview.scrollTop = (top + bottom) / 2 - overview.clientHeight / 2;
}

const overviewPoint = (e: MouseEvent): Point => {
  const r = overviewCanvas.getBoundingClientRect();
  const s = overviewScale();
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
};

let ovDrag: { handle: Handle; from: Point; start: ClipMm; screen: Point; moved: boolean } | undefined;
const ovInner = $("overview-inner");
ovInner.addEventListener("pointerdown", (e) => {
  if (!plan || e.button !== 0) return;
  const p = overviewPoint(e);
  ovDrag = { handle: hitTest(clip, p, GRAB_PX / overviewScale()), from: p, start: { ...clip }, screen: { x: e.clientX, y: e.clientY }, moved: false };
  ovInner.setPointerCapture(e.pointerId);
  e.preventDefault();
});
ovInner.addEventListener("pointermove", (e) => {
  if (!plan) return;
  const p = overviewPoint(e);
  if (!ovDrag) {
    ovInner.style.cursor = CURSORS[hitTest(clip, p, GRAB_PX / overviewScale())];
    return;
  }
  if (!ovDrag.moved && Math.hypot(e.clientX - ovDrag.screen.x, e.clientY - ovDrag.screen.y) < 4) return;
  ovDrag.moved = true;
  const page = { x0: 0, y0: 0, x1: plan.widthMm, y1: plan.heightMm };
  applyDrag(ovDrag.handle, ovDrag.start, ovDrag.from, p, e.altKey, page, GRAB_PX / overviewScale());
});
ovInner.addEventListener("pointerup", (e) => {
  if (!ovDrag) return;
  if (!ovDrag.moved) viewer.centerOn(overviewPoint(e)); // a click navigates
  else viewer.setClip(clip); // drop guides
  ovDrag = undefined;
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

const input = $<HTMLInputElement>("file");
input.disabled = false;
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  $("plan-info").textContent = "Plan wird geöffnet…";
  snapIndex = undefined;
  try {
    const t0 = performance.now();
    const info = await engine.openPlan(await file.arrayBuffer());
    plan = { name: file.name.replace(/\.pdf$/i, ""), widthMm: info.widthPt * PT_TO_MM, heightMm: info.heightPt * PT_TO_MM };
    showDetails(info);
    const preview = await engine.renderPreview();
    const bitmap = await createImageBitmap(new ImageData(preview.pixels as Uint8ClampedArray<ArrayBuffer>, preview.widthPx, preview.heightPx));
    overviewCanvas.width = preview.widthPx;
    overviewCanvas.height = preview.heightPx;
    overviewCanvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    $("workspace").hidden = false;
    viewer.setPlan(plan.widthMm, plan.heightMm, bitmap);

    // Restore the last Clip if it fits this Plan (ADR 0007), else a sensible default.
    const stored = loadStoredClip();
    const fits = stored && stored.x + stored.width <= plan.widthMm + 0.05 && stored.y + stored.height <= plan.heightMm + 0.05;
    setClip(fits ? stored : { x: 0, y: 0, width: plan.widthMm, height: Math.min(600, plan.heightMm) });
    viewer.fitClip();

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("plan-info").textContent = `${file.name}: ${fmt(plan.widthMm)} × ${fmt(plan.heightMm)} mm (geladen in ${secs} s)`;

    $("snap-status").textContent = "Einrasten wird vorbereitet…";
    const t1 = performance.now();
    snapIndex = await engine.snapTargets();
    const n = snapIndex.vertical.pos.length + snapIndex.horizontal.pos.length;
    $("snap-status").textContent = `${n.toLocaleString("de-DE")} Linien zum Einrasten gefunden (${((performance.now() - t1) / 1000).toFixed(1)} s).`;
    document.body.dataset.snapReady = "1";
  } catch (e) {
    $("plan-info").textContent = `Plan konnte nicht geöffnet werden: ${String(e)}`;
  }
});

// ---- Export ----------------------------------------------------------------
const exportButton = $<HTMLButtonElement>("export-svg");
exportButton.addEventListener("click", async () => {
  if (!plan) return;
  const status = $("export-status");
  const mergeMode = (document.querySelector('input[name="merge"]:checked') as HTMLInputElement).value as MergeMode;
  const textAsPaths = $<HTMLInputElement>("text-paths").checked;
  exportButton.disabled = true;
  status.textContent = "Wird berechnet…";
  try {
    const r = await engine.exportSvg({ clip, mergeMode, textAsPaths });
    const blob = new Blob([r.svg as BlobPart], { type: "image/svg+xml" });
    const svgz = $<HTMLInputElement>("svgz").checked;
    // .svgz = the same SVG, gzip-compressed (whether the whiteboard tool accepts it is to be tested).
    const file = svgz ? await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob() : blob;
    const size = file.size;

    status.replaceChildren();
    const line = document.createElement("p");
    line.textContent =
      `Größe ${(size / MB).toLocaleString("de-DE", { maximumFractionDigits: 2 })} MB${svgz ? ` (unkomprimiert ${(blob.size / MB).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB)` : ""} · ` +
      `${r.elements.toLocaleString("de-DE")} Elemente (aus ${r.sourceItems.toLocaleString("de-DE")} PDF-Objekten) · ` +
      `${r.seconds.toLocaleString("de-DE", { maximumFractionDigits: 1 })} s`;
    status.append(line);

    if (size > WHITEBOARD_LIMIT) {
      const p = document.createElement("p");
      p.className = "severe";
      p.textContent =
        "Achtung: Die Datei ist größer als 45 MB. Das Whiteboard-Tool lehnt Dateien dieser Größe ab. " +
        "Bitte den Ausschnitt verkleinern oder in mehrere Ausschnitte aufteilen.";
      status.append(p);
    } else if (size > WHITEBOARD_RECOMMENDED) {
      const p = document.createElement("p");
      p.className = "warn";
      p.textContent = "Hinweis: Größer als 2 MB. Das Whiteboard-Tool empfiehlt kleinere Dateien, das Board kann träge werden.";
      status.append(p);
    }
    const unsupported = Object.entries(r.unsupported);
    if (unsupported.length > 0) {
      const p = document.createElement("p");
      p.className = "warn";
      p.textContent = "Nicht vollständig übernommen: " + unsupported.map(([k, n]) => `${k} (${n}×)`).join(", ");
      status.append(p);
    }

    const resultImg = $<HTMLImageElement>("result-img");
    URL.revokeObjectURL(resultImg.src);
    resultImg.src = URL.createObjectURL(blob);
    resultImg.hidden = false;

    if (svgz) await saveFile(file, `${plan.name}_Ausschnitt.svgz`, "Komprimierte SVG-Grafik", "image/svg+xml", ".svgz");
    else await saveFile(blob, `${plan.name}_Ausschnitt.svg`, "SVG-Grafik", "image/svg+xml", ".svg");
  } catch (e) {
    status.textContent = `Export fehlgeschlagen: ${String(e)}`;
  } finally {
    exportButton.disabled = false;
  }
});
