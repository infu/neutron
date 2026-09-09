import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

const manifest = async () => JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest;
const archive = async () => unpackNeutronPackage(await readFile(new URL("../uniswap.v0.1.18.neutron", import.meta.url)));

test("Uniswap owns its managed journal and declares exact public Wallet access", async () => {
  const value = await manifest();
  expect(validate_neutron_conf(value).errors).toEqual([]);
  expect(value).toMatchObject({ id: "uniswap", version: 118, update_source: "233tv-xiaaa-aaaay-aacta-cai", memory: {
    uniswap: { version: 1, schemas: { "1": { src: "memory/uniswap/v1.mo" } }, migrations: [] },
    uniswap_actions: { version: 1, schemas: { "1": { src: "memory/uniswap_actions/v1.mo" } }, migrations: [] },
  } });
  expect(Object.keys(value.capabilities ?? {}).sort()).toEqual(["frontend_tools", "preapproved_self_calls"]);
  expect(value.capabilities?.frontend_tools).toMatchObject({ api: 1, targets: [{ app: "evm_wallet", tools: expect.arrayContaining(["evm_accounts_v1", "evm_wallet_prices_v1", "evm_operation_status_v1", "evm_send_transaction_v1"]) }] });
  expect(value.backend).toBeUndefined();
  expect(value.background?.path).toBe("service.html");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(packageJson.license).toBe("LicenseRef-Neutron-Sovereign-Application-Use-License-1.0");
  expect(packageJson.dependencies.viem).toBe("2.55.1");
});

test("the packaged tile, resident service and managed-memory root are installable", async () => {
  const files = await archive();
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["neutron.json", "schema.json", "web/index.html", "web/main.css", "web/main.js", "web/service.html", "web/service.js", "web/static/icon.svg"]));
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.id).toBe("uniswap");
  expect(prepared.manifest.version).toBe(118);
  const compiled = JSON.parse(new TextDecoder().decode(files["neutron.json"]!));
  const lock = JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"));
  expect(compiled.memory.uniswap.schemas["1"]).toMatchObject(lock.memory.uniswap.schemas["1"]);
  expect(compiled.memory.uniswap_actions.schemas["1"]).toMatchObject(lock.memory.uniswap_actions.schemas["1"]);
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const initial = planMemoryMigrations({ kernel }, { kernel, uniswap: compiled });
  expect(initial.upgrades).toEqual([
    { kind: "initialize", owner: "uniswap", memoryId: "uniswap", to: 1 },
    { kind: "initialize", owner: "uniswap", memoryId: "uniswap_actions", to: 1 },
  ]);
  expect(initial.destructiveMemoryRoots).toEqual([]);
  const restored = planMemoryMigrations({ kernel, uniswap: compiled }, { kernel, uniswap: compiled });
  expect(restored.upgrades).toEqual([
    { kind: "keep", owner: "uniswap", memoryId: "uniswap", version: 1 },
    { kind: "keep", owner: "uniswap", memoryId: "uniswap_actions", version: 1 },
  ]);
  expect(restored.destructiveMemoryRoots).toEqual([]);
  const published109Files = unpackNeutronPackage(await readFile(new URL("../uniswap.v0.1.9.neutron", import.meta.url)));
  const published109 = JSON.parse(new TextDecoder().decode(published109Files["neutron.json"]!));
  expect(published109.version).toBe(109);
  expect(compiled.memory).toEqual(published109.memory);
  expect(files["neutron.lock.json"]).toEqual(published109Files["neutron.lock.json"]);
  for (const root of Object.values(published109.memory) as Array<{ schemas: Record<string, { entry: string }> }>) {
    for (const schema of Object.values(root.schemas)) expect(files[`mo/${schema.entry}.mo`]).toEqual(published109Files[`mo/${schema.entry}.mo`]);
  }
  expect(planMemoryMigrations({ kernel, uniswap: published109 }, { kernel, uniswap: compiled })).toEqual(restored);
  // Production and skipped-release upgrades retain the exact old root and its
  // immutable lock lineage while initializing only the independent new root.
  for (const version of ["0.1.6", "0.1.8"]) {
    const previous = unpackNeutronPackage(await readFile(new URL(`../uniswap.v${version}.neutron`, import.meta.url)));
    const installed = JSON.parse(new TextDecoder().decode(previous["neutron.json"]!));
    const previousLock = JSON.parse(new TextDecoder().decode(previous["neutron.lock.json"]!));
    expect(compiled.memory.uniswap).toEqual(installed.memory.uniswap);
    expect(lock.memory.uniswap).toEqual(previousLock.memory.uniswap);
    const entry = installed.memory.uniswap.schemas["1"].entry;
    const schemaPath = `mo/${entry}.mo`;
    expect(files[schemaPath]).toBeDefined();
    expect(files[schemaPath]).toEqual(previous[schemaPath]);
    const upgrade = planMemoryMigrations({ kernel, uniswap: installed }, { kernel, uniswap: compiled });
    expect(upgrade.upgrades).toEqual([
      { kind: "keep", owner: "uniswap", memoryId: "uniswap", version: 1 },
      { kind: "initialize", owner: "uniswap", memoryId: "uniswap_actions", to: 1 },
    ]);
    expect(upgrade.destructiveMemoryRoots).toEqual([]);
  }
});

