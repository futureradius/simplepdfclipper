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
      case "openPlan":
        result = core.openPlan(req.bytes);
        break;
      case "renderPreview": {
        const preview = core.renderPreview();
        scope.postMessage({ id: req.id, ok: true, result: preview } satisfies Response, [preview.png.buffer]);
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
