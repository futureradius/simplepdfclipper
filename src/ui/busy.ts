// Busy window (ADR 0012, issue #26): a centred window over a dimmed app while a
// Document loads or an export runs, with what is happening, the elapsed time and,
// where the work can really stop (Tiled Export), "Abbrechen".
//
// The app is blocked from the first moment (the dialog is modal but transparent);
// the window only fades in if the job is still running after a short delay, so fast
// jobs don't flash it, and once visible it stays long enough to be read.

export interface BusyTiming {
  /** Show the window only if the job still runs after this long. */
  delayMs: number;
  /** Once visible, keep it at least this long. */
  minShowMs: number;
  /** Length of the fade-out; the dialog closes after it. */
  fadeMs: number;
}

export const BUSY_TIMING: BusyTiming = { delayMs: 400, minShowMs: 500, fadeMs: 150 };

/** "0:07", "12:34", "1:02:03". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** When to show, hide and close: timing only, no DOM (unit-tested). */
export class BusySchedule {
  private shownAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle: (() => void) | undefined;

  constructor(
    private readonly timing: BusyTiming,
    private readonly cb: { show(): void; hide(): void; closed(): void },
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Whether the window is (still) visible, including its minimum time and fade-out. */
  get visible(): boolean {
    return this.shownAt !== undefined;
  }

  /** A job starts. `immediate`: no delay (main-thread engine, ADR 0010). */
  begin(immediate: boolean): void {
    this.clear();
    // A job that ended while the window was still up hands it straight to this one.
    this.settle?.();
    this.settle = undefined;
    if (this.shownAt !== undefined) return this.cb.show();
    if (immediate || this.timing.delayMs <= 0) this.reveal();
    else this.timer = setTimeout(() => this.reveal(), this.timing.delayMs);
  }

  /** The job ended; resolves once the window is gone. */
  finish(): Promise<void> {
    this.clear();
    if (this.shownAt === undefined) {
      this.cb.closed();
      return Promise.resolve();
    }
    const wait = Math.max(0, this.shownAt + this.timing.minShowMs - this.now());
    return new Promise<void>((resolve) => {
      this.settle = resolve;
      this.timer = setTimeout(() => {
        this.cb.hide();
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.shownAt = undefined;
          this.settle = undefined;
          this.cb.closed();
          resolve();
        }, this.timing.fadeMs);
      }, wait);
    });
  }

  private reveal(): void {
    this.timer = undefined;
    this.shownAt = this.now();
    this.cb.show();
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export interface BusyElements {
  dialog: HTMLDialogElement;
  text: HTMLElement;
  time: HTMLElement;
  bar: HTMLProgressElement;
  cancel: HTMLButtonElement;
}

export interface BusyOptions {
  /** The button that started the job: it shows a small spinner too. */
  button?: HTMLElement;
  /** Offered as "Abbrechen" (and `Esc`) only if the work can really stop. */
  cancel?: () => void;
}

export class BusyWindow {
  /** Main-thread engine (ADR 0010): show at once, the delay timer could not fire. */
  immediate = false;
  private readonly schedule: BusySchedule;
  private running = false;
  private startedAt = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private button: HTMLElement | undefined;
  private onCancel: (() => void) | undefined;

  constructor(
    private readonly el: BusyElements,
    timing: BusyTiming = BUSY_TIMING,
  ) {
    this.schedule = new BusySchedule(timing, {
      show: () => {
        el.dialog.classList.add("shown");
        this.button?.classList.add("busy");
      },
      hide: () => {
        el.dialog.classList.remove("shown");
        this.button?.classList.remove("busy");
      },
      closed: () => {
        clearInterval(this.tick);
        this.tick = undefined;
        this.button?.classList.remove("busy");
        this.button = undefined;
        el.dialog.close();
      },
    });
    el.cancel.addEventListener("click", () => this.cancel());
    // The dialog has closedby="none", so Esc never closes it on its own.
    el.dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.cancel();
    });
    // Belt and braces: a modal that got closed some other way comes back while busy.
    el.dialog.addEventListener("close", () => {
      if (this.running) el.dialog.showModal();
    });
  }

  /** Whether a job is running (the app is blocked). */
  get active(): boolean {
    return this.running;
  }

  /**
   * A job starts (or the running one moves on to `text`, keeping its timer).
   * Resolves once it is safe to start work that may block the main thread.
   */
  async start(text: string, opts: BusyOptions = {}): Promise<void> {
    if (!this.running) this.startedAt = performance.now();
    this.running = true;
    this.el.text.textContent = text;
    this.el.bar.hidden = true;
    this.onCancel = opts.cancel;
    this.el.cancel.hidden = !opts.cancel;
    this.el.cancel.disabled = false;
    if (this.button !== opts.button) {
      this.button?.classList.remove("busy");
      this.button = opts.button;
      if (this.schedule.visible) this.button?.classList.add("busy");
    }
    this.showTime();
    this.tick ??= setInterval(() => this.showTime(), 250);
    if (!this.el.dialog.open) this.el.dialog.showModal();
    this.schedule.begin(this.immediate);
    // Main thread: let the window paint before the work blocks it.
    if (this.immediate) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  /** What is happening now. */
  text(text: string): void {
    this.el.text.textContent = text;
  }

  /** n of m done (Tiled Export). */
  progress(done: number, total: number): void {
    this.el.bar.hidden = false;
    this.el.bar.max = total;
    this.el.bar.value = done;
  }

  /** Whether "Abbrechen" still works (not while saving). */
  cancellable(on: boolean): void {
    this.el.cancel.disabled = !on;
  }

  /** The job ended; resolves once the window is gone. */
  end(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.running = false;
    this.onCancel = undefined;
    return this.schedule.finish();
  }

  private cancel(): void {
    if (!this.running || !this.onCancel || this.el.cancel.hidden || this.el.cancel.disabled) return;
    this.el.cancel.disabled = true;
    this.el.text.textContent = "Wird abgebrochen…";
    this.onCancel();
  }

  private showTime(): void {
    this.el.time.textContent = formatElapsed(performance.now() - this.startedAt);
  }
}
