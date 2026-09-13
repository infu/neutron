/**
 * Installed memory v1 -> v2 and v2 -> v2 qualification, using frozen releases.
 *
 * NEUTRON_RUN_MARKETPLACE_DISCOUNT_UPGRADE=1 \
 * NEUTRON_MARKETPLACE_DISCOUNT_CANDIDATE_SHA256=<reviewed archive SHA-256> \
 * NEUTRON_MARKETPLACE_DISCOUNT_CANDIDATE_VERSION=119 \
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 * bun test apps/marketplace/test/discount_upgrade.pocketic.test.ts
 *
 * No browser, protocol deployment, ledger payment, archive rebuild or production
 * call. The only upgrade is the normal checked installation transaction for
 * the reviewed Marketplace successor; Kernel359 remains byte-for-byte intact.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  compileFreshPackages, compilePackages, preparePackageInstall,
  type CompileResult,
} from "../../../packages/neutron-compiler/src/install.ts";
import {
  DirectPocketIcCalls, createApplicationInstance, deployExactTransition,
  freshDeployment, freshPackageState, fundIcp, launchPocketIc,
  loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
  requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  type DirectPocketIcClient, type PreparedArchive,
} from "../../../packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts";

const qualify = process.env.NEUTRON_RUN_MARKETPLACE_DISCOUNT_UPGRADE === "1" ? test : test.skip;
const root = path.resolve(import.meta.dir, "../../..");
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = (value: string) => new TextEncoder().encode(value);
const Blob = IDL.Vec(IDL.Nat8);
const State = IDL.Record({ seed: IDL.Opt(Blob), canister: IDL.Opt(IDL.Principal), host: IDL.Text, owner: IDL.Principal, revision: IDL.Nat });
const result = (value: IDL.Type) => IDL.Variant({ ok: value, err: IDL.Text });
const stateMethod = IDL.Func([IDL.Null], [State], ["query"]);
const draftMethod = IDL.Func([IDL.Text], [IDL.Opt(Blob)], ["query"]);
const draftsMethod = IDL.Func([IDL.Record({ cursor: IDL.Opt(IDL.Text), limit: IDL.Nat })], [IDL.Record({ items: IDL.Vec(IDL.Record({ id: IDL.Text, value: Blob })), nextCursor: IDL.Opt(IDL.Text) })], ["query"]);
const initializeMethod = IDL.Func([Blob], [result(State)], []);
const saveDraftMethod = IDL.Func([IDL.Record({ id: IDL.Text, value: Blob })], [result(IDL.Text)], []);
const reviseDraftMethod = IDL.Func([IDL.Record({ id: IDL.Text, expected: Blob, value: Blob, revision: IDL.Text })], [result(IDL.Text)], []);
const configureMethod = IDL.Func([IDL.Record({ canister: IDL.Principal, host: IDL.Text })], [result(State)], []);
const readKeyMethod = IDL.Func([IDL.Null], [result(Blob)], []);
const readIdentityMethod = IDL.Func([IDL.Record({ publicKey: Blob })], [result(IDL.Record({ publicKey: Blob, sessionPublicKey: Blob, signature: Blob, expiration: IDL.Nat64, target: IDL.Principal }))], []);
const discountMethod = IDL.Func([IDL.Null], [IDL.Opt(IDL.Text)], ["query"]);
const saveDiscountMethod = IDL.Func([IDL.Record({ code: IDL.Opt(IDL.Text) })], [result(IDL.Opt(IDL.Text))], []);
const stateJson = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
function ok<T>(value: unknown): T {
  expect(value).not.toHaveProperty("err");
  return (value as { ok: T }).ok;
}
async function pinned(id: string, version: number, digest: string, size?: number): Promise<PreparedArchive> {
  const semver = `${Math.floor(version / 10_000)}.${Math.floor(version / 100) % 100}.${version % 100}`;
  const archive = new Uint8Array(await readFile(path.join(root, "apps", id, `${id}.v${semver}.neutron`)));
  expect(sha256(archive), `${id}${version} exact reviewed archive`).toBe(digest);
  if (size !== undefined) expect(archive.byteLength).toBe(size);
  return { archive, prepared: preparePackageInstall(archive, { expectedIdentity: { id, version, sha256: digest } }) };
}

function packageFile(archive: PreparedArchive, filePath: string): Uint8Array {
  const file = archive.prepared.files.find(file => file.path === filePath);
  if (!file) throw new Error(`Reviewed Marketplace archive is missing ${filePath}`);
  return file.content;
}

// Released source and lock lineage must survive even when a schema is inactive.
function assertReleasedMemoryHistory(previous: PreparedArchive, next: PreparedArchive) {
  expect(Object.keys(previous.prepared.manifest.memory!)).toEqual(["state"]);
  expect(Object.keys(next.prepared.manifest.memory!)).toEqual(["state"]);
  const released = previous.prepared.manifest.memory!.state!;
  const target = next.prepared.manifest.memory!.state!;
  for (const [version, schema] of Object.entries(released.schemas!)) {
    expect(target.schemas![version]).toEqual(schema);
    expect(packageFile(next, `mo/${schema.entry}.mo`)).toEqual(packageFile(previous, `mo/${schema.entry}.mo`));
  }
  for (const migration of released.migrations ?? []) {
    expect(target.migrations).toContainEqual(migration);
    expect(packageFile(next, `mo/${migration.entry}.mo`)).toEqual(packageFile(previous, `mo/${migration.entry}.mo`));
  }
  const lockPath = "app/marketplace/pkg/neutron.lock.json";
  const releasedLock = JSON.parse(new TextDecoder().decode(packageFile(previous, lockPath)));
  const targetLock = JSON.parse(new TextDecoder().decode(packageFile(next, lockPath)));
  expect(targetLock.format).toBe(releasedLock.format);
  expect(targetLock.app).toBe(releasedLock.app);
  for (const [version, schema] of Object.entries(releasedLock.memory.state.schemas)) {
    expect(targetLock.memory.state.schemas[version]).toEqual(schema);
  }
  for (const [edge, migration] of Object.entries(releasedLock.memory.state.migrations ?? {})) {
    expect(targetLock.memory.state.migrations[edge]).toEqual(migration);
  }
  if (released.version === target.version) {
    expect(target).toEqual(released);
    expect(packageFile(next, lockPath)).toEqual(packageFile(previous, lockPath));
  }
}

const predecessors = [
  { version: 112, memoryVersion: 1, digest: "6412027d0bd3fc594c878d653342ce3c4599a9cbe7d3379448c725b5314f9a21", size: 476_452 },
  { version: 118, memoryVersion: 2, digest: "54136d8bd22c9d682fc958c1eef7904816f34e599f6dd2daf503c10c554eec20", size: 489_788 },
] as const;

for (const predecessor of predecessors) qualify(`Marketplace${predecessor.version} managed state ${predecessor.memoryVersion === 1 ? "migrates once" : "keeps v2 unchanged"} and retains identity, journals and discount preference`, async () => {
  const candidateDigest = process.env.NEUTRON_MARKETPLACE_DISCOUNT_CANDIDATE_SHA256;
  if (!candidateDigest || !/^[0-9a-f]{64}$/.test(candidateDigest)) throw new Error("Set the exact reviewed candidate archive digest after packaging");
  const candidateVersion = Number(process.env.NEUTRON_MARKETPLACE_DISCOUNT_CANDIDATE_VERSION ?? "119");
  expect(candidateVersion).toBeGreaterThan(predecessor.version);
  const kernel = await pinned("kernel", 359, "6b506590ab9160a6e8e31859a791d40e60b797f06e9fde28781b8f0beb89574d", 2_466_756);
  const previous = await pinned("marketplace", predecessor.version, predecessor.digest, predecessor.size);
  const next = await pinned("marketplace", candidateVersion, candidateDigest);
  const releasedMemory = previous.prepared.manifest.memory!.state!;
  const targetMemory = next.prepared.manifest.memory!.state!;
  expect(releasedMemory.version).toBe(predecessor.memoryVersion);
  expect(targetMemory.version).toBe(2);
  assertReleasedMemoryHistory(previous, next);
  expect(targetMemory.migrations).toHaveLength(1);
  expect(targetMemory.migrations![0]).toMatchObject({ from: 1, to: 2 });
  const baseline = [kernel, previous];
  const targets = [kernel, next];
  console.log(`Marketplace discount upgrade: compile frozen Kernel359 + Marketplace${predecessor.version}`);
  const initial = await compileFreshPackages({ packages: baseline.map(item => item.prepared), persistenceMode: "classical" });
  const state = freshPackageState(baseline.map(item => item.prepared), initial);
  console.log(`Marketplace discount upgrade: compile reviewed Marketplace${candidateVersion} transition`);
  const upgraded = await compilePackages({
    packages: [next.prepared], existingModules: state.existingModules,
    existingConfigs: state.existingConfigs, existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable, connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical", versionPolicy: "strict-upgrade",
  });
  expect(upgraded.compatibilityDiagnostics).toEqual([]);
  expect(upgraded.managedMemoryRetirements).toEqual([]);
  expect(upgraded.migrationPlan.removedApps).toEqual([]);
  expect(upgraded.migrationPlan.destructiveMemoryRoots).toEqual([]);
  expect(upgraded.migrationPlan.upgrades.filter(item => item.owner === "marketplace")).toEqual(predecessor.memoryVersion === 1 ? [{
    kind: "migrate", owner: "marketplace", memoryId: "state", from: 1, to: 2,
    oldSchemaEntry: releasedMemory.schemas!["1"]!.entry!,
    path: [{ ...targetMemory.migrations![0]!, entry: targetMemory.migrations![0]!.entry! }],
  }] : [{ kind: "keep", owner: "marketplace", memoryId: "state", version: 2 }]);
  expect(upgraded.migrationPlan.upgrades.filter(item => item.owner === "kernel").every(item => item.kind === "keep")).toBe(true);
  console.log("Marketplace discount upgrade: compile clean target initialization");
  const clean = await compileFreshPackages({ packages: targets.map(item => item.prepared), persistenceMode: "classical" });
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256(new Uint8Array(await readFile(binary)))).toBe("f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4");
  const temporary = await mkdtemp(path.join(tmpdir(), "marketplace-discount-upgrade-"));
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  try {
    const launched = await launchPocketIc(binary, temporary);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"), true);
    instanceId = created.instanceId;
    const direct = new DirectPocketIcCalls(client, instanceId);
    const deployer = Principal.selfAuthenticating(new Uint8Array(32).fill(171));
    const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(172));
    async function initialize(archives: PreparedArchive[], compiled: CompileResult, activationByte: number) {
      const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
      await fundIcp(direct, canister, 200_000_000n);
      await direct.installInitial(canister, deployer, compiled);
      await direct.setControllers(canister, deployer, [deployer, canister]);
      const options = { controlUrl: launched.controlUrl, instanceId: instanceId!, canisterId: canister.toText(), client: client! };
      const controllerActor = provision.createDirectPocketIcKernelActor({ ...options, caller: deployer });
      await provision.seedFreshKernel({ actor: controllerActor, canisterId: canister.toText(), deployment: freshDeployment(archives, compiled), concurrency: 32, logger: { log() {} } });
      const token = new Uint8Array(32).fill(activationByte);
      expect(await direct.kernelActivation(canister, deployer, { set: Uint8Array.from(Buffer.from(sha256(token), "hex")) })).toEqual({ ready: null });
      expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
      const actor = provision.createDirectPocketIcKernelActor({ ...options, caller: owner });
      const call = (name: string, method: IDL.FuncClass, args: unknown[]) => direct.actorCall(canister, owner, physicalAppMethodName("marketplace", name), method, args);
      return { canister, actor, call };
    }
    const existing = await initialize(baseline, initial, 0x91);
    const production = Principal.fromText("sj2r4-haaaa-aaaay-aadgq-cai");
    const beforeFresh = await existing.call("marketplace_state", stateMethod, [null]) as any;
    expect(beforeFresh.seed).toEqual([]);
    expect(beforeFresh.canister).toEqual([production]);
    const seed = bytes("01234567890123456789012345678901");
    ok(await existing.call("marketplace_initialize", initializeMethod, [seed]));
    const configuredProtocol = predecessor.memoryVersion === 2 ? Principal.selfAuthenticating(new Uint8Array(32).fill(173)) : production;
    ok(await existing.call("marketplace_configure", configureMethod, [{ canister: configuredProtocol, host: "https://icp0.io" }]));
    const originalPurchase = bytes('{"version":1,"kind":"purchase","id":"retained-purchase","referralCode":"ORIGINAL","status":"prepared"}');
    const pendingPurchase = bytes('{"version":1,"kind":"purchase","id":"retained-purchase","referralCode":"ORIGINAL","status":"submitted","requestId":"same-request"}');
    const originalInstall = bytes('{"version":1,"kind":"installation","id":"retained-install","status":"prepared","setupUrl":"https://example.test/original-saved-offer"}');
    const pendingInstall = bytes('{"version":1,"kind":"installation","id":"retained-install","status":"review_required","setupUrl":"https://example.test/original-saved-offer"}');
    ok(await existing.call("marketplace_save_draft", saveDraftMethod, [{ id: "retained-purchase", value: originalPurchase }]));
    ok(await existing.call("marketplace_revise_draft", reviseDraftMethod, [{ id: "retained-purchase", expected: originalPurchase, value: pendingPurchase, revision: "submitted" }]));
    ok(await existing.call("marketplace_save_draft", saveDraftMethod, [{ id: "retained-install", value: originalInstall }]));
    ok(await existing.call("marketplace_revise_draft", reviseDraftMethod, [{ id: "retained-install", expected: originalInstall, value: pendingInstall, revision: "review-required" }]));
    const retainedDiscount = predecessor.memoryVersion === 2 ? ["RETAINED118"] : [];
    if (predecessor.memoryVersion === 2) {
      expect(ok<string[]>(await existing.call("marketplace_set_discount_code", saveDiscountMethod, [{ code: [" retained118 "] }]))).toEqual(retainedDiscount);
      expect(await existing.call("marketplace_discount_code", discountMethod, [null])).toEqual(retainedDiscount);
    }
    const savedDrafts = await existing.call("marketplace_drafts", draftsMethod, [{ cursor: [], limit: 100n }]) as any;
    expect(savedDrafts.items).toHaveLength(4);
    expect(savedDrafts.nextCursor).toEqual([]);
    const rootKey = ok<Uint8Array>(await existing.call("marketplace_read_key", readKeyMethod, [null]));
    expect(rootKey.length).toBe(33);
    const sessionPublicKey = Uint8Array.from(Buffer.from("302a300506032b65700321007bc3079518ed11da0336085bf6962920ff87fb3c4d630a9b58cb6153674f5dd6", "hex"));
    const delegation = ok<any>(await existing.call("marketplace_read_identity", readIdentityMethod, [{ publicKey: sessionPublicKey }]));
    expect(delegation.publicKey).toEqual(rootKey);
    const stateSnapshot = await existing.call("marketplace_state", stateMethod, [null]) as any;
    expect(stateSnapshot.seed).toEqual([seed]);
    expect(stateSnapshot.canister).toEqual([configuredProtocol]);
    expect(stateSnapshot.host).toBe("https://icp0.io");
    expect(stateSnapshot.revision).toBe(3n);
    const savedState = stateJson(stateSnapshot);
    const before = await existing.actor.kernel_runtime_info();
    expect(normalizeMemoryInventory(before.memories)).toContainEqual(["marketplace", "state", predecessor.memoryVersion]);
    console.log(`Marketplace discount upgrade: checked install of successor over saved v${predecessor.memoryVersion} identity, journals and discount`);
    const installed = await deployExactTransition({ actor: existing.actor, canisterId: existing.canister, packages: [next.prepared], state, compiled: upgraded, expectedDeploymentId: initial.deploymentId });
    const after = await existing.actor.kernel_runtime_info();
    expect(after.deployment_id).toBe(installed.compiled.deploymentId);
    expect(await existing.actor.kernel_install_status(null)).toEqual([]);
    expect(normalizeMemoryInventory(after.memories)).toContainEqual(["marketplace", "state", 2]);
    for (const beforeApp of normalizeAppInstances(before.apps)) {
      const afterApp = requiredAppInstance(normalizeAppInstances(after.apps), beforeApp.scope.app_id);
      expect(afterApp.scope).toEqual(beforeApp.scope);
      expect(afterApp.browser_origin_nonce).toBe(beforeApp.browser_origin_nonce);
      expect(afterApp.browser_origin_authority_epoch).toBe(beforeApp.browser_origin_authority_epoch);
    }
    expect(requiredAppInstance(normalizeAppInstances(after.apps), "kernel").version).toBe(359);
    expect(requiredAppInstance(normalizeAppInstances(after.apps), "marketplace").version).toBe(candidateVersion);
    expect(stateJson(await existing.call("marketplace_state", stateMethod, [null]))).toBe(savedState);
    expect(await existing.call("marketplace_discount_code", discountMethod, [null])).toEqual(retainedDiscount);
    expect(await existing.call("marketplace_drafts", draftsMethod, [{ cursor: [], limit: 100n }])).toEqual(savedDrafts);
    expect(await existing.call("marketplace_draft", draftMethod, ["retained-purchase"])).toEqual([pendingPurchase]);
    expect(await existing.call("marketplace_draft", draftMethod, ["retained-install"])).toEqual([pendingInstall]);
    expect(await existing.call("marketplace_draft", draftMethod, ["history:retained-purchase:submitted"])).toEqual([originalPurchase]);
    expect(await existing.call("marketplace_draft", draftMethod, ["history:retained-install:review-required"])).toEqual([originalInstall]);
    expect(ok<Uint8Array>(await existing.call("marketplace_read_key", readKeyMethod, [null]))).toEqual(rootKey);
    const restoredDelegation = ok<any>(await existing.call("marketplace_read_identity", readIdentityMethod, [{ publicKey: sessionPublicKey }]));
    expect(restoredDelegation.publicKey).toEqual(rootKey);
    expect(restoredDelegation.sessionPublicKey).toEqual(delegation.sessionPublicKey);
    expect(restoredDelegation.expiration).toBe(delegation.expiration);
    expect(restoredDelegation.target).toEqual(delegation.target);
    expect(restoredDelegation.target).toEqual(configuredProtocol);
    expect(restoredDelegation.signature).toHaveLength(64);
    for (const [input, expected] of [[" \t welcome10\n", ["WELCOME10"]], ["next10", ["NEXT10"]], [null, []], [" \r\n ", []]] as const) {
      expect(ok<readonly string[]>(await existing.call("marketplace_set_discount_code", saveDiscountMethod, [{ code: input === null ? [] : [input] }]))).toEqual(expected);
      expect(await existing.call("marketplace_discount_code", discountMethod, [null])).toEqual(expected);
      expect(stateJson(await existing.call("marketplace_state", stateMethod, [null]))).toBe(savedState);
      expect(await existing.call("marketplace_drafts", draftsMethod, [{ cursor: [], limit: 100n }])).toEqual(savedDrafts);
    }
    console.log("Marketplace discount upgrade: verify clean v2 installation defaults");
    const fresh = await initialize(targets, clean, 0x92);
    const freshState = await fresh.call("marketplace_state", stateMethod, [null]) as any;
    expect(freshState.seed).toEqual([]);
    expect(freshState.canister).toEqual([production]);
    expect(freshState.host).toBe("https://icp-api.io");
    expect(freshState.revision).toBe(1n);
    expect(await fresh.call("marketplace_discount_code", discountMethod, [null])).toEqual([]);
    expect(await fresh.call("marketplace_draft", draftMethod, ["retained-purchase"])).toEqual([]);
    expect(ok<string[]>(await fresh.call("marketplace_set_discount_code", saveDiscountMethod, [{ code: ["fresh10"] }]))).toEqual(["FRESH10"]);
    expect(await fresh.call("marketplace_discount_code", discountMethod, [null])).toEqual(["FRESH10"]);
    expect(normalizeMemoryInventory((await fresh.actor.kernel_runtime_info()).memories)).toEqual(normalizeMemoryInventory(after.memories));
    expect(direct.externalInstallModes).toEqual(["install", "install"]);
    const output = path.resolve(process.env.NEUTRON_MARKETPLACE_DISCOUNT_EVIDENCE_DIR ?? "/tmp/marketplace-discount-upgrade-evidence");
    await mkdir(output, { recursive: true });
    const receipt = {
      status: "passed", qualification: `marketplace${predecessor.version}-state${predecessor.memoryVersion}-to-state2`,
      scope: "Exact released archives and immutable memory source/lock lineage, generated actor compatibility, one checked app upgrade, retained complete state root, read key/delegation and original/revised journal bytes/history, clean v2 initialization. No browser or protocol financial calls.",
      kernel: { version: 359, sha256: sha256(kernel.archive) },
      predecessor: { version: predecessor.version, memoryVersion: predecessor.memoryVersion, sha256: sha256(previous.archive), size: previous.archive.byteLength },
      successor: { version: candidateVersion, sha256: sha256(next.archive) },
      migrationPlan: upgraded.migrationPlan,
      runtimeMemories: normalizeMemoryInventory(after.memories),
      deploymentBefore: before.deployment_id, deploymentAfter: after.deployment_id,
      readPublicKeySha256: sha256(rootKey), journalSha256: [pendingPurchase, pendingInstall, originalPurchase, originalInstall].map(sha256),
      retainedDiscount, retainedStateSha256: sha256(bytes(savedState)),
      externalInstallModes: direct.externalInstallModes,
    };
    const receiptName = predecessor.memoryVersion === 1 ? "receipt.json" : "receipt-state2.json";
    await writeFile(path.join(output, receiptName), JSON.stringify(receipt, null, 2) + "\n");
    console.log(`Marketplace discount upgrade passed; evidence ${path.join(output, receiptName)}`);
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
