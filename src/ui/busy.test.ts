import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusySchedule, formatElapsed } from "./busy";

describe("formatElapsed", () => {
  it("shows minutes and seconds, hours only when needed", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_900)).toBe("0:07");
    expect(formatElapsed(754_000)).toBe("12:34");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});

describe("BusySchedule", () => {
  let log: string[];
  let schedule: BusySchedule;
  beforeEach(() => {
    vi.useFakeTimers();
    log = [];
    schedule = new BusySchedule(
      { delayMs: 400, minShowMs: 500, fadeMs: 150 },
      { show: () => log.push(`show@${Date.now()}`), hide: () => log.push(`hide@${Date.now()}`), closed: () => log.push(`closed@${Date.now()}`) },
      () => Date.now(),
    );
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("never shows a job that ends within the delay", async () => {
    schedule.begin(false);
    vi.advanceTimersByTime(399);
    await schedule.finish();
    vi.runAllTimers();
    expect(log).toEqual(["closed@399"]);
  });

  it("shows after the delay, stays the minimum time, then fades out", async () => {
    schedule.begin(false);
    vi.advanceTimersByTime(450);
    const gone = schedule.finish();
    await vi.runAllTimersAsync();
    await gone;
    // shown at 400, kept until 900, closed after the 150 ms fade.
    expect(log).toEqual(["show@400", "hide@900", "closed@1050"]);
  });

  it("hides at once after a long job (minimum time already over)", async () => {
    schedule.begin(false);
    vi.advanceTimersByTime(3000);
    const gone = schedule.finish();
    await vi.runAllTimersAsync();
    await gone;
    expect(log).toEqual(["show@400", "hide@3000", "closed@3150"]);
  });

  it("shows at once when immediate (main-thread engine)", () => {
    schedule.begin(true);
    expect(log).toEqual(["show@0"]);
  });

  it("keeps the window for a job that starts while it fades out", async () => {
    schedule.begin(false);
    vi.advanceTimersByTime(1000);
    const first = schedule.finish();
    vi.advanceTimersByTime(50); // fading
    expect(log).toEqual(["show@400", "hide@1000"]);
    schedule.begin(false);
    await first; // the first job is done waiting
    expect(log).toEqual(["show@400", "hide@1000", "show@1050"]);
    vi.advanceTimersByTime(5000);
    expect(log).toHaveLength(3); // no close while the second job runs
    expect(schedule.visible).toBe(true);
  });
});
