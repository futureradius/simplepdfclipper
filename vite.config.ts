import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * The app must run from file:// (ADR 0001, 0010), where the MuPDF WASM binary
 * cannot be fetched. This plugin:
 *  - exposes the binary as `virtual:mupdf-wasm` (gzip + base64 string), and
 *  - removes MuPDF's `new URL("mupdf-wasm.wasm", import.meta.url)` so the bundler
 *    does not also emit/inline the raw 10 MB file. We pass `wasmBinary` instead.
 */
function mupdfWasmInline(): Plugin {
  const VIRTUAL = "virtual:mupdf-wasm";
  const RESOLVED = "\0" + VIRTUAL;
  return {
    name: "mupdf-wasm-inline",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const wasmPath = join(dirname(require.resolve("mupdf")), "mupdf-wasm.wasm");
      const gz = gzipSync(readFileSync(wasmPath), { level: 9 });
      return `export default ${JSON.stringify(gz.toString("base64"))};`;
    },
    transform(code, id) {
      if (!/mupdf[\\/]dist[\\/]mupdf-wasm\.js/.test(id)) return undefined;
      const needle = 'new URL("mupdf-wasm.wasm",import.meta.url).href';
      if (!code.includes(needle)) this.error("mupdf-wasm.js changed: wasm URL pattern not found");
      return code.replace(needle, '"mupdf-wasm.wasm"');
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [mupdfWasmInline(), viteSingleFile()],
  worker: {
    format: "es",
    plugins: () => [mupdfWasmInline()],
    rolldownOptions: { output: { codeSplitting: false } },
  },
  build: {
    target: "esnext",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 20000,
    rolldownOptions: { output: { codeSplitting: false } },
  },
  optimizeDeps: { exclude: ["mupdf"] },
});
