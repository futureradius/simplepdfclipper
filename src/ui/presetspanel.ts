// Named export Presets (ADR 0015): the "Vorlage" dropdown in step 3, the SVG
// options, and the Preset window (a PresetMenu). Owns the export settings: stores
// them on every change (ADR 0007).

import {
  DEFAULT_EXPORT_SETTINGS,
  initialSelection,
  PRESET_NAMES,
  presetsFromJson,
  presetsToJson,
  sameSettings,
  STANDARD,
  type ExportSettings,
  type Preset,
  type SvgOptions,
} from "./presets";
import { PresetMenu } from "./presetmenu";
import { loadPresets, storeExportSettings, storePresets } from "./storage";
import type { TilesPanel } from "./tilespanel";
import type { MergeMode } from "../export/index";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class PresetsPanel {
  private readonly menu: PresetMenu<Preset, ExportSettings>;

  constructor(
    private readonly tiles: TilesPanel,
    svg: SvgOptions,
  ) {
    this.writeSvg(svg);
    this.menu = new PresetMenu<Preset, ExportSettings>({
      prefix: "",
      rules: PRESET_NAMES,
      plural: "Vorlagen",
      standard: STANDARD,
      fileName: "simplepdfclipper-Vorlagen.json",
      overwriteLabel: (name) => `„${name}“ mit aktuellen Einstellungen überschreiben`,
      changedTitle: "Einstellungen von Hand geändert. Vorlage erneut wählen, um sie wiederherzustellen.",
      sameTitle: "Die aktuellen Einstellungen entsprechen schon dieser Vorlage.",
      current: () => ({ value: this.current() }),
      valueOf: (p) => p.settings,
      make: (name, settings) => ({ name, settings }),
      apply: (s = DEFAULT_EXPORT_SETTINGS) => {
        this.writeSvg(s.svg);
        this.tiles.apply(s.tiles); // reports back through changed()
      },
      same: (a, b) => sameSettings(a, b ?? DEFAULT_EXPORT_SETTINGS),
      initial: (presets, last) => initialSelection(this.current(), presets, last).name,
      load: loadPresets,
      store: (s) => storePresets({ presets: [...s.presets], selected: s.selected }),
      toJson: presetsToJson,
      fromJson: presetsFromJson,
    });
    for (const el of document.querySelectorAll<HTMLInputElement>('#text-paths, input[name="merge"]'))
      el.addEventListener("change", () => this.changed());
  }

  /** The settings step 3 shows right now. */
  current(): ExportSettings {
    return { tiles: structuredClone(this.tiles.settings), svg: this.readSvg() };
  }

  /** A setting was changed (by hand, or by applying a Preset). */
  changed(): void {
    storeExportSettings(this.current());
    this.menu?.render(); // undefined while the menu itself starts
  }

  get isOpen(): boolean {
    return this.menu.isOpen;
  }

  private readSvg(): SvgOptions {
    const merge = document.querySelector<HTMLInputElement>('input[name="merge"]:checked');
    return {
      textAsPaths: $<HTMLInputElement>("text-paths").checked,
      mergeMode: (merge?.value ?? DEFAULT_EXPORT_SETTINGS.svg.mergeMode) as MergeMode,
    };
  }

  private writeSvg(svg: SvgOptions): void {
    $<HTMLInputElement>("text-paths").checked = svg.textAsPaths;
    const el = document.querySelector<HTMLInputElement>(`input[name="merge"][value="${svg.mergeMode}"]`);
    if (el) el.checked = true;
  }
}
