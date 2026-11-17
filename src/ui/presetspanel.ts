// Named export Presets (ADR 0015): the "Vorlage" dropdown in step 3, the SVG
// options, and the Preset window (save, overwrite, rename, delete, export, import).
// Owns the export settings: stores them on every change (ADR 0007).

import {
  cleanName,
  DEFAULT_EXPORT_SETTINGS,
  importPresets,
  initialSelection,
  nameProblem,
  presetsFromJson,
  presetsToJson,
  sameSettings,
  STANDARD,
  type ExportSettings,
  type Preset,
  type SvgOptions,
} from "./presets";
import { saveFile } from "./save";
import { loadPresets, storeExportSettings, storePresets } from "./storage";
import type { TilesPanel } from "./tilespanel";
import type { MergeMode } from "../export/index";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Dropdown value of the factory settings, and of the "… (geändert)" entry. */
const STANDARD_VALUE = "\u0000standard";
const CHANGED_VALUE = "\u0000changed";

const byName = (a: Preset, b: Preset) => a.name.localeCompare(b.name, "de");

export class PresetsPanel {
  private presets: Preset[];
  /** The Preset last picked; undefined: Standard. */
  private selected: string | undefined;
  private readonly select = $<HTMLSelectElement>("preset");
  private readonly dialog = $<HTMLDialogElement>("presets");
  private readonly list = $<HTMLUListElement>("presets-list");
  private readonly nameInput = $<HTMLInputElement>("preset-name");
  private readonly message = $("presets-msg");
  /** The Preset being renamed in the list. */
  private renaming: string | undefined;

  constructor(
    private readonly tiles: TilesPanel,
    svg: SvgOptions,
  ) {
    const stored = loadPresets();
    this.presets = stored.presets;
    this.writeSvg(svg);
    const start = initialSelection(this.current(), this.presets, stored.selected);
    this.selected = start.name;
    this.bind();
    this.render();
  }

  /** The settings step 3 shows right now. */
  current(): ExportSettings {
    return { tiles: structuredClone(this.tiles.settings), svg: this.readSvg() };
  }

  /** A setting was changed (by hand, or by applying a Preset). */
  changed(): void {
    storeExportSettings(this.current());
    this.render();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  // ---- Applying -------------------------------------------------------------------

  private settingsOf(name: string | undefined): ExportSettings {
    return this.presets.find((p) => p.name === name)?.settings ?? DEFAULT_EXPORT_SETTINGS;
  }

  private pick(name: string | undefined): void {
    this.selected = name;
    this.save();
    const s = this.settingsOf(name);
    this.writeSvg(s.svg);
    this.tiles.apply(s.tiles); // reports back through changed()
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

  private save(): void {
    storePresets({ presets: this.presets, selected: this.selected });
  }

  // ---- Display ----------------------------------------------------------------------

  private isChanged(): boolean {
    return !sameSettings(this.current(), this.settingsOf(this.selected));
  }

  private render(): void {
    this.presets.sort(byName);
    const changed = this.isChanged();
    const options: HTMLOptionElement[] = [];
    if (changed) options.push(new Option(`${this.selected ?? STANDARD} (geändert)`, CHANGED_VALUE));
    options.push(new Option(STANDARD, STANDARD_VALUE));
    for (const p of this.presets) options.push(new Option(p.name, p.name));
    this.select.replaceChildren(...options);
    this.select.value = changed ? CHANGED_VALUE : (this.selected ?? STANDARD_VALUE);
    this.select.title = changed ? "Einstellungen von Hand geändert. Vorlage erneut wählen, um sie wiederherzustellen." : "";
    if (this.dialog.open) this.renderDialog();
  }

  private renderDialog(): void {
    const rows = this.presets.map((p) => this.row(p));
    this.list.replaceChildren(...rows);
    this.list.hidden = rows.length === 0;
    $("presets-empty").hidden = rows.length > 0;
    $<HTMLButtonElement>("presets-export").disabled = rows.length === 0;

    const overwrite = $<HTMLButtonElement>("preset-overwrite");
    overwrite.hidden = this.selected === undefined;
    overwrite.textContent = `„${this.selected ?? ""}“ mit aktuellen Einstellungen überschreiben`;
    overwrite.disabled = !this.isChanged();
    overwrite.title = overwrite.disabled ? "Die aktuellen Einstellungen entsprechen schon dieser Vorlage." : "";
  }

  private row(p: Preset): HTMLLIElement {
    const li = document.createElement("li");
    li.dataset.name = p.name;
    if (p.name === this.selected) li.classList.add("current");
    const button = (text: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = text;
      b.addEventListener("click", onClick);
      return b;
    };
    if (this.renaming === p.name) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "name";
      input.value = p.name;
      input.setAttribute("aria-label", "Neuer Name");
      const ok = () => this.rename(p.name, input.value);
      const cancel = () => {
        this.renaming = undefined;
        this.clearMessage();
        this.renderDialog();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok();
        else if (e.key === "Escape") {
          e.preventDefault(); // don't close the window
          cancel();
        }
      });
      li.append(input, button("OK", ok), button("Abbrechen", cancel));
      queueMicrotask(() => input.select());
    } else {
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name;
      li.append(
        name,
        button("Umbenennen", () => {
          this.renaming = p.name;
          this.clearMessage();
          this.renderDialog();
        }),
        button("Löschen", () => this.remove(p.name)),
      );
    }
    return li;
  }

