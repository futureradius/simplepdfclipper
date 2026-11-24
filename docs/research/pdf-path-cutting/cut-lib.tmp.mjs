// Research #34 prototype: cut path geometry in a PDF content stream at the Clip.
// Tokenizer + q/Q/cm tracking + fill clipping (half-plane, per subpath) + stroke
// centreline cutting (with dash phase continuation). Not production code.

// ---------------- tokenizer ----------------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

/** Yields {ops: operands (raw text), op, start, end} per operator. Operands are kept as raw text slices. */
export function* tokenize(buf) {
  const n = buf.length;
  let i = 0;
  let operands = [];
  let opStart = -1;
  const dec = (a, b) => {
    let s = "";
    for (let k = a; k < b; k++) s += String.fromCharCode(buf[k]);
    return s;
  };
  while (i < n) {
    const c = buf[i];
    if (WS.has(c)) { i++; continue; }
    if (opStart < 0) opStart = i;
    if (c === 37) { while (i < n && buf[i] !== 10 && buf[i] !== 13) i++; continue; } // comment
    const s = i;
    if (c === 40) { // literal string
      let depth = 0;
      for (; i < n; i++) {
        const d = buf[i];
        if (d === 92) { i++; continue; }
        if (d === 40) depth++;
        else if (d === 41 && --depth === 0) { i++; break; }
      }
      operands.push(dec(s, i));
    } else if (c === 60 && buf[i + 1] === 60) { // dict: scan to matching >>
      let depth = 0;
      for (; i < n; i++) {
        if (buf[i] === 40) { let dd = 0; for (; i < n; i++) { if (buf[i] === 92) { i++; continue; } if (buf[i] === 40) dd++; else if (buf[i] === 41 && --dd === 0) break; } continue; }
        if (buf[i] === 60 && buf[i + 1] === 60) { depth++; i++; }
        else if (buf[i] === 62 && buf[i + 1] === 62) { depth--; i++; if (depth === 0) { i++; break; } }
      }
      operands.push(dec(s, i));
    } else if (c === 60) { // hex string
      while (i < n && buf[i] !== 62) i++;
      i++;
      operands.push(dec(s, i));
    } else if (c === 91) { // array: scan to matching ] (strings inside handled)
      let depth = 0;
      for (; i < n; i++) {
        const d = buf[i];
        if (d === 40) { let dd = 0; for (; i < n; i++) { if (buf[i] === 92) { i++; continue; } if (buf[i] === 40) dd++; else if (buf[i] === 41 && --dd === 0) break; } continue; }
        if (d === 91) depth++;
        else if (d === 93 && --depth === 0) { i++; break; }
      }
      operands.push(dec(s, i));
    } else if (c === 47) { // name
      i++;
      while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      operands.push(dec(s, i));
    } else { // number or operator
      while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      const tok = dec(s, i);
      if (/^[+\-.0-9]/.test(tok)) operands.push(tok);
      else {
        if (tok === "ID") { // inline image data up to whitespace EI whitespace
          i++;
          while (i < n && !(WS.has(buf[i]) && buf[i + 1] === 69 && buf[i + 2] === 73 && (i + 3 >= n || WS.has(buf[i + 3])))) i++;
          i += 3;
          yield { operands, op: "ID…EI", start: opStart, end: i };
        } else yield { operands, op: tok, start: opStart, end: i };
        operands = [];
        opStart = -1;
      }
    }
  }
}

// ---------------- geometry ----------------
export const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const EPS = 1e-9;

