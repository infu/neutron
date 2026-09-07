import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

test("Aave release initializes its new journal and restores it without resetting state", async () => {
  const files = unpackNeutronPackage(await readFile(new URL("../aave.v0.1.0.neutron", import.meta.url)));
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.id).toBe("aave"); expect(prepared.manifest.version).toBe(100);
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["web/index.html", "web/main.js", "web/main.css", "web/service.html", "web/service.js", "web/static/icon.svg", "schema.json", "neutron.lock.json"]));
  const compiled = JSON.parse(new TextDecoder().decode(files["neutron.json"]!));
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const lock = JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"));
  expect(Object.keys(compiled.memory)).toEqual(["aave"]);
  expect(compiled.memory.aave.schemas["1"]).toMatchObject(lock.memory.aave.schemas["1"]);
  const fresh = planMemoryMigrations({ kernel }, { kernel, aave: compiled });
  expect(fresh.upgrades).toEqual([{ kind: "initialize", owner: "aave", memoryId: "aave", to: 1 }]);
  expect(fresh.destructiveMemoryRoots).toEqual([]);
  const restore = planMemoryMigrations({ kernel, aave: compiled }, { kernel, aave: compiled });
  expect(restore.upgrades).toEqual([{ kind: "keep", owner: "aave", memoryId: "aave", version: 1 }]);
  expect(restore.destructiveMemoryRoots).toEqual([]);
});


test("release 101 keeps the production 100 journal, lineage and full backend closure", async () => {
  const previousBytes = await readFile(new URL("../aave.v0.1.0.neutron", import.meta.url));
  expect(createHash("sha256").update(previousBytes).digest("hex")).toBe("9c04143f8e3f212b6c39647e2f704d7a613d6375871908ab32e1ec5afba19c65");
  const previous = unpackNeutronPackage(previousBytes);
  const files = unpackNeutronPackage(await readFile(new URL("../aave.v0.1.1.neutron", import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8"));
  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({ id: "aave", version: 101, update_source: "233tv-xiaaa-aaaay-aacta-cai" });
  expect(preparePackageInstall(files).manifest).toMatchObject({ id: "aave", version: 101 });
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["web/index.html", "web/main.js", "web/main.css", "web/service.html", "web/service.js", "web/static/icon.svg"]));
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const old = JSON.parse(decode(previous["neutron.json"]!)), next = JSON.parse(decode(files["neutron.json"]!));
  expect(old.version).toBe(100);
  expect(next.memory).toEqual(old.memory);
  expect(Object.keys(next.memory)).toEqual(["aave"]);
  expect(files["neutron.lock.json"]).toEqual(previous["neutron.lock.json"]);
  expect(JSON.parse(decode(files["neutron.lock.json"]!))).toEqual(JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8")));
  // A frontend-only successor retains every backend module, including all
  // transitive dependencies of its immutable managed-memory schema.
  expect(next.entry).toBe(old.entry);
  const modules = Object.keys(previous).filter(path => path.startsWith("mo/")).sort();
  expect(Object.keys(files).filter(path => path.startsWith("mo/")).sort()).toEqual(modules);
  for (const path of modules) expect(files[path]).toEqual(previous[path]);
  const schema = JSON.parse(decode(files["schema.json"]!)), priorSchema = JSON.parse(decode(previous["schema.json"]!));
  expect(schema).toEqual(generateAppMethodSchemaArtifact(manifest, await readFile(new URL("../backend/main.mo", import.meta.url), "utf8")));
  expect(schema).toEqual({ ...priorSchema, app: { ...priorSchema.app, version: 101 } });
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const clean = planMemoryMigrations({ kernel }, { kernel, aave: next });
  expect(clean.upgrades).toEqual([{ kind: "initialize", owner: "aave", memoryId: "aave", to: 1 }]);
  expect(clean.destructiveMemoryRoots).toEqual([]);
  const upgraded = planMemoryMigrations({ kernel, aave: old }, { kernel, aave: next });
  expect(upgraded.upgrades).toEqual([{ kind: "keep", owner: "aave", memoryId: "aave", version: 1 }]);
  expect(upgraded.destructiveMemoryRoots).toEqual([]);
  expect(planMemoryMigrations({ kernel, aave: next }, { kernel, aave: next })).toEqual(upgraded);
});
