import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

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


test.each([
  [100, "0.1.0", "eff079d91d8b328e70933ae5bc4841517274b99a0c1ce41a53ae64770e3f75fd"],
  [101, "0.1.1", "a8bda98fe957d33b1057e42c86d7fd902571225663938d4d8f802f7186e8c8b7"],
  [102, "0.1.2", "686b2a06eb91f60e27ad22a222c9cda636aca79093245e36444ab0d8408fe1bf"],
  [103, "0.1.3", "b4a7126b920d8dfdd76c5094fa8949533d055a2e9e88bc91ed8b5a4a5c90444b"],
  [104, "0.1.4", "dc7043680d659a9444f79d24add9eab1db9098f76c243a78f7a037ce060b9341"],
  [105, "0.1.5", "d9e35c13c678c2e5d169a574a2eec3c32f0b93d19934a72afd065ad11ed9e5a2"],
] as const)("release 106 keeps production %s journal, lineage and full backend closure", async (version, release, digest) => {
  const previousBytes = await readFile(new URL(`../curve.v${release}.neutron`, import.meta.url));
  if (version === 104) expect(previousBytes.byteLength).toBe(313_720);
  if (version === 105) expect(previousBytes.byteLength).toBe(317_186);
  expect(createHash("sha256").update(previousBytes).digest("hex")).toBe(digest);
  const previous = unpackNeutronPackage(previousBytes);
  const files = unpackNeutronPackage(await readFile(new URL("../curve.v0.1.6.neutron", import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8"));
  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({ id: "curve", version: 106, update_source: "233tv-xiaaa-aaaay-aacta-cai" });
  expect(preparePackageInstall(files).manifest).toMatchObject({ id: "curve", version: 106 });
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["web/index.html", "web/main.js", "web/main.css", "web/service.html", "web/service.js", "web/static/icon.svg"]));
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const old = JSON.parse(decode(previous["neutron.json"]!)), next = JSON.parse(decode(files["neutron.json"]!));
  expect(old.version).toBe(version);
  expect(next.memory).toEqual(old.memory);
  expect(Object.keys(next.memory)).toEqual(["curve"]);
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
  expect(schema).toEqual({ ...priorSchema, app: { ...priorSchema.app, name: "via Curve", version: 106 } });
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const clean = planMemoryMigrations({ kernel }, { kernel, curve: next });
  expect(clean.upgrades).toEqual([{ kind: "initialize", owner: "curve", memoryId: "curve", to: 1 }]);
  expect(clean.destructiveMemoryRoots).toEqual([]);
  const upgraded = planMemoryMigrations({ kernel, curve: old }, { kernel, curve: next });
  expect(upgraded.upgrades).toEqual([{ kind: "keep", owner: "curve", memoryId: "curve", version: 1 }]);
  expect(upgraded.destructiveMemoryRoots).toEqual([]);
  expect(planMemoryMigrations({ kernel, curve: next }, { kernel, curve: next })).toEqual(upgraded);
});