  private say(text: string, warn = false): void {
    this.message.textContent = text;
    this.message.classList.toggle("warn", warn);
    this.message.hidden = !text;
  }

  private clearMessage(): void {
    this.say("");
  }

  // ---- Window actions -------------------------------------------------------------------

  private open(): void {
    this.renaming = undefined;
    this.nameInput.value = "";
    this.clearMessage();
    this.renderDialog();
    this.dialog.showModal();
    this.nameInput.focus();
  }

  private saveNew(): void {
    const problem = nameProblem(this.nameInput.value, this.presets);
    if (problem) return this.say(problem, true);
    const name = cleanName(this.nameInput.value);
    this.presets.push({ name, settings: this.current() });
    this.selected = name;
    this.nameInput.value = "";
    this.save();
    this.render();
    this.say(`Vorlage „${name}“ gespeichert.`);
  }

  private overwrite(): void {
    const p = this.presets.find((q) => q.name === this.selected);
    if (!p) return;
    p.settings = this.current();
    this.save();
    this.render();
    this.say(`Vorlage „${p.name}“ überschrieben.`);
  }

  private rename(from: string, to: string): void {
    const problem = nameProblem(to, this.presets, from);
    if (problem) return this.say(problem, true);
    const name = cleanName(to);
    const p = this.presets.find((q) => q.name === from);
    if (!p) return;
    p.name = name;
    if (this.selected === from) this.selected = name;
    this.renaming = undefined;
    this.save();
    this.clearMessage();
    this.render();
  }

  private remove(name: string): void {
    if (!confirm(`Vorlage „${name}“ löschen?`)) return;
    this.presets = this.presets.filter((p) => p.name !== name);
    if (this.selected === name) this.selected = undefined;
    if (this.renaming === name) this.renaming = undefined;
    this.save();
    this.render();
    this.say(`Vorlage „${name}“ gelöscht.`);
  }

  private async exportFile(): Promise<void> {
    const blob = new Blob([presetsToJson(this.presets)], { type: "application/json" });
    await saveFile(blob, "simplepdfclipper-Vorlagen.json", "Vorlagen", "application/json", ".json");
  }

  private async importFile(file: File): Promise<void> {
    let incoming: Preset[];
    try {
      incoming = presetsFromJson(await file.text());
    } catch (e) {
      return this.say(e instanceof Error ? e.message : String(e), true);
    }
    if (incoming.length === 0) return this.say("Die Datei enthält keine Vorlagen.", true);
    const { presets, added } = importPresets(this.presets, incoming);
    this.presets = presets;
    this.save();
    this.render();
    const names = added.map((p) => `„${p.name}“`).join(", ");
    this.say(added.length === 1 ? `1 Vorlage importiert: ${names}.` : `${added.length} Vorlagen importiert: ${names}.`);
  }

  // ---- Wiring --------------------------------------------------------------------------

  private bind(): void {
    this.select.addEventListener("change", () => {
      const v = this.select.value;
      if (v === CHANGED_VALUE) return;
      this.pick(v === STANDARD_VALUE ? undefined : v);
    });
    for (const el of document.querySelectorAll<HTMLInputElement>('#text-paths, input[name="merge"]'))
      el.addEventListener("change", () => this.changed());

    $("presets-open").addEventListener("click", () => this.open());
    $("presets-close").addEventListener("click", () => this.dialog.close());
    $("preset-save").addEventListener("click", () => this.saveNew());
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveNew();
    });
    $("preset-overwrite").addEventListener("click", () => this.overwrite());
    $("presets-export").addEventListener("click", () => void this.exportFile());
    const file = $<HTMLInputElement>("presets-file");
    $("presets-import").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (f) void this.importFile(f);
    });
  }
}
