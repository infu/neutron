// Proprietary marketplace protocol. All rights reserved.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface Asset { path: string; sha256: string; size: number }
interface Manifest { files: Asset[] }
interface StorageInputs {
  format: "marketplace-private-storage-inputs-v1";
  ashrootRevision: string;
  schemaSha256: string;
  generatedManifestSha256: string;
  runtimeManifestSha256: string;
  runtimePatchSha256: string;
  publishers: { schemaSha256: string; generatedManifestSha256: string };
}
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

async function verifiedFile(file: string, expected: string): Promise<Uint8Array> {
  const bytes = await readFile(file);
  if (digest(bytes) !== expected) throw new Error(`Prepared storage input changed: ${file}`);
  return bytes;
}

async function verifyManifest(directory: string, name: string, expected: string): Promise<void> {
  const encoded = await verifiedFile(path.join(directory, name), expected);
  const manifest = JSON.parse(new TextDecoder().decode(encoded)) as Manifest;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Invalid prepared storage manifest: ${name}`);
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) ||
        entry.path.split(/[\\/]/u).some((segment) => segment === "..") || seen.has(entry.path)) {
      throw new Error(`Invalid prepared storage manifest file: ${name}`);
    }
    seen.add(entry.path);
    const bytes = await verifiedFile(path.join(directory, entry.path), entry.sha256);
    if (bytes.byteLength !== entry.size) throw new Error(`Prepared storage input size changed: ${entry.path}`);
  }
}

/** Verify already-prepared private inputs; ordinary builds never regenerate or fetch them. */
export async function ensureStorageInputs(projectRoot: string): Promise<Record<string, string>> {
  const root = path.resolve(projectRoot);
  const receiptPath = path.join(root, ".private/storage-inputs.json");
  let receipt: StorageInputs;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8")) as StorageInputs;
  } catch (cause) {
    throw new Error("Marketplace private storage inputs are not prepared; restore the reviewed private build inputs before building.", { cause });
  }
  if (receipt.format !== "marketplace-private-storage-inputs-v1" || !/^[0-9a-f]{40}$/u.test(receipt.ashrootRevision)) {
    throw new Error("Invalid marketplace private storage-input receipt");
  }
  if (!receipt.publishers || !/^[0-9a-f]{64}$/u.test(receipt.publishers.schemaSha256) ||
      !/^[0-9a-f]{64}$/u.test(receipt.publishers.generatedManifestSha256)) {
    throw new Error("Marketplace publisher storage inputs are not prepared");
  }
  await verifiedFile(path.join(root, "ashroot.json"), receipt.schemaSha256);
  await verifiedFile(path.join(root, ".private/publishers/ashroot.json"), receipt.publishers.schemaSha256);
  await verifiedFile(path.join(root, ".private/ashroot-no-expiry.patch"), receipt.runtimePatchSha256);
  const runtime = path.join(root, ".private/ashroot");
  await Promise.all([
    verifyManifest(path.join(root, ".ashroot"), "manifest.json", receipt.generatedManifestSha256),
    verifyManifest(runtime, ".ashroot-runtime.json", receipt.runtimeManifestSha256),
    verifyManifest(path.join(root, ".private/publishers/.ashroot"), "manifest.json", receipt.publishers.generatedManifestSha256),
  ]);
  return { ashroot: runtime };
}
