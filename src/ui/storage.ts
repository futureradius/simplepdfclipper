// Remembers the last Clip, the last export settings, the Presets and the Clip presets
// in this browser (ADR 0007, 0015). Storage may be unavailable (e.g. strict privacy settings), so
// every access is guarded.

import type { ClipMm } from "../export/index";
import { readRegions, single, type Region } from "../export/regions";
import { readPresetList, sanitizeSettings, type ExportSettings, type Preset } from "./presets";
import { clipPresetEntries, readClipPresetList, readPlanSize, type ClipPreset, type PlanSize } from "./clippresets";

const KEY = "simplepdfclipper.lastRegions";
/** The size of the Plan the last Regions were made on (ADR 0007), so they can be stretched. */
const PLAN_KEY = "simplepdfclipper.lastPlanSize";
/** Before Regions (ADR 0016) one rectangle was remembered, under this key. */
const OLD_CLIP_KEY = "simplepdfclipper.lastClip";
const CLIP_PRESETS_KEY = "simplepdfclipper.clipPresets";

/**
 * The last Regions with their Layout, and the Plan size they were made on (missing if
 * stored before #38); undefined if nothing (usable) is remembered.
 */
export function loadStoredRegions(): { regions: Region[]; plan: PlanSize | undefined } | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const planRaw = localStorage.getItem(PLAN_KEY);
    const plan = planRaw ? readPlanSize(JSON.parse(planRaw)) : undefined;
    if (raw) {
      const regions = readRegions(JSON.parse(raw));
      return regions && { regions, plan };
    }
    const old = localStorage.getItem(OLD_CLIP_KEY);
    if (!old) return undefined;
    const c = JSON.parse(old) as Partial<ClipMm>;
    const ok = [c.x, c.y, c.width, c.height].every((v) => typeof v === "number" && Number.isFinite(v)) && c.width! > 0 && c.height! > 0;
    return ok ? { regions: single(c as ClipMm), plan: undefined } : undefined;
  } catch {
    return undefined;
  }
}

export function storeRegions(regions: readonly Region[], plan: PlanSize): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(regions));
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  } catch {
    // ignore
  }
}

/** Clip presets (ADR 0015) and the one last picked. */
export function loadClipPresets(): { presets: ClipPreset[]; selected: string | undefined } {
  try {
    const raw = localStorage.getItem(CLIP_PRESETS_KEY);
    if (!raw) return { presets: [], selected: undefined };
    const d = JSON.parse(raw) as { presets?: unknown; selected?: unknown };
    return { presets: readClipPresetList(d.presets), selected: typeof d.selected === "string" ? d.selected : undefined };
  } catch {
    return { presets: [], selected: undefined };
  }
}

export function storeClipPresets(p: { presets: readonly ClipPreset[]; selected: string | undefined }): void {
  try {
    localStorage.setItem(CLIP_PRESETS_KEY, JSON.stringify({ presets: clipPresetEntries(p.presets), selected: p.selected }));
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
