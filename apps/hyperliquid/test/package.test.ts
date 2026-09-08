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
const archive = new URL("../hyperliquid.v0.1.1.neutron", import.meta.url);
const releasedArchive = new URL("../hyperliquid.v0.1.0.neutron", import.meta.url);

test("release installs its complete UI, resident service and private journal", async () => {
  expect(validate_neutron_conf(sourceManifest).errors).toEqual([]);
  expect(sourceManifest).toMatchObject({ id: "hyperliquid", version: 101, update_source: "233tv-xiaaa-aaaay-aacta-cai" });
  const files = unpackNeutronPackage(await readFile(archive));
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest).toMatchObject({ id: "hyperliquid", version: 101 });
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
  const releasedBytes = await readFile(releasedArchive);
  expect(hash(releasedBytes)).toBe("90e9c8c8a9cfd125bbf0db4bf04c8697416fd5244bd2aaf399d35232611898f1");
  const releasedFiles = unpackNeutronPackage(releasedBytes);
  const released = JSON.parse(decode(releasedFiles["neutron.json"]!));
  const upgrade = planMemoryMigrations({ kernel, hyperliquid: released }, { kernel, hyperliquid: compiled });
  expect(upgrade.upgrades).toEqual([{ kind: "keep", owner: "hyperliquid", memoryId: "hyperliquid", version: 1 }]);
  expect(upgrade.destructiveMemoryRoots).toEqual([]);
  expect(files["neutron.lock.json"]).toEqual(releasedFiles["neutron.lock.json"]!);
  const schemaPath = `mo/${released.memory.hyperliquid.schemas["1"].entry}.mo`;
  expect(files[schemaPath]).toEqual(releasedFiles[schemaPath]!);
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
  const snapshot = decodeNeutronAppSourceSnapshot(new Uint8Array(gunzipSync(bytes)), { id: "hyperliquid", version: 101 });
  assertNeutronAppSourceBuildInputs(snapshot, record.build.inputs);
  for (const path of ["apps/hyperliquid/backend/memory/hyperliquid/v1.mo", "apps/hyperliquid/src/service.ts", "apps/hyperliquid/neutron.lock.json"]) {
    const file = snapshot.files.find((entry) => entry.path === path);
    expect(file, `${path} must be in the offered source`).toBeDefined();
    expect(file!.content).toEqual(new Uint8Array(await readFile(new URL(`../../../${path}`, import.meta.url))));
  }
});
