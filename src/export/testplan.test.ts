// Integration test + size measurement on the generated Test Plan.
// Writes samples/measurements.md (git-ignored). Skipped if the Test Plan is missing.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as mupdf from "mupdf";
import { exportSvg, type ClipMm, type MergeMode } from "./index";

const PLAN = "samples/test-plan.pdf";
const have = existsSync(PLAN);

const CLIPS: Record<string, ClipMm> = {
  // A typical meeting excerpt: full width, ~120 rows.
  "full width, 600 mm tall": { x: 0, y: 2000, width: 1188.9, height: 600 },
  // Task table plus a few months, ~400 rows.
  "table + 1 year, 2000 mm tall": { x: 0, y: 5000, width: 540, height: 2000 },
};
const MODES: MergeMode[] = ["exact", "balanced", "max"];

describe.skipIf(!have)("SVG export on the Test Plan", () => {
  const doc = have ? mupdf.Document.openDocument(readFileSync(PLAN), "application/pdf") : undefined;
  const page = doc?.loadPage(0);
  const rows: string[] = [];

  for (const [name, clip] of Object.entries(CLIPS)) {
    for (const textAsPaths of [false, true]) {
      it(`${name}, ${textAsPaths ? "text as paths" : "real text"}`, () => {
        const sizes: number[] = [];
        const elems: number[] = [];
        for (const mergeMode of MODES) {
          const t0 = performance.now();
          const r = exportSvg(mupdf, page!, { clip, textAsPaths, mergeMode });
          const ms = performance.now() - t0;
          const bytes = Buffer.byteLength(r.svg, "utf8");
          sizes.push(bytes);
          elems.push(r.elements);
          rows.push(
            `| ${name} | ${textAsPaths ? "paths" : "text"} | ${mergeMode} | ${r.sourceItems} | ${r.elements} | ${(bytes / 1e6).toFixed(2)} MB | ${(ms / 1000).toFixed(1)} s |`,
          );
          expect(r.svg.startsWith("<svg")).toBe(true);
          expect(r.svg.endsWith("</svg>")).toBe(true);
          expect(r.unsupported).toEqual({});
          mkdirSync("samples/out", { recursive: true });
          writeFileSync(`samples/out/${name.replace(/[^a-z0-9]+/gi, "-")}-${textAsPaths ? "paths" : "text"}-${mergeMode}.svg`, r.svg);
        }
        // More merging never makes the result bigger.
        expect(elems[1]).toBeLessThanOrEqual(elems[0]!);
        expect(elems[2]).toBeLessThanOrEqual(elems[1]!);
      }, 120_000);
    }
  }

  it("stores repeated hatch tiles and images once (full page)", () => {
    const r = exportSvg(mupdf, page!, {
      clip: { x: 0, y: 0, width: 1188.9, height: 14270.9 },
      textAsPaths: false,
      mergeMode: "balanced",
    });
    const withContent = r.svg.match(/<pattern id="[^"]+" patternUnits=/g) ?? [];
    const references = r.svg.match(/<pattern id="[^"]+" xlink:href=/g) ?? [];
    const images = r.svg.match(/<image /g) ?? [];
    const uses = r.svg.match(/<use xlink:href="#i\d+"/g) ?? [];
    console.log(`patterns with content ${withContent.length}, references ${references.length}, images ${images.length}, uses ${uses.length}`);
    expect(withContent.length).toBe(1); // 29 zones, each with its own PDF pattern, same tile
    expect(references.length).toBeGreaterThan(20);
    expect(images.length).toBe(1); // the logo, placed 5 times
    expect(uses.length).toBe(5);
  }, 120_000);

  it("writes the measurement table", () => {
    const md = [
      "| Clip | Text | Merge mode | PDF items in Clip | SVG elements | SVG size | Time |",
      "|---|---|---|---|---|---|---|",
      ...rows,
    ].join("\n");
    writeFileSync("samples/measurements.md", md + "\n");
    console.log(md);
  });
});
