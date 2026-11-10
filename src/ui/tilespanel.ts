// The Tiled Export controls in step 3 (ADR 0013): Paper format or free Tile grid,
// Margin, output mode, and a summary of the resulting Sheets. Settings are
// remembered (ADR 0007).
//
// Free grid, per axis: two linked fields (count ⇄ length). The field edited last
// leads and keeps its value when the Clip changes; the other one shows the result
// (styled as "derived") and becomes the leading one as soon as it is edited.

import type { ClipMm } from "../export/index";
import {
  computeTileGrid,
  DEFAULT_TILE_SETTINGS,
  MANY_SHEETS,
  paperSize,
  sheetCount,
  type AxisSetting,
  type PaperFormat,
  type TileGrid,
  type TileSettings,
} from "../export/tilegrid";
import { loadTileSettings, storeTileSettings } from "./storage";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const de = (v: number, digits = 1) => v.toLocaleString("de-DE", { maximumFractionDigits: digits });
const fmt = (v: number) => String(Math.round(v * 10) / 10);

interface AxisFields {
  key: "columns" | "rows";
  count: HTMLInputElement;
  length: HTMLInputElement;
  rest: HTMLElement;
  /** "letzte Spalte" / "letzte Zeile" */
  lastLabel: string;
}

export class TilesPanel {
  readonly settings: TileSettings;
  /** The grid for the current Clip, or an error; undefined while switched off. */
  grid: TileGrid | { error: string } | undefined;
  private clip: ClipMm = { x: 0, y: 0, width: 0, height: 0 };
  private readonly axes: AxisFields[];

  constructor(private readonly onChange: () => void) {
    this.settings = loadTileSettings(DEFAULT_TILE_SETTINGS);
    this.axes = [
      { key: "columns", count: $("tiles-cols"), length: $("tiles-col-w"), rest: $("tiles-cols-rest"), lastLabel: "letzte Spalte" },
      { key: "rows", count: $("tiles-rows"), length: $("tiles-row-h"), rest: $("tiles-rows-rest"), lastLabel: "letzte Zeile" },
    ];
    this.populate();
    this.bind();
  }

  /** Recompute for a (new) Clip and refresh everything derived from it. */
  update(clip: ClipMm): void {
    this.clip = clip;
    this.refresh();
  }

  // ---- Setup ------------------------------------------------------------------

  private populate(): void {
    const s = this.settings;
    $<HTMLInputElement>("tiles-on").checked = s.enabled;
    radio("tiles-mode", s.mode);
    radio("tiles-output", s.output);
    $<HTMLSelectElement>("tiles-format").value = s.format;
    $<HTMLSelectElement>("tiles-orientation").value = s.orientation;
    $<HTMLInputElement>("tiles-custom-w").value = fmt(s.customWidthMm);
    $<HTMLInputElement>("tiles-custom-h").value = fmt(s.customHeightMm);
    $<HTMLInputElement>("tiles-margin").value = fmt(s.marginMm);
    for (const a of this.axes) {
      const axis = s[a.key];
      if (axis.lead === "count") a.count.value = String(axis.count);
      else a.length.value = fmt(axis.lengthMm);
    }
  }

