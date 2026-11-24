// Research #34: redaction (as today) vs redaction + geometric cut, on the Test Plan.
import * as mupdf from "mupdf";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cutContent, pathPoints, tokenize } from "./cut-lib.tmp.mjs";

const PLAN = process.argv[2] ?? "samples/test-plan.pdf";
const MM = 72 / 25.4;
const clips = [
  { x: 200, y: 3000, width: 500, height: 600 },
  { x: 0, y: 2000, width: 1188.9, height: 600 },
  { x: 37.3, y: 7011.7, width: 333.3, height: 1222.2 },
];
const bytes = new Uint8Array(readFileSync(PLAN));
mkdirSync("samples/out", { recursive: true });

function redacted(clip) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  const page = doc.loadPage(0);
  const [bx0, by0, bx1, by1] = page.getBounds();
  const c = [bx0 + clip.x * MM, by0 + clip.y * MM, 0, 0];
  c[2] = c[0] + clip.width * MM;
  c[3] = c[1] + clip.height * MM;
  const m = Math.max(bx1 - bx0, by1 - by0);
  for (const r of [
    [bx0 - m, by0 - m, bx1 + m, c[1]],
    [bx0 - m, c[3], bx1 + m, by1 + m],
    [bx0 - m, c[1], c[0], c[3]],
    [c[2], c[1], bx1 + m, c[3]],
  ]) if (r[2] > r[0] && r[3] > r[1]) page.createAnnotation("Redact").setRect(r);
  page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  return { doc, page, c };
}

function render(page, c, k = 3 / MM) {
  // k px per pt; renders the clip area of the page
  const w = Math.round((c[2] - c[0]) * k), h = Math.round((c[3] - c[1]) * k);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice([k, 0, 0, k, -c[0] * k, -c[1] * k], pix);
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  const px = pix.getPixels().slice();
  pix.destroy();
  return px;
}
function diff(a, b, w) {
  let n = 0, any = 0; const where = {};
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > 64) { n++; const p = i / 3, x = p % w, y = Math.floor(p / w); const key = `x${Math.min(x, w - 1 - x) < 4 ? "edge" : "in"} y${Math.floor(y / (w ? 1 : 1)) < 4 ? "top" : ""}`; where[`${x},${y}`] = 1; }
    if (d > 0) any++;
  }
  return [n / (a.length / 3), any / (a.length / 3), where];
}

for (const clip of clips) {
  console.log(`\n== Clip ${JSON.stringify(clip)}`);
  const A = redacted(clip);
  const B = redacted(clip);
  const obj = B.page.getObject();
  const content = obj.get("Contents");
  const buf = content.readStream().asUint8Array().slice();
  const base = B.page.getTransform();
  const stats = { paths: 0, crossing: 0, strokes: 0, dashed: 0, clips: 0, xobjects: 0 };
  let t = performance.now();
  let ops = 0;
  for (const _ of tokenize(buf)) ops++;
  const tTok = performance.now() - t;
  t = performance.now();
  const out = cutContent(buf, base, B.c, stats, process.env.OVERHANG === "1");
  const tCut = performance.now() - t;
  obj.put("Contents", B.doc.addStream(out, B.doc.newDictionary()));
  console.log(`content after redaction ${(buf.length / 1e3).toFixed(0)} kB, ${ops} ops; tokenize ${tTok.toFixed(0)} ms, cut ${tCut.toFixed(0)} ms -> ${(out.length / 1e3).toFixed(0)} kB`);
  console.log("stats", JSON.stringify(stats));

  // Verification: path coordinates outside the Clip (pt) before/after.
  const outside = (b) => {
    let n = 0, worst = 0;
    pathPoints(b, base, (x, y) => {
      const d = Math.max(B.c[0] - x, x - B.c[2], B.c[1] - y, y - B.c[3]);
      if (d > 0.01) { n++; worst = Math.max(worst, d); }
    });
    return `${n} points outside, farthest ${(worst / MM).toFixed(1)} mm`;
  };
  console.log("before cut:", outside(buf));
  console.log("after cut: ", outside(out));

  const ra = render(A.page, A.c);
  const rb = render(B.page, B.c);
  const W = Math.round((B.c[2] - B.c[0]) * 3 / MM), H = ra.length / 3 / W;
  const [d64, dany, where] = diff(ra, rb, W);
  const ks = Object.keys(where).map((k) => k.split(",").map(Number)); const distE = ks.map(([x, y]) => Math.min(x, W - 1 - x, y, H - 1 - y)); const hist = {}; for (const d of distE) { const b = d < 2 ? "<2px" : d < 10 ? "2-10px" : ">=10px"; hist[b] = (hist[b] ?? 0) + 1; } console.log("diff px by distance from Clip edge", JSON.stringify(hist), "samples", JSON.stringify(ks.filter((_, i) => distE[i] >= 2).slice(0, 12)));
  console.log(`render diff at 3 px/mm: ${(d64 * 100).toFixed(4)} % pixels >64, ${(dany * 100).toFixed(4)} % any`);
  const sa = A.doc.saveToBuffer("garbage=deduplicate,compress").asUint8Array().length;
  const sb = B.doc.saveToBuffer("garbage=deduplicate,compress").asUint8Array().length;
  console.log(`saved size: redaction only ${(sa / 1e6).toFixed(3)} MB, + cut ${(sb / 1e6).toFixed(3)} MB`);
  if (clip === clips[0]) writeFileSync("samples/out/cut-proto.pdf", B.doc.saveToBuffer("garbage=deduplicate,compress").asUint8Array());
}
