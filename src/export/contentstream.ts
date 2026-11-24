// Minimal PDF content stream tokenizer: yields each operator with its operands as raw
// text. Strings, arrays and dictionaries are skipped as whole operands, comments are
// dropped and inline images (BI … ID <data> EI) come out as one "BI" operator, so
// binary image data never ends up parsed as operators.

const WS = new Set([0, 9, 10, 12, 13, 32]);
// ( ) < > [ ] { } / %
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

export interface ContentOp {
  op: string;
  operands: string[];
  /** Byte range of the operator with its operands (comments before them included). */
  start: number;
  end: number;
}

/** A number as PDF writes it: 12 significant digits (a scale rounded to 4 decimals
 * shifts content 14 m away from the origin by ~0.15 mm), never in exponent notation
 * (which PDF can't read: blank page). Leftovers of float maths below 1e-6 are 0. */
export function pdfNumber(v: number): string {
  const r = Number(v.toPrecision(12));
  return Math.abs(r) < 1e-6 ? "0" : String(r);
}

const text = (buf: Uint8Array, a: number, b: number) => {
  let s = "";
  for (let k = a; k < b; k++) s += String.fromCharCode(buf[k]!);
  return s;
};

/** Index after the literal string starting at `i` (which is "("). */
function skipString(buf: Uint8Array, i: number): number {
  let depth = 0;
  for (; i < buf.length; i++) {
    const c = buf[i];
    if (c === 92) i++; // backslash escapes the next byte
    else if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return i + 1;
  }
  return i;
}

/** Index after the array or dictionary starting at `i`, nested ones and strings included. */
function skipNested(buf: Uint8Array, i: number): number {
  let depth = 0;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === 40) {
      i = skipString(buf, i);
      continue;
    }
    if (c === 60 && buf[i + 1] === 60) {
      depth++;
      i += 2;
    } else if (c === 62 && buf[i + 1] === 62) {
      depth--;
      i += 2;
    } else if (c === 60) {
      // hex string inside
      while (i < buf.length && buf[i] !== 62) i++;
      i++;
    } else {
      if (c === 91) depth++;
      else if (c === 93) depth--;
      i++;
    }
    if (depth === 0) return i;
  }
  return i;
}

export function* tokenize(buf: Uint8Array): Generator<ContentOp> {
  const n = buf.length;
  let i = 0;
  let operands: string[] = [];
  let start = -1;
  while (i < n) {
    const c = buf[i]!;
    if (WS.has(c)) {
      i++;
      continue;
    }
    const s = i;
    if (start < 0) start = i;
    if (c === 37) {
      while (i < n && buf[i] !== 10 && buf[i] !== 13) i++;
      continue;
    }
    if (c === 40) i = skipString(buf, i);
    else if (c === 91 || (c === 60 && buf[i + 1] === 60)) i = skipNested(buf, i);
    else if (c === 60) {
      while (i < n && buf[i] !== 62) i++;
      i++;
    } else if (c === 47) {
      i++;
      while (i < n && !WS.has(buf[i]!) && !DELIM.has(buf[i]!)) i++;
    } else if (DELIM.has(c)) {
      i++; // stray ) > ] { }: ignore
      continue;
    } else {
      while (i < n && !WS.has(buf[i]!) && !DELIM.has(buf[i]!)) i++;
      const tok = text(buf, s, i);
      if (/^[+\-.0-9]/.test(tok) || tok === "true" || tok === "false" || tok === "null") {
        operands.push(tok);
        continue;
      }
      if (tok === "BI") {
        // Skip to "ID", then the data up to whitespace + "EI" + whitespace/end.
        while (i < n && !(buf[i] === 73 && buf[i + 1] === 68 && WS.has(buf[i - 1]!) && (i + 2 >= n || WS.has(buf[i + 2]!)))) i++;
        i += 3;
        while (i < n && !(WS.has(buf[i - 1]!) && buf[i] === 69 && buf[i + 1] === 73 && (i + 2 >= n || WS.has(buf[i + 2]!) || DELIM.has(buf[i + 2]!)))) i++;
        i += 2;
      }
      yield { op: tok, operands, start, end: i };
      operands = [];
      start = -1;
      continue;
    }
    operands.push(text(buf, s, i));
  }
}
