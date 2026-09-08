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
