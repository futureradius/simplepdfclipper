// Clip presets and the remembered Clip on Plans of another size (ADR 0007, 0015, 0016).
// Pure logic, no DOM: a saved Clip is its Regions with their Layout plus the size of the
// Plan they were made on; on another Plan they are stretched to fit.

import { readRegions, stretchRegions, type Region } from "../export/regions";
import { cleanName, type NameRules } from "./presets";

export interface PlanSize {
  widthMm: number;
  heightMm: number;
}

/** Regions with their Layout, and the Plan they belong to. */
export interface SavedClip {
  plan: PlanSize;
  regions: Region[];
}

export interface ClipPreset {
  name: string;
  clip: SavedClip;
}

/** Names of Clip presets; no factory entry. */
export const CLIP_PRESET_NAMES: NameRules = { noun: "Ausschnitt-Vorlage" };

/** Factors this close to 1 count as the same Plan size (MuPDF keeps page sizes as 32-bit floats). */
const SAME = 1e-6;
/** Regions closer than this (mm) count as the same. */
const TOL = 1e-4;

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Reads a Plan size from untrusted data; undefined if malformed. */
export function readPlanSize(data: unknown): PlanSize | undefined {
  const d = data as Partial<PlanSize> | null;
  return d && typeof d === "object" && positive(d.widthMm) && positive(d.heightMm) ? { widthMm: d.widthMm, heightMm: d.heightMm } : undefined;
}

/** Reads a saved Clip from untrusted data; undefined if malformed or without Regions. */
export function readSavedClip(data: unknown): SavedClip | undefined {
  const d = data as { plan?: unknown; regions?: unknown } | null;
  if (!d || typeof d !== "object") return undefined;
  const plan = readPlanSize(d.plan);
  const regions = readRegions(d.regions);
  return plan && regions && regions.length > 0 ? { plan, regions } : undefined;
}

/** How much a Clip was stretched per axis (1: not at all). */
export interface Stretch {
  x: number;
  y: number;
}

/**
 * A saved Clip on `plan`: as saved if the Plan has the same size, else stretched by the
 * width and height ratios (ADR 0007). Each Region stays on the Plan; overlaps that
 * rounding may leave are repaired. `stretch` is set only if something was stretched.
 */
export function fitClip(saved: SavedClip, plan: PlanSize): { regions: Region[]; stretch?: Stretch } {
  let sx = plan.widthMm / saved.plan.widthMm;
  let sy = plan.heightMm / saved.plan.heightMm;
  if (Math.abs(sx - 1) < SAME) sx = 1;
  if (Math.abs(sy - 1) < SAME) sy = 1;
  if (sx === 1 && sy === 1) return { regions: saved.regions.map((r) => ({ ...r, at: { ...r.at } })) };
  const kept = stretchRegions(saved.regions, sx, sy).map((r) => {
    const width = Math.min(r.width, plan.widthMm);
    const height = Math.min(r.height, plan.heightMm);
    return {
      ...r,
      width,
      height,
      x: Math.min(Math.max(0, r.x), plan.widthMm - width),
      y: Math.min(Math.max(0, r.y), plan.heightMm - height),
    };
  });
  return { regions: readRegions(kept) ?? kept, stretch: { x: sx, y: sy } };
}

/** Whether two Region lists are the same, in the same order, up to rounding. */
export function sameRegions(a: readonly Region[], b: readonly Region[]): boolean {
  if (a.length !== b.length) return false;
  const close = (u: number, v: number) => Math.abs(u - v) < TOL;
  return a.every((r, i) => {
    const s = b[i]!;
    return close(r.x, s.x) && close(r.y, s.y) && close(r.width, s.width) && close(r.height, s.height) && close(r.at.x, s.at.x) && close(r.at.y, s.at.y);
  });
}

/** Whether the Clip `current` is `saved`, fitted to the current Plan. */
export function sameClip(current: SavedClip, saved: SavedClip): boolean {
  return sameRegions(current.regions, fitClip(saved, current.plan).regions);
}

const percent = (factor: number) => {
  const p = (factor - 1) * 100;
  const abs = Math.abs(p);
  const shown = abs < 0.05 ? "< 0,1" : abs.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${p > 0 ? "+" : "−"}${shown} %`;
};

/** The yellow note in step 2 after stretching (ADR 0007). */
export function stretchNote(s: Stretch): string {
  const parts: string[] = [];
  for (const [axis, f] of [["horizontal", s.x], ["vertikal", s.y]] as const)
    if (f !== 1) parts.push(`${axis} um ${percent(f)} ${f > 1 ? "gestreckt" : "gestaucht"}`);
  return `Bereiche an die Plangröße angepasst: ${parts.join(", ")}. Bitte prüfen.`;
}

// ---- File format ------------------------------------------------------------------

const FILE_KIND = "simplepdfclipper-clip-presets";

/** A list as stored and in the file: `{ name, plan, regions }` each. */
export const clipPresetEntries = (presets: readonly ClipPreset[]) => presets.map((p) => ({ name: p.name, plan: p.clip.plan, regions: p.clip.regions }));

export function clipPresetsToJson(presets: readonly ClipPreset[]): string {
  return JSON.stringify({ kind: FILE_KIND, version: 1, presets: clipPresetEntries(presets) }, null, 2) + "\n";
}

/** Reads a Clip presets file. Throws an Error with a German message if it isn't one. */
export function clipPresetsFromJson(text: string): ClipPreset[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Die Datei ist keine Ausschnitt-Vorlagen-Datei (kein gültiges JSON).");
  }
  const d = data as { kind?: unknown; presets?: unknown };
  if (!d || typeof d !== "object" || d.kind !== FILE_KIND || !Array.isArray(d.presets))
    throw new Error("Die Datei ist keine Ausschnitt-Vorlagen-Datei von simple pdf clipper.");
  return readClipPresetList(d.presets);
}

/**
 * A stored or imported list, entries as in the file (`name`, `plan`, `regions`): those
 * without a usable name or Clip are dropped.
 */
export function readClipPresetList(raw: unknown): ClipPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipPreset[] = [];
  for (const item of raw) {
    const p = item as { name?: unknown } | null;
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !cleanName(p.name)) continue;
    const clip = readSavedClip(p);
    if (clip) out.push({ name: cleanName(p.name), clip });
  }
  return out;
}
