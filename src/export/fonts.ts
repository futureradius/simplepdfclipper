// Mapping PDF font names to SVG font-family lists (ADR 0006).

import type { FontStyle } from "./ir";

/** Facts about a PDF font that the mapping needs (subset of MuPDF's Font). */
export interface FontFacts {
  name: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

/** Families whose metrics match a common Windows font (same glyph advances). */
const METRIC_TWINS: Record<string, string> = {
  Arial: "Arial",
  Helvetica: "Arial",
  "Arial Narrow": "Arial Narrow",
  "Helvetica Narrow": "Arial Narrow",
  Times: "Times New Roman",
  "Times New Roman": "Times New Roman",
  Courier: "Courier New",
  "Courier New": "Courier New",
};

/** "ABCDEF+Arial-BoldMT" -> "Arial-BoldMT" */
export function stripSubsetTag(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

/**
 * Style words that Windows appends to family names, in several UI languages
 * (German Windows calls Arial Regular/Bold "Arial Standard"/"Arial Fett").
 */
const STYLE_WORDS =
  /^(standard|regular|normal|book|plain|fett|halbfett|kursiv|bold|italic|oblique|semibold|demibold|gras|italique|negrita|cursiva|grassetto|corsivo|vet|cursief)$/i;
const BOLD_WORDS = /bold|black|heavy|semibold|demi|fett|gras|negrita|grassetto|\bvet\b/i;
const ITALIC_WORDS = /italic|oblique|kursiv|italique|cursiva|corsivo|cursief/i;

/** Best guess of the family name a user would recognise: "ABCDEF+TimesNewRomanPS-BoldMT" -> "Times New Roman". */
export function familyOf(pdfFontName: string): string {
  let n = stripSubsetTag(pdfFontName).split(/[-,]/)[0] ?? "";
  n = n.replace(/(PSMT|MT|PS)$/, "");
  n = n.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  // Drop trailing style words ("Arial Fett Kursiv" -> "Arial"), but keep at least one word.
  const words = n.split(/\s+/);
  while (words.length > 1 && STYLE_WORDS.test(words[words.length - 1]!)) words.pop();
  n = words.join(" ").replace(/\bSchmal$/i, "Narrow"); // German "Arial Schmal" = Arial Narrow
  return n || "Arial";
}

function cssName(family: string): string {
  return /[^A-Za-z0-9-]/.test(family) ? `'${family}'` : family;
}

/**
 * Decide how text in this font is written to SVG. `substitutions` maps an
 * original family to a user-chosen installed font (from the font dialog).
 */
export function fontStyleFor(f: FontFacts, substitutions: Record<string, string> = {}): FontStyle {
  const original = familyOf(f.name);
  const twin = METRIC_TWINS[original];
  const fallback = f.mono ? "Courier New" : f.serif ? "Times New Roman" : "Arial";
  const substitute = substitutions[original] ?? twin ?? fallback;
  const generic = f.mono ? "monospace" : f.serif ? "serif" : "sans-serif";
  const list = [...new Set([original, substitute, "Arial"])].map(cssName);
  list.push(generic);
  const name = stripSubsetTag(f.name);
  return {
    family: list.join(","),
    bold: f.bold || BOLD_WORDS.test(name),
    italic: f.italic || ITALIC_WORDS.test(name),
    metricCompatible: twin !== undefined && substitute === twin,
  };
}
