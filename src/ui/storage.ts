// Remembers the last Clip in this browser (ADR 0007). Storage may be unavailable
// (e.g. strict privacy settings), so every access is guarded.

import type { ClipMm } from "../export/index";
import type { AxisSetting, TileSettings } from "../export/tilegrid";

const KEY = "simplepdfclipper.lastClip";

export function loadStoredClip(): ClipMm | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const c = JSON.parse(raw) as Partial<ClipMm>;
    const ok = [c.x, c.y, c.width, c.height].every((v) => typeof v === "number" && Number.isFinite(v));
    return ok ? (c as ClipMm) : undefined;
  } catch {
    return undefined;
  }
}

export function storeClip(clip: ClipMm): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(clip));
  } catch {
    // ignore
  }
}

// ---- Tiled Export settings (ADR 0013) ---------------------------------------

const TILES_KEY = "simplepdfclipper.tileSettings";

/** Stored settings merged over the defaults; anything malformed falls back to the default. */
export function loadTileSettings(defaults: TileSettings): TileSettings {
  try {
    const raw = localStorage.getItem(TILES_KEY);
    if (!raw) return structuredClone(defaults);
    const s = JSON.parse(raw) as Partial<TileSettings>;
    const pick = <K extends keyof TileSettings>(k: K, ok: (v: unknown) => boolean): TileSettings[K] =>
      ok(s[k]) ? (s[k] as TileSettings[K]) : structuredClone(defaults[k]);
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const axis = (v: unknown) => {
      const a = v as Partial<AxisSetting> | undefined;
      return !!a && (a.lead === "count" || a.lead === "length") && num(a.count) && num(a.lengthMm);
    };
    return {
      enabled: pick("enabled", (v) => typeof v === "boolean"),
      mode: pick("mode", (v) => v === "paper" || v === "free"),
      format: pick("format", (v) => ["A4", "A3", "A2", "A1", "A0", "custom"].includes(v as string)),
      customWidthMm: pick("customWidthMm", num),
      customHeightMm: pick("customHeightMm", num),
      orientation: pick("orientation", (v) => v === "auto" || v === "portrait" || v === "landscape"),
      columns: pick("columns", axis),
      rows: pick("rows", axis),
      marginMm: pick("marginMm", num),
      output: pick("output", (v) => v === "files" || v === "multipage"),
    };
  } catch {
    return structuredClone(defaults);
  }
}

export function storeTileSettings(s: TileSettings): void {
  try {
    localStorage.setItem(TILES_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
