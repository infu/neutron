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
// production deployment. Preserve every identity schema and lock byte.
const history = new URL("./fixtures/history/105/", import.meta.url);
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
  expect(sha256(manifestBytes)).toBe("a23dbfb32e0a3e4b3fe9d1e0f17b8f67fd14f5cf34a1071cb0b30a2c613e6220");
  expect(sha256(lockBytes)).toBe("02ec057e9f91dafd8cf37ecba7e5318dad40da7378fd0a96f8511d3333a71820");
  const manifest = JSON.parse(decode(manifestBytes)) as PackagedNeutronManifest;
  expect(manifest).toMatchObject({ id: "taggr", version: 105, memory: { identity: { version: 1 } } });
  expect(Object.keys(manifest.memory ?? {})).toEqual(["identity"]);
  expect(createMemoryLock(manifest)).toEqual(JSON.parse(decode(lockBytes)));
  return { manifest, lockBytes };
}

async function successor() {
  const source = JSON.parse(await readFile(new URL("neutron.json", app), "utf8")) as NeutronManifest;
  const files = unpackNeutronPackage(await readFile(new URL(packageArchiveFilename(source.id, source.version), app)));
  const manifest = JSON.parse(decode(files["neutron.json"]!)) as PackagedNeutronManifest;
  expect(source.version).toBeGreaterThan(105);
  expect(manifest.version).toBe(source.version);
  expect(manifest.id).toBe("taggr");
  return { files, manifest };
}

test("Taggr keeps the imported identity v1 schema, complete closure, and lock", async () => {
  const previous = await predecessor();
  const { files, manifest } = await successor();
  expect(manifest.memory).toEqual(previous.manifest.memory);
  expect(files["neutron.lock.json"]).toEqual(new Uint8Array(previous.lockBytes));
  expect(await readFile(new URL("neutron.lock.json", app))).toEqual(previous.lockBytes);
  expect(createMemoryLock(manifest)).toEqual(JSON.parse(decode(previous.lockBytes)));

  const memory = previous.manifest.memory?.identity;
  expect(memory?.version).toBe(1);
  expect(memory?.migrations).toEqual([]);
  expect(Object.keys(memory?.schemas ?? {})).toEqual(["1"]);
  const schema = memory?.schemas?.["1"];
  if (schema?.hash === undefined || schema.entry === undefined) throw new Error("Imported identity schema is missing");
  const source = await readFile(new URL(`backend/${schema.src}`, app), "utf8");
  expect(sha256(removeCommentsAndEmptyLines(source))).toBe(schema.hash);
  const path = `mo/${schema.entry}.mo`;
  const bytes = await readFile(new URL(path, history));
  expect(sha256(bytes)).toBe(schema.entry);
  expect(files[path]).toEqual(new Uint8Array(bytes));
  expect(decode(bytes)).not.toMatch(/\bimport\s/);
  expect(await readdir(new URL("mo/", history))).toEqual([`${schema.entry}.mo`]);
});

test("Taggr initializes cleanly and preserves the identity root on import and restoration", async () => {
  const { manifest: previous } = await predecessor();
  const { manifest } = await successor();
  expect(planMemoryMigrations({ kernel }, { kernel, taggr: manifest })).toEqual({
    upgrades: [{ kind: "initialize", owner: "taggr", memoryId: "identity", to: 1 }],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  for (const installed of [previous, manifest]) {
    expect(planMemoryMigrations({ kernel, taggr: installed }, { kernel, taggr: manifest })).toEqual({
      upgrades: [{ kind: "keep", owner: "taggr", memoryId: "identity", version: 1 }],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  }
});
