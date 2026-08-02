import { createHash, type Hash } from "node:crypto";
import type { StaticFileOperation } from "neutron-compiler/src/install.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";

const ROOT_DOMAIN = "neutron-starter-files-root-v1";
const LEAF_DOMAIN = "neutron-starter-file-leaf-v1";

/**
 * Commit to the exact ordered static-file payload stored by the Dispenser.
 *
 * Each leaf covers the path, HTTP metadata, chunk count, total stored byte
 * length, and every stored byte in chunk order. The root covers the sorted
 * list of leaves. Length prefixes make the encoding unambiguous.
 */
export function starterFileCommitment(
  operations: readonly StaticFileOperation[],
): string {
  const sorted = [...operations].sort(({ key: left }, { key: right }) =>
    compareCanonicalText(left, right),
  );
  const seen = new Set<string>();
  const root = createHash("sha256").update(ROOT_DOMAIN);
  writeNat(root, sorted.length);

  for (const operation of sorted) {
    if (seen.has(operation.key)) {
      throw new Error(`Duplicate starter file ${operation.key}`);
    }
    seen.add(operation.key);
    root.update(fileLeaf(operation));
  }
  return root.digest("hex");
}

function fileLeaf(operation: StaticFileOperation): Buffer {
  const chunks = [...operation.chunks].sort(
    ({ chunk_id: left }, { chunk_id: right }) => left - right,
  );
  if (operation.val.chunks !== chunks.length + 1) {
    throw new Error(`Starter file ${operation.key} has an invalid chunk count`);
  }
  chunks.forEach(({ chunk_id }, index) => {
    if (chunk_id !== index + 1) {
      throw new Error(`Starter file ${operation.key} has invalid chunk IDs`);
    }
  });

  const digest = createHash("sha256").update(LEAF_DOMAIN);
  writeText(digest, operation.key);
  writeText(digest, operation.val.content_type);
  writeText(digest, operation.val.content_encoding);
  writeNat(digest, operation.val.chunks);
  writeNat(
    digest,
    operation.val.content.byteLength +
      chunks.reduce((sum, { content }) => sum + content.byteLength, 0),
  );
  digest.update(operation.val.content);
  for (const { content } of chunks) digest.update(content);
  return digest.digest();
}

function writeText(digest: Hash, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  digest.update(String(bytes.byteLength)).update(":").update(bytes);
}

function writeNat(digest: Hash, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Starter commitment integer is invalid");
  }
  digest.update(String(value)).update("\0");
}
