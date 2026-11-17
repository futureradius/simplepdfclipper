import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_SETTINGS,
  importPresets,
  initialSelection,
  nameProblem,
  presetsFromJson,
  presetsToJson,
  sameSettings,
  sanitizeSettings,
  uniqueName,
  type ExportSettings,
  type Preset,
} from "./presets";

const settings = (patch: { tiles?: Partial<ExportSettings["tiles"]>; svg?: Partial<ExportSettings["svg"]> } = {}): ExportSettings => ({
  tiles: { ...structuredClone(DEFAULT_EXPORT_SETTINGS.tiles), ...patch.tiles },
  svg: { ...DEFAULT_EXPORT_SETTINGS.svg, ...patch.svg },
});
const plotter: Preset = { name: "Plotter A0", settings: settings({ tiles: { enabled: true, format: "A0", marginMm: 5 } }) };
const office: Preset = { name: "Büro A4", settings: settings({ tiles: { enabled: true }, svg: { textAsPaths: true } }) };

describe("sanitizeSettings", () => {
  it("keeps valid settings", () => {
    expect(sanitizeSettings(plotter.settings)).toEqual(plotter.settings);
  });

  it("falls back to the default per field", () => {
    const s = sanitizeSettings({
      tiles: { enabled: "yes", format: "B5", marginMm: -1, output: "multipage", columns: { lead: "length", count: 2, lengthMm: 800, extra: 1 } },
      svg: { textAsPaths: true, mergeMode: "everything" },
    });
    expect(s.tiles.enabled).toBe(false);
    expect(s.tiles.format).toBe("A4");
    expect(s.tiles.marginMm).toBe(10);
    expect(s.tiles.output).toBe("multipage");
    expect(s.tiles.columns).toEqual({ lead: "length", count: 2, lengthMm: 800 });
    expect(s.svg).toEqual({ textAsPaths: true, mergeMode: "balanced" });
  });

  it("turns garbage into the factory settings", () => {
    for (const raw of [undefined, null, 3, "x", [], { tiles: 5, svg: null }]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_EXPORT_SETTINGS);
  });

  it("never shares objects with its input or the defaults", () => {
    const s = sanitizeSettings({});
    s.tiles.columns.count = 7;
    expect(DEFAULT_EXPORT_SETTINGS.tiles.columns.count).toBe(1);
  });
});

describe("sameSettings", () => {
  it("compares every setting", () => {
    expect(sameSettings(settings(), settings())).toBe(true);
    expect(sameSettings(settings(), settings({ tiles: { marginMm: 11 } }))).toBe(false);
    expect(sameSettings(settings(), settings({ svg: { mergeMode: "max" } }))).toBe(false);
  });

  it("ignores the derived field of a free axis", () => {
    const a = settings({ tiles: { columns: { lead: "count", count: 3, lengthMm: 400 } } });
    const b = settings({ tiles: { columns: { lead: "count", count: 3, lengthMm: 396.3 } } });
    const c = settings({ tiles: { columns: { lead: "length", count: 3, lengthMm: 400 } } });
    expect(sameSettings(a, b)).toBe(true);
    expect(sameSettings(a, c)).toBe(false);
  });
});

describe("names", () => {
  const presets = [plotter, office];

  it("rejects empty, reserved and taken names", () => {
    expect(nameProblem("  ", presets)).toMatch(/Namen/);
    expect(nameProblem("standard", presets)).toMatch(/Werkseinstellung/);
    expect(nameProblem(" plotter  a0 ", presets)).toMatch(/schon/);
    expect(nameProblem("Buro A4", presets)).toBeUndefined(); // accents count
    expect(nameProblem("Plotter A1", presets)).toBeUndefined();
  });

  it("allows a Preset to keep its own name when renamed", () => {
    expect(nameProblem("Plotter A0", presets, "Plotter A0")).toBeUndefined();
    expect(nameProblem("Büro A4", presets, "Plotter A0")).toMatch(/schon/);
  });

  it("numbers clashing names", () => {
    expect(uniqueName("Plotter A1", presets)).toBe("Plotter A1");
    expect(uniqueName("Plotter A0", presets)).toBe("Plotter A0 (2)");
    expect(uniqueName("Plotter A0", [...presets, { ...plotter, name: "Plotter A0 (2)" }])).toBe("Plotter A0 (3)");
    expect(uniqueName("Standard", presets)).toBe("Standard (2)");
  });
});

describe("import and export", () => {
  it("round-trips through the file format", () => {
    expect(presetsFromJson(presetsToJson([plotter, office]))).toEqual([plotter, office]);
  });

  it("brings in clashing names numbered, never overwriting", () => {
    const changed = { ...plotter, settings: settings({ tiles: { format: "A1" } }) };
    const { presets, added } = importPresets([plotter], [changed, office]);
    expect(presets.map((p) => p.name)).toEqual(["Plotter A0", "Plotter A0 (2)", "Büro A4"]);
    expect(presets[0]).toEqual(plotter);
    expect(added.map((p) => p.name)).toEqual(["Plotter A0 (2)", "Büro A4"]);
  });

  it("numbers duplicates within one file too", () => {
    const { presets } = importPresets([], [plotter, plotter]);
    expect(presets.map((p) => p.name)).toEqual(["Plotter A0", "Plotter A0 (2)"]);
  });

  it("rejects files that are not Preset files", () => {
    expect(() => presetsFromJson("not json")).toThrow(/kein gültiges JSON/);
    expect(() => presetsFromJson(JSON.stringify({ presets: [] }))).toThrow(/keine Vorlagen-Datei/);
  });

  it("drops entries without a name and sanitises settings", () => {
    const text = JSON.stringify({
      kind: "simplepdfclipper-presets",
      version: 1,
      presets: [{ name: "  " }, { settings: {} }, 5, { name: " A0  quer ", settings: { tiles: { format: "A0", orientation: "landscape" } } }],
    });
    const [only, ...rest] = presetsFromJson(text);
    expect(rest).toEqual([]);
    expect(only!.name).toBe("A0 quer");
    expect(only!.settings.tiles.format).toBe("A0");
    expect(only!.settings.svg).toEqual(DEFAULT_EXPORT_SETTINGS.svg);
  });
});

describe("initialSelection", () => {
  const presets = [plotter, office];

  it("shows the last picked Preset when it still matches", () => {
    expect(initialSelection(plotter.settings, presets, "Plotter A0")).toEqual({ name: "Plotter A0", changed: false });
  });

  it("shows Standard for the factory settings", () => {
    expect(initialSelection(settings(), presets, undefined)).toEqual({ name: undefined, changed: false });
  });

  it("finds a matching Preset when the last picked one doesn't match", () => {
    expect(initialSelection(office.settings, presets, "Plotter A0")).toEqual({ name: "Büro A4", changed: false });
    expect(initialSelection(settings(), presets, "Plotter A0")).toEqual({ name: undefined, changed: false });
  });

  it("otherwise shows the last picked one as changed", () => {
    const own = settings({ tiles: { marginMm: 3 } });
    expect(initialSelection(own, presets, "Plotter A0")).toEqual({ name: "Plotter A0", changed: true });
    expect(initialSelection(own, presets, undefined)).toEqual({ name: undefined, changed: true });
    expect(initialSelection(own, presets, "deleted")).toEqual({ name: undefined, changed: true });
  });
});