/** Real roots of a + b t + c t^2 + d t^3 in (0,1). */
function cubicRoots(a, b, c, d) {
  const out = [];
  const push = (t) => { if (t > 1e-9 && t < 1 - 1e-9) out.push(t); };
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d)) || 1;
  if (Math.abs(d) < 1e-12 * scale) {
    if (Math.abs(c) < 1e-12 * scale) { if (Math.abs(b) > 1e-15 * scale) push(-a / b); return out; }
    const D = b * b - 4 * c * a;
    if (D < 0) return out;
    const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(D));
    push(q / c); if (q !== 0) push(a / q);
    return out.sort((x, y) => x - y);
  }
  // normalise t^3 + A t^2 + B t + C
  const A = c / d, B = b / d, C = a / d;
  const Q = (3 * B - A * A) / 9, R = (9 * A * B - 27 * C - 2 * A * A * A) / 54;
  const D = Q * Q * Q + R * R;
  if (D >= 0) {
    const sD = Math.sqrt(D);
    const S = Math.cbrt(R + sD), T = Math.cbrt(R - sD);
    push(-A / 3 + S + T);
    if (Math.abs(S - T) < 1e-12) push(-A / 3 - (S + T) / 2);
  } else {
    const th = Math.acos(R / Math.sqrt(-Q * Q * Q));
    const r = 2 * Math.sqrt(-Q);
    for (const k of [0, 1, 2]) push(r * Math.cos((th + 2 * Math.PI * k) / 3) - A / 3);
  }
  return out.sort((x, y) => x - y);
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
function splitCubic(P, t) {
  const [p0, p1, p2, p3] = P;
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
  return [[p0, a, d, f], [f, e, c, p3]];
}
/** Split a segment ({pts:[p0,p1]} line or {pts:[p0..p3]} cubic) at sorted ts. */
function splitAt(seg, ts) {
  if (ts.length === 0) return [seg];
  const out = [];
  let cur = seg.pts, base = 0;
  for (const t of ts) {
    const u = (t - base) / (1 - base);
    if (cur.length === 2) {
      const m = lerp(cur[0], cur[1], u);
      out.push({ pts: [cur[0], m] });
      cur = [m, cur[1]];
    } else {
      const [x, y] = splitCubic(cur, u);
      out.push({ pts: x });
      cur = y;
    }
    base = t;
  }
  out.push({ pts: cur });
  return out;
}
const gval = (g, p) => g[0] * p[0] + g[1] * p[1] + g[2];
function rootsOf(seg, g) {
  const v = seg.pts.map((p) => gval(g, p));
  if (seg.pts.length === 2) {
    if ((v[0] < 0) === (v[1] < 0) || v[0] === v[1]) return [];
    const t = v[0] / (v[0] - v[1]);
    return t > 1e-9 && t < 1 - 1e-9 ? [t] : [];
  }
  const [a, b, c, d] = v; // Bernstein -> power basis
  return cubicRoots(a, 3 * (b - a), 3 * (a - 2 * b + c), -a + 3 * b - 3 * c + d);
}
const midpoint = (seg) => (seg.pts.length === 2 ? lerp(seg.pts[0], seg.pts[1], 0.5) : splitCubic(seg.pts, 0.5)[0][3]);
const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7;

// Gauss-Legendre 8 for cubic arc length.
const GL = [[-0.1834346424956498, 0.3626837833783620], [0.1834346424956498, 0.3626837833783620], [-0.5255324099163290, 0.3137066458778873], [0.5255324099163290, 0.3137066458778873], [-0.7966664774136267, 0.2223810344533745], [0.7966664774136267, 0.2223810344533745], [-0.9602898564975363, 0.1012285362903763], [0.9602898564975363, 0.1012285362903763]];
function segLength(seg) {
  const P = seg.pts;
  if (P.length === 2) return Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
  let L = 0;
  for (const [x, w] of GL) {
    const t = (x + 1) / 2, u = 1 - t;
    const dx = 3 * (u * u * (P[1][0] - P[0][0]) + 2 * u * t * (P[2][0] - P[1][0]) + t * t * (P[3][0] - P[2][0]));
    const dy = 3 * (u * u * (P[1][1] - P[0][1]) + 2 * u * t * (P[2][1] - P[1][1]) + t * t * (P[3][1] - P[2][1]));
    L += (w / 2) * Math.hypot(dx, dy);
  }
  return L;
}

// Subpath: {start:[x,y], segs:[{pts}], closed:bool}

/** Fill clipping against one half-plane g >= 0 (Sutherland–Hodgman with curves). */
function clipFillHalf(sub, g) {
  const segs = [...sub.segs];
  const last = segs.length ? segs[segs.length - 1].pts.at(-1) : sub.start;
  if (!same(last, sub.start)) segs.push({ pts: [last, sub.start] }); // implicit closing line
  const pieces = segs.flatMap((s) => splitAt(s, rootsOf(s, g)));
  const out = [];
  let cur = null;
  let start = null;
  for (const p of pieces) {
    if (gval(g, midpoint(p)) < -1e-7) continue;
    const a = p.pts[0];
    if (!start) { start = a; cur = a; }
    else if (!same(cur, a)) out.push({ pts: [cur, a] }); // along the boundary
    out.push(p);
    cur = p.pts.at(-1);
  }
  if (!start) return null;
  return { start, segs: out, closed: true };
}
export function clipFill(subs, gs) {
  let cur = subs;
  for (const g of gs) cur = cur.map((s) => clipFillHalf(s, g)).filter(Boolean);
  return cur;
}

