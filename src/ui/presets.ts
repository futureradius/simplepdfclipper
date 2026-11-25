// Export settings and named Presets (ADR 0015). Pure logic, no DOM: validating
// stored or imported settings, comparing them, unique names, and the JSON file
// format used to pass Presets between colleagues.

import type { MergeMode } from "../export/index";
import { DEFAULT_TILE_SETTINGS, type AxisSetting, type TileSettings } from "../export/tilegrid";

export interface SvgOptions {
  textAsPaths: boolean;
  mergeMode: MergeMode;
}

/** Everything step 3 lets the user set. Never the Clip. */
export interface ExportSettings {
  tiles: TileSettings;
  svg: SvgOptions;
}

export interface Preset {
  name: string;
  settings: ExportSettings;
}

/** The factory settings; shown as "Standard" in the Preset dropdown. */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  tiles: DEFAULT_TILE_SETTINGS,
  svg: { textAsPaths: false, mergeMode: "balanced" },
};

/** Name of the factory settings in the dropdown; no Preset may take it. */
export const STANDARD = "Standard";

const MERGE_MODES: readonly MergeMode[] = ["exact", "balanced", "max"];
const FORMATS = ["A4", "A3", "A2", "A1", "A0", "custom"];

/** Any value merged over the defaults; anything missing or malformed falls back to the default. */
export function sanitizeTileSettings(raw: unknown, defaults: TileSettings = DEFAULT_TILE_SETTINGS): TileSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof TileSettings, unknown>>;
  const pick = <K extends keyof TileSettings>(k: K, ok: (v: unknown) => boolean): TileSettings[K] =>
    ok(s[k]) ? (structuredClone(s[k]) as TileSettings[K]) : structuredClone(defaults[k]);
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const axis = (v: unknown) => {
    const a = v as Partial<AxisSetting> | undefined;
    return !!a && typeof a === "object" && (a.lead === "count" || a.lead === "length") && num(a.count) && num(a.lengthMm);
  };
  const tiles: TileSettings = {
    enabled: pick("enabled", (v) => typeof v === "boolean"),
    mode: pick("mode", (v) => v === "paper" || v === "free"),
    format: pick("format", (v) => FORMATS.includes(v as string)),
    customWidthMm: pick("customWidthMm", num),
    customHeightMm: pick("customHeightMm", num),
    orientation: pick("orientation", (v) => v === "auto" || v === "portrait" || v === "landscape"),
    columns: pick("columns", axis),
    rows: pick("rows", axis),
    marginMm: pick("marginMm", num),
    output: pick("output", (v) => v === "files" || v === "multipage"),
  };
  // Keep only the axis fields, nothing else an imported file may carry.
  for (const k of ["columns", "rows"] as const) {
    const { lead, count, lengthMm } = tiles[k];
    tiles[k] = { lead, count, lengthMm };
  }
  return tiles;
}

export function sanitizeSettings(raw: unknown): ExportSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as { tiles?: unknown; svg?: unknown };
  const svg = (s.svg && typeof s.svg === "object" ? s.svg : {}) as Partial<Record<keyof SvgOptions, unknown>>;
  const d = DEFAULT_EXPORT_SETTINGS.svg;
  return {
    tiles: sanitizeTileSettings(s.tiles),
    svg: {
      textAsPaths: typeof svg.textAsPaths === "boolean" ? svg.textAsPaths : d.textAsPaths,
      mergeMode: MERGE_MODES.includes(svg.mergeMode as MergeMode) ? (svg.mergeMode as MergeMode) : d.mergeMode,
    },
  };
}

/**
 * Whether two settings export the same. In a free Tile grid only the leading
 * field of each axis counts: the other one is derived from the Clip.
 */
export function sameSettings(a: ExportSettings, b: ExportSettings): boolean {
  return JSON.stringify(essentials(a)) === JSON.stringify(essentials(b));
}

function essentials(s: ExportSettings): unknown {
  const axis = (a: AxisSetting) => (a.lead === "count" ? ["count", a.count] : ["length", a.lengthMm]);
  const t = s.tiles;
  return [
    t.enabled, t.mode, t.format, t.customWidthMm, t.customHeightMm, t.orientation,
    axis(t.columns), axis(t.rows), t.marginMm, t.output,
    s.svg.textAsPaths, s.svg.mergeMode,
  ];
}

