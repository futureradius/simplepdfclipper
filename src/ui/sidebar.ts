// The sidebar (ADR 0012, #50): its width can be dragged at its right edge, and each
// step (1 Plan, 2 Ausschnitt, 3 Export) folds away on a click on its heading. Both are
// remembered in this browser; storage may be unavailable, so every access is guarded.

export const PANEL_DEFAULT = 320;
export const PANEL_MIN = 280;
export const PANEL_MAX = 560;
/** Arrow keys on the focused handle change the width by this much. */
const KEY_STEP = 16;

const WIDTH_KEY = "simplepdfclipper.panelWidth";
const FOLDED_KEY = "simplepdfclipper.foldedSteps";

/** The width the sidebar may have in a window this wide: 280–560 px, at most half the window. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(windowWidth / 2)));
  if (!Number.isFinite(width)) return Math.min(PANEL_DEFAULT, max);
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)));
}

/** A remembered width, or undefined if none (usable) is stored. */
export function readPanelWidth(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The remembered folded steps (their numbers), ignoring anything that is not one. */
export function readFoldedSteps(raw: string | null): Set<string> {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; the sidebar still works
  }
}

/**
 * Wires the resize handle: `app` holds the sidebar width in `--panel-w`. Dragging the
 * handle sets it, double-click resets it, arrow keys nudge it.
 */
export function setUpPanelResize(app: HTMLElement, handle: HTMLElement): void {
  let width = clampPanelWidth(readPanelWidth(load(WIDTH_KEY)) ?? PANEL_DEFAULT, window.innerWidth);
  const apply = (w: number, remember: boolean) => {
    width = clampPanelWidth(w, window.innerWidth);
    app.style.setProperty("--panel-w", `${width}px`);
    handle.setAttribute("aria-valuenow", String(width));
    if (remember) store(WIDTH_KEY, String(width));
  };
  handle.setAttribute("aria-valuemin", String(PANEL_MIN));
  handle.setAttribute("aria-valuemax", String(PANEL_MAX));
  apply(width, false);

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    document.body.classList.add("resizing-panel");
    const move = (ev: PointerEvent) => apply(startW + ev.clientX - startX, false);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing-panel");
      apply(width, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => apply(PANEL_DEFAULT, true));
  handle.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation(); // not the arrow keys that move a Region
    apply(width + step, true);
  });
  // A smaller window may no longer allow the stored width (at most half the window).
  window.addEventListener("resize", () => apply(readPanelWidth(load(WIDTH_KEY)) ?? width, false));
}

/**
 * Wires the fold buttons: each `button.step-toggle` sits in the heading of a
 * `section.step` with a `data-step` name; a folded step shows only its heading.
 */
export function setUpStepFolding(root: ParentNode): void {
  const folded = readFoldedSteps(load(FOLDED_KEY));
  for (const button of root.querySelectorAll<HTMLButtonElement>("button.step-toggle")) {
    const step = button.closest<HTMLElement>("section.step")!;
    const name = step.dataset.step!;
    const show = (fold: boolean) => {
      step.classList.toggle("folded", fold);
      button.setAttribute("aria-expanded", String(!fold));
    };
    show(folded.has(name));
    button.addEventListener("click", () => {
      const fold = !step.classList.contains("folded");
      if (fold) folded.add(name);
      else folded.delete(name);
      show(fold);
      store(FOLDED_KEY, JSON.stringify([...folded].sort()));
    });
  }
}
