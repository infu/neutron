import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import msgpack5 from "msgpack5";
import { packDirectory, removeOlderPackageArchives } from "../src/pack.ts";

const msgpack = msgpack5();

async function createPackageTree(
  rootDir: string,
  creationOrder: readonly string[],
): Promise<void> {
  await fs.writeFile(
    path.join(rootDir, "neutron.json"),
    JSON.stringify({ id: "reproducible", version: 100 }),
  );
  await fs.mkdir(path.join(rootDir, "dist"));
  for (const relativePath of creationOrder) {
    const absolutePath = path.join(rootDir, "dist", relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `contents:${relativePath}`);
  }
}

test("packer bytes do not depend on directory creation order", async () => {
  const firstRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-order-a-"),
  );
  const secondRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-order-b-"),
  );
  const paths = [
    "z-last.txt",
    "nested/z-child.txt",
    "a-first.txt",
    "nested/a-child.txt",
  ] as const;

  try {
    await createPackageTree(firstRoot, paths);
    await createPackageTree(secondRoot, [...paths].reverse());

    const firstArchive = await fs.readFile(await packDirectory(firstRoot));
    const secondArchive = await fs.readFile(await packDirectory(secondRoot));

    expect(firstArchive).toEqual(secondArchive);
  } finally {
    await Promise.all([
      fs.rm(firstRoot, { recursive: true, force: true }),
      fs.rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
});

test("packer removes only older archives for the same app", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-archives-"),
  );

  try {
    await Promise.all(
      [
        "files.v1.neutron",
        "files.v0.1.0.neutron",
        "files.v0.1.2.neutron",
        "files.v0.1.3.neutron",
        "files.v0.1.4.neutron",
        "files.vold.neutron",
        "files_backup.v1.neutron",
        "other.v1.neutron",
      ].map((name) => fs.writeFile(path.join(rootDir, name), name)),
    );
    await fs.mkdir(path.join(rootDir, "files.v2.neutron"));

    expect(await removeOlderPackageArchives(rootDir, "files", 103)).toEqual([
      "files.v0.1.0.neutron",
      "files.v0.1.2.neutron",
      "files.v1.neutron",
    ]);
    expect((await fs.readdir(rootDir)).sort()).toEqual([
      "files.v0.1.3.neutron",
      "files.v0.1.4.neutron",
      "files.v2.neutron",
      "files.vold.neutron",
      "files_backup.v1.neutron",
      "other.v1.neutron",
    ]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("packer emits a deployment-target-neutral archive", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-target-"),
  );

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "target_test", version: 100 }),
    );
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(path.join(rootDir, "dist", "index.html"), "test");

    const archivePath = await packDirectory(rootDir);
    const archive = await fs.readFile(archivePath);
    const entries = msgpack.decode(archive) as Record<string, Uint8Array>;
    expect(Object.keys(entries)).toEqual(["index.html"]);
    expect(entries[".neutron-build.json"]).toBeUndefined();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("packer rejects the removed build-target marker", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-reserved-"),
  );

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "reserved_test", version: 100 }),
    );
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(
      path.join(rootDir, "dist", ".neutron-build.json"),
      "forged",
    );

    await expect(packDirectory(rootDir)).rejects.toThrow(
      "package archives are deployment-target neutral",
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
