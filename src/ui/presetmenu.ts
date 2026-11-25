// A dropdown of named presets plus their window (save, overwrite, rename, delete,
// export, import), shared by the export Presets in step 3 and the Clip presets in
// step 2 (ADR 0015). What a preset holds, how it is applied and compared is up to the
// `PresetKind`.

import { cleanName, importPresets, nameProblem, type Named, type NameRules } from "./presets";
import { saveFile } from "./save";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Dropdown value of the factory entry, and of the "… (geändert)" or "–" entry. */
const STANDARD_VALUE = "\u0000standard";
const PLACEHOLDER_VALUE = "\u0000changed";

const byName = (a: Named, b: Named) => a.name.localeCompare(b.name, "de");

export interface PresetKind<P extends Named, T> {
  /** Prefix of the element ids: `${prefix}preset`, `${prefix}presets`, `${prefix}presets-list`, … */
  prefix: string;
  rules: NameRules;
  /** "Vorlagen", for messages. */
  plural: string;
  /** Label of the factory entry, if there is one (always in the dropdown). */
  standard?: string;
  fileName: string;
  /** Text of the overwrite button for the picked preset. */
  overwriteLabel(name: string): string;
  /** Tooltip of the dropdown while the picked preset is changed. */
  changedTitle: string;
  /** Tooltip of the disabled overwrite button. */
  sameTitle: string;
  /** What would be saved now; undefined: nothing to save (with the reason, German). */
  current(): { value: T } | { problem: string };
  valueOf(p: P): T;
  make(name: string, value: T): P;
  /** Applies a preset's value, or the factory one (undefined). */
  apply(value: T | undefined): void;
  /** Whether `current` equals `saved` (undefined: the factory value). */
  same(current: T, saved: T | undefined): boolean;
  /** Which preset the dropdown starts with, given the last picked one. */
  initial?(presets: readonly P[], lastPicked: string | undefined): string | undefined;
  load(): { presets: P[]; selected: string | undefined };
  store(s: { presets: readonly P[]; selected: string | undefined }): void;
  toJson(presets: readonly P[]): string;
  /** Throws an Error with a German message if the file isn't one. */
  fromJson(text: string): P[];
}

export class PresetMenu<P extends Named, T> {
  private presets: P[];
  /** The preset last picked; undefined: the factory entry, or none. */
  private selected: string | undefined;
  private readonly select: HTMLSelectElement;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLUListElement;
  private readonly nameInput: HTMLInputElement;
  private readonly message: HTMLElement;
  /** The preset being renamed in the list. */
  private renaming: string | undefined;

