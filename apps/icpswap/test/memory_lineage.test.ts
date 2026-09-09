import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { removeCommentsAndEmptyLines } from "neutron-scripts/src/walk.ts";
import type { NeutronManifest, PackagedNeutronManifest } from "neutron-tools/src/schema.ts";

// Exact publicly deployed release-200 assets, recovered from the owner's
// Neutron. These are historical schema evidence, not a rebuilt release archive.
const history = new URL("./fixtures/history/200/", import.meta.url);
const app = new URL("../", import.meta.url);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const roots = ["icpswap", "icpswap_swap"] as const;
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 348,
  entry: "f".repeat(64),
};

async function predecessor(): Promise<PackagedNeutronManifest> {
  const bytes = await readFile(new URL("neutron.json", history));
  expect(sha256(bytes)).toBe("7aca910ff4c91bfd18bf8daa0c3bb49d45241e1e06da693e9eb071f5de2002a8");
  const lock = await readFile(new URL("neutron.lock.json", history));
  expect(sha256(lock)).toBe("a76ddf96d7b55026b7af872f5af102867fb0a9a6b4fa856d7de44a9dfbe37efc");
  return JSON.parse(decode(bytes)) as PackagedNeutronManifest;
}

async function successor() {
  const source = JSON.parse(await readFile(new URL("neutron.json", app), "utf8")) as NeutronManifest;
  const version = source.version;
  const semver = `${Math.floor(version / 10_000)}.${Math.floor((version % 10_000) / 100)}.${version % 100}`;
  const files = unpackNeutronPackage(await readFile(new URL(`icpswap.v${semver}.neutron`, app)));
  return {
    source,
    files,
    manifest: JSON.parse(decode(files["neutron.json"]!)) as PackagedNeutronManifest,
  };
}

test.each([
  ["0.2.1", "ccd9e6d4144785049c333c850da55797ad466e3ab471db54b0e264751909ea97"],
  ["0.2.2", "ceba67dcdddf64debb1f205857a27ec714c389078f4dab4377c11777fb296213"],
  ["0.2.3", "1513aff1bab366becc4e179a3e4e618fce9f445933f2c8426a25e79dd126f90e"],
])("the update preserves all three release-%s roots and their complete schema dependencies", async (release, digest) => {
  const bytes = await readFile(new URL(`icpswap.v${release}.neutron`, app));
  expect(sha256(bytes)).toBe(digest);
  const previousFiles = unpackNeutronPackage(bytes);
  const previous = JSON.parse(decode(previousFiles["neutron.json"]!)) as PackagedNeutronManifest;
  const { files, manifest } = await successor();
  expect(manifest.version).toBeGreaterThan(previous.version);
  expect(manifest.memory).toEqual(previous.memory);
  expect(manifest.func).toEqual(previous.func);
  expect(files["neutron.lock.json"]).toEqual(previousFiles["neutron.lock.json"]);
  // Runtime code may change; every immutable schema and its transitive imports
  // must remain byte-identical to the published root's dependency closure.
  const pending = Object.values(previous.memory!).flatMap(memory => Object.values(memory.schemas!).map(schema => schema.entry!));
  const checked = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (checked.has(hash)) continue;
    checked.add(hash);
    const path = `mo/${hash}.mo`, module = previousFiles[path]!;
    expect(module).toBeDefined();
    expect(files[path]).toEqual(module);
    for (const dependency of decode(module).matchAll(/import\s+\w+\s+"([a-f0-9]{64})"/g)) pending.push(dependency[1]!);
  }
  expect(checked.size).toBeGreaterThan(3);
  const upgrade = planMemoryMigrations({ kernel, icpswap: previous }, { kernel, icpswap: manifest });
  expect(upgrade.destructiveMemoryRoots).toEqual([]);
  expect(upgrade.upgrades).toHaveLength(3);
  for (const memoryId of ["icpswap", "icpswap_swap", "icpswap_actions"]) {
    expect(upgrade.upgrades).toContainEqual({ kind: "keep", owner: "icpswap", memoryId, version: 1 });
  }
});

