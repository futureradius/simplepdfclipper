import { describe, expect, it } from "vitest";
import { overlapsInLayout, setRect, stretchRegions, type Region } from "../export/regions";
import {
  CLIP_PRESET_NAMES,
  clipPresetsFromJson,
  clipPresetsToJson,
  fitClip,
  readSavedClip,
  sameClip,
  stretchNote,
  type ClipPreset,
  type SavedClip,
} from "./clippresets";
import { importPresets, nameProblem } from "./presets";

const r = (x: number, y: number, width: number, height: number, at = { x: 0, y: 0 }): Region => ({ x, y, width, height, at });

/** A tall schedule: legend on top, a slice from the middle beside a symbol box, all touching. */
const schedule: SavedClip = {
  plan: { widthMm: 1189, heightMm: 13_000 },
  regions: [r(0, 0, 1189, 150), r(0, 5000, 800, 600, { x: 0, y: 150 }), r(800, 12_700, 389, 300, { x: 800, y: 150 })],
};

describe("stretchRegions", () => {
  it("leaves everything exactly in place with factors of 1", () => {
    expect(stretchRegions(schedule.regions, 1, 1)).toEqual(schedule.regions);
  });

  it("stretches one axis only", () => {
    const [a, b, c] = stretchRegions(schedule.regions, 1, 1.1);
    expect(a).toEqual(r(0, 0, 1189, 165));
    expect(b!.x).toBe(0);
    expect(b!.width).toBe(800);
    expect(b!.y).toBeCloseTo(5500, 9);
    expect(b!.height).toBeCloseTo(660, 9);
    expect(b!.at.y).toBeCloseTo(165, 9);
    expect(c!.at.x).toBe(800);
    expect(c!.y).toBeCloseTo(13_970, 9);
  });

  it("stretches both axes, and touching Regions keep touching", () => {
    const s = stretchRegions(schedule.regions, 0.97, 1.021);
    const [a, b, c] = s;
    // Exactly the same edge values, not just close: later resizes find the chains.
    expect(b!.at.y).toBe(a!.at.y + a!.height);
    expect(c!.at.y).toBe(b!.at.y);
    expect(c!.at.x).toBe(b!.at.x + b!.width);
    expect(c!.at.x + c!.width).toBeCloseTo(a!.width, 9);
    expect(overlapsInLayout(s)).toBe(false);
  });

  it("keeps the chains for a later resize", () => {
    const s = stretchRegions(schedule.regions, 0.97, 1.021);
    // Making the legend taller pushes both Regions below it down along with its edge.
    const grown = setRect(s, 0, { ...s[0]!, height: s[0]!.height + 10 });
    expect(grown[1]!.at.y).toBeCloseTo(s[1]!.at.y + 10, 9);
    expect(grown[2]!.at.y).toBeCloseTo(s[2]!.at.y + 10, 9);
  });
});

describe("fitClip", () => {
  it("restores exactly on a Plan of the same size", () => {
    const f = fitClip(schedule, { widthMm: 1189, heightMm: 13_000 });
    expect(f.regions).toEqual(schedule.regions);
    expect(f.stretch).toBeUndefined();
  });

  it("stretches to a Plan that grew at one end", () => {
    const f = fitClip(schedule, { widthMm: 1189, heightMm: 13_273 });
    expect(f.stretch).toEqual({ x: 1, y: 13_273 / 13_000 });
    const last = f.regions[2]!;
    expect(last.y + last.height).toBeCloseTo(13_273, 6); // still at the bottom edge
    expect(f.regions[0]).toEqual(r(0, 0, 1189, 150 * (13_273 / 13_000)));
  });

  it("keeps every Region on the Plan", () => {
    const f = fitClip({ plan: { widthMm: 100, heightMm: 100 }, regions: [r(50, 50, 50, 50)] }, { widthMm: 210, heightMm: 297 });
    const [only] = f.regions;
    expect(only!.x + only!.width).toBeLessThanOrEqual(210);
    expect(only!.y + only!.height).toBeLessThanOrEqual(297);
  });

  it("counts a stretched Clip as the same as its preset", () => {
    const plan = { widthMm: 1000, heightMm: 12_000 };
    const current: SavedClip = { plan, regions: fitClip(schedule, plan).regions };
    expect(sameClip(current, schedule)).toBe(true);
    current.regions[1] = { ...current.regions[1]!, x: current.regions[1]!.x + 1 };
    expect(sameClip(current, schedule)).toBe(false);
  });
});

