import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { createMemoryLock } from "neutron-tools/src/memory.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import type { NeutronManifest, PackagedNeutronManifest } from "neutron-tools/src/schema.js";

// Imported predecessor package evidence, not an independently recovered
// production deployment. Keep every historical schema and migration byte.
const history = new URL("./fixtures/history/108/", import.meta.url);
const app = new URL("../", import.meta.url);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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
  expect(sha256(manifestBytes)).toBe("aa96205d5e1304041faaf7f32dbe13f586a42e0cd0597abdd8a70b4c55d12b7b");
  expect(sha256(lockBytes)).toBe("cbf4e225c60c069912141d6ab9fd1a6626a9516c3a74c71037c576d4a37964f0");
  const manifest = JSON.parse(decode(manifestBytes)) as PackagedNeutronManifest;
  expect(manifest).toMatchObject({ id: "nuance", version: 108, memory: { nuance: { version: 2 } } });
  expect(Object.keys(manifest.memory ?? {})).toEqual(["nuance"]);
  expect(createMemoryLock(manifest)).toEqual(JSON.parse(decode(lockBytes)));
  return { manifest, lockBytes };
}

async function successor() {
  const source = JSON.parse(await readFile(new URL("neutron.json", app), "utf8")) as NeutronManifest;
  const files = unpackNeutronPackage(await readFile(new URL(packageArchiveFilename(source.id, source.version), app)));
  const manifest = JSON.parse(decode(files["neutron.json"]!)) as PackagedNeutronManifest;
  expect(source.version).toBeGreaterThan(108);
  expect(manifest.version).toBe(source.version);
  expect(manifest.id).toBe("nuance");
  return { source, files, manifest };
}

test("Nuance keeps the imported predecessor's complete schema and migration closures", async () => {
  const previous = await predecessor();
  const { files, manifest } = await successor();
  expect(manifest.memory).toEqual(previous.manifest.memory);
  expect(files["neutron.lock.json"]).toEqual(new Uint8Array(previous.lockBytes));
  expect(await readFile(new URL("neutron.lock.json", app))).toEqual(previous.lockBytes);
  expect(createMemoryLock(manifest)).toEqual(JSON.parse(decode(previous.lockBytes)));

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
    for (const schema of Object.values(memory.schemas ?? {})) await preserveClosure(schema.entry);
    for (const migration of memory.migrations ?? []) await preserveClosure(migration.entry);
  }
  expect([...visited].map((entry) => `${entry}.mo`).sort()).toEqual(moduleNames);
  expect(visited.size).toBe(3);
});

test("Nuance initializes cleanly and keeps the existing v2 root on import and later restoration", async () => {
  const { manifest: previous } = await predecessor();
  const { manifest } = await successor();
  expect(planMemoryMigrations({ kernel }, { kernel, nuance: manifest })).toEqual({
    upgrades: [{ kind: "initialize", owner: "nuance", memoryId: "nuance", to: 2 }],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  for (const installed of [previous, manifest]) {
    expect(planMemoryMigrations({ kernel, nuance: installed }, { kernel, nuance: manifest })).toEqual({
      upgrades: [{ kind: "keep", owner: "nuance", memoryId: "nuance", version: 2 }],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  }
});

test("Nuance retains the unique forward migration for installations holding the declared v1 schema", async () => {
  const { manifest: previous } = await predecessor();
  const { manifest } = await successor();
  const schema = previous.memory?.nuance?.schemas?.["1"];
  if (schema?.entry === undefined) throw new Error("Imported v1 schema is missing");
  const path = (previous.memory?.nuance?.migrations ?? []).map((migration) => {
    if (migration.entry === undefined) throw new Error("Imported migration entry is missing");
    return { ...migration, entry: migration.entry };
  });
  expect(path).toHaveLength(1);
  // This is a projection of a v1 memory installation, not a fabricated claim
  // about an older released app archive. The migration's data semantics are
  // exercised separately by migration.test.mo with representative owner data.
  const installed: PackagedNeutronManifest = {
    ...previous,
    memory: {
      nuance: { version: 1, schemas: { "1": schema }, migrations: [] },
    },
  };
  expect(planMemoryMigrations({ kernel, nuance: installed }, { kernel, nuance: manifest })).toEqual({
    upgrades: [{
      kind: "migrate",
      owner: "nuance",
      memoryId: "nuance",
      from: 1,
      to: 2,
      oldSchemaEntry: schema.entry,
      path,
    }],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});
