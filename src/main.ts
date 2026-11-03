import { startEngine } from "./engine/client";
import type { PlanInfo } from "./engine/protocol";

const PT_TO_MM = 25.4 / 72;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mm = (pt: number) => (pt * PT_TO_MM).toFixed(1);

$("version").textContent = `v${__APP_VERSION__} (${__BUILD_DATE__})`;

const engine = await startEngine().catch((e: unknown) => {
  $("engine-status").textContent = `PDF-Engine konnte nicht geladen werden: ${String(e)}`;
  throw e;
});
$("engine-status").textContent = `PDF-Engine bereit (${engine.mode === "worker" ? "Hintergrund-Thread" : "Haupt-Thread"}).`;
document.body.dataset.engine = engine.mode;

function showDetails(info: PlanInfo): void {
  const rows: [string, string][] = [["Seiten", String(info.pageCount)]];
  for (const [name, b] of Object.entries(info.boxes)) rows.push([name, `${mm(b.widthPt)} × ${mm(b.heightPt)} mm`]);
  rows.push(["UserUnit", String(info.userUnit)], ["Drehung", `${info.rotate}°`]);
  const table = $<HTMLTableElement>("plan-details");
  table.replaceChildren(
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
  table.hidden = false;
}

const input = $<HTMLInputElement>("file");
input.disabled = false;
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  $("plan-details").hidden = true;
  $("preview-wrap").hidden = true;
  $("plan-info").textContent = "Plan wird geöffnet…";
  try {
    const t0 = performance.now();
    const info = await engine.openPlan(await file.arrayBuffer());
    $("plan-info").textContent = `${file.name}: ${info.pageCount} Seite(n), ${mm(info.widthPt)} × ${mm(info.heightPt)} mm. Vorschau wird berechnet…`;
    showDetails(info);
    const preview = await engine.renderPreview();
    const img = $<HTMLImageElement>("preview");
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(new Blob([preview.png as BlobPart], { type: "image/png" }));
    $("preview-wrap").hidden = false;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("plan-info").textContent = `${file.name}: ${info.pageCount} Seite(n), ${mm(info.widthPt)} × ${mm(info.heightPt)} mm (geladen in ${secs} s)`;
  } catch (e) {
    $("plan-info").textContent = `Plan konnte nicht geöffnet werden: ${String(e)}`;
  }
});
