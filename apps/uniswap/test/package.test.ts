import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

const manifest = async () => JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest;
const archive = async () => unpackNeutronPackage(await readFile(new URL("../uniswap.v0.1.9.neutron", import.meta.url)));

test("Uniswap owns its managed journal and declares exact public Wallet access", async () => {
  const value = await manifest();
  expect(validate_neutron_conf(value).errors).toEqual([]);
  expect(value).toMatchObject({ id: "uniswap", version: 109, update_source: "233tv-xiaaa-aaaay-aacta-cai", memory: {
    uniswap: { version: 1, schemas: { "1": { src: "memory/uniswap/v1.mo" } }, migrations: [] },
    uniswap_actions: { version: 1, schemas: { "1": { src: "memory/uniswap_actions/v1.mo" } }, migrations: [] },
  } });
  expect(Object.keys(value.capabilities ?? {}).sort()).toEqual(["frontend_tools", "preapproved_self_calls"]);
  expect(value.capabilities?.frontend_tools).toMatchObject({ api: 1, targets: [{ app: "evm_wallet", tools: expect.arrayContaining(["evm_accounts_v1", "evm_operation_status_v1", "evm_send_transaction_v1"]) }] });
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
  expect(prepared.manifest.version).toBe(109);
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
