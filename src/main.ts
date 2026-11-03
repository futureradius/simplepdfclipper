import { startEngine } from "./engine/client";
import type { PlanInfo } from "./engine/protocol";
import type { ClipMm, MergeMode } from "./export/index";
import { saveFile } from "./ui/save";
import { loadStoredClip, storeClip } from "./ui/storage";
import { CURSORS, dragClip, hitTest, type Handle, type Point } from "./ui/clipdrag";

const PT_TO_MM = 25.4 / 72;
const MB = 1_000_000;
const WHITEBOARD_RECOMMENDED = 2 * MB;
const WHITEBOARD_LIMIT = 45 * MB;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number) => v.toFixed(1);

$("version").textContent = `v${__APP_VERSION__} (${__BUILD_DATE__})`;

const engine = await startEngine().catch((e: unknown) => {
  $("engine-status").textContent = `PDF-Engine konnte nicht geladen werden: ${String(e)}`;
  throw e;
});
$("engine-status").textContent = `PDF-Engine bereit (${engine.mode === "worker" ? "Hintergrund-Thread" : "Haupt-Thread"}).`;
document.body.dataset.engine = engine.mode;

// ---- State ---------------------------------------------------------------
let plan: { name: string; widthMm: number; heightMm: number } | undefined;
let clip: ClipMm = { x: 0, y: 0, width: 100, height: 100 };
let previewScale = 1; // preview px per mm

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

function setClip(c: ClipMm, from: "fields" | "other" = "other"): void {
  clip = clampClip(c);
  if (from !== "fields") {
    fields.x.value = fmt(clip.x);
    fields.y.value = fmt(clip.y);
    fields.width.value = fmt(clip.width);
    fields.height.value = fmt(clip.height);
  }
  const box = $("clip-box");
  box.style.left = `${clip.x * previewScale}px`;
  box.style.top = `${clip.y * previewScale}px`;
  box.style.width = `${Math.max(2, clip.width * previewScale)}px`;
  box.style.height = `${Math.max(2, clip.height * previewScale)}px`;
  $("clip-note").textContent = `Ausschnitt: ${fmt(clip.width)} × ${fmt(clip.height)} mm`;
  storeClip(clip);
}

for (const input of Object.values(fields)) {
  input.addEventListener("input", () => {
    const v = {
      x: Number(fields.x.value),
      y: Number(fields.y.value),
      width: Number(fields.width.value),
      height: Number(fields.height.value),
    };
    if (Object.values(v).every(Number.isFinite)) setClip(v, "fields");
  });
  input.addEventListener("change", () => setClip(clip)); // normalise display on blur
}

// ---- Drag a Clip on the overview ------------------------------------------
const wrap = $("preview-wrap");
const GRAB_PX = 8; // how close (screen pixels) the mouse must be to grab an edge
let drag: { handle: Handle; from: Point; start: ClipMm } | undefined;
const toMm = (ev: MouseEvent): Point => {
  const r = $("preview").getBoundingClientRect();
  return { x: (ev.clientX - r.left) / previewScale, y: (ev.clientY - r.top) / previewScale };
};
wrap.addEventListener("mousedown", (ev) => {
  if (!plan || ev.button !== 0) return;
  const p = toMm(ev);
  drag = { handle: hitTest(clip, p, GRAB_PX / previewScale), from: p, start: { ...clip } };
  ev.preventDefault();
});
window.addEventListener("mousemove", (ev) => {
  if (!plan) return;
  const p = toMm(ev);
  if (!drag) {
    wrap.style.cursor = CURSORS[hitTest(clip, p, GRAB_PX / previewScale)];
    return;
  }
  setClip(dragClip(drag.start, drag.handle, drag.from, p, { width: plan.widthMm, height: plan.heightMm }));
});
window.addEventListener("mouseup", () => (drag = undefined));

// ---- Open a Plan -----------------------------------------------------------
function showDetails(info: PlanInfo): void {
  const rows: [string, string][] = [["Seiten", String(info.pageCount)]];
  for (const [name, b] of Object.entries(info.boxes))
    rows.push([name, `${fmt(b.widthPt * PT_TO_MM)} × ${fmt(b.heightPt * PT_TO_MM)} mm`]);
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
  $("workspace").hidden = true;
  $("result").hidden = true;
  $("plan-info").textContent = "Plan wird geöffnet…";
  try {
    const t0 = performance.now();
    const info = await engine.openPlan(await file.arrayBuffer());
    plan = { name: file.name.replace(/\.pdf$/i, ""), widthMm: info.widthPt * PT_TO_MM, heightMm: info.heightPt * PT_TO_MM };
    $("plan-info").textContent = `${file.name}: ${fmt(plan.widthMm)} × ${fmt(plan.heightMm)} mm. Übersicht wird berechnet…`;
    showDetails(info);
    const preview = await engine.renderPreview();
    const img = $<HTMLImageElement>("preview");
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(new Blob([preview.png as BlobPart], { type: "image/png" }));
    previewScale = preview.widthPx / plan.widthMm;
    $("workspace").hidden = false;

    // Restore the last Clip if it fits this Plan (ADR 0007), else a sensible default.
    const stored = loadStoredClip();
    const fits = stored && stored.x + stored.width <= plan.widthMm + 0.05 && stored.y + stored.height <= plan.heightMm + 0.05;
    setClip(fits ? stored : { x: 0, y: 0, width: plan.widthMm, height: Math.min(600, plan.heightMm) });

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("plan-info").textContent = `${file.name}: ${fmt(plan.widthMm)} × ${fmt(plan.heightMm)} mm (geladen in ${secs} s)`;
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
    const size = blob.size;

    status.replaceChildren();
    const line = document.createElement("p");
    line.textContent =
      `Größe ${(size / MB).toLocaleString("de-DE", { maximumFractionDigits: 2 })} MB · ` +
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
    $("result").hidden = false;

    await saveFile(blob, `${plan.name}_Ausschnitt.svg`, "SVG-Grafik", "image/svg+xml", ".svg");
  } catch (e) {
    status.textContent = `Export fehlgeschlagen: ${String(e)}`;
  } finally {
    exportButton.disabled = false;
  }
});
