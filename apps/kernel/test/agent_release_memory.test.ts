import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";

test("Kernel 0.3.36 restores both released memory roots without migration", async () => {
  const [oldBytes, newBytes, lockText] = await Promise.all([
    readFile(new URL("../kernel.v0.3.33.neutron", import.meta.url)),
    readFile(new URL("../kernel.v0.3.36.neutron", import.meta.url)),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(oldBytes.length).toBe(2_468_220);
  expect(createHash("sha256").update(oldBytes).digest("hex")).toBe("390b1db9af417226487e11d3798a51e5ef38b080ee32cf7575ff80dd3bf7cbb5");
  const unpack = (bytes: Uint8Array) => {
    const files = unpackNeutronPackage(bytes);
    return { files, manifest: JSON.parse(new TextDecoder().decode(files["neutron.json"]!)) };
  };
  const old = unpack(oldBytes);
  const next = unpack(newBytes);
  expect(next.manifest.version).toBe(336);
  expect(next.manifest.memory).toEqual(old.manifest.memory);
  const lock = JSON.parse(lockText);
  for (const [id, version] of [["kernel", 3], ["kernel_activation", 1]] as const) {
    const schema = next.manifest.memory[id].schemas[String(version)];
    expect(schema).toMatchObject(lock.memory[id].schemas[String(version)]);
    expect(next.files[`mo/${schema.entry}.mo`]).toEqual(old.files[`mo/${schema.entry}.mo`]);
  }
  expect(planMemoryMigrations({ kernel: old.manifest }, { kernel: next.manifest })).toEqual({
    upgrades: [
      { kind: "keep", owner: "kernel", memoryId: "kernel", version: 3 },
      { kind: "keep", owner: "kernel", memoryId: "kernel_activation", version: 1 },
    ],
    removedApps: [], destructiveMemoryRoots: [],
  });
});
