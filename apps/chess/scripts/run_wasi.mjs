import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";

const wasmPath = process.argv[2];
if (!wasmPath) throw new Error("Expected a WASI module path");

const wasi = new WASI({ version: "preview1" });
const module = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: wasi.wasiImport,
});
wasi.start(instance);
