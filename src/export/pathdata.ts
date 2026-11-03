// Compact SVG path encoding (ADR 0011) and a parser for MuPDF's glyph paths.

import { Op, type PathData } from "./ir";
import { apply, type Matrix } from "./geometry";

/**
 * Encodes path data as compact SVG path syntax:
 *  - coordinates rounded to integers (export units are 0.01 mm),
 *  - relative commands, h/v for axis-aligned lines,
 *  - repeated command letters and needless separators omitted.
 * Keeps the current point across calls, so several items can be appended to
 * one <path> element.
 */
export class PathEncoder {
  private out: string[] = [];
  private cx = 0;
  private cy = 0;
  private sx = 0;
  private sy = 0;
  private lastCmd = "";
  private lastNumEndsNum = false;

  private cmd(c: string, ...nums: number[]): void {
    let s = "";
    if (c !== this.lastCmd || c === "m" || c === "z") {
      s = c;
      this.lastNumEndsNum = false;
    }
    for (const n of nums) {
      const t = String(n);
      if (this.lastNumEndsNum && n >= 0) s += " ";
      s += t;
      this.lastNumEndsNum = true;
    }
    if (c === "z") this.lastNumEndsNum = false;
    this.out.push(s);
    // After "m", implicit repeats mean "l", so never elide a letter following m.
    this.lastCmd = c === "m" ? "" : c;
  }

  add(d: PathData): void {
    let i = 0;
    while (i < d.length) {
      const op = d[i++];
      if (op === Op.Move) {
        const x = Math.round(d[i++]!);
        const y = Math.round(d[i++]!);
        this.cmd("m", x - this.cx, y - this.cy);
        this.cx = this.sx = x;
        this.cy = this.sy = y;
      } else if (op === Op.Line) {
        const x = Math.round(d[i++]!);
        const y = Math.round(d[i++]!);
        const dx = x - this.cx;
        const dy = y - this.cy;
        if (dy === 0) this.cmd("h", dx);
        else if (dx === 0) this.cmd("v", dy);
        else this.cmd("l", dx, dy);
        this.cx = x;
        this.cy = y;
      } else if (op === Op.Curve) {
        const p = [d[i++]!, d[i++]!, d[i++]!, d[i++]!, d[i++]!, d[i++]!].map(Math.round) as number[];
        this.cmd("c", p[0]! - this.cx, p[1]! - this.cy, p[2]! - this.cx, p[3]! - this.cy, p[4]! - this.cx, p[5]! - this.cy);
        this.cx = p[4]!;
        this.cy = p[5]!;
      } else if (op === Op.Close) {
        this.cmd("z");
        this.cx = this.sx;
        this.cy = this.sy;
      } else {
        throw new Error(`bad path op ${op}`);
      }
    }
  }

  toString(): string {
    return this.out.join("");
  }
}

export function encodePath(d: PathData): string {
  const e = new PathEncoder();
  e.add(d);
  return e.toString();
}

/**
 * Parses absolute SVG path syntax as produced by MuPDF's SVG writer for glyph
 * outlines (M, L, H, V, C, Z with implicit repeats) and transforms it.
 */
export function parseGlyphPath(d: string, m: Matrix): PathData {
  const tokens = d.match(/[MLHVCZmlhvcz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: PathData = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]!);
  const pt = (px: number, py: number) => apply(m, px, py);
  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++]!;
    switch (cmd) {
      case "M": {
        x = sx = num();
        y = sy = num();
        out.push(Op.Move, ...pt(x, y));
        cmd = "L";
        break;
      }
      case "L":
        x = num();
        y = num();
        out.push(Op.Line, ...pt(x, y));
        break;
      case "H":
        x = num();
        out.push(Op.Line, ...pt(x, y));
        break;
      case "V":
        y = num();
        out.push(Op.Line, ...pt(x, y));
        break;
      case "C": {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num();
        x = num();
        y = num();
        out.push(Op.Curve, ...pt(x1, y1), ...pt(x2, y2), ...pt(x, y));
        break;
      }
      case "Z":
      case "z":
        out.push(Op.Close);
        x = sx;
        y = sy;
        break;
      default:
        throw new Error(`unsupported glyph path command "${cmd}"`);
    }
  }
  return out;
}