test("the imported app retains both deployed v1 source identities and immutable lock records", async () => {
  const previous = await predecessor();
  expect(previous).toMatchObject({ id: "icpswap", version: 200 });
  expect(Object.keys(previous.memory ?? {})).toEqual([...roots]);
  const oldLock = JSON.parse(await readFile(new URL("neutron.lock.json", history), "utf8"));
  const currentLock = JSON.parse(await readFile(new URL("neutron.lock.json", app), "utf8"));
  for (const id of roots) {
    const released = previous.memory![id]!;
    expect(released.version).toBe(1);
    expect(released.migrations).toEqual([]);
    const schema = released.schemas!["1"]!;
    if (schema.hash === undefined) throw new Error(`Released ${id}@1 has no schema hash`);
    const source = await readFile(new URL(`backend/${schema.src}`, app), "utf8");
    expect(sha256(removeCommentsAndEmptyLines(source))).toBe(schema.hash);
    expect(currentLock.memory[id]).toEqual(oldLock.memory[id]);
  }
});

test("the successor packages the exact production schema closures and preserves existing roots", async () => {
  const previous = await predecessor();
  const { source, files, manifest } = await successor();
  expect(source.version).toBeGreaterThan(200);
  expect(manifest.version).toBe(source.version);
  for (const [name, released] of Object.entries(previous.func ?? {})) {
    expect(manifest.func?.[name], `released backend method ${name} must remain available`).toEqual(released);
  }
  for (const id of roots) expect(manifest.memory![id]).toEqual(previous.memory![id]);
  const moduleNames = (await readdir(new URL("mo/", history))).sort();
  expect(moduleNames).toHaveLength(16);
  for (const name of moduleNames) {
    const bytes = await readFile(new URL(`mo/${name}`, history));
    expect(sha256(bytes)).toBe(name.slice(0, -3));
    expect(files[`mo/${name}`]).toEqual(new Uint8Array(bytes));
    // Every content-addressed import remains present in the released closure.
    const imports = decode(bytes).matchAll(/import\s+\w+\s+"([a-f0-9]{64})"/g);
    for (const dependency of imports) expect(moduleNames).toContain(`${dependency[1]}.mo`);
  }
  const packagedLock = JSON.parse(decode(files["neutron.lock.json"]!));
  expect(packagedLock).toEqual(JSON.parse(await readFile(new URL("neutron.lock.json", app), "utf8")));
  const upgrade = planMemoryMigrations({ kernel, icpswap: previous }, { kernel, icpswap: manifest });
  expect(upgrade.destructiveMemoryRoots).toEqual([]);
  for (const id of roots) {
    expect(upgrade.upgrades).toContainEqual({ kind: "keep", owner: "icpswap", memoryId: id, version: 1 });
  }
  // Newly introduced roots initialize independently; no existing journal is
  // reset, retired, consumed or sent through an invented migration.
  for (const step of upgrade.upgrades) {
    if (!roots.includes(step.memoryId as (typeof roots)[number])) expect(step.kind).toBe("initialize");
  }
  const clean = planMemoryMigrations({ kernel }, { kernel, icpswap: manifest });
  expect(clean.destructiveMemoryRoots).toEqual([]);
  for (const [id, memory] of Object.entries(manifest.memory ?? {})) {
    if (memory.version === undefined) throw new Error(`Missing current version for ${id}`);
    expect(clean.upgrades).toContainEqual({ kind: "initialize", owner: "icpswap", memoryId: id, to: memory.version });
  }
  const restored = planMemoryMigrations({ kernel, icpswap: manifest }, { kernel, icpswap: manifest });
  expect(restored.destructiveMemoryRoots).toEqual([]);
  for (const step of restored.upgrades) expect(step.kind).toBe("keep");
});
