import { startEngine } from "./engine/client";

const PT_TO_MM = 25.4 / 72;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

$("version").textContent = `v${__APP_VERSION__} (${__BUILD_DATE__})`;

const engine = await startEngine().catch((e: unknown) => {
  $("engine-status").textContent = `PDF-Engine konnte nicht geladen werden: ${String(e)}`;
  throw e;
});
$("engine-status").textContent = `PDF-Engine bereit (${engine.mode === "worker" ? "Hintergrund-Thread" : "Haupt-Thread"}).`;
document.body.dataset.engine = engine.mode;

const input = $<HTMLInputElement>("file");
input.disabled = false;
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  $("plan-info").textContent = "Plan wird geöffnet…";
  try {
    const info = await engine.openPlan(await file.arrayBuffer());
    $("plan-info").textContent =
      `${file.name}: ${info.pageCount} Seite(n), ` +
      `${(info.widthPt * PT_TO_MM).toFixed(1)} × ${(info.heightPt * PT_TO_MM).toFixed(1)} mm`;
  } catch (e) {
    $("plan-info").textContent = `Plan konnte nicht geöffnet werden: ${String(e)}`;
  }
});
