import { describe, expect, it } from "vitest";
import { clampPanelWidth, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, readFoldedSteps, readPanelWidth } from "./sidebar";

describe("clampPanelWidth", () => {
  it("keeps a width between 280 and 560 px on a wide window", () => {
    expect(clampPanelWidth(400, 1920)).toBe(400);
    expect(clampPanelWidth(100, 1920)).toBe(PANEL_MIN);
    expect(clampPanelWidth(900, 1920)).toBe(PANEL_MAX);
  });

  it("never takes more than half the window", () => {
    expect(clampPanelWidth(560, 900)).toBe(450);
  });

  it("keeps the minimum even on a very narrow window", () => {
    expect(clampPanelWidth(500, 400)).toBe(PANEL_MIN);
  });

  it("falls back to the default for nonsense", () => {
    expect(clampPanelWidth(NaN, 1920)).toBe(PANEL_DEFAULT);
  });
});

describe("readPanelWidth", () => {
  it("reads a stored number and ignores anything else", () => {
    expect(readPanelWidth("410")).toBe(410);
    expect(readPanelWidth(null)).toBeUndefined();
    expect(readPanelWidth("wide")).toBeUndefined();
    expect(readPanelWidth("-5")).toBeUndefined();
  });
});

describe("readFoldedSteps", () => {
  it("reads the folded step names and drops broken entries", () => {
    expect([...readFoldedSteps('["2","3"]')]).toEqual(["2", "3"]);
    expect([...readFoldedSteps('["1",4,null]')]).toEqual(["1"]);
    expect(readFoldedSteps("{oops").size).toBe(0);
    expect(readFoldedSteps(null).size).toBe(0);
  });
});
