// Remembers the last Clip, the last export settings and the Presets in this browser
// (ADR 0007, 0015). Storage may be unavailable (e.g. strict privacy settings), so
// every access is guarded.

import type { ClipMm } from "../export/index";
import { readPresetList, sanitizeSettings, type ExportSettings, type Preset } from "./presets";

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

// ---- Export settings and Presets (ADR 0007, 0013, 0015) ---------------------------

const SETTINGS_KEY = "simplepdfclipper.exportSettings";
/** Before Presets only the Tiled Export settings were remembered, under this key. */
const OLD_TILES_KEY = "simplepdfclipper.tileSettings";
const PRESETS_KEY = "simplepdfclipper.presets";

/** The last export settings; anything malformed falls back to the default. */
export function loadExportSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
    const old = localStorage.getItem(OLD_TILES_KEY);
    return sanitizeSettings(old ? { tiles: JSON.parse(old) } : {});
  } catch {
    return sanitizeSettings({});
  }
}

export function storeExportSettings(s: ExportSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export interface StoredPresets {
  presets: Preset[];
  /** The Preset last picked in the dropdown; undefined: Standard. */
  selected: string | undefined;
}

export function loadPresets(): StoredPresets {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return { presets: [], selected: undefined };
    const d = JSON.parse(raw) as { presets?: unknown; selected?: unknown };
    return { presets: readPresetList(d.presets), selected: typeof d.selected === "string" ? d.selected : undefined };
  } catch {
    return { presets: [], selected: undefined };
  }
}

export function storePresets(p: StoredPresets): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}
