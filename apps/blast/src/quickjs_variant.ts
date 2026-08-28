import releaseVariant from "@jitl/quickjs-wasmfile-release-sync";
import wasmLocation from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { newVariant } from "quickjs-emscripten-core";

const WASM_PAGE_BYTES = 64 * 1024;

// Keep the Emscripten build's 16 MiB initial size and cap its linear memory at
// 64 MiB. QuickJS separately enforces a 32 MiB allocator limit; the remaining
// headroom covers the runtime and bounded host marshalling outside that quota.
export const BLAST_QUICKJS_WASM_INITIAL_PAGES =
  (16 * 1024 * 1024) / WASM_PAGE_BYTES;
export const BLAST_QUICKJS_WASM_MAXIMUM_PAGES =
  (64 * 1024 * 1024) / WASM_PAGE_BYTES;

export function newBlastQuickJSVariant() {
  const source: unknown = wasmLocation;
  const wasmMemory = new WebAssembly.Memory({
    initial: BLAST_QUICKJS_WASM_INITIAL_PAGES,
    maximum: BLAST_QUICKJS_WASM_MAXIMUM_PAGES,
  });
  if (typeof source === "string") {
    return newVariant(releaseVariant, { wasmLocation: source, wasmMemory });
  }
  if (source instanceof Uint8Array) {
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    return newVariant(releaseVariant, {
      wasmBinary: bytes.buffer,
      wasmMemory,
    });
  }
  throw new Error("QuickJS Wasm asset is invalid");
}