/** Stroke cutting: centre line cut at the convex region (all g >= 0). Returns runs with dash offset. */
export function cutStroke(subs, gs) {
  const runs = [];
  let unchanged = true;
  for (const sub of subs) {
    const segs = [...sub.segs];
    if (sub.closed) {
      const last = segs.length ? segs[segs.length - 1].pts.at(-1) : sub.start;
      if (!same(last, sub.start)) segs.push({ pts: [last, sub.start] });
    }
    if (segs.length === 0) { // lone point (dot with round caps)
      if (gs.every((g) => gval(g, sub.start) >= -1e-7)) runs.push({ start: sub.start, segs: [], closed: sub.closed, offset: 0 });
      else unchanged = false;
      continue;
    }
    const pieces = [];
    let s = 0;
    for (const seg of segs) {
      const ts = [...new Set(gs.flatMap((g) => rootsOf(seg, g)))].sort((a, b) => a - b);
      for (const p of splitAt(seg, ts)) {
        const m = midpoint(p);
        const inside = gs.every((g) => gval(g, m) >= -1e-7);
        const len = segLength(p);
        pieces.push({ p, inside, s });
        s += len;
      }
    }
    if (pieces.every((x) => x.inside)) { runs.push({ ...sub, offset: 0 }); continue; }
    unchanged = false;
    // closed: rotate so we start after an outside piece (a run may then wrap over the
    // original start; its dash offset becomes discontinuous there: split it, see notes)
    let order = pieces;
    if (sub.closed) {
      const k = pieces.findIndex((x) => !x.inside);
      order = [...pieces.slice(k + 1), ...pieces.slice(0, k + 1)];
    }
    let run = null;
    for (const x of order) {
      const wrapped = run && x.s === 0; // passing the original start of a closed subpath
      if (!x.inside || wrapped) { if (run) runs.push(run); run = null; if (!x.inside) continue; }
      if (!run) run = { start: x.p.pts[0], segs: [], closed: false, offset: x.s };
      run.segs.push(x.p);
    }
    if (run) runs.push(run);
  }
  return { runs, unchanged };
}

// ---------------- serialise ----------------
const fmt = (v) => {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? "0" : String(r);
};
export function pathText(subs) {
  let t = "";
  for (const s of subs) {
    t += `${fmt(s.start[0])} ${fmt(s.start[1])} m\n`;
    for (const seg of s.segs) {
      const P = seg.pts;
      if (P.length === 2) t += `${fmt(P[1][0])} ${fmt(P[1][1])} l\n`;
      else t += `${fmt(P[1][0])} ${fmt(P[1][1])} ${fmt(P[2][0])} ${fmt(P[2][1])} ${fmt(P[3][0])} ${fmt(P[3][1])} c\n`;
    }
    if (s.closed) t += "h\n";
  }
  return t;
}

// ---------------- content stream rewriting ----------------
const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const CONSTRUCT = new Set(["m", "l", "c", "v", "y", "h", "re"]);

/**
 * Rewrites a content stream: every painted / clip path is cut at the clip rect
 * (given in MuPDF page space), using `base` = user space -> page space at stream start.
 */
