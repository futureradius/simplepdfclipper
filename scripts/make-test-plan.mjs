// Generates a stand-in for a real schedule ("Test Plan", see CONTEXT.md):
// one page, 1188.9 x 14270.9 mm, vector lines, bars, milestones and small text.
// Like the real schedule, it sets /UserUnit so the long side is exactly 14,400 PDF units.
// Output: samples/test-plan.pdf (git-ignored).
//
// Like many schedule exporters, it draws the grid verbosely (per cell, per row
// block), so the SVG writer's merging has realistic duplicate geometry to work on.

import * as mupdf from "mupdf";
import { mkdirSync, writeFileSync } from "node:fs";

const W_MM = 1188.9;
const H_MM = 14270.9;
const MAX_UNITS = 14400; // PDF page size limit per side
const USER_UNIT = (H_MM / 25.4) * 72 / MAX_UNITS; // 2.8092..., same as the real schedule
const MM = 72 / 25.4 / USER_UNIT; // PDF units per mm
const W = W_MM * MM;
const H = H_MM * MM;

// Deterministic PRNG so the Test Plan is identical on every run.
let seed = 20261103;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const f = (n) => (Math.round(n * 1000) / 1000).toString();
const X = (mm) => f(mm * MM);
const Y = (mm) => f(H - mm * MM); // top-down mm -> PDF user space

/** Encode a JS string as a PDF literal string (Latin-1 subset of WinAnsi). */
function pdfStr(s) {
  let out = "(";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c < 32 || c > 126) out += "\\" + (c & 0xff).toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + ")";
}

const ops = [];
const text = (font, sizePt, xmm, ymm, s) =>
  ops.push(`BT /${font} ${f(sizePt / USER_UNIT)} Tf 1 0 0 1 ${X(xmm)} ${Y(ymm)} Tm ${pdfStr(s)} Tj ET`);
const line = (x1, y1, x2, y2) => ops.push(`${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`);
const rectStroke = (x, y, w, h) => ops.push(`${X(x)} ${Y(y + h)} ${f(w * MM)} ${f(h * MM)} re S`);
const rectFill = (x, y, w, h) => ops.push(`${X(x)} ${Y(y + h)} ${f(w * MM)} ${f(h * MM)} re f`);
const rgb = (r, g, b, stroke) => ops.push(`${f(r)} ${f(g)} ${f(b)} ${stroke ? "RG" : "rg"}`);
const lw = (mm) => ops.push(`${f(mm * MM)} w`);

// ---- Layout -------------------------------------------------------------
const HEADER = 60;
const ROW = 5;
const TABLE_COLS = [
  ["Nr.", 20],
  ["Vorgang", 200],
  ["Anfang", 40],
  ["Ende", 40],
  ["Dauer", 30],
  ["Gewerk", 50],
];
const TABLE_W = TABLE_COLS.reduce((s, [, w]) => s + w, 0); // 380 mm
const T0 = TABLE_W;
const WEEKS = 260;
const WEEK_W = (W_MM - T0) / WEEKS;
const ROWS = Math.floor((H_MM - HEADER - 20) / ROW);
const BLOCK = 1; // rows per grid block: grid lines are drawn per row, like verbose exporters

