import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

const manifest = async () => JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest;
const archive = async () => unpackNeutronPackage(await readFile(new URL("../uniswap.v0.1.7.neutron", import.meta.url)));

test("Uniswap is a separate app with only its own managed journal capability", async () => {
  const value = await manifest();
  expect(validate_neutron_conf(value).errors).toEqual([]);
  expect(value).toMatchObject({ id: "uniswap", version: 107, update_source: "233tv-xiaaa-aaaay-aacta-cai", memory: { uniswap: { version: 1, schemas: { "1": { src: "memory/uniswap/v1.mo" } }, migrations: [] } } });
  expect(Object.keys(value.capabilities ?? {})).toEqual(["preapproved_self_calls"]);
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
  expect(prepared.manifest.version).toBe(107);
  const compiled = JSON.parse(new TextDecoder().decode(files["neutron.json"]!));
  const lock = JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"));
  expect(compiled.memory.uniswap.schemas["1"]).toMatchObject(lock.memory.uniswap.schemas["1"]);
  const kernel = { format: 3 as const, id: "kernel", name: "Kernel", version: 100, entry: "f".repeat(64) };
  const initial = planMemoryMigrations({ kernel }, { kernel, uniswap: compiled });
  expect(initial.upgrades).toEqual([{ kind: "initialize", owner: "uniswap", memoryId: "uniswap", to: 1 }]);
  expect(initial.destructiveMemoryRoots).toEqual([]);
  const restored = planMemoryMigrations({ kernel, uniswap: compiled }, { kernel, uniswap: compiled });
  expect(restored.upgrades).toEqual([{ kind: "keep", owner: "uniswap", memoryId: "uniswap", version: 1 }]);
  expect(restored.destructiveMemoryRoots).toEqual([]);
  const previous = unpackNeutronPackage(await readFile(new URL("../uniswap.v0.1.6.neutron", import.meta.url)));
  const installed = JSON.parse(new TextDecoder().decode(previous["neutron.json"]!));
  expect(compiled.memory).toEqual(installed.memory);
  expect(files["neutron.lock.json"]).toEqual(previous["neutron.lock.json"]);
  const upgrade = planMemoryMigrations({ kernel, uniswap: installed }, { kernel, uniswap: compiled });
  expect(upgrade.upgrades).toEqual([{ kind: "keep", owner: "uniswap", memoryId: "uniswap", version: 1 }]);
  expect(upgrade.destructiveMemoryRoots).toEqual([]);
});

test("journal methods emit schemas that preserve typed identity and optional operation evidence", async () => {
  const artifact = generateAppMethodSchemaArtifact(await manifest(), await readFile(new URL("../backend/main.mo", import.meta.url), "utf8"));
  expect(validateAppMethodArgs(artifact, "uniswap_list_v1", [null]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_get_v1", ["a".repeat(32)]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_update_v1", [{ id: "a", expected_revision: "0", stage: "swap", request_id: "b", account_id: "main", chain_id: "1", phase: "swap_requested" }]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "uniswap_update_v1", [{ id: "a", expected_revision: "0", stage: "swap", request_id: "b", account_id: "main", chain_id: 1, phase: "swap_requested" }]).valid).toBe(false);
});