export function cutContent(buf, base, clip, stats, overhang = false) {
  let lw = 1, ml = 10, lj = 0;
  const [cx0, cy0, cx1, cy1] = clip;
  const enc = new TextEncoder();
  const parts = [];
  let last = 0;
  let ctm = [1, 0, 0, 1, 0, 0];
  let dash = { arr: "[]", list: [], phase: 0 };
  const stack = [];
  let subs = [];
  let cur = null;
  let pathStart = -1;
  let clipOp = null;
  const num = (s) => Number(s);
  let lastStart = [0, 0];
  const startSub = (p) => { lastStart = p; cur = { start: p, segs: [], closed: false }; subs.push(cur); };
  const cp = () => (cur ? (cur.segs.length ? cur.segs.at(-1).pts.at(-1) : cur.start) : [0, 0]);

  for (const t of tokenize(buf)) {
    const o = t.operands;
    switch (t.op) {
      case "q": stack.push({ ctm, dash, lw, ml, lj }); break;
      case "Q": ({ ctm, dash, lw, ml, lj } = stack.pop() ?? { ctm, dash, lw, ml, lj }); break;
      case "w": lw = num(o[0]); break;
      case "M": ml = num(o[0]); break;
      case "j": lj = num(o[0]); break;
      case "cm": ctm = mul(o.map(num), ctm); break;
      case "d": {
        const list = o[0].replace(/[\[\]]/g, " ").trim().split(/\s+/).filter(Boolean).map(num);
        dash = { arr: o[0], list, phase: num(o[1]) };
        break;
      }
      case "Do": stats.xobjects++; break;
      case "W": case "W*": clipOp = t.op; break;
    }
    if (CONSTRUCT.has(t.op)) {
      if (pathStart < 0) pathStart = t.start;
      const v = o.map(num);
      if (t.op === "m") startSub([v[0], v[1]]);
      else if (t.op === "l") { if (!cur) startSub(lastStart); cur.segs.push({ pts: [cp(), [v[0], v[1]]] }); }
      else if (t.op === "c") (cur ?? (startSub(lastStart), cur)).segs.push({ pts: [cp(), [v[0], v[1]], [v[2], v[3]], [v[4], v[5]]] });
      else if (t.op === "v") cur.segs.push({ pts: [cp(), cp(), [v[0], v[1]], [v[2], v[3]]] });
      else if (t.op === "y") cur.segs.push({ pts: [cp(), [v[0], v[1]], [v[2], v[3]], [v[2], v[3]]] });
      else if (t.op === "h") { if (cur) { cur.closed = true; cur = null; } }
      else if (t.op === "re") {
        const [x, y, w, h] = v;
        subs.push({ start: [x, y], segs: [{ pts: [[x, y], [x + w, y]] }, { pts: [[x + w, y], [x + w, y + h]] }, { pts: [[x + w, y + h], [x, y + h]] }], closed: true });
        cur = null;
      }
      continue;
    }
    if (PAINT.has(t.op) && pathStart >= 0) {
      stats.paths++;
      const M = mul(ctm, base);
      // half-planes in user space: page x = a x + c y + e, page y = b x + d y + f
      const gs = [
        [M[0], M[2], M[4] - cx0], [-M[0], -M[2], cx1 - M[4]],
        [M[1], M[3], M[5] - cy0], [-M[1], -M[3], cy1 - M[5]],
      ];
      // fast path: all control points inside
      const allIn = subs.every((s) => [s.start, ...s.segs.flatMap((g) => g.pts)].every((p) => gs.every((g) => gval(g, p) >= -1e-7)));
      if (!allIn) {
        stats.crossing++;
        const op = t.op;
        const closeFirst = op === "s" || op === "b" || op === "b*";
        if (closeFirst && subs.length) subs.at(-1).closed = true;
        const fill = op !== "S" && op !== "s" && op !== "n";
        const stroke = op === "S" || op === "s" || op.startsWith("B") || op.startsWith("b");
        const eo = op.endsWith("*");
        let out = "";
        const clipSubs = clipOp ? clipFill(subs, gs) : null;
        if (fill) {
          const fs = clipFill(subs, gs);
          if (fs.length) out += pathText(fs) + (eo ? "f*\n" : "f\n");
        }
        if (stroke) {
          stats.strokes++;
          const r = overhang ? (lw / 2) * Math.max(Math.SQRT2, lj === 0 ? ml : 1) * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) : 0;
          const sg = gs.map((g) => [g[0], g[1], g[2] + r]);
          const { runs } = cutStroke(subs, sg);
          if (dash.list.length && runs.some((r) => r.offset)) {
            stats.dashed++;
            for (const r of runs) out += `q ${dash.arr} ${fmt(dash.phase + r.offset)} d\n${pathText([r])}S Q\n`;
          } else if (runs.length) out += pathText(runs) + "S\n";
        }
        if (clipOp) {
          out += (clipSubs.length ? pathText(clipSubs) : "0 0 m h\n") + `${clipOp} n\n`;
          stats.clips++;
        } else if (op === "n") out += "n\n";
        parts.push(buf.subarray(last, pathStart), enc.encode("\n" + out));
        last = t.end;
      }
      subs = []; cur = null; pathStart = -1; clipOp = null;
    }
  }
  parts.push(buf.subarray(last));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const res = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { res.set(p, off); off += p.length; }
  return res;
}

/** All path points of painted paths, in page space (for verification). */
export function pathPoints(buf, base, cb) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (const t of tokenize(buf)) {
    const o = t.operands.map(Number);
    if (t.op === "q") stack.push(ctm);
    else if (t.op === "Q") ctm = stack.pop() ?? ctm;
    else if (t.op === "cm") ctm = mul(o, ctm);
    else if (CONSTRUCT.has(t.op) && t.op !== "h") {
      const M = mul(ctm, base);
      const pts = t.op === "re" ? [[o[0], o[1]], [o[0] + o[2], o[1] + o[3]]] : [];
      if (t.op !== "re") for (let k = 0; k + 1 < o.length; k += 2) pts.push([o[k], o[k + 1]]);
      for (const [x, y] of pts) cb(M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5], t.op);
    }
  }
}