/** Trimmed name with inner whitespace collapsed. */
export const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");

const sameName = (a: string, b: string) => a.localeCompare(b, "de", { sensitivity: "accent" }) === 0;

/** Anything with a name: a Preset or a Clip preset. */
export interface Named {
  name: string;
}

/** How names of one kind of preset are checked: what it is called (German), and the name the factory entry takes. */
export interface NameRules {
  noun: string;
  reserved?: string;
}

/** Names of Presets: "Standard" is the factory settings. */
export const PRESET_NAMES: NameRules = { noun: "Vorlage", reserved: STANDARD };

/** Why `name` can't be used (German, for the UI), or undefined if it can. `except` is the one being renamed. */
export function nameProblem(name: string, presets: readonly Named[], except?: string, rules: NameRules = PRESET_NAMES): string | undefined {
  const n = cleanName(name);
  if (!n) return "Bitte einen Namen eingeben.";
  if (rules.reserved && sameName(n, rules.reserved)) return `„${rules.reserved}“ ist die Werkseinstellung; bitte einen anderen Namen wählen.`;
  if (presets.some((p) => sameName(p.name, n) && p.name !== except)) return `Es gibt schon eine ${rules.noun} „${n}“.`;
  return undefined;
}

/** `name`, or "name (2)", "name (3)", … whichever is still free. */
export function uniqueName(name: string, presets: readonly Named[], rules: NameRules = PRESET_NAMES): string {
  const base = cleanName(name) || rules.noun;
  if (!nameProblem(base, presets, undefined, rules)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!nameProblem(candidate, presets, undefined, rules)) return candidate;
  }
}

/** Imported presets added to the existing ones; a name clash comes in renamed, never overwrites. */
export function importPresets<P extends Named>(
  existing: readonly P[],
  incoming: readonly P[],
  rules: NameRules = PRESET_NAMES,
): { presets: P[]; added: P[] } {
  const presets = [...existing];
  const added: P[] = [];
  for (const p of incoming) {
    const q = { ...p, name: uniqueName(p.name, presets, rules) };
    presets.push(q);
    added.push(q);
  }
  return { presets, added };
}

// ---- File format ------------------------------------------------------------------

const FILE_KIND = "simplepdfclipper-presets";

export function presetsToJson(presets: readonly Preset[]): string {
  return JSON.stringify({ kind: FILE_KIND, version: 1, presets }, null, 2) + "\n";
}

/** Reads a Presets file. Throws an Error with a German message if it isn't one. */
export function presetsFromJson(text: string): Preset[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Die Datei ist keine Vorlagen-Datei (kein gültiges JSON).");
  }
  const d = data as { kind?: unknown; presets?: unknown };
  if (!d || typeof d !== "object" || d.kind !== FILE_KIND || !Array.isArray(d.presets))
    throw new Error("Die Datei ist keine Vorlagen-Datei von simple pdf clipper.");
  return readPresetList(d.presets);
}

/** A stored or imported list: entries without a usable name are dropped, settings sanitised. */
export function readPresetList(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  for (const item of raw) {
    const p = item as { name?: unknown; settings?: unknown } | null;
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !cleanName(p.name)) continue;
    out.push({ name: cleanName(p.name), settings: sanitizeSettings(p.settings) });
  }
  return out;
}

// ---- Dropdown state -----------------------------------------------------------------

/**
 * What the dropdown shows for `current` settings at start: the last picked Preset
 * if it still matches, else any matching Preset (or Standard), else the last picked
 * one marked as changed. `undefined` means Standard.
 */
export function initialSelection(
  current: ExportSettings,
  presets: readonly Preset[],
  lastPicked: string | undefined,
): { name: string | undefined; changed: boolean } {
  const last = presets.find((p) => p.name === lastPicked);
  if (last && sameSettings(current, last.settings)) return { name: last.name, changed: false };
  if (!last && sameSettings(current, DEFAULT_EXPORT_SETTINGS)) return { name: undefined, changed: false };
  const match = presets.find((p) => sameSettings(current, p.settings));
  if (match) return { name: match.name, changed: false };
  if (sameSettings(current, DEFAULT_EXPORT_SETTINGS)) return { name: undefined, changed: false };
  return { name: last?.name, changed: true };
}