test.each([
  [110, "0.1.10", "5973ffc69dc0ee99f8cc2d32046595827448eb3b7ca5879ea6a943d98acd6c37"],
  [111, "0.1.11", "391b7e17b8b41e09d2e539031cf80b788b5c9ff30b868b21e3f71b92af786bc5"],
  [112, "0.1.12", "3c6e86b7ca2d14dd7a8ee428d41e8d4ccfb0fe0c861023ac3c2d133b09987686"],
  [113, "0.1.13", "30034d1a81995cb26ffaee1d924327ea466ea18a7c6e99a5d6ada737116c21d0"],
  [114, "0.1.14", "75ba92f844ebc8177b44c2fb24ed41088a73b7655bbae2aaa14fb6d955daf243"],
  [115, "0.1.15", "791a1a609d1318ae13a2bd032002916b78bd65d7966d6676cff2cc48b761fa7b"],
  [116, "0.1.16", "715ffdfa5fcd9d689cd9020e5e978807715c7721f1e78aa2ac055828a9a83bfd"],
  [117, "0.1.17", "e98e1b6492ae07f4ddf6d5a5aefbc48612b151fbdb1d7c4c000694be8ed19f6f"],
] as const)("release 118 preserves production %s backend and both root dependency closures", async (version, release, digest) => {
  const previousBytes = await readFile(new URL(`../uniswap.v${release}.neutron`, import.meta.url));
  if (version === 113) expect(previousBytes.byteLength).toBe(1_002_257);
  if (version === 116) expect(previousBytes.byteLength).toBe(1_009_025);
  expect(createHash("sha256").update(previousBytes).digest("hex")).toBe(digest);
  const previous = unpackNeutronPackage(previousBytes), files = await archive();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const old = JSON.parse(decode(previous["neutron.json"]!)), next = JSON.parse(decode(files["neutron.json"]!));
  expect(old.version).toBe(version);
  expect(next.version).toBe(118);
  expect(next.memory).toEqual(old.memory);
  expect(files["neutron.lock.json"]).toEqual(previous["neutron.lock.json"]);
  // This release changes frontend code only: equality of every backend module also
  // covers every schema's transitive dependency closure.
  expect(next.entry).toBe(old.entry);
  const modules = Object.keys(previous).filter(path => path.startsWith("mo/")).sort();
  expect(Object.keys(files).filter(path => path.startsWith("mo/")).sort()).toEqual(modules);
  for (const path of modules) expect(files[path]).toEqual(previous[path]);
  const schema = JSON.parse(decode(files["schema.json"]!)), priorSchema = JSON.parse(decode(previous["schema.json"]!));
  expect(schema).toEqual(generateAppMethodSchemaArtifact(await manifest(), await readFile(new URL("../backend/main.mo", import.meta.url), "utf8")));
  expect(schema).toEqual({ ...priorSchema, app: { ...priorSchema.app, name: "via Uniswap", version: 118 } });
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const upgraded = planMemoryMigrations({ kernel, uniswap: old }, { kernel, uniswap: next });
  expect(upgraded.upgrades).toEqual([
    { kind: "keep", owner: "uniswap", memoryId: "uniswap", version: 1 },
    { kind: "keep", owner: "uniswap", memoryId: "uniswap_actions", version: 1 },
  ]);
  expect(upgraded.destructiveMemoryRoots).toEqual([]);
});

test("journal methods emit schemas that preserve typed identity and optional operation evidence", async () => {
  const artifact = generateAppMethodSchemaArtifact(await manifest(), await readFile(new URL("../backend/main.mo", import.meta.url), "utf8"));
  expect(validateAppMethodArgs(artifact, "uniswap_list_v1", [null]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_get_v1", ["a".repeat(32)]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_update_v1", [{ id: "a", expected_revision: "0", stage: "swap", request_id: "b", account_id: "main", chain_id: "1", phase: "swap_requested" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_update_v1", [{ id: "a", expected_revision: "0", stage: "swap", request_id: "b", account_id: "main", chain_id: 1, phase: "swap_requested" }]).valid).toBe(false);
  expect(validateAppMethodArgs(artifact, "uniswap_action_begin_v1", [{ id: "a", input_json: "{}", summary: "Add liquidity", state_json: "{}", phase: "queued" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_action_get_v1", ["a"]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_action_update_v1", [{ id: "a", expected_revision: "0", state_json: "{}", phase: "requested" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_action_page_v1", [{ limit: "7" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_action_page_v1", [{ cursor: "a", limit: "7" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_position_track_v1", [{ chain_id: "1", protocol: "v4", token_id: "123" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_position_refs_v1", ["1"]).valid).toBe(true);
});
