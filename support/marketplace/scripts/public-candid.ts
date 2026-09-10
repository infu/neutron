// All rights reserved. See ../LICENSE.
import { readFile, writeFile } from "node:fs/promises";
import { wasmCustomSections } from "neutron-tools/src/wasm_metadata.js";

const privateName = "icp:private candid:service";
const publicName = "icp:public candid:service";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function service(wasm: Uint8Array): { privateCount: number; publicCount: number } {
  // The shared reader validates the Wasm envelope without asking the host to
  // compile the protocol's Memory64 module.
  const privateValues = wasmCustomSections(wasm, privateName);
  const publicValues = wasmCustomSections(wasm, publicName);
  const values = [...privateValues, ...publicValues];
  if (values.length !== 1) throw new Error("Marketplace Wasm must contain exactly one candid:service metadata section");
  if (values[0]!.length === 0) throw new Error("Marketplace candid:service metadata must not be empty");
  return { privateCount: privateValues.length, publicCount: publicValues.length };
}

function leb(value: number): Uint8Array {
  const result: number[] = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    result.push(value ? low | 128 : low);
  } while (value);
  return Uint8Array.from(result);
}

function readLeb(wasm: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  // service() has already validated every section/name length. Keep this local
  // reader bounded as well; its sole purpose is locating the exact section.
  for (let index = 0; index < 5; index += 1) {
    const byte = wasm[offset++];
    if (byte === undefined || (index === 4 && (byte & 0xf0) !== 0)) throw new Error("Malformed Wasm section length");
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  throw new Error("Malformed Wasm section length");
}

/** Expose only the compiled service interface; every other byte is retained. */
export function withPublicCandidService(wasm: Uint8Array): Uint8Array {
  const existing = service(wasm);
  if (existing.publicCount === 1) return wasm;
  const name = encoder.encode(publicName);
  const nameLength = leb(name.length);
  let start = 8;
  while (start < wasm.length) {
    const kind = wasm[start]!;
    const section = readLeb(wasm, start + 1);
    const end = section.next + section.value;
    if (kind === 0) {
      const oldName = readLeb(wasm, section.next);
      const payloadStart = oldName.next + oldName.value;
      if (decoder.decode(wasm.subarray(oldName.next, payloadStart)) === privateName) {
        const payload = wasm.subarray(payloadStart, end);
        const sectionLength = leb(nameLength.length + name.length + payload.length);
        const result = new Uint8Array(start + 1 + sectionLength.length + nameLength.length + name.length + payload.length + wasm.length - end);
        let offset = 0;
        for (const bytes of [wasm.subarray(0, start), Uint8Array.of(0), sectionLength, nameLength, name, payload, wasm.subarray(end)]) {
          result.set(bytes, offset);
          offset += bytes.length;
        }
        assertPublicCandidService(result);
        return result;
      }
    }
    start = end;
  }
  throw new Error("Marketplace private candid:service metadata could not be located");
}

export function assertPublicCandidService(wasm: Uint8Array): void {
  const metadata = service(wasm);
  if (metadata.publicCount !== 1 || metadata.privateCount !== 0) throw new Error("Marketplace candid:service metadata must be public for non-controller clients");
}

export async function exposeCandidService(wasmPath: string): Promise<void> {
  const wasm = await readFile(wasmPath);
  const publicWasm = withPublicCandidService(wasm);
  assertPublicCandidService(publicWasm);
  await writeFile(wasmPath, publicWasm);
}
