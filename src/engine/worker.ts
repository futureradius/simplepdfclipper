/// <reference lib="webworker" />
import * as core from "./core";
import type { Request, Response } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<Request>) => {
  const req = ev.data;
  try {
    let result: unknown;
    switch (req.op) {
      case "init":
        result = await core.init(req.wasmBinary);
        break;
      case "openDocument":
        result = core.openDocument(req.bytes);
        break;
      case "discardDocument":
        result = core.discardDocument();
        break;
      case "openPage":
        result = core.openPage(req.page);
        break;
      case "renderThumbnail": {
        const t = core.renderThumbnail(req.thumb);
        scope.postMessage({ id: req.id, ok: true, result: t } satisfies Response, [t.pixels.buffer]);
        return;
      }
      case "renderPreview": {
        const preview = core.renderPreview();
        scope.postMessage({ id: req.id, ok: true, result: preview } satisfies Response, [preview.pixels.buffer]);
        return;
      }
      case "renderRegion": {
        const r = core.renderRegion(req.region);
        scope.postMessage({ id: req.id, ok: true, result: r } satisfies Response, [r.pixels.buffer]);
        return;
      }
      case "snapTargets": {
        const r = core.snapTargets();
        const buffers = [r.vertical, r.horizontal, r.textVertical, r.textHorizontal].flatMap((l) => [l.pos.buffer, l.a.buffer, l.b.buffer]);
        scope.postMessage({ id: req.id, ok: true, result: r } satisfies Response, buffers);
        return;
      }
      case "exportPdf": {
        const r = core.exportPdf(req.options);
        scope.postMessage({ id: req.id, ok: true, result: r } satisfies Response, [r.pdf.buffer]);
        return;
      }
      case "tilesBegin":
        result = core.tilesBegin(req.job);
        break;
      case "tile":
      case "tilesFinish": {
        const r = req.op === "tile" ? core.tile(req.tile) : core.tilesFinish();
        scope.postMessage({ id: req.id, ok: true, result: r } satisfies Response, r.pdf ? [r.pdf.buffer] : []);
        return;
      }
      case "tilesAbort":
        result = core.tilesAbort();
        break;
      case "exportSvgTiles": {
        const r = core.exportSvgTiles(req.options);
        scope.postMessage({ id: req.id, ok: true, result: r } satisfies Response, r.tiles.flatMap((t) => (t ? [t.svg.buffer] : [])));
        return;
      }
      case "exportSvg": {
        const r = core.exportSvg(req.options);
        scope.postMessage({ id: req.id, ok: true, result: r } satisfies Response, [r.svg.buffer]);
        return;
      }
    }
    scope.postMessage({ id: req.id, ok: true, result } satisfies Response);
  } catch (e) {
    scope.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Response);
  }
};
