// Engine on the Test Plan: rendering regions and extracting Snap targets.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as core from "./core";
import { nearest } from "../ui/snap";

const PLAN = "samples/test-plan.pdf";

describe.skipIf(!existsSync(PLAN))("engine core on the Test Plan", () => {
  it("opens, renders a viewport-sized region and extracts snap targets", async () => {
    const require = createRequire(import.meta.url);
    const wasm = readFileSync(join(dirname(require.resolve("mupdf")), "mupdf-wasm.wasm"));
    await core.init(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

    let t = performance.now();
    const info = core.openPlan(readFileSync(PLAN).buffer as ArrayBuffer);
    console.log(`open + display list: ${(performance.now() - t).toFixed(0)} ms`);
    expect(Math.round((info.heightPt * 25.4) / 72)).toBe(14271);

    t = performance.now();
    const r = core.renderRegion({ xMm: 300, yMm: 2000, widthMm: 400, heightMm: 250, pxPerMm: 6 });
    console.log(`viewport render 2400x1500 px: ${(performance.now() - t).toFixed(0)} ms`);
    expect(r.width).toBe(2400);
    expect(r.pixels.length).toBe(2400 * 1500 * 4);

    t = performance.now();
    const snap = core.snapTargets();
    console.log(
      `snap targets: ${(performance.now() - t).toFixed(0)} ms, ${snap.vertical.pos.length} vertical / ${snap.horizontal.pos.length} horizontal lines, ${snap.textVertical.pos.length + snap.textHorizontal.pos.length} text edges`,
    );
    // Table column border at x = 20 mm (Nr. | Vorgang) runs the full height in many pieces -> one line.
    const col = nearest(snap.vertical, 20.3, 1, { lo: 5000, hi: 5100 });
    expect(col?.pos).toBeCloseTo(20, 1);
    // Row borders every 5 mm from y = 60 mm.
    const row = nearest(snap.horizontal, 2001.2, 2, { lo: 0, hi: 380 }); // lines only: the row border, not the text top at 2001.75
    expect(row?.pos).toBeCloseTo(2000, 1);
  }, 120_000);
});
