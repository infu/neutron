import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";

test("release 101 installs cleanly and keeps the immutable release-100 root", async () => {
  const releasedBytes = await readFile(new URL("../curve.v0.1.0.neutron", import.meta.url));
  expect(createHash("sha256").update(releasedBytes).digest("hex")).toBe("eff079d91d8b328e70933ae5bc4841517274b99a0c1ce41a53ae64770e3f75fd");
  const previous = unpackNeutronPackage(releasedBytes);
  const files = unpackNeutronPackage(await readFile(new URL("../curve.v0.1.1.neutron", import.meta.url)));
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.id).toBe("curve"); expect(prepared.manifest.version).toBe(101);
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["web/index.html", "web/main.js", "web/main.css", "web/service.html", "web/service.js", "web/static/icon.svg", "schema.json", "neutron.lock.json"]));
  const compiled = JSON.parse(new TextDecoder().decode(files["neutron.json"]!)), kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const lock = JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"));
  const released = JSON.parse(new TextDecoder().decode(previous["neutron.json"]!));
  expect(released.version).toBe(100);
  expect(files["neutron.lock.json"]).toEqual(previous["neutron.lock.json"]);
  expect(compiled.memory).toEqual(released.memory);
  const schemaPath = `mo/${released.memory.curve.schemas["1"].entry}.mo`;
  expect(files[schemaPath]).toBeDefined(); expect(files[schemaPath]).toEqual(previous[schemaPath]);
  expect(compiled.memory.curve.schemas["1"]).toMatchObject(lock.memory.curve.schemas["1"]);
  const initial = planMemoryMigrations({ kernel }, { kernel, curve: compiled });
  expect(initial.upgrades).toEqual([{ kind: "initialize", owner: "curve", memoryId: "curve", to: 1 }]); expect(initial.destructiveMemoryRoots).toEqual([]);
  const restored = planMemoryMigrations({ kernel, curve: released }, { kernel, curve: compiled });
  expect(restored.upgrades).toEqual([{ kind: "keep", owner: "curve", memoryId: "curve", version: 1 }]); expect(restored.destructiveMemoryRoots).toEqual([]);
});
