declare module "virtual:mupdf-wasm" {
  /** MuPDF WASM binary, gzip-compressed, base64-encoded. */
  const wasmGzBase64: string;
  export default wasmGzBase64;
}

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