describe("stretchNote", () => {
  it("says the direction and the amount", () => {
    expect(stretchNote({ x: 1, y: 1.021 })).toBe("Bereiche an die Plangröße angepasst: vertikal um +2,1 % gestreckt. Bitte prüfen.");
    expect(stretchNote({ x: 0.985, y: 1 })).toBe("Bereiche an die Plangröße angepasst: horizontal um −1,5 % gestaucht. Bitte prüfen.");
    expect(stretchNote({ x: 1.0001, y: 0.9 })).toBe(
      "Bereiche an die Plangröße angepasst: horizontal um +< 0,1 % gestreckt, vertikal um −10,0 % gestaucht. Bitte prüfen.",
    );
  });
});

describe("Clip preset files", () => {
  const legend: ClipPreset = { name: "Legende + Woche", clip: schedule };
  const other: ClipPreset = { name: "Nur Legende", clip: { plan: { widthMm: 841, heightMm: 594 }, regions: [r(0, 0, 841, 40)] } };

  it("round-trips through the file format", () => {
    const text = clipPresetsToJson([legend, other]);
    expect(JSON.parse(text)).toMatchObject({ kind: "simplepdfclipper-clip-presets", version: 1 });
    expect(JSON.parse(text).presets[0]).toEqual({ name: "Legende + Woche", plan: schedule.plan, regions: schedule.regions });
    expect(clipPresetsFromJson(text)).toEqual([legend, other]);
  });

  it("rejects files that are not Clip preset files, Presets files included", () => {
    expect(() => clipPresetsFromJson("not json")).toThrow(/kein gültiges JSON/);
    expect(() => clipPresetsFromJson(JSON.stringify({ kind: "simplepdfclipper-presets", version: 1, presets: [] }))).toThrow(
      /keine Ausschnitt-Vorlagen-Datei/,
    );
  });

  it("drops entries without a name or a usable Clip, and repairs overlaps", () => {
    const text = JSON.stringify({
      kind: "simplepdfclipper-clip-presets",
      version: 1,
      presets: [
        { name: " ", plan: schedule.plan, regions: schedule.regions },
        { name: "no plan", regions: schedule.regions },
        { name: "no regions", plan: schedule.plan, regions: [] },
        { name: "bad size", plan: { widthMm: -1, heightMm: 5 }, regions: schedule.regions },
        { name: "bad region", plan: schedule.plan, regions: [{ x: 0, y: 0, width: 0, height: 5, at: { x: 0, y: 0 } }] },
        { name: "  zwei   über­einander ", plan: schedule.plan, regions: [r(0, 0, 10, 10), r(0, 20, 10, 10)] },
      ],
    });
    const list = clipPresetsFromJson(text);
    expect(list.map((p) => p.name)).toEqual(["zwei über­einander"]);
    expect(overlapsInLayout(list[0]!.clip.regions)).toBe(false);
  });

  it("numbers clashing names on import; no name is reserved", () => {
    const { presets } = importPresets([legend], [legend, { ...other, name: "Standard" }], CLIP_PRESET_NAMES);
    expect(presets.map((p) => p.name)).toEqual(["Legende + Woche", "Legende + Woche (2)", "Standard"]);
    expect(nameProblem("legende + woche", [legend], undefined, CLIP_PRESET_NAMES)).toBe("Es gibt schon eine Ausschnitt-Vorlage „legende + woche“.");
  });

  it("reads a saved Clip only with a Plan size and Regions", () => {
    expect(readSavedClip({ plan: schedule.plan, regions: schedule.regions })).toEqual(schedule);
    expect(readSavedClip({ regions: schedule.regions })).toBeUndefined();
    expect(readSavedClip(null)).toBeUndefined();
  });
});
