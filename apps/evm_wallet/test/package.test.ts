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
import { estimateTransaction, replacementTransaction } from "../src/read_adapters.ts";
import type { MsgBusToolContext } from "neutron-tools/app";
import {
  identityArgs,
  parseAccounts,
  parseBalance,
  parseHistory,
  parseOperation,
  parseReviewEvidence,
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
    version: 106,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: { path: "service.html" },
    capabilities: {
      wallet_custody_signing: {
        api: 1,
        slots: [{ id: "main", algorithm: "ecdsa_secp256k1" }],
      },
    },
    memory: {
      evm_wallet: { version: 1, migrations: [] },
      evm_evidence: { version: 1, migrations: [] },
    },
  });
  expect(Object.keys(m.func ?? {})).toHaveLength(14);
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
  const evidence = await project("evm_wallet_review_evidence_v1", {
    operation,
    token_evidence: {
      chain_id: "1", contract: request.to, method: "approve",
      owner: account.address, spender: request.to, amount: "9007199254740993",
      recognition: "erc20_calldata", block_number: "0x20000000000001",
      observed_at: "999", balance: { value: "9007199254740993" },
      allowance: { error: "Allowance provider unavailable" },
    },
  });
  expect((evidence as { operation: unknown }).operation).not.toHaveProperty("token_evidence");
  const token = parseReviewEvidence(evidence).tokenEvidence;
  expect(token).toMatchObject({
    blockNumber: "9007199254740993", amount: "9007199254740993",
    balance: { value: "9007199254740993", error: null },
    allowance: { value: null, error: "Allowance provider unavailable" },
    blockHash: null,
  });
  expect(parseReviewEvidence(await project("evm_wallet_review_evidence_v1", { operation })).tokenEvidence).toBeNull();
});
test("published 101 self-call inputs and closed outputs stay unchanged when review evidence is added", async () => {
  const files = unpackNeutronPackage(await readFile(new URL("../evm_wallet.v0.1.1.neutron", import.meta.url)));
  const released = JSON.parse(new TextDecoder().decode(files["schema.json"]!));
  const current = generateAppMethodSchemaArtifact(await manifest(), await source());
  for (const [name, method] of Object.entries(released.methods)) {
    expect(current.methods[name] as unknown).toEqual(method);
  }
  expect(validateAppMethodArgs(current, "evm_wallet_review_evidence_v1", [{
    identity: identityArgs(caller, request.requestId), review_revision: "1", refresh: false,
  }] as never).valid).toBe(true);
});
test("new estimate and replacement-proof adapters accept actual Candid-projected optional fields", async () => {
  const estimate = await project("evm_wallet_estimate_transaction_v1", {
    chain_id: "1", from: account.address, to: request.to, value: "7", data: "0x",
    status: "unavailable", base_fee_per_gas: "10", observed_at: "999",
    fee_basis: "unavailable", posting_costs: "not_applicable", reasons: ["Gas provider unavailable"],
  });
  const artifact = generateAppMethodSchemaArtifact(await manifest(), await source());
  const ctx = {
    kernel: {
      async updateSelf(method: string, args: unknown[]) {
        expect(validateAppMethodArgs(artifact, method, args as never).valid).toBe(true);
        return estimate;
      },
      async querySelf(method: string, args: unknown[]) {
        expect(validateAppMethodArgs(artifact, method, args as never).valid).toBe(true);
        return project("evm_wallet_replacement_transaction_v1", {
          chain_id: "1", transaction_hash: `0x${"33".repeat(32)}`,
          original_wallet_request: { caller_app_id: "wallet", caller_installation_uid: "9007199254740993", request_id: request.requestId },
          wallet_replacement_matches: false, observed_at: "999", source: "evm_wallet_journal",
        });
      },
    },
  } as unknown as MsgBusToolContext;
  expect(await estimateTransaction({ accountId: "main", chainId: "1", to: request.to, valueWei: "7", data: "0x" }, ctx)).toMatchObject({
    gasLimit: null, baseFeePerGasWei: "10", estimatedFeeWei: null, blockNumber: null,
  });
  expect(await replacementTransaction({
    chainId: "1", transactionHash: `0x${"33".repeat(32)}`,
    originalWalletRequest: { callerAppId: "wallet", callerInstallationUid: "9007199254740993", requestId: request.requestId },
  }, ctx)).toMatchObject({ walletReplacementMatches: false, originalWalletRequest: { callerInstallationUid: "9007199254740993" } });
});
test("release 106 initializes cleanly and preserves the published 101 root while adding token evidence", async () => {
  const files = unpackNeutronPackage(
    await readFile(new URL("../evm_wallet.v0.1.6.neutron", import.meta.url)),
  );
  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.id).toBe("evm_wallet");
  expect(prepared.manifest.version).toBe(106);
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
  const clean = planMemoryMigrations({ kernel }, { kernel, evm_wallet: compiled });
  expect(clean.upgrades).toHaveLength(2);
  expect(clean.upgrades).toEqual(expect.arrayContaining([
    { kind: "initialize", owner: "evm_wallet", memoryId: "evm_wallet", to: 1 },
    { kind: "initialize", owner: "evm_wallet", memoryId: "evm_evidence", to: 1 },
  ]));
  expect(clean.destructiveMemoryRoots).toEqual([]);
  const restored = planMemoryMigrations(
    { kernel, evm_wallet: compiled },
    { kernel, evm_wallet: compiled },
  );
  expect(restored.upgrades).toHaveLength(2);
  expect(restored.upgrades).toEqual(expect.arrayContaining([
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_wallet", version: 1 },
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_evidence", version: 1 },
  ]));
  expect(restored.destructiveMemoryRoots).toEqual([]);
  // Release 101 is immutable production history. The original wallet root and
  // all of its lock entries must survive the independent evidence-root addition.
  const baselineBytes = await readFile(
    new URL("../evm_wallet.v0.1.1.neutron", import.meta.url),
  );
  expect(createHash("sha256").update(baselineBytes).digest("hex")).toBe(
    "1f7e9fb0ab82b60543ed38d81f215e7655ef4ca9fb1afab0f6ea6eb4cf456048",
  );
  const baselineFiles = unpackNeutronPackage(baselineBytes);
  const baseline = JSON.parse(
    new TextDecoder().decode(baselineFiles["neutron.json"]!),
  );
  expect(compiled.memory.evm_wallet).toEqual(baseline.memory.evm_wallet);
  const currentLock = JSON.parse(new TextDecoder().decode(files["neutron.lock.json"]!));
  const baselineLock = JSON.parse(new TextDecoder().decode(baselineFiles["neutron.lock.json"]!));
  expect(currentLock.memory.evm_wallet).toEqual(baselineLock.memory.evm_wallet);
  const upgraded = planMemoryMigrations(
    { kernel, evm_wallet: baseline },
    { kernel, evm_wallet: compiled },
  );
  expect(upgraded.upgrades).toHaveLength(2);
  expect(upgraded.upgrades).toEqual(expect.arrayContaining([
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_wallet", version: 1 },
    { kind: "initialize", owner: "evm_wallet", memoryId: "evm_evidence", to: 1 },
  ]));
  expect(upgraded.destructiveMemoryRoots).toEqual([]);
  // Prepared candidate 102 was not published. Preserve its bytes and confirm
  // this frontend-only successor does not alter either candidate memory root.
  const candidate102Bytes = await readFile(new URL("../evm_wallet.v0.1.2.neutron", import.meta.url));
  expect(createHash("sha256").update(candidate102Bytes).digest("hex")).toBe(
    "57d8b1c69af50e70d865d2f01dd6b8c1484af8fd5907b21aaa483116ecd92641",
  );
  const candidate102Files = unpackNeutronPackage(candidate102Bytes);
  const candidate102 = JSON.parse(new TextDecoder().decode(candidate102Files["neutron.json"]!));
  expect(compiled.memory).toEqual(candidate102.memory);
  expect(files["neutron.lock.json"]).toEqual(candidate102Files["neutron.lock.json"]);
  // Candidate 103 is installed only in the local qualification canister. Its
  // state and API remain compatible with the owner-review and RPC comparison fixes.
  const candidate103Bytes = await readFile(new URL("../evm_wallet.v0.1.3.neutron", import.meta.url));
  expect(createHash("sha256").update(candidate103Bytes).digest("hex")).toBe(
    "80cb4d5a55d52ce1e27114e9bb36686af3d60dd668b7c85e694fb16ed4eb1d92",
  );
  const candidate103Files = unpackNeutronPackage(candidate103Bytes);
  const candidate103 = JSON.parse(new TextDecoder().decode(candidate103Files["neutron.json"]!));
  expect(compiled.memory).toEqual(candidate103.memory);
  expect(files["neutron.lock.json"]).toEqual(candidate103Files["neutron.lock.json"]);
  const currentSchema = JSON.parse(new TextDecoder().decode(files["schema.json"]!));
  const priorSchema = JSON.parse(new TextDecoder().decode(candidate103Files["schema.json"]!));
  // The artifact records its app release version beside the method schemas.
  expect(currentSchema).toEqual({ ...priorSchema, app: { ...priorSchema.app, version: 106 } });
  // Private candidate 104 isolates the owner-review UI fix: all 80 backend
  // modules are identical to 103. The successor additionally fixes the proven
  // RPC text-comparison overflow; its unchanged source closure is checked with
  // the offered-source comparison and its behavior by a real compiled actor.
  const candidate104Bytes = await readFile(new URL("../evm_wallet.v0.1.4.neutron", import.meta.url));
  expect(createHash("sha256").update(candidate104Bytes).digest("hex")).toBe(
    "002759fbb401bfcf9e399fa0a9a654bbdd7833dba1c30c4cecd888a8a0a3c820",
  );
  const candidate104Files = unpackNeutronPackage(candidate104Bytes);
  const candidate104 = JSON.parse(new TextDecoder().decode(candidate104Files["neutron.json"]!));
  expect(compiled.memory).toEqual(candidate104.memory);
  expect(files["neutron.lock.json"]).toEqual(candidate104Files["neutron.lock.json"]);
  expect(candidate104.entry).toEqual(candidate103.entry);
  const modules = Object.keys(candidate104Files).filter((path) => path.startsWith("mo/")).sort();
  expect(modules).toEqual(Object.keys(candidate103Files).filter((path) => path.startsWith("mo/")).sort());
  for (const path of modules) expect(candidate104Files[path]).toEqual(candidate103Files[path]);
  const kept103 = planMemoryMigrations(
    { kernel, evm_wallet: candidate103 }, { kernel, evm_wallet: compiled },
  );
  expect(kept103.upgrades).toEqual(expect.arrayContaining([
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_wallet", version: 1 },
    { kind: "keep", owner: "evm_wallet", memoryId: "evm_evidence", version: 1 },
  ]));
  expect(kept103.upgrades).toHaveLength(2);
  expect(kept103.destructiveMemoryRoots).toEqual([]);
  // The adaptive history reader changes only frontend behavior. Preserve the
  // complete backend and managed-memory bytes of installed private candidate105.
  const candidate105Bytes = await readFile(new URL("../evm_wallet.v0.1.5.neutron", import.meta.url));
  expect(createHash("sha256").update(candidate105Bytes).digest("hex")).toBe(
    "a3a792b9716914bc73ba56826a9bfde583806f6b278109bdd8712e7ab1802bc2",
  );
  const candidate105Files = unpackNeutronPackage(candidate105Bytes);
  const candidate105 = JSON.parse(new TextDecoder().decode(candidate105Files["neutron.json"]!));
  expect(compiled.memory).toEqual(candidate105.memory);
  expect(compiled.entry).toEqual(candidate105.entry);
  expect(files["neutron.lock.json"]).toEqual(candidate105Files["neutron.lock.json"]);
  const currentModules = Object.keys(files).filter(path => path.startsWith("mo/")).sort();
  expect(currentModules).toEqual(Object.keys(candidate105Files).filter(path => path.startsWith("mo/")).sort());
  for (const path of currentModules) expect(files[path]).toEqual(candidate105Files[path]);
});
