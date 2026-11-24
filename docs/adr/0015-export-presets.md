# 15. Named export Presets

Status: accepted (2026-11-17, issue #5)

## Context

Tiled Export (ADR 0013) added many settings, and ADR 0007 only remembers the *last*
ones per browser. People switch between setups such as "A4 office printer" and
"plotter, 3 columns × 3 m rows", and set everything again each time. Colleagues want
to share such setups.

## Decision

- **Glossary:** a **Preset** (UI: "Vorlage") is a named copy of all export settings.
- **Content:** everything in step 3: Tiled Export on/off and its whole setup (mode,
  Paper format and custom size, orientation, both axes' leading field and value,
  Margin, output mode) plus the SVG options (text as paths, merge mode). Never the
  Clip: it belongs to the Plan, a Preset to the output device.
- **Only the user's own Presets**, no built-in ones. They live in localStorage (no
  server, ADR 0001). "Standard", the factory settings, is always in the dropdown and
  can't be edited, deleted or used as a name.
- **Step 3** starts with "Vorlage: [▾] [✎]". Picking an entry applies it. Changing a
  setting by hand afterwards shows "Name (geändert)" as an extra entry at the top of
  the dropdown; picking the Preset again restores it, and changing the setting back
  removes the mark. Settings count as equal when they export the same: in a free
  Tile grid only the leading field of each axis matters.
- **Preset window** (✎): the list with "Umbenennen" (inline, Enter/Escape) and
  "Löschen" (asks first); a name field with "Aktuelle Einstellungen als neue Vorlage
  speichern"; "„Name“ mit aktuellen Einstellungen überschreiben" for the picked
  Preset (disabled while nothing differs); "Exportieren…" and "Importieren…". Names
  are trimmed, must be unique ignoring case but not accents.
- **File format:** JSON `{ "kind": "simplepdfclipper-presets", "version": 1,
  "presets": [{ "name", "settings": { "tiles", "svg" } }] }`, saved as
  `simplepdfclipper-Vorlagen.json` (Save-as dialog or download, ADR 0009). Export
  writes all Presets.
- **Import** adds every Preset in the file. A name clash comes in as "Plotter A0 (2)"
  (then "(3)" …), never overwriting. Every setting is validated; a missing or
  malformed one falls back to the factory value, so files from older or newer
  versions still load.
- **Last settings** (ADR 0007) are still restored on start, now including the SVG
  options. The dropdown shows the last picked Preset if the settings match it, else
  any matching Preset (or Standard), else the last picked one with "(geändert)".

## Consequences

- Code: `src/ui/presets.ts` (pure logic: validation, comparison, names, file format,
  start selection), `src/ui/presetspanel.ts` (dropdown, SVG options, window),
  `src/ui/storage.ts` (keys `simplepdfclipper.exportSettings` and
  `simplepdfclipper.presets`; the old `simplepdfclipper.tileSettings` is read once
  as a fallback). `TilesPanel` no longer stores anything itself; it takes its
  initial settings and gains `apply()`.
- Tests: `src/ui/presets.test.ts`, `e2e/presets.spec.ts`.
- Presets are per browser profile; moving them to another computer or colleague goes
  through export and import.

## Clip presets (decided 2026-11-24, #14; to be built in #38)

Regions and their Layout (ADR 0016) can be saved as a **Clip preset** (UI
"Ausschnitt-Vorlage"), separate from Presets: a Preset still never holds the Clip, and
loading one kind never changes the other (the Clip belongs to the Plan, a Preset to the
output device). Same window and actions as Presets (save, overwrite, rename, delete,
JSON export/import with numbered clashes, validated). On a Plan of another size the
Regions are stretched to fit, with a warning (ADR 0007).
