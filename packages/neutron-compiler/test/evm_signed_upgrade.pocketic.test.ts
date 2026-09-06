/**
 * Exact published EVM101 signed-state successor qualification, opt-in only.
 *
 * NEUTRON_RUN_EVM_SIGNED_UPGRADE_POCKETIC=1
 * NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256='{"evm_wallet":"<sha256>",...}'
 * NEUTRON_POCKETIC_BIN=<pinned pocket-ic14 path>
 * NEUTRON_EVM_SIGNED_UPGRADE_EVIDENCE_DIR=<independent release evidence dir>
 * bun test packages/neutron-compiler/test/evm_signed_upgrade.pocketic.test.ts
 *
 * By default this requires an actual EVM successor. Before final archives exist,
 * NEUTRON_EVM_SIGNED_UPGRADE_TARGET=hello exercises the fixture with a checked
 * Hello201 install, explicitly recorded as fixture qualification, not a release.
 * No published archive/schema/lineage is rewritten. All runtime instances are
 * isolated and temporary; external install_code initializes new local canisters
 * only, and the existing Neutron changes via its checked install transaction.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { compileFreshPackages, compilePackages, type CompileResult } from "../src/install.ts";
import {
  DirectPocketIcCalls, createApplicationInstance, deployExactTransition,
  freshDeployment, freshPackageState, fundIcp, launchPocketIc,
  loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
  requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  type DirectPocketIcClient, type PreparedArchive,
} from "./legacy_kernel_upgrade.pocketic.test.ts";
import { predecessor, reviewedCandidate, repositoryRoot, sha256, type CandidateId } from "./evm_wallet_upgrade/archives.ts";
import { compileLocalFixture, installLocalFixture } from "./evm_wallet_upgrade/actor_fixtures.ts";
import { seedExistingApps, seedKernelState } from "./evm_wallet_upgrade/existing_apps.ts";
import { assertNewAppsFresh, seedAndCaptureNewApps, evmUpgradeMethods, upgradeSwapListMethod, type CallApp } from "./evm_wallet_upgrade/new_apps.ts";
import { seedSignedPending, signedRpcPrincipal } from "./evm_wallet_upgrade/evm_signed_pending.ts";

const qualify = process.env.NEUTRON_RUN_EVM_SIGNED_UPGRADE_POCKETIC === "1" ? test : test.skip;
const binaryDigest = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const principal = (seed: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(seed));
const describeArchive = ({ archive, prepared }: PreparedArchive) => ({ id: prepared.manifest.id, version: prepared.manifest.version, bytes: archive.byteLength, sha256: sha256(archive) });

qualify("published EVM101 signed bytes and nonce survive checked successor upgrade without resigning", async () => {
  const fixtureOnly = process.env.NEUTRON_EVM_SIGNED_UPGRADE_TARGET === "hello";
  const label = fixtureOnly ? "evm101-signed-hello-fixture" : "evm101-signed-successor";
  const baseline = await Promise.all([
    predecessor("kernel339"), predecessor("wallet315"), predecessor("kitchensink314"),
    predecessor("evm_wallet101"), predecessor("uniswap102"), predecessor("contacts306"),
  ]);
  const baselineById = new Map(baseline.map((entry) => [entry.prepared.manifest.id, entry]));
  let candidates: PreparedArchive[];
  if (fixtureOnly) {
    candidates = [await predecessor("hello201")];
  } else {
    const raw = process.env.NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256;
    if (!raw) throw new Error("Supply reviewed successor archive pins");
    const pins = JSON.parse(raw) as Record<string, unknown>;
    const ids = ["kernel", "wallet", "kitchensink", "evm_wallet", "uniswap"] as const;
    expect(pins).toHaveProperty("evm_wallet");
    for (const id of Object.keys(pins)) expect(ids.includes(id as CandidateId), `Unexpected candidate ${id}`).toBe(true);
    candidates = await Promise.all(ids.filter((id) => id in pins).map(reviewedCandidate));
    expect(candidates.find((entry) => entry.prepared.manifest.id === "evm_wallet")!.prepared.manifest.version).toBeGreaterThan(101);
  }
  const changed = candidates.filter((entry) => {
    const old = baselineById.get(entry.prepared.manifest.id);
    if (!old) return true;
    if (entry.prepared.manifest.version === old.prepared.manifest.version) {
      expect(sha256(entry.archive), "A retained release must keep exact published bytes").toBe(sha256(old.archive));
      return false;
    }
    expect(entry.prepared.manifest.version).toBeGreaterThan(old.prepared.manifest.version);
    return true;
  });
  const targets = new Map(baselineById);
  for (const entry of changed) targets.set(entry.prepared.manifest.id, entry);
  const targetArchives = [...targets.values()];
  const initialPackages = baseline.map((entry) => entry.prepared);
  const updatePackages = changed.map((entry) => entry.prepared);
  console.log(`${label}: compile exact published baseline`);
  const initial = await compileFreshPackages({ packages: initialPackages, persistenceMode: "classical" });
  const state = freshPackageState(initialPackages, initial);
  console.log(`${label}: compile checked successor and clean initialization`);
  const upgraded = await compilePackages({
    packages: updatePackages, existingModules: state.existingModules,
    existingConfigs: state.existingConfigs, existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable, connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical", versionPolicy: "strict-upgrade",
  });
  expect(upgraded.compatibilityDiagnostics).toEqual([]);
  expect(upgraded.managedMemoryRetirements).toEqual([]);
  expect(upgraded.migrationPlan.removedApps).toEqual([]);
  expect(upgraded.migrationPlan.destructiveMemoryRoots).toEqual([]);
  for (const entry of initial.migrationPlan.upgrades) {
    expect(upgraded.migrationPlan.upgrades.find((item) => item.owner === entry.owner && item.memoryId === entry.memoryId))
      .toMatchObject({ kind: "keep", version: entry.kind === "initialize" ? entry.to : 0 });
  }
  if (!fixtureOnly) expect(upgraded.migrationPlan.upgrades.find((entry) => entry.owner === "evm_wallet" && entry.memoryId === "evm_evidence"))
    .toMatchObject({ kind: "initialize", to: 1 });
  const clean = await compileFreshPackages({ packages: targetArchives.map((entry) => entry.prepared), persistenceMode: "classical" });
  const fixtureWasm = await compileLocalFixture(path.join(import.meta.dir, "evm_wallet_upgrade/evm_signed_rpc_fixture.mo"), path.join(repositoryRoot, "apps/evm_wallet"));

  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256(new Uint8Array(await readFile(binary)))).toBe(binaryDigest);
  const temporary = await mkdtemp(path.join(tmpdir(), "neutron-evm-signed-upgrade-"));
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
    const deployer = principal(141), owner = principal(142);
    await installLocalFixture(client, instanceId, deployer, fixtureWasm, signedRpcPrincipal);
    const initialize = async (archives: PreparedArchive[], compiled: CompileResult, activationByte: number) => {
      const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
      await fundIcp(direct, canister, 200_000_000n);
      await direct.installInitial(canister, deployer, compiled);
      await direct.setControllers(canister, deployer, [deployer, canister]);
      const actorOptions = { controlUrl: launched.controlUrl, instanceId: instanceId!, canisterId: canister.toText(), client: client! };
      const deployerActor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: deployer });
      await provision.seedFreshKernel({ actor: deployerActor, canisterId: canister.toText(), deployment: freshDeployment(archives, compiled), concurrency: 32, logger: { log() {} } });
      const token = new Uint8Array(32).fill(activationByte);
      expect(await direct.kernelActivation(canister, deployer, { set: Uint8Array.from(Buffer.from(sha256(token), "hex")) })).toEqual({ ready: null });
      expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
      const actor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: owner });
      const callApp: CallApp = (id, name, method, args) => direct.actorCall(canister, owner, physicalAppMethodName(id, name), method, args);
      return { canister, actor, callApp };
    };
    const existing = await initialize(baseline, initial, 0x81);
    await assertNewAppsFresh(existing.callApp);
    const assertExisting = await seedExistingApps(existing.callApp, direct, existing.canister, owner);
    const assertKernel = await seedKernelState(existing.callApp, direct, existing.canister, owner);
    const before = await existing.actor.kernel_runtime_info();
    const caller = requiredAppInstance(normalizeAppInstances(before.apps), "kitchensink");
    const callerIdentity = { app_id: caller.scope.app_id, installation_uid: BigInt(caller.scope.installation_uid), endpoint: "app:kitchensink:signed-upgrade-fixture" };
    await seedAndCaptureNewApps(existing.callApp, callerIdentity);
    const uniswapBefore = await existing.callApp("uniswap", "uniswap_list_v1", upgradeSwapListMethod, [null]);
    console.log(`${label}: real Kernel custody signing and uncertain first broadcast`);
    const pending = await seedSignedPending({ ...existing, direct, owner, caller: callerIdentity });
    console.log(`${label}: checked upgrade with signed operation pending`);
    const deployed = await deployExactTransition({ actor: existing.actor, canisterId: existing.canister, packages: updatePackages, state, compiled: upgraded, expectedDeploymentId: initial.deploymentId });
    const after = await existing.actor.kernel_runtime_info();
    expect(after.deployment_id).toBe(deployed.compiled.deploymentId);
    expect(await existing.actor.kernel_install_status(null)).toEqual([]);
    for (const old of normalizeAppInstances(before.apps)) {
      const current = requiredAppInstance(normalizeAppInstances(after.apps), old.scope.app_id);
      expect(current.scope).toEqual(old.scope);
      expect(current.browser_origin_nonce).toBe(old.browser_origin_nonce);
      expect(current.browser_origin_authority_epoch).toBe(old.browser_origin_authority_epoch);
    }
    for (const { prepared } of targetArchives) expect(requiredAppInstance(normalizeAppInstances(after.apps), prepared.manifest.id).version).toBe(prepared.manifest.version);
    await assertExisting();
    await assertKernel();
    expect(await existing.callApp("uniswap", "uniswap_list_v1", upgradeSwapListMethod, [null])).toEqual(uniswapBefore);
    if (!fixtureOnly) expect(await existing.callApp("evm_wallet", "evm_wallet_review_evidence_v1", evmUpgradeMethods.evidence, [{ identity: pending.evidence.identity, review_revision: 1n, refresh: false }]))
      .toEqual({ ok: { token_evidence: [] } });
    await pending.assertRestoredAndReconcile();
    console.log(`${label}: exact original rebroadcast and reconciliation passed; clean target initialization`);
    const fresh = await initialize(targetArchives, clean, 0x82);
    await assertNewAppsFresh(fresh.callApp);
    const freshRuntime = await fresh.actor.kernel_runtime_info();
    expect(normalizeMemoryInventory(freshRuntime.memories)).toEqual(normalizeMemoryInventory(after.memories));
    expect(await fresh.callApp("wallet", "wallet_transfers_pending_v2", IDL.Func([IDL.Null], [IDL.Vec(IDL.Reserved)], ["query"]), [null])).toEqual([]);
    expect(direct.externalInstallModes).toEqual(["install", "install"]);

    const evidence = {
      status: "passed", qualification: label, fixture_only: fixtureOnly,
      scope: "Current compiler/client checked actor upgrade and clean initialization. Real Kernel custody signing, isolated scripted RPC observations; browser and external-chain acceptance not exercised.",
      predecessors: baseline.map(describeArchive), inspected_candidates: candidates.map(describeArchive), targets: targetArchives.map(describeArchive),
      fixture_wasm_sha256: sha256(fixtureWasm), signed_pending: pending.evidence,
      deployment_id: after.deployment_id, memory_plan: upgraded.migrationPlan,
      runtime_memories: normalizeMemoryInventory(after.memories), clean_runtime_memories: normalizeMemoryInventory(freshRuntime.memories),
      external_install_modes: direct.externalInstallModes,
    };
    const output = process.env.NEUTRON_EVM_SIGNED_UPGRADE_EVIDENCE_DIR;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(path.resolve(output), `${label}.json`), JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
    }
    console.log(`${label}: signed operation checked-upgrade qualification passed`);
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
