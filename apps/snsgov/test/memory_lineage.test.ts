import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { removeCommentsAndEmptyLines } from "neutron-scripts/src/walk.js";
import { createMemoryLock } from "neutron-tools/src/memory.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import type { NeutronManifest, PackagedNeutronManifest } from "neutron-tools/src/schema.js";

// Imported predecessor package evidence, not an independently recovered
// production deployment. Preserve the schema's complete dependency closure.
const history = new URL("./fixtures/history/110/", import.meta.url);
const app = new URL("../", import.meta.url);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};

async function predecessor() {
  const manifestBytes = await readFile(new URL("neutron.json", history));
  const lockBytes = await readFile(new URL("neutron.lock.json", history));
  expect(sha256(manifestBytes)).toBe("a21ff82f74fa2694462e54527207c56450b766299d5b255e06dbfecea388661c");
  expect(sha256(lockBytes)).toBe("6d78f73500f1724409d70f3788a7d3e05340ba9f4beccf61cdb2b1a77396546f");
  const manifest = JSON.parse(decode(manifestBytes)) as PackagedNeutronManifest;
  expect(manifest).toMatchObject({ id: "snsgov", version: 110, memory: { snsgov: { version: 1 } } });
  expect(Object.keys(manifest.memory ?? {})).toEqual(["snsgov"]);
  expect(createMemoryLock(manifest)).toEqual(JSON.parse(decode(lockBytes)));
  return { manifest, lockBytes };
}

async function successor() {
  const source = JSON.parse(await readFile(new URL("neutron.json", app), "utf8")) as NeutronManifest;
  const files = unpackNeutronPackage(await readFile(new URL(packageArchiveFilename(source.id, source.version), app)));
  const manifest = JSON.parse(decode(files["neutron.json"]!)) as PackagedNeutronManifest;
  expect(source.version).toBeGreaterThan(110);
  expect(manifest.version).toBe(source.version);
  expect(manifest.id).toBe("snsgov");
  return { files, manifest };
}

test("SNS Governance keeps the imported v1 schema, lock lineage, and complete Map dependency closure", async () => {
  const previous = await predecessor();
  const { files, manifest } = await successor();
  expect(manifest.memory?.snsgov).toEqual(previous.manifest.memory?.snsgov);
  const currentLock = createMemoryLock(manifest);
  expect(currentLock.memory.snsgov).toEqual(JSON.parse(decode(previous.lockBytes)).memory.snsgov);
  const lockBytes = await readFile(new URL("neutron.lock.json", app));
  expect(files["neutron.lock.json"]).toEqual(new Uint8Array(lockBytes));
  expect(currentLock).toEqual(JSON.parse(decode(lockBytes)));
  expect(Object.keys(manifest.memory ?? {}).sort()).toEqual(["snsgov", "snsgov_operations"]);
  expect(manifest.memory?.snsgov_operations).toMatchObject({
    version: 1,
    schemas: { "1": { src: "memory/snsgov_operations/v1.mo" } },
    migrations: [],
  });
  expect(Object.keys(manifest.memory?.snsgov_operations?.schemas ?? {})).toEqual(["1"]);

  const moduleNames = (await readdir(new URL("mo/", history))).sort();
  const visited = new Set<string>();
  async function preserveClosure(entry: string | undefined): Promise<void> {
    if (entry === undefined) throw new Error("Imported memory entry is missing");
    if (visited.has(entry)) return;
    visited.add(entry);
    const path = `mo/${entry}.mo`;
    const bytes = await readFile(new URL(path, history));
    expect(sha256(bytes)).toBe(entry);
    expect(files[path]).toEqual(new Uint8Array(bytes));
    for (const dependency of decode(bytes).matchAll(/\bimport\s+[^;]*?"([a-f0-9]{64})"\s*;/g)) {
      await preserveClosure(dependency[1]);
    }
  }
  for (const memory of Object.values(previous.manifest.memory ?? {})) {
    expect(memory.version).toBe(1);
    expect(memory.migrations).toEqual([]);
    expect(Object.keys(memory.schemas ?? {})).toEqual(["1"]);
    for (const schema of Object.values(memory.schemas ?? {})) {
      if (schema.hash === undefined) throw new Error("Imported schema hash is missing");
      const source = await readFile(new URL(`backend/${schema.src}`, app), "utf8");
      expect(sha256(removeCommentsAndEmptyLines(source))).toBe(schema.hash);
      await preserveClosure(schema.entry);
    }
  }
  expect([...visited].map((entry) => `${entry}.mo`).sort()).toEqual(moduleNames);
  expect(visited.size).toBe(15);
});

test("SNS Governance initializes its journal independently and keeps both roots on restoration", async () => {
  const { manifest: previous } = await predecessor();
  const { manifest } = await successor();
  expect(planMemoryMigrations({ kernel }, { kernel, snsgov: manifest })).toEqual({
    upgrades: [
      { kind: "initialize", owner: "snsgov", memoryId: "snsgov", to: 1 },
      { kind: "initialize", owner: "snsgov", memoryId: "snsgov_operations", to: 1 },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  expect(planMemoryMigrations({ kernel, snsgov: previous }, { kernel, snsgov: manifest })).toEqual({
    upgrades: [
      { kind: "keep", owner: "snsgov", memoryId: "snsgov", version: 1 },
      { kind: "initialize", owner: "snsgov", memoryId: "snsgov_operations", to: 1 },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  expect(planMemoryMigrations({ kernel, snsgov: manifest }, { kernel, snsgov: manifest })).toEqual({
    upgrades: [
      { kind: "keep", owner: "snsgov", memoryId: "snsgov", version: 1 },
      { kind: "keep", owner: "snsgov", memoryId: "snsgov_operations", version: 1 },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});

test("every checked-in production predecessor keeps its v1 root and initializes only the journal", async () => {
  const { manifest } = await successor();
  const { manifest: imported } = await predecessor();
  for (const version of [111, 112, 113, 114]) {
    const files = unpackNeutronPackage(await readFile(new URL(packageArchiveFilename("snsgov", version), app)));
    const previous = JSON.parse(decode(files["neutron.json"]!)) as PackagedNeutronManifest;
    expect(previous.version).toBe(version);
    expect(previous.memory).toEqual(imported.memory);
    expect(planMemoryMigrations({ kernel, snsgov: previous }, { kernel, snsgov: manifest })).toEqual({
      upgrades: [
        { kind: "keep", owner: "snsgov", memoryId: "snsgov", version: 1 },
        { kind: "initialize", owner: "snsgov", memoryId: "snsgov_operations", to: 1 },
      ],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  }
});
