import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  assertNoPrivacySentinelBytes,
  MAIL_PRIVACY_SENTINEL,
  privacySentinelNeedles,
  scanPrivacySnapshotDirectory,
} from "../e2e/privacy_sentinel.ts";

test("privacy sentinel scanner rejects raw and reversible persisted encodings", () => {
  expect(privacySentinelNeedles()).toHaveLength(6);
  expect(() => assertNoPrivacySentinelBytes(
    Buffer.from(`prefix:${MAIL_PRIVACY_SENTINEL}:suffix`),
    "raw fixture",
  )).toThrow(/raw fixture \(utf8\)/u);
  expect(() => assertNoPrivacySentinelBytes(
    Buffer.from(Buffer.from(MAIL_PRIVACY_SENTINEL).toString("base64")),
    "base64 fixture",
  )).toThrow(/base64 fixture \(base64\)/u);
  expect(() => assertNoPrivacySentinelBytes(
    Buffer.from(MAIL_PRIVACY_SENTINEL, "utf16le"),
    "utf16 fixture",
  )).toThrow(/utf16 fixture \(utf16le\)/u);
  expect(() => assertNoPrivacySentinelBytes(
    Buffer.from("unrelated encrypted bytes"),
    "clean fixture",
  )).not.toThrow();
});

test("snapshot proof scans every raw file, decoded Wasm, and stream boundaries", async () => {
  const clean = await snapshotDirectory("clean");
  try {
    await writeFile(resolve(clean, "metadata.json"), JSON.stringify({ snapshot: "fixture" }));
    await writeFile(resolve(clean, "stable_memory.bin"), new Uint8Array());
    await writeFile(resolve(clean, "wasm_memory.bin"), Buffer.alloc(70_000, 0xa5));
    await writeFile(resolve(clean, "wasm_module.bin"), gzipSync(Buffer.from("module-without-private-content")));
    await mkdir(resolve(clean, "wasm_chunk_store"));
    await writeFile(resolve(clean, "wasm_chunk_store", "chunk.bin"), Buffer.from("ciphertext-only"));
    await expect(scanPrivacySnapshotDirectory(clean)).resolves.toMatchObject({
      files: 5,
      wasmMemoryBytes: 70_000,
      stableMemoryBytes: 0,
    });
  } finally {
    await rm(clean, { recursive: true, force: true });
  }

  const leaking = await snapshotDirectory("leaking");
  try {
    await writeFile(resolve(leaking, "metadata.json"), "{}");
    await writeFile(resolve(leaking, "stable_memory.bin"), Buffer.from(MAIL_PRIVACY_SENTINEL));
    await writeFile(resolve(leaking, "wasm_memory.bin"), Buffer.alloc(70_000, 0xa5));
    await writeFile(resolve(leaking, "wasm_module.bin"), gzipSync(Buffer.from("module")));
    await expect(scanPrivacySnapshotDirectory(leaking)).rejects.toThrow(
      /stable_memory\.bin raw \(utf8\)/u,
    );

    await writeFile(resolve(leaking, "stable_memory.bin"), new Uint8Array());
    // Node's file stream splits at 64 KiB. Straddling that boundary proves the
    // full-snapshot scan does not miss a marker split between chunks.
    await writeFile(resolve(leaking, "wasm_memory.bin"), Buffer.concat([
      Buffer.alloc(65_520, 0xa5),
      Buffer.from(MAIL_PRIVACY_SENTINEL),
      Buffer.alloc(128, 0x5a),
    ]));
    await expect(scanPrivacySnapshotDirectory(leaking)).rejects.toThrow(
      /wasm_memory\.bin raw \(utf8\)/u,
    );
  } finally {
    await rm(leaking, { recursive: true, force: true });
  }
});

async function snapshotDirectory(label: string): Promise<string> {
  return mkdtemp(resolve(tmpdir(), `mail-privacy-${label}-`));
}
