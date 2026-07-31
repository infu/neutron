import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex } from "../src/artifact.ts";
import {
  persistTransactionPayload,
  sweepUnreferencedTransactionPayloads,
  transactionPayloadPath,
  type SerializedTransactionPayload,
} from "../src/payload.ts";

describe("transaction payload orphan collection", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("retires a pre-active crash orphan and preserves exactly the active payload", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "production.ndeploy.session.json");
    const orphan = payload([1, 2, 3]);
    const active = payload([4, 5, 6]);
    const orphanPath = await persistTransactionPayload(sessionPath, orphan);
    const activePath = await persistTransactionPayload(sessionPath, active);
    const abandonedTemporary = `${activePath}.tmp-999-${"a".repeat(12)}`;
    await writeFile(abandonedTemporary, new Uint8Array([9]), { mode: 0o600 });
    const retiredPayload = activePath.replace(".payload-v3", ".payload-v2");
    await writeFile(retiredPayload, active.bytes, { mode: 0o600 });

    expect(
      await sweepUnreferencedTransactionPayloads(sessionPath, active.sha256),
    ).toBe(3);
    expect([...await readFile(activePath)]).toEqual([...active.bytes]);
    expect(await exists(orphanPath)).toBe(false);
    expect(await exists(abandonedTemporary)).toBe(false);
    expect(await exists(retiredPayload)).toBe(false);
  });

  test("retires a post-completion orphan when no active payload is referenced", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "production.ndeploy.session.json");
    const orphanPath = await persistTransactionPayload(
      sessionPath,
      payload([7, 8, 9]),
    );

    expect(await sweepUnreferencedTransactionPayloads(sessionPath)).toBe(1);
    expect(await exists(orphanPath)).toBe(false);
  });

  test("refuses unsafe payload symlinks and permissions", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "production.ndeploy.session.json");
    const unsafe = payload([10, 11, 12]);
    const unsafePath = transactionPayloadPath(sessionPath, unsafe.sha256);
    const seedPath = await persistTransactionPayload(sessionPath, payload([13]));
    await rm(seedPath);
    const target = path.join(root, "target");
    await writeFile(target, unsafe.bytes, { mode: 0o600 });
    await symlink(target, unsafePath);

    await expect(
      sweepUnreferencedTransactionPayloads(sessionPath),
    ).rejects.toThrow("Refusing symlink transaction payload");

    await rm(unsafePath);
    await writeFile(unsafePath, unsafe.bytes, { mode: 0o644 });
    await expect(
      sweepUnreferencedTransactionPayloads(sessionPath),
    ).rejects.toThrow("mode 0600");

    await chmod(unsafePath, 0o600);
    await chmod(path.dirname(unsafePath), 0o755);
    await expect(
      sweepUnreferencedTransactionPayloads(sessionPath),
    ).rejects.toThrow("must be private");
  });
});

function payload(values: number[]): SerializedTransactionPayload {
  const bytes = new Uint8Array(values);
  return { version: 3, sha256: sha256Hex(bytes), bytes };
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-payload-gc-test-"));
  roots.push(root);
  return root;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await readFile(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