  private bind(): void {
    const s = this.settings;
    const changed = () => {
      storeTileSettings(s);
      this.refresh();
      this.onChange();
    };
    $<HTMLInputElement>("tiles-on").addEventListener("change", (e) => {
      s.enabled = (e.target as HTMLInputElement).checked;
      changed();
    });
    for (const name of ["tiles-mode", "tiles-output"])
      for (const el of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`))
        el.addEventListener("change", () => {
          if (name === "tiles-mode") s.mode = el.value as TileSettings["mode"];
          else s.output = el.value as TileSettings["output"];
          changed();
        });
    $<HTMLSelectElement>("tiles-format").addEventListener("change", (e) => {
      s.format = (e.target as HTMLSelectElement).value as PaperFormat;
      changed();
    });
    $<HTMLSelectElement>("tiles-orientation").addEventListener("change", (e) => {
      s.orientation = (e.target as HTMLSelectElement).value as TileSettings["orientation"];
      changed();
    });
    const numberField = (id: string, set: (v: number) => void) => {
      const el = $<HTMLInputElement>(id);
      el.addEventListener("input", () => {
        const v = Number(el.value);
        if (el.value.trim() !== "" && Number.isFinite(v) && v >= 0) {
          set(v);
          changed();
        }
      });
    };
    numberField("tiles-custom-w", (v) => (s.customWidthMm = v));
    numberField("tiles-custom-h", (v) => (s.customHeightMm = v));
    numberField("tiles-margin", (v) => (s.marginMm = v));

    for (const a of this.axes) {
      const axis = (): AxisSetting => s[a.key];
      numberField(a.count.id, (v) => {
        axis().lead = "count";
        axis().count = Math.max(1, Math.round(v));
      });
      numberField(a.length.id, (v) => {
        axis().lead = "length";
        axis().lengthMm = v;
      });
      // On leaving a field, show the value actually used (rounded, clamped).
      for (const el of [a.count, a.length]) el.addEventListener("change", () => this.refresh(true));
    }
  }

  // ---- Display ------------------------------------------------------------------

  private refresh(normaliseLeading = false): void {
    const s = this.settings;
    $("tiles-panel").hidden = !s.enabled;
    $("tiles-paper").hidden = s.mode !== "paper";
    $("tiles-free").hidden = s.mode !== "free";
    for (const el of document.querySelectorAll<HTMLElement>("[data-custom]")) el.hidden = s.format !== "custom";
    $("tiles-margin-hint").hidden = s.marginMm >= 2;

    if (!s.enabled || this.clip.width <= 0) {
      this.grid = undefined;
      return;
    }
    const g = computeTileGrid(this.clip.width, this.clip.height, s);
    this.grid = g;
    const summary = $("tiles-summary");
    if ("error" in g) {
      summary.replaceChildren(p(g.error, "warn"));
      return;
    }
    this.showAxes(g, normaliseLeading);

    const n = sheetCount(g);
    const lines: HTMLElement[] = [];
    const head = `${g.columns.length} Spalte${g.columns.length === 1 ? "" : "n"} × ${g.rows.length} Zeile${g.rows.length === 1 ? "" : "n"} = ${n.toLocaleString("de-DE")} ${n === 1 ? "Blatt" : "Blätter"}`;
    if (g.orientation) {
      const [w, h] = paperSize(s, g.orientation);
      const name = s.format === "custom" ? "Eigenes Format" : s.format;
      lines.push(p(`${head}`), p(`${name} ${g.orientation === "portrait" ? "hoch" : "quer"} (${de(w)} × ${de(h)} mm)`, "muted"));
    } else {
      const ws = [...new Set(g.sheetWidths.map((v) => Math.round(v * 10)))];
      const hs = [...new Set(g.sheetHeights.map((v) => Math.round(v * 10)))];
      const size = `${de(g.sheetWidths[0]!)} × ${de(g.sheetHeights[0]!)} mm`;
      lines.push(p(head), p(ws.length === 1 && hs.length === 1 ? `Blatt ${size}` : `Blätter bis ${size}; die letzte Spalte/Zeile ist kleiner`, "muted"));
    }
    for (const h of g.hints) lines.push(p(h, "warn"));
    if (n > MANY_SHEETS) lines.push(p(`Viele Blätter (${n.toLocaleString("de-DE")}). Der Export ist trotzdem möglich, kann aber dauern.`, "warn"));
    summary.replaceChildren(...lines);
  }

  /** Linked fields: the leading one keeps the user's value, the other shows the result. */
  private showAxes(g: TileGrid, normaliseLeading: boolean): void {
    if (this.settings.mode !== "free") return;
    for (const a of this.axes) {
      const axis = this.settings[a.key];
      const spans = a.key === "columns" ? g.columns : g.rows;
      const count = spans.length;
      const len = spans[0]!.length;
      const last = spans.at(-1)!.length;
      const byCount = axis.lead === "count";
      a.count.closest(".field")!.classList.toggle("derived", !byCount);
      a.length.closest(".field")!.classList.toggle("derived", byCount);
      const active = document.activeElement;
      if (byCount) {
        if (active !== a.length) a.length.value = fmt(len);
        if (normaliseLeading) a.count.value = String(count);
      } else {
        if (active !== a.count) a.count.value = String(count);
        if (normaliseLeading && count > 1) a.length.value = fmt(len); // longer than the Clip: keep the typed length
      }
      a.rest.textContent = !byCount && count > 1 && Math.abs(last - len) >= 0.05 ? `${a.lastLabel} ${de(last)} mm` : "";
      if (normaliseLeading) {
        // Store what is actually used, so a clamped value is not restored next time.
        if (byCount) axis.count = count;
        else axis.lengthMm = count === 1 ? axis.lengthMm : len;
        storeTileSettings(this.settings);
      }
    }
  }
}

function radio(name: string, value: string): void {
  const el = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function p(text: string, cls = ""): HTMLParagraphElement {
  const el = document.createElement("p");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
