// UI-side engine handle. Prefers a Web Worker (inlined as a Blob URL so it works
// from file://); falls back to running the engine on the main thread.

import wasmGzBase64 from "virtual:mupdf-wasm";
import EngineWorker from "./worker?worker&inline";
import type { PlanInfo, Preview, RequestBody, Response, SvgExportRequest, SvgExportResult } from "./protocol";

export type EngineMode = "worker" | "main-thread";

export interface Engine {
  mode: EngineMode;
  openPlan(bytes: ArrayBuffer): Promise<PlanInfo>;
  renderPreview(): Promise<Preview>;
  exportSvg(options: SvgExportRequest): Promise<SvgExportResult>;
}

async function decodeWasm(): Promise<ArrayBuffer> {
  const bin = atob(wasmGzBase64);
  const gz = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * Edge refuses module workers from blob: URLs on file:// pages, but accepts them
 * from data: URLs (verified in Edge 156). Vite's inline worker falls back to a
 * data: URL when createObjectURL yields nothing, so suppress it for this call.
 */
function createEngineWorker(): Worker {
  if (location.protocol !== "file:") return new EngineWorker();
  const original = URL.createObjectURL;
  URL.createObjectURL = () => "";
  try {
    return new EngineWorker();
  } finally {
    URL.createObjectURL = original;
  }
}

function workerEngine(wasm: ArrayBuffer, timeoutMs: number): Promise<Engine> {
  const worker = createEngineWorker();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  worker.onmessage = (ev: MessageEvent<Response>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.result);
    else p.reject(new Error(ev.data.error));
  };

  const call = <T>(req: RequestBody, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...req, id }, transfer);
    });

  return new Promise<Engine>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("worker init timed out"));
    }, timeoutMs);
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`worker error: ${e.message}`));
    };
    call({ op: "init", wasmBinary: wasm }, [wasm]).then(
      () => {
        clearTimeout(timer);
        resolve({
          mode: "worker",
          openPlan: (bytes) => call<PlanInfo>({ op: "openPlan", bytes }, [bytes]),
          renderPreview: () => call<Preview>({ op: "renderPreview" }),
          exportSvg: (options) => call<SvgExportResult>({ op: "exportSvg", options }),
        });
      },
      (e: Error) => {
        clearTimeout(timer);
        worker.terminate();
        reject(e);
      },
    );
  });
}

async function mainThreadEngine(wasm: ArrayBuffer): Promise<Engine> {
  const core = await import("./core");
  await core.init(wasm);
  return {
    mode: "main-thread",
    openPlan: async (bytes) => core.openPlan(bytes),
    renderPreview: async () => core.renderPreview(),
    exportSvg: async (options) => core.exportSvg(options),
  };
}

export async function startEngine(): Promise<Engine> {
  try {
    // The worker takes ownership of its copy of the binary (transfer).
    return await workerEngine(await decodeWasm(), 30000);
  } catch (e) {
    console.warn("Engine: worker unavailable, falling back to main thread:", e);
    return mainThreadEngine(await decodeWasm());
  }
}
