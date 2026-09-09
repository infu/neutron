import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { assertNeutronAppSourceBuildInputs, decodeNeutronAppSourceSnapshot } from "neutron-compiler/src/source_snapshot.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sourceManifest = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8"));
const archive = new URL("../hyperliquid.v0.1.4.neutron", import.meta.url);
const predecessors = [
  ["0.1.0", "90e9c8c8a9cfd125bbf0db4bf04c8697416fd5244bd2aaf399d35232611898f1"],
  ["0.1.1", "2663e454e603cdad6e299c8821f41adefaa8a61bc3483004c9def61034ea4d23"],
  ["0.1.2", "5dcb640a37bbeb66b4e5d87fd5d38bf121c6339b0fec619e8f892fb41b84db24"],
  ["0.1.3", "4e82195fe8fe14e1328108963c0e2c71de45b1dfab0f1bef603e1d736c1069aa"],
] as const;

test("release installs its complete UI, resident service and private journal", async () => {
  expect(validate_neutron_conf(sourceManifest).errors).toEqual([]);
  expect(sourceManifest).toMatchObject({ id: "hyperliquid", version: 104, update_source: "233tv-xiaaa-aaaay-aacta-cai" });
  const files = unpackNeutronPackage(await readFile(archive));
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest).toMatchObject({ id: "hyperliquid", version: 104 });
  expect(Object.keys(files)).toEqual(expect.arrayContaining([
    "web/index.html", "web/main.js", "web/main.css", "web/service.html", "web/service.js",
    "web/static/icon.svg", "schema.json", "neutron.lock.json",
  ]));
  const compiled = JSON.parse(decode(files["neutron.json"]!));
  expect(compiled.capabilities.persistent_browser_storage).toEqual({ api: 1, surface: "background" });
  expect(compiled.background.path).toBe("service.html");
  expect(Object.keys(compiled.memory)).toEqual(["hyperliquid"]);
  const lock = JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"));
  expect(JSON.parse(decode(files["neutron.lock.json"]!))).toEqual(lock);
  expect(compiled.memory.hyperliquid.schemas["1"]).toMatchObject(lock.memory.hyperliquid.schemas["1"]);
  expect(files[`mo/${compiled.entry}.mo`]).toBeDefined();
  expect(files[`mo/${compiled.memory.hyperliquid.schemas["1"].entry}.mo`]).toBeDefined();
  const schema = JSON.parse(decode(files["schema.json"]!));
  expect(schema).toEqual(generateAppMethodSchemaArtifact(sourceManifest, await readFile(new URL("../backend/main.mo", import.meta.url), "utf8")));
});

test("new installation initializes one root and a retained installation keeps it", async () => {
  const files = unpackNeutronPackage(await readFile(archive));
  const compiled = JSON.parse(decode(files["neutron.json"]!));
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const fresh = planMemoryMigrations({ kernel }, { kernel, hyperliquid: compiled });
  expect(fresh.upgrades).toEqual([{ kind: "initialize", owner: "hyperliquid", memoryId: "hyperliquid", to: 1 }]);
  expect(fresh.destructiveMemoryRoots).toEqual([]);
  const restore = planMemoryMigrations({ kernel, hyperliquid: compiled }, { kernel, hyperliquid: compiled });
  expect(restore.upgrades).toEqual([{ kind: "keep", owner: "hyperliquid", memoryId: "hyperliquid", version: 1 }]);
  expect(restore.destructiveMemoryRoots).toEqual([]);
});

test.each(predecessors)("release %s retains the full backend and memory lineage", async (version, digest) => {
  const files = unpackNeutronPackage(await readFile(archive));
  const compiled = JSON.parse(decode(files["neutron.json"]!));
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const releasedBytes = await readFile(new URL(`../hyperliquid.v${version}.neutron`, import.meta.url));
  expect(hash(releasedBytes)).toBe(digest);
  const releasedFiles = unpackNeutronPackage(releasedBytes);
  const released = JSON.parse(decode(releasedFiles["neutron.json"]!));
  const upgrade = planMemoryMigrations({ kernel, hyperliquid: released }, { kernel, hyperliquid: compiled });
  expect(upgrade.upgrades).toEqual([{ kind: "keep", owner: "hyperliquid", memoryId: "hyperliquid", version: 1 }]);
  expect(upgrade.destructiveMemoryRoots).toEqual([]);
  expect(files["neutron.lock.json"]).toEqual(releasedFiles["neutron.lock.json"]!);
  const schemaPath = `mo/${released.memory.hyperliquid.schemas["1"].entry}.mo`;
  expect(files[schemaPath]).toEqual(releasedFiles[schemaPath]!);
  const backendPaths = Object.keys(releasedFiles).filter(path => path.startsWith("mo/"));
  expect(Object.keys(files).filter(path => path.startsWith("mo/")).sort()).toEqual(backendPaths.sort());
  for (const path of backendPaths) expect(files[path]).toEqual(releasedFiles[path]!);
  const schema = JSON.parse(decode(files["schema.json"]!));
  const priorSchema = JSON.parse(decode(releasedFiles["schema.json"]!));
  expect(schema).toEqual({ ...priorSchema, app: { ...priorSchema.app, name: "via Hyperliquid", version: 104 } });
});

test("release contains the shared use license and the exact offered source artifact", async () => {
  const files = unpackNeutronPackage(await readFile(archive));
  const prepared = preparePackageInstall(files);
  const record = prepared.packageRecord;
  expect(record?.license.id).toBe("LicenseRef-Neutron-Sovereign-Application-Use-License-1.0");
  expect(files["legal/LICENSE.APP.USE.txt"]).toEqual(new Uint8Array(await readFile(new URL("../../../LICENSE.APP.USE", import.meta.url))));
  expect(files["legal/APPLICATION-NOTICE.txt"]).toEqual(new Uint8Array(await readFile(new URL("../NOTICE", import.meta.url))));
  expect(files["legal/THIRD_PARTY_NOTICES.md"]).toBeDefined();
  if (!record || record.source.kind !== "https") throw new Error("A production release must have its HTTPS source offer.");
  const source = record.source;
  const filename = `${source.sha256}.source.v1.msgpack.gz`;
  expect(source.url).toBe(`https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/sources/${filename}`);
  expect(source.revision).toBe(`source-sha256:${source.sha256}`);
  const bytes = await readFile(new URL(`../.neutron/sources/${filename}`, import.meta.url));
  expect(bytes.byteLength).toBe(source.bytes);
  expect(hash(bytes)).toBe(source.sha256);
  const snapshot = decodeNeutronAppSourceSnapshot(new Uint8Array(gunzipSync(bytes)), { id: "hyperliquid", version: 104 });
  assertNeutronAppSourceBuildInputs(snapshot, record.build.inputs);
  for (const path of ["apps/hyperliquid/backend/memory/hyperliquid/v1.mo", "apps/hyperliquid/src/service.ts", "apps/hyperliquid/neutron.lock.json"]) {
    const file = snapshot.files.find((entry) => entry.path === path);
    expect(file, `${path} must be in the offered source`).toBeDefined();
    expect(file!.content).toEqual(new Uint8Array(await readFile(new URL(`../../../${path}`, import.meta.url))));
  }
});