  constructor(private readonly kind: PresetKind<P, T>) {
    const id = (s: string) => $(kind.prefix + s);
    this.select = id("preset") as HTMLSelectElement;
    this.dialog = id("presets") as HTMLDialogElement;
    this.list = id("presets-list") as HTMLUListElement;
    this.nameInput = id("preset-name") as HTMLInputElement;
    this.message = id("presets-msg");
    const stored = kind.load();
    this.presets = stored.presets;
    this.selected = kind.initial ? kind.initial(this.presets, stored.selected) : this.presets.some((p) => p.name === stored.selected) ? stored.selected : undefined;
    this.bind();
    this.render();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** What is shown changed (by hand, or by applying a preset): updates the dropdown. */
  render(): void {
    this.presets.sort(byName);
    const changed = this.isChanged();
    const options: HTMLOptionElement[] = [];
    const placeholder = changed || (this.selected === undefined && !this.kind.standard);
    if (placeholder) options.push(new Option(changed ? `${this.selected ?? this.kind.standard} (geändert)` : "–", PLACEHOLDER_VALUE));
    if (this.kind.standard) options.push(new Option(this.kind.standard, STANDARD_VALUE));
    for (const p of this.presets) options.push(new Option(p.name, p.name));
    this.select.replaceChildren(...options);
    this.select.value = placeholder ? PLACEHOLDER_VALUE : (this.selected ?? STANDARD_VALUE);
    this.select.title = changed ? this.kind.changedTitle : "";
    if (this.dialog.open) this.renderDialog();
  }

  // ---- Applying -------------------------------------------------------------------

  private valueOf(name: string | undefined): T | undefined {
    const p = this.presets.find((q) => q.name === name);
    return p && this.kind.valueOf(p);
  }

  private pick(name: string | undefined): void {
    this.selected = name;
    this.save();
    this.kind.apply(this.valueOf(name)); // reports back through render()
    this.render();
  }

  private save(): void {
    this.kind.store({ presets: this.presets, selected: this.selected });
  }

  /** Whether what is shown differs from the picked preset (or the factory value). */
  private isChanged(): boolean {
    if (this.selected === undefined && !this.kind.standard) return false;
    const c = this.kind.current();
    if (!("value" in c)) return true;
    return !this.kind.same(c.value, this.valueOf(this.selected));
  }

  // ---- Window ---------------------------------------------------------------------

  private renderDialog(): void {
    const rows = this.presets.map((p) => this.row(p));
    this.list.replaceChildren(...rows);
    this.list.hidden = rows.length === 0;
    $(this.kind.prefix + "presets-empty").hidden = rows.length > 0;
    $<HTMLButtonElement>(this.kind.prefix + "presets-export").disabled = rows.length === 0;

    const overwrite = $<HTMLButtonElement>(this.kind.prefix + "preset-overwrite");
    overwrite.hidden = this.selected === undefined;
    overwrite.textContent = this.kind.overwriteLabel(this.selected ?? "");
    const current = this.kind.current();
    overwrite.disabled = !("value" in current) || !this.isChanged();
    overwrite.title = "problem" in current ? current.problem : overwrite.disabled ? this.kind.sameTitle : "";
  }

  private row(p: P): HTMLLIElement {
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

  private open(): void {
    this.renaming = undefined;
    this.nameInput.value = "";
    this.clearMessage();
    this.renderDialog();
    this.dialog.showModal();
    this.nameInput.focus();
  }

  private saveNew(): void {
    const { rules } = this.kind;
    const problem = nameProblem(this.nameInput.value, this.presets, undefined, rules);
    if (problem) return this.say(problem, true);
    const current = this.kind.current();
    if (!("value" in current)) return this.say(current.problem, true);
    const name = cleanName(this.nameInput.value);
    this.presets.push(this.kind.make(name, current.value));
    this.selected = name;
    this.nameInput.value = "";
    this.save();
    this.render();
    this.say(`${rules.noun} „${name}“ gespeichert.`);
  }

  private overwrite(): void {
    const i = this.presets.findIndex((q) => q.name === this.selected);
    const current = this.kind.current();
    if (i < 0 || !("value" in current)) return;
    this.presets[i] = this.kind.make(this.presets[i]!.name, current.value);
    this.save();
    this.render();
    this.say(`${this.kind.rules.noun} „${this.selected}“ überschrieben.`);
  }

  private rename(from: string, to: string): void {
    const problem = nameProblem(to, this.presets, from, this.kind.rules);
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
    const { noun } = this.kind.rules;
    if (!confirm(`${noun} „${name}“ löschen?`)) return;
    this.presets = this.presets.filter((p) => p.name !== name);
    if (this.selected === name) this.selected = undefined;
    if (this.renaming === name) this.renaming = undefined;
    this.save();
    this.render();
    this.say(`${noun} „${name}“ gelöscht.`);
  }

  private async exportFile(): Promise<void> {
    const blob = new Blob([this.kind.toJson(this.presets)], { type: "application/json" });
    await saveFile(blob, this.kind.fileName, this.kind.plural, "application/json", ".json");
  }

  private async importFile(file: File): Promise<void> {
    const { rules, plural } = this.kind;
    let incoming: P[];
    try {
      incoming = this.kind.fromJson(await file.text());
    } catch (e) {
      return this.say(e instanceof Error ? e.message : String(e), true);
    }
    if (incoming.length === 0) return this.say(`Die Datei enthält keine ${plural}.`, true);
    const { presets, added } = importPresets(this.presets, incoming, rules);
    this.presets = presets;
    this.save();
    this.render();
    const names = added.map((p) => `„${p.name}“`).join(", ");
    this.say(added.length === 1 ? `1 ${rules.noun} importiert: ${names}.` : `${added.length} ${plural} importiert: ${names}.`);
  }

  private bind(): void {
    const id = (s: string) => $(this.kind.prefix + s);
    this.select.addEventListener("change", () => {
      const v = this.select.value;
      if (v === PLACEHOLDER_VALUE) return;
      const name = v === STANDARD_VALUE ? undefined : v;
      // Already in effect: nothing to do. Chrome fires "change" again on blur once the
      // options were rebuilt, which must not load the preset a second time.
      if (name === this.selected && !this.isChanged()) return;
      this.pick(name);
    });
    id("presets-open").addEventListener("click", () => this.open());
    id("presets-close").addEventListener("click", () => this.dialog.close());
    id("preset-save").addEventListener("click", () => this.saveNew());
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveNew();
    });
    id("preset-overwrite").addEventListener("click", () => this.overwrite());
    id("presets-export").addEventListener("click", () => void this.exportFile());
    const file = id("presets-file") as HTMLInputElement;
    id("presets-import").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (f) void this.importFile(f);
    });
  }
}
