// Shows where the bytes of an SVG go (by element type), and how small it would be
// compressed. Usage: node scripts/svg-breakdown.mjs file.svg
// Only prints statistics; nothing leaves the machine.

import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

const bytes = readFileSync(process.argv[2]);
// .svgz files are gzip-compressed (magic bytes 1f 8b)
const svg = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
const total = Buffer.byteLength(svg);
const stats = new Map();
const add = (k, bytes) => {
  const s = stats.get(k) ?? { n: 0, bytes: 0 };
  s.n++;
  s.bytes += bytes;
  stats.set(k, s);
};

// Classify each element by tag, plus some interesting sub-kinds.
for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)([^>]*)>/g)) {
  if (m[1]) continue;
  const tag = m[2];
  const attrs = m[3];
  let kind = tag;
  if (tag === "path" && attrs.includes('fill="url(#p')) kind = "path (pattern fill)";
  else if (tag === "path" && attrs.includes('fill="none"')) kind = "path (stroke)";
  else if (tag === "path") kind = "path (fill)";
  add(kind, Buffer.byteLength(m[0]));
}
// Text content and whole definitions.
for (const m of svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) add("(text content)", Buffer.byteLength(m[1]));
for (const m of svg.matchAll(/<clipPath[\s\S]*?<\/clipPath>/g)) add("[clipPath blocks]", Buffer.byteLength(m[0]));
for (const m of svg.matchAll(/<pattern[^/]*?>[\s\S]*?<\/pattern>|<pattern[^>]*\/>/g)) add("[pattern blocks]", Buffer.byteLength(m[0]));

const rows = [...stats].sort((a, b) => b[1].bytes - a[1].bytes);
const mb = (b) => (b / 1e6).toFixed(2).padStart(6) + " MB";
console.log(`total ${mb(total)}   gzip ${mb(gzipSync(svg).length)}`);
for (const [k, s] of rows) console.log(`${k.padEnd(22)} ${String(s.n).padStart(7)} × ${mb(s.bytes)}  ${((s.bytes / total) * 100).toFixed(1).padStart(5)} %`);

// Duplicate pattern contents (same tile drawn as separate pattern definitions)?
const contents = new Map();
for (const m of svg.matchAll(/<pattern id="[^"]+"([^>]*)>([\s\S]*?)<\/pattern>/g)) {
  const key = m[1].replace(/patternTransform="[^"]*"/, "") + m[2];
  contents.set(key, (contents.get(key) ?? 0) + 1);
}
if (contents.size) console.log(`pattern definitions with content: ${[...contents.values()].reduce((a, b) => a + b, 0)}, distinct contents: ${contents.size}`);

// Images: how many distinct, and how big?
const hrefs = [...svg.matchAll(/<image [^>]*href="([^"]+)"/g)].map((m) => m[1]);
if (hrefs.length) {
  const distinct = new Set(hrefs);
  const sizes = [...distinct].map((h) => h.length).sort((a, b) => b - a);
  console.log(`images: ${hrefs.length} embedded, ${distinct.size} distinct, largest ${sizes.slice(0, 5).map((n) => (n / 1e3).toFixed(0) + " kB").join(", ")}`);
}
const uses = (svg.match(/<use /g) ?? []).length;
if (uses) console.log(`image reuses (<use>): ${uses}`);
