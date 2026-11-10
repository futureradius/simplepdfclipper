# 6. Export page size, units, SVG text

Status: accepted (2026-11-03)

## Decision

- **Page size:** the exported page is exactly the Clip at 1:1 scale. No fitting to
  paper sizes (the PDF viewer can scale when printing).
- **PDF scale (UserUnit):** if the Clip is at most 5,080 mm per side, the exported PDF
  has UserUnit 1 (the scale is baked into the content), so every viewer shows it at
  real size. Longer Clips keep the Plan's UserUnit; the UI says so.
- **Units:** the UI shows and accepts millimetres with 0.1 mm resolution. Origin is the
  top-left corner of the Plan.
- **File names:** `<original name>_Ausschnitt.pdf` and `<original name>_Ausschnitt.svg`.
- **SVG text:** real `<text>` by default. On import the app lists the Plan's fonts
  and proposes a substitute for each (closest-named common Windows font, else Arial);
  the user can change it. (Dialog dropped for now, ADR 0012: the automatic choice is used.) Each
  text gets `font-family="<original>,<substitute>,Arial,sans-serif"`. Small visual
  differences between participants' machines are acceptable (all project members use
  Windows).
- **`textLength` only where needed:** for fonts whose substitute is metric-compatible
  (Helvetica/Arial, Times/Times New Roman, Courier/Courier New) glyph advances are
  identical, so no width correction is written. Other fonts get
  `textLength` + `lengthAdjust="spacingAndGlyphs"` with the original run width. This
  saves ~30 bytes per text for the common Arial case.
- **Localised font names:** The schedule PDF uses Windows' localised style names, e.g.
  "Arial Standard" / "Arial Fett" (German for Regular / Bold). Trailing style words
  in several languages are stripped (Standard, Fett, Kursiv, Regular, Bold, Gras…),
  so these are recognised as Arial and need no `textLength`. Words that are part of a
  family name are kept ("Times New Roman", "Arial Black").
- **Text runs:** consecutive glyphs on one baseline form one `<text>`. A gap of exactly
  one space width becomes a space character; other gaps start a new `<text>`, so
  positions stay exact.
- **Whitespace at the edges is trimmed**, and runs are split where more than one space
  would be needed. SVG viewers drop leading/trailing spaces and collapse multiple
  spaces; together with `textLength` that squeezed the remaining letters into the gap
  (first real-schedule test: single letters stretched, e.g. "MaschinelleBettungs…").
- **"Text als Pfade" checkbox** on export: text as outlines instead (outlines are
  obtained from MuPDF's own SVG writer, one glyph at a time, and cached). Measured on
  the Test Plan: outlines are **3–7× larger** (1.5–3.9 MB vs. 0.5–0.6 MB) but have
  fewer elements. Real text stays the default.

## Consequences

With real text, SVG appearance depends on fonts where the SVG is displayed.

Amended by ADR 0013 (Tiled Export): there, a page is a Sheet, not the Clip.
