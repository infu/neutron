import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";

test("exclusive principal reservation release restores all Kernel roots unchanged", async () => {
  const unpack = async (version: string) => {
    const files = unpackNeutronPackage(
      await readFile(new URL(`../kernel.v${version}.neutron`, import.meta.url)),
    );
    return {
      files,
      manifest: JSON.parse(new TextDecoder().decode(files["neutron.json"]!)),
    };
  };
  const [previous, next, lockText] = await Promise.all([
    unpack("0.3.60"),
    unpack("0.3.61"),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(next.manifest.version).toBe(361);
  expect(next.manifest.memory).toEqual(previous.manifest.memory);
  const lock = JSON.parse(lockText);
  for (const [id, version] of [
    ["kernel", 4],
    ["kernel_activation", 1],
    ["kernel_cycle_calls", 1],
  ] as const) {
    const schema = next.manifest.memory[id].schemas[String(version)];
    expect(schema).toMatchObject(lock.memory[id].schemas[String(version)]);
    expect(next.files[`mo/${schema.entry}.mo`]).toEqual(
      previous.files[`mo/${schema.entry}.mo`],
    );
  }
  expect(planMemoryMigrations(
    { kernel: previous.manifest },
    { kernel: next.manifest },
  )).toEqual({
    upgrades: [
      { kind: "keep", owner: "kernel", memoryId: "kernel", version: 4 },
      { kind: "keep", owner: "kernel", memoryId: "kernel_activation", version: 1 },
      { kind: "keep", owner: "kernel", memoryId: "kernel_cycle_calls", version: 1 },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});
