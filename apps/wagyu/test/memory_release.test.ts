import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { createMemoryLock } from "neutron-tools/src/memory.js";
import type {
  NeutronManifest,
  NeutronMemoryConfig,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";

const decoder = new TextDecoder();
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};

test("Wagyu 0.3.3 keeps the exact production v3 memory root", async () => {
  const [productionBytes, sourceText, lockText] = await Promise.all([
    readFile(new URL("../wagyu.v0.3.2.neutron", import.meta.url)),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(productionBytes.byteLength).toBe(1_155_566);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    "f75975ea9bcaa9165ae812f84a6914d260bf3fcb8965659da0ec22ecbdd58423",
  );

  const production = packageManifest(productionBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  const lock = JSON.parse(lockText) as ReturnType<typeof createMemoryLock>;
  expect(production).toMatchObject({ id: "wagyu", version: 302 });
  expect(source).toMatchObject({ id: "wagyu", version: 303 });

  const productionMemory = requiredMemory(production);
  const sourceMemory = requiredMemory(source);
  expect(sourceShape(productionMemory)).toEqual(sourceMemory);
  expect(createMemoryLock(production)).toEqual(lock);
  expect(sourceMemory.version).toBe(3);

  const candidate: PackagedNeutronManifest = {
    ...production,
    ...source,
    entry: production.entry,
    memory: { wagyu: productionMemory },
  };
  expect(planMemoryMigrations({ kernel }, { kernel, wagyu: candidate }))
    .toEqual({
      upgrades: [
        { kind: "initialize", owner: "wagyu", memoryId: "wagyu", to: 3 },
      ],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  expect(
    planMemoryMigrations(
      { kernel, wagyu: production },
      { kernel, wagyu: candidate },
    ),
  ).toEqual({
    upgrades: [
      { kind: "keep", owner: "wagyu", memoryId: "wagyu", version: 3 },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});

function packageManifest(bytes: Uint8Array): PackagedNeutronManifest {
  const manifest = unpackNeutronPackage(bytes)["neutron.json"];
  if (manifest === undefined) throw new Error("Missing packaged manifest");
  return JSON.parse(decoder.decode(manifest)) as PackagedNeutronManifest;
}

function requiredMemory(manifest: NeutronManifest): NeutronMemoryConfig {
  const memory = manifest.memory?.wagyu;
  if (memory === undefined) throw new Error("Missing Wagyu memory root");
  return memory;
}

function sourceShape(memory: NeutronMemoryConfig): NeutronMemoryConfig {
  return {
    ...memory,
    schemas: Object.fromEntries(
      Object.entries(memory.schemas ?? {}).map(
        ([version, { entry: _entry, hash: _hash, ...schema }]) => [
          version,
          schema,
        ],
      ),
    ),
    migrations: (memory.migrations ?? []).map(
      ({ entry: _entry, ...migration }) => migration,
    ),
  };
}
