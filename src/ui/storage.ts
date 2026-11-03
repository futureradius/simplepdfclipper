// Remembers the last Clip in this browser (ADR 0007). Storage may be unavailable
// (e.g. strict privacy settings), so every access is guarded.

import type { ClipMm } from "../export/index";

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
