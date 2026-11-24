// Research #34: re-emit the (redacted) page through MuPDF's PDF writer device.
// A pass-through JS device sits in between (where cutting would happen).
import * as mupdf from "mupdf";
import { readFileSync, writeFileSync } from "node:fs";

const MM = 72 / 25.4;
const clip = { x: 200, y: 3000, width: 500, height: 600 };
const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync("samples/test-plan.pdf")), "application/pdf").asPDF();
const page = doc.loadPage(0);
const [bx0, by0, bx1, by1] = page.getBounds();
const c = [bx0 + clip.x * MM, by0 + clip.y * MM, bx0 + (clip.x + clip.width) * MM, by0 + (clip.y + clip.height) * MM];
const m = Math.max(bx1 - bx0, by1 - by0);
for (const r of [[bx0 - m, by0 - m, bx1 + m, c[1]], [bx0 - m, c[3], bx1 + m, by1 + m], [bx0 - m, c[1], c[0], c[3]], [c[2], c[1], bx1 + m, c[3]]]) page.createAnnotation("Redact").setRect(r);
page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);

const buf = new mupdf.Buffer();
const writer = new mupdf.DocumentWriter(buf, "pdf", "compress");
const target = writer.beginPage([0, 0, c[2] - c[0], c[3] - c[1]]);
const counts = {};
const n = (k) => (counts[k] = (counts[k] ?? 0) + 1);
const pass = new mupdf.Device({
  fillPath: (p, eo, ctm, cs, col, a) => (n("fillPath"), target.fillPath(p, eo, ctm, cs, col, a)),
  strokePath: (p, st, ctm, cs, col, a) => (n("strokePath"), target.strokePath(p, st, ctm, cs, col, a)),
  clipPath: (p, eo, ctm) => (n("clipPath"), target.clipPath(p, eo, ctm)),
  clipStrokePath: (p, st, ctm) => (n("clipStrokePath"), target.clipStrokePath(p, st, ctm)),
  fillText: (t, ctm, cs, col, a) => (n("fillText"), target.fillText(t, ctm, cs, col, a)),
  strokeText: (t, st, ctm, cs, col, a) => (n("strokeText"), target.strokeText(t, st, ctm, cs, col, a)),
  clipText: (t, ctm) => (n("clipText"), target.clipText(t, ctm)),
  clipStrokeText: (t, st, ctm) => (n("clipStrokeText"), target.clipStrokeText(t, st, ctm)),
  ignoreText: (t, ctm) => (n("ignoreText"), target.ignoreText(t, ctm)),
  fillShade: (s, ctm, a) => (n("fillShade"), target.fillShade(s, ctm, a)),
  fillImage: (i, ctm, a) => (n("fillImage"), target.fillImage(i, ctm, a)),
  fillImageMask: (i, ctm, cs, col, a) => (n("fillImageMask"), target.fillImageMask(i, ctm, cs, col, a)),
  clipImageMask: (i, ctm) => (n("clipImageMask"), target.clipImageMask(i, ctm)),
  popClip: () => (n("popClip"), target.popClip()),
  beginMask: (r, l, cs, col) => (n("beginMask"), target.beginMask(r, l, cs, col)),
  endMask: () => (n("endMask"), target.endMask()),
  beginGroup: (r, cs, i, k, bm, a) => (n("beginGroup"), target.beginGroup(r, cs, i, k, bm, a)),
  endGroup: () => (n("endGroup"), target.endGroup()),
  beginTile: (area, view, xs, ys, ctm, id, did) => (n("beginTile"), target.beginTile(area, view, xs, ys, ctm, id, did)),
  endTile: () => (n("endTile"), target.endTile()),
  beginLayer: (name) => (n("beginLayer"), target.beginLayer(name)),
  endLayer: () => (n("endLayer"), target.endLayer()),
});
const t = performance.now();
try {
  page.run(pass, [1, 0, 0, 1, -c[0], -c[1]]);
  pass.close();
  writer.endPage();
  writer.close();
  const out = buf.asUint8Array().slice();
  writeFileSync("samples/out/devroute.pdf", out);
  console.log(`device route: ${(performance.now() - t).toFixed(0)} ms, ${(out.length / 1e6).toFixed(3)} MB`, counts);
  const od = mupdf.Document.openDocument(out, "application/pdf").asPDF();
  const op = od.loadPage(0);
  console.log("out resources:", op.getObject().getInheritable("Resources").resolve().toString().slice(0, 400));
  console.log("out text sample:", op.toStructuredText("preserve-whitespace").asText().slice(0, 200).replace(/\n/g, " | "));
} catch (e) {
  console.log("device route failed:", e.message, counts);
}
