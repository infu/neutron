// All rights reserved. See ../LICENSE.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStorageInputs } from "../scripts/storage-inputs.ts";

const roots: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "marketplace-storage-inputs-"));
  roots.push(root);
  await mkdir(path.join(root, ".private/ashroot"), { recursive: true });
  await mkdir(path.join(root, ".ashroot"));
  const schema = "private reviewed input";
  const generated = "generated content";
  const runtime = "runtime content";
  const patch = "reviewed compatibility patch";
  const manifest = (name: string, content: string) => JSON.stringify({ files: [{ path: name, sha256: hash(content), size: Buffer.byteLength(content) }] });
  const generatedManifest = manifest("lib.mo", generated);
  const runtimeManifest = manifest("stable_blob.mo", runtime);
  const files = {
    "ashroot.json": schema,
    ".ashroot/lib.mo": generated,
    ".ashroot/manifest.json": generatedManifest,
    ".private/ashroot/stable_blob.mo": runtime,
    ".private/ashroot/.ashroot-runtime.json": runtimeManifest,
    ".private/ashroot-no-expiry.patch": patch,
    ".private/storage-inputs.json": JSON.stringify({
      format: "marketplace-private-storage-inputs-v1", ashrootRevision: "1".repeat(40),
      schemaSha256: hash(schema), generatedManifestSha256: hash(generatedManifest),
      runtimeManifestSha256: hash(runtimeManifest), runtimePatchSha256: hash(patch),
    }),
  };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(root, name), content)));
  return { root, files };
}

test("prepared inputs verify repeatedly without rewriting source or receipts", async () => {
  const { root, files } = await fixture();
  const before = await Promise.all(Object.keys(files).map(async name => [name, await stat(path.join(root, name))] as const));
  await Promise.all([ensureStorageInputs(root), ensureStorageInputs(root)]);
  expect(await ensureStorageInputs(root)).toEqual({ ashroot: path.join(root, ".private/ashroot") });
  for (const [name, metadata] of before) {
    expect(await readFile(path.join(root, name), "utf8")).toBe(files[name as keyof typeof files]);
    expect((await stat(path.join(root, name))).mtimeMs).toBe(metadata.mtimeMs);
  }
});

for (const name of ["ashroot.json", ".ashroot/lib.mo", ".private/ashroot/stable_blob.mo", ".private/ashroot-no-expiry.patch"]) {
  test(`changed reviewed input is rejected: ${name}`, async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, name), "changed");
    await expect(ensureStorageInputs(root)).rejects.toThrow("Prepared storage input changed");
  });
}

test("missing private inputs fail before compiler execution", async () => {
  const { root } = await fixture();
  await rm(path.join(root, ".private/storage-inputs.json"));
  await expect(ensureStorageInputs(root)).rejects.toThrow("restore the reviewed private build inputs");
});
