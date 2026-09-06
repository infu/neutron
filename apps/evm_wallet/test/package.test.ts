import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
  extractPublicTypeAliases,
  motokoTypeToIdl,
} from "neutron-scripts/src/method_schema.js";
import { normalizeSelfCallResult } from "neutron-kernel/src/self_calls.ts";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { effectIntent } from "../src/provider.ts";
import {
  identityArgs,
  parseAccounts,
  parseBalance,
  parseHistory,
  parseOperation,
  parseSnapshot,
} from "../src/data.ts";
const manifest = async () =>
  JSON.parse(
    await readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ) as NeutronManifest;
const source = () =>
  readFile(new URL("../backend/main.mo", import.meta.url), "utf8");
const account = {
  id: "main",
  slot: "main",
  address: `0x${"22".repeat(20)}`,
  public_key: new Uint8Array([2, ...new Uint8Array(32).fill(1)]),
  key_fingerprint: new Uint8Array(32).fill(3),
  namespace_version: "1",
};
const caller = {
  appId: "kitchensink",
  installationUid: "9",
  endpoint: "app:kitchensink:tile:main",
};
const request = {
  requestId: "ab".repeat(16),
  accountId: "main" as const,
  chainId: "1",
  to: `0x${"11".repeat(20)}`,
  valueWei: "7",
  data: "0x",
};
function candid(type: IDL.Type, value: unknown): unknown {
  if (type instanceof IDL.OptClass)
    return value == null ? [] : [candid(type._type, value)];
  if (type instanceof IDL.VecClass) {
    if (type._type === IDL.Nat8) return value;
    return (value as unknown[]).map((v) => candid(type._type, v));
  }
  if (type instanceof IDL.RecordClass) {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      type._fields.map(([name, child]) => [name, candid(child, row[name])]),
    );
  }
  if (type instanceof IDL.VariantClass) {
    const row = value as Record<string, unknown>,
      entry = type._fields.find(([name]) => Object.hasOwn(row, name));
    if (!entry) throw new Error("Missing variant");
    return { [entry[0]]: candid(entry[1], row[entry[0]]) };
  }
  if (/^(nat|int)(64)?$/.test(type.display())) return BigInt(value as string);
  return value;
}
async function project(method: string, value: unknown): Promise<unknown> {
  const aliases = extractPublicTypeAliases(await source()),
    type = motokoTypeToIdl(aliases[`${method}_Output`]!, IDL, aliases);
  const raw = candid(type, { ok: value });
  return normalizeSelfCallResult(
    IDL.decode([type], IDL.encode([type], [raw]))[0],
    type,
  );
}
test("separate EVM Wallet declares custody, exact RPC reservations and all generated methods", async () => {
  const m = await manifest();
  expect(validate_neutron_conf(m).errors).toEqual([]);
  expect(m).toMatchObject({
    id: "evm_wallet",
    version: 101,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: { path: "service.html" },
    capabilities: {
      wallet_custody_signing: {
        api: 1,
        slots: [{ id: "main", algorithm: "ecdsa_secp256k1" }],
      },
    },
    memory: { evm_wallet: { version: 1, migrations: [] } },
  });
  expect(Object.keys(m.func ?? {})).toHaveLength(11);
  expect(m.capabilities).not.toHaveProperty("chain_key_signing");
  expect(m.capabilities).not.toHaveProperty("ethereum_provider");
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(pkg.license).toBe(
    "LicenseRef-Neutron-Sovereign-Application-Use-License-1.0",
  );
});
test("actual generated schemas accept provider self-call arguments and reject wrong chains", async () => {
  const artifact = generateAppMethodSchemaArtifact(
    await manifest(),
    await source(),
  );
  expect(
    validateAppMethodArgs(artifact, "evm_wallet_accounts_v1", [null]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "evm_wallet_accounts_v1", []).valid,
  ).toBe(false);
  const identity = identityArgs(caller, request.requestId);
  expect(
    validateAppMethodArgs(artifact, "evm_wallet_prepare_v1", [
      { identity, intent: effectIntent("transaction", request) },
    ] as never).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "evm_wallet_execute_v1", [
      { identity, review_revision: "1" },
    ] as never).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "evm_wallet_prepare_v1", [
      {
        identity,
        intent: { ...effectIntent("transaction", request), chain_id: false },
      },
    ] as never).valid,
  ).toBe(false);
});
test("real Candid self-call projection unwraps Results, keeps bytes and omits absent optionals", async () => {
  const accounts = await project("evm_wallet_accounts_v1", [account]);
  expect(Array.isArray(accounts)).toBe(true);
  expect(parseAccounts(accounts)[0]!.publicKey).toEqual(account.public_key);
  const snapshot = await project("evm_wallet_snapshot_v1", {
    accounts: [account],
    networks: [
      {
        chain_id: "1",
        name: "Ethereum",
        native_symbol: "ETH",
        explorer_url: "https://etherscan.io",
        testnet: false,
        finality_description: "Ethereum finality",
      },
    ],
    assets: [],
    lifecycle: "Upgrade preserves key",
  });
  expect(parseSnapshot(snapshot).accounts[0]!.id).toBe("main");
  const projectedBalance = await project("evm_wallet_balances_v1", {
    account_id: "main",
    chain_id: "1",
    address: account.address,
    native_balance: "9",
    tokens: [
      {
        address: request.to,
        balance: null,
        decimals: null,
        symbol: null,
        error: "provider unavailable",
      },
    ],
    block_number: "0x20000000000001",
    observed_at: "999",
    completeness: "requested_only",
  });
  expect(
    (projectedBalance as { tokens: unknown[] }).tokens[0],
  ).not.toHaveProperty("balance");
  expect(parseBalance(projectedBalance).blockNumber).toBe("9007199254740993");
  const operation = {
    operation_id: "1",
    caller: {
      app_id: caller.appId,
      installation_uid: caller.installationUid,
      endpoint: caller.endpoint,
    },
    request_id: request.requestId,
    account_id: "main",
    chain_id: "1",
    kind: "transaction",
    status: "prepared",
    address: account.address,
    review_revision: "1",
    created_at: "999",
    updated_at: "999",
    intent: effectIntent("transaction", request),
  };
  const projectedOperation = await project("evm_wallet_prepare_v1", operation);
  expect(projectedOperation).not.toHaveProperty("ok");
  expect(projectedOperation).not.toHaveProperty("transaction_hash");
  expect(parseOperation(projectedOperation)).toMatchObject({
    operationId: "1",
    transactionHash: null,
    signature: null,
    review: null,
    preparedTransaction: null,
  });
  expect(
    parseHistory(
      await project("evm_wallet_history_v1", {
        operations: [operation],
        total: "1",
      }),
    ).operations[0]!.operationId,
  ).toBe("1");
});
test("current archive initializes cleanly and retains the private prepared candidate's root", async () => {
  const files = unpackNeutronPackage(
    await readFile(new URL("../evm_wallet.v0.1.1.neutron", import.meta.url)),
  );
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.id).toBe("evm_wallet");
  expect(prepared.manifest.version).toBe(101);
  expect(Object.keys(files)).toEqual(
    expect.arrayContaining([
      "web/index.html",
      "web/main.js",
      "web/main.css",
      "web/service.html",
      "web/service.js",
      "web/static/icon.svg",
      "schema.json",
    ]),
  );
  const compiled = JSON.parse(new TextDecoder().decode(files["neutron.json"]!)),
    kernel = {
      format: 3 as const,
      id: "kernel",
      name: "Kernel",
      version: 100,
      entry: "f".repeat(64),
    };
  expect(
    planMemoryMigrations({ kernel }, { kernel, evm_wallet: compiled }).upgrades,
  ).toEqual([
    { kind: "initialize", owner: "evm_wallet", memoryId: "evm_wallet", to: 1 },
  ]);
  const restored = planMemoryMigrations(
    { kernel, evm_wallet: compiled },
    { kernel, evm_wallet: compiled },
  );
  expect(restored.upgrades).toEqual([
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_wallet", version: 1 },
  ]);
  expect(restored.destructiveMemoryRoots).toEqual([]);
  // Candidate 100 was prepared privately and never published. This verifies
  // immutable schema compatibility without asserting production release history.
  const baselineBytes = await readFile(
    new URL("../evm_wallet.v0.1.0.neutron", import.meta.url),
  );
  expect(createHash("sha256").update(baselineBytes).digest("hex")).toBe(
    "9a3859850d587a224e3046883d23f856dab2fd07304c43927c91e64242efdd8d",
  );
  const baselineFiles = unpackNeutronPackage(baselineBytes);
  const baseline = JSON.parse(
    new TextDecoder().decode(baselineFiles["neutron.json"]!),
  );
  expect(compiled.memory).toEqual(baseline.memory);
  const upgraded = planMemoryMigrations(
    { kernel, evm_wallet: baseline },
    { kernel, evm_wallet: compiled },
  );
  expect(upgraded.upgrades).toEqual([
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_wallet", version: 1 },
  ]);
  expect(upgraded.destructiveMemoryRoots).toEqual([]);
});
