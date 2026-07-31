import fs from "node:fs/promises";
import { withSupportedCertificateVersions } from "neutron-tools/src/wasm_metadata.js";

const wasmPath = process.argv[2];
if (!wasmPath) {
  throw new Error("Usage: bun stamp_wasm_metadata.ts <wasm-path>");
}

const wasm = new Uint8Array(await fs.readFile(wasmPath));
await fs.writeFile(wasmPath, withSupportedCertificateVersions(wasm));