const TRADES = [
  ["Gleisbau", [0.2, 0.45, 0.8]],
  ["Oberleitung", [0.85, 0.45, 0.1]],
  ["Kabeltiefbau", [0.35, 0.65, 0.3]],
  ["LST", [0.6, 0.3, 0.65]],
  ["Ingenieurbau", [0.55, 0.55, 0.55]],
  ["Weichen", [0.8, 0.2, 0.25]],
];
const VERBS = ["einbauen", "ausbauen", "umbauen", "prüfen", "abnehmen", "herstellen", "rückbauen"];
const OBJECTS = ["Weiche", "Gleis", "Mast", "Kabeltrog", "Bahnsteig", "Durchlass", "Signal", "Brücke"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const weekDate = (week) => new Date(Date.UTC(2026, 0, 5 + week * 7));
const fmtDate = (week) => {
  const d = weekDate(week);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCFullYear()).slice(2)}`;
};

// ---- Background ---------------------------------------------------------
rgb(1, 1, 1, false);
rectFill(0, 0, W_MM, H_MM);

// ---- Header -------------------------------------------------------------
rgb(0, 0, 0, false);
text("F2", 28, 10, 18, "Bauablaufplan ABS Musterstadt - Testplan (generiert)");
text("F1", 10, 10, 28, "Stand: 03.11.2026  Index c  Erstellt mit scripts/make-test-plan.mjs");
rgb(0, 0, 0, true);
lw(0.35);
let x = 0;
for (const [name, w] of TABLE_COLS) {
  rectStroke(x, HEADER - 15, w, 15);
  text("F2", 8, x + 1.5, HEADER - 5, name);
  x += w;
}
for (let wk = 0; wk < WEEKS; wk++) {
  const d = weekDate(wk);
  const xx = T0 + wk * WEEK_W;
  if (d.getUTCDate() <= 7) {
    lw(0.35);
    line(xx, HEADER - 15, xx, HEADER);
    text("F1", 7, xx + 0.8, HEADER - 9, `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`);
  }
  lw(0.1);
  line(xx, HEADER - 5, xx, HEADER);
  text("F1", 4, xx + 0.4, HEADER - 1, String((wk % 52) + 1));
}

// ---- Grid (verbose, per block) -------------------------------------------
for (let b = 0; b * BLOCK < ROWS; b++) {
  const y0 = HEADER + b * BLOCK * ROW;
  const y1 = HEADER + Math.min(ROWS, (b + 1) * BLOCK) * ROW;
  if (b % 2 === 1) {
    rgb(0.96, 0.96, 0.96, false);
    rectFill(T0, y0, W_MM - T0, y1 - y0);
  }
  rgb(0.75, 0.75, 0.75, true);
  lw(0.1);
  for (let wk = 0; wk <= WEEKS; wk++) line(T0 + wk * WEEK_W, y0, T0 + wk * WEEK_W, y1);
}

// ---- Rows ---------------------------------------------------------------
for (let r = 0; r < ROWS; r++) {
  const y = HEADER + r * ROW;
  // table cells, each stroked on its own
  rgb(0.4, 0.4, 0.4, true);
  lw(0.18);
  let cx = 0;
  for (const [, w] of TABLE_COLS) {
    rectStroke(cx, y, w, ROW);
    cx += w;
  }
  // row separator through the timeline
  rgb(0.85, 0.85, 0.85, true);
  lw(0.1);
  line(T0, y + ROW, W_MM, y + ROW);

  const [trade, color] = pick(TRADES);
  const start = Math.floor(rand() * (WEEKS - 20));
  const dur = 1 + Math.floor(rand() * 18);
  const isMilestone = rand() < 0.08;
  const name = isMilestone
    ? `Meilenstein: ${pick(OBJECTS)} ${1 + Math.floor(rand() * 200)} in Betrieb`
    : `${pick(OBJECTS)} ${1 + Math.floor(rand() * 200)} ${pick(VERBS)} km ${(10 + rand() * 30).toFixed(3).replace(".", ",")}`;

  rgb(0, 0, 0, false);
  const ty = y + ROW - 1.4;
  text("F1", 7, 1.5, ty, String(r + 1));
  text("F1", 7, 21.5, ty, name);
  text("F1", 7, 221.5, ty, fmtDate(start));
  text("F1", 7, 261.5, ty, fmtDate(start + dur));
  text("F1", 7, 301.5, ty, isMilestone ? "0 AT" : `${dur * 5} AT`);
  text("F1", 7, 331.5, ty, trade);

  const bx = T0 + start * WEEK_W;
  if (isMilestone) {
    // diamond: identical shape repeated many times (a <use> candidate)
    const cym = y + ROW / 2;
    const s = 1.8;
    rgb(0, 0, 0, false);
    ops.push(`${X(bx)} ${Y(cym - s)} m ${X(bx + s)} ${Y(cym)} l ${X(bx)} ${Y(cym + s)} l ${X(bx - s)} ${Y(cym)} l h f`);
  } else {
    rgb(...color, false);
    rectFill(bx, y + 1, dur * WEEK_W, ROW - 2);
    rgb(0, 0, 0, true);
    lw(0.1);
    rectStroke(bx, y + 1, dur * WEEK_W, ROW - 2);
  }
  // occasional dependency arrow down to the next row
  if (r + 1 < ROWS && rand() < 0.25) {
    const ax = bx + (isMilestone ? 0 : dur * WEEK_W);
    rgb(0.1, 0.1, 0.1, true);
    lw(0.15);
    ops.push(`${X(ax)} ${Y(y + ROW / 2)} m ${X(ax + 1.5)} ${Y(y + ROW / 2)} l ${X(ax + 1.5)} ${Y(y + ROW + 1)} l S`);
    rgb(0.1, 0.1, 0.1, false);
    ops.push(`${X(ax + 0.8)} ${Y(y + ROW + 0.2)} m ${X(ax + 2.2)} ${Y(y + ROW + 0.2)} l ${X(ax + 1.5)} ${Y(y + ROW + 1)} l h f`);
  }
}

// ---- Hatched, slanted closure zones (tiling pattern in a non-rectangular shape)
// Like the "Sperrungen" in time-distance diagrams: exercises pattern fills and
// clip paths that are not rectangles. Like the real schedule, every zone gets its own pattern
// object: same tile, different origin (/Matrix).
const hatchOrigins = [];
for (let r = 20; r + 12 < ROWS; r += 97) {
  const y0 = HEADER + r * ROW;
  const y1 = y0 + 12 * ROW;
  const x0 = T0 + Math.floor(rand() * (WEEKS - 60)) * WEEK_W;
  const w = (10 + Math.floor(rand() * 30)) * WEEK_W;
  const slant = 25;
  hatchOrigins.push([x0 * MM, H - y0 * MM]);
  ops.push(`q /Pattern cs /H${hatchOrigins.length} scn`);
  ops.push(`${X(x0)} ${Y(y0)} m ${X(x0 + w)} ${Y(y0)} l ${X(x0 + w + slant)} ${Y(y1)} l ${X(x0 + slant)} ${Y(y1)} l h f Q`);
  rgb(0.8, 0, 0, true);
  lw(0.3);
  ops.push(`${X(x0)} ${Y(y0)} m ${X(x0 + w)} ${Y(y0)} l ${X(x0 + w + slant)} ${Y(y1)} l ${X(x0 + slant)} ${Y(y1)} l h S`);
}

// ---- Signal symbols: repeated curved shapes (filled circle + ring) ----------
// Like symbols in real schedules: the same form at many positions.
const K = 0.5523; // circle approximation by 4 Béziers
const circle = (cx, cy, r) =>
  `${X(cx + r)} ${Y(cy)} m ${X(cx + r)} ${Y(cy - K * r)} ${X(cx + K * r)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ` +
  `${X(cx - K * r)} ${Y(cy - r)} ${X(cx - r)} ${Y(cy - K * r)} ${X(cx - r)} ${Y(cy)} c ` +
  `${X(cx - r)} ${Y(cy + K * r)} ${X(cx - K * r)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ` +
  `${X(cx + K * r)} ${Y(cy + r)} ${X(cx + r)} ${Y(cy + K * r)} ${X(cx + r)} ${Y(cy)} c h`;
for (let r = 3; r < ROWS; r += 7) {
  // positions on a 0.1 mm grid, so the shapes are identical after rounding
  const cx = Math.round((T0 + 20 + rand() * (W_MM - T0 - 40)) * 10) / 10;
  const cy = HEADER + r * ROW + ROW / 2;
  rgb(0.1, 0.5, 0.1, false);
  ops.push(`${circle(cx, cy, 1.2)} f`);
  rgb(0, 0, 0, true);
  lw(0.15);
  ops.push(`${circle(cx, cy, 1.8)} S`);
}

// ---- Logo image, repeated (like a company logo in several title blocks) -----
for (let r = 0; r < ROWS; r += 600) {
  const y = HEADER + r * ROW;
  ops.push(`q ${f(30 * MM)} 0 0 ${f(15 * MM)} ${X(1150)} ${Y(y + 15)} cm /Logo Do Q`);
}

// ---- "Today" line, dashed -------------------------------------------------
rgb(0.9, 0, 0, true);
lw(0.5);
ops.push("[2 1] 0 d");
const today = T0 + 95 * WEEK_W;
line(today, HEADER - 15, today, HEADER + ROWS * ROW);
ops.push("[] 0 d");

// ---- Build the PDF --------------------------------------------------------
const doc = new mupdf.PDFDocument();
const fonts = doc.newDictionary();
fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin"));
fonts.put("F2", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"), "Latin"));
const res = doc.newDictionary();
res.put("Font", fonts);
// Hatch pattern: 45° red lines, cell of 1.5 mm.
{
  const cell = 1.5 * MM;
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("Pattern"));
  dict.put("PatternType", 1);
  dict.put("PaintType", 1);
  dict.put("TilingType", 1);
  const bbox = doc.newArray();
  for (const v of [0, 0, cell, cell]) bbox.push(v);
  dict.put("BBox", bbox);
  dict.put("XStep", cell);
  dict.put("YStep", cell);
  dict.put("Resources", doc.newDictionary());
  const e = cell * 0.25;
  const hatch = `0.8 0 0 RG ${f(0.12 * MM)} w 0 0 m ${f(cell)} ${f(cell)} l S ${f(-e)} ${f(cell - e)} m ${f(e)} ${f(cell + e)} l S ${f(cell - e)} ${f(-e)} m ${f(cell + e)} ${f(e)} l S`;
  const patterns = doc.newDictionary();
  hatchOrigins.forEach(([ox, oy], i) => {
    const d = doc.newDictionary();
    for (const k of ["Type", "PatternType", "PaintType", "TilingType", "BBox", "XStep", "YStep", "Resources"]) d.put(k, dict.get(k));
    const m = doc.newArray();
    for (const v of [1, 0, 0, 1, ox, oy]) m.push(v);
    d.put("Matrix", m);
    patterns.put(`H${i + 1}`, doc.addStream(hatch, d));
  });
  res.put("Pattern", patterns);
}
// Logo: a small RGB image with a gradient and a frame.
{
  const lw = 120, lh = 60;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, lw, lh], false);
  const px = pix.getPixels();
  for (let y = 0; y < lh; y++)
    for (let x = 0; x < lw; x++) {
      const i = (y * lw + x) * 3;
      const frame = x < 3 || y < 3 || x >= lw - 3 || y >= lh - 3;
      px[i] = frame ? 20 : 30 + (x * 200) / lw;
      px[i + 1] = frame ? 60 : 90 + (y * 120) / lh;
      px[i + 2] = frame ? 140 : 200;
    }
  const xobjects = doc.newDictionary();
  xobjects.put("Logo", doc.addImage(new mupdf.Image(pix)));
  res.put("XObject", xobjects);
}
const content = ops.join("\n");
const pageObj = doc.addPage([0, 0, W, H], 0, res, content);
pageObj.put("UserUnit", USER_UNIT);
doc.insertPage(-1, pageObj);

mkdirSync("samples", { recursive: true });
const out = doc.saveToBuffer("compress,garbage").asUint8Array();
writeFileSync("samples/test-plan.pdf", out);
console.log(
  `samples/test-plan.pdf: ${(out.length / 1e6).toFixed(2)} MB, ${W_MM} x ${H_MM} mm, UserUnit ${USER_UNIT}, ` +
    `${ROWS} rows, ${ops.length} drawing ops, content ${(content.length / 1e6).toFixed(1)} MB uncompressed`,
);
