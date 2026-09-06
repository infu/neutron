/**
 * Exact batch52 K342/EVM107/Uniswap104 -> browser RPC release qualification.
 *
 * NEUTRON_RUN_EVM_BROWSER_UPGRADE_POCKETIC=1 \
 * NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256='{"kernel":"<sha256>","evm_wallet":"<sha256>","uniswap":"<sha256>"}' \
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 * NEUTRON_EVM_BROWSER_UPGRADE_EVIDENCE_DIR=<new independent directory> \
 * bun test packages/neutron-compiler/test/evm_browser_rpc_upgrade.pocketic.test.ts
 *
 * Owns a fresh temporary PocketIC server and dynamic control port, with no HTTP
 * gateway. Released bytes establish the predecessor through first install;
 * one checked install transaction updates all three apps together. A separate
 * clean canister initializes the exact successor set. No reinstall, deployment
 * config, developer gateway, production canister or release archive is changed.
 * The scripted legacy RPC actor is used only to create actual signed pending
 * state in EVM107. The successor must recover through browser-observation APIs
 * without dispatching any further call to that actor or signing again.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { compileFreshPackages, compilePackages, preparePackageInstall, type CompileResult } from "../src/install.ts";
import {
  DirectPocketIcCalls, createApplicationInstance, deployExactTransition,
  freshDeployment, freshPackageState, fundIcp, launchPocketIc,
  loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
  requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  type DirectPocketIcClient, type PreparedArchive,
} from "./legacy_kernel_upgrade.pocketic.test.ts";
import { predecessor, reviewedCandidate, repositoryRoot, sha256 } from "./evm_wallet_upgrade/archives.ts";
import { compileLocalFixture, installLocalFixture } from "./evm_wallet_upgrade/actor_fixtures.ts";
import { seedExistingApps, seedKernelState } from "./evm_wallet_upgrade/existing_apps.ts";
import { assertNewAppsFresh, seedAndCaptureNewApps, upgradeSwapListMethod, type CallApp } from "./evm_wallet_upgrade/new_apps.ts";
import { seedSignedPending, signedRpcPrincipal } from "./evm_wallet_upgrade/evm_signed_pending.ts";
import { captureBrowserRecovery, seedReleasedTokenEvidence } from "./evm_wallet_upgrade/browser_recovery.ts";

const qualify = process.env.NEUTRON_RUN_EVM_BROWSER_UPGRADE_POCKETIC === "1" ? test : test.skip;
const binaryDigest = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const principal = (seed: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(seed));
const describeArchive = ({ archive, prepared }: PreparedArchive) => ({ id: prepared.manifest.id, version: prepared.manifest.version, bytes: archive.byteLength, sha256: sha256(archive) });

// Exact immutable production catalog batch52. Never regenerate these archives.
const published = [
  { id: "kernel", version: 342, bytes: 2_448_936, sha256: "ed8dbd29b9c13e91786e3c836489ca81505d5c079884e37a573b3719be63dce4", file: "kernel.v0.3.42.neutron" },
  { id: "wallet", version: 316, bytes: 768_823, sha256: "fd15c2f0a0fa53575f11e3a97ad75f85707f2f8c238c9ed4c5b252a178219d76", file: "wallet.v0.3.16.neutron" },
  { id: "kitchensink", version: 315, bytes: 472_282, sha256: "50f6670f51364eb8b594f4fd77444ed9d900d508d917b9f0ccfb64fdcffc28b6", file: "kitchensink.v0.3.15.neutron" },
  { id: "evm_wallet", version: 107, bytes: 391_816, sha256: "ce05d6106fcfd398281411e488759d52d331d73a735cd7cc05f36574c72e4e91", file: "evm_wallet.v0.1.7.neutron" },
  { id: "uniswap", version: 104, bytes: 288_989, sha256: "63b84e763186c64f834a8c5ed15361d70bb74a5837b6d14a6e759d23b5f0c685", file: "uniswap.v0.1.4.neutron" },
] as const;

async function publishedArchive(pin: typeof published[number]): Promise<PreparedArchive> {
  const archive = new Uint8Array(await readFile(path.join(repositoryRoot, "apps", pin.id, pin.file)));
  expect(archive.byteLength, `${pin.id} published size`).toBe(pin.bytes);
  expect(sha256(archive), `${pin.id} published digest`).toBe(pin.sha256);
  return { archive, prepared: preparePackageInstall(archive, { expectedIdentity: pin }) };
}

qualify("published K342 EVM107 Uniswap104 preserve signed journals in one checked browser-RPC upgrade", async () => {
  const label = "batch52-browser-rpc-combined-upgrade";
  const rawPins = process.env.NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256;
  if (!rawPins) throw new Error("Supply reviewed successor SHA-256 pins after all packages are frozen");
  const pins = JSON.parse(rawPins) as Record<string, unknown>;
  const candidateIds = ["kernel", "evm_wallet", "uniswap"] as const;
  expect(Object.keys(pins).sort()).toEqual([...candidateIds].sort());
  const baseline = [...await Promise.all(published.map(publishedArchive)), await predecessor("contacts306")];
  const candidates = await Promise.all(candidateIds.map(reviewedCandidate));
  const targetById = new Map(baseline.map(entry => [entry.prepared.manifest.id, entry]));
  for (const candidate of candidates) {
    const prior = targetById.get(candidate.prepared.manifest.id)!;
    expect(candidate.prepared.manifest.version).toBeGreaterThan(prior.prepared.manifest.version);
    expect(candidate.prepared.manifest.memory).toEqual(prior.prepared.manifest.memory);
    targetById.set(candidate.prepared.manifest.id, candidate);
  }
  const targets = [...targetById.values()];
  const initialPackages = baseline.map(entry => entry.prepared);
  const updatePackages = candidates.map(entry => entry.prepared);
  console.log(`${label}: compile immutable released baseline`);
  const initial = await compileFreshPackages({ packages: initialPackages, persistenceMode: "classical" });
  const state = freshPackageState(initialPackages, initial);
  console.log(`${label}: compile combined checked successor and clean initialization`);
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
  expect(upgraded.migrationPlan.upgrades).toHaveLength(initial.migrationPlan.upgrades.length);
  for (const entry of initial.migrationPlan.upgrades) {
    expect(entry.kind).toBe("initialize");
    expect(upgraded.migrationPlan.upgrades.find(item => item.owner === entry.owner && item.memoryId === entry.memoryId))
      .toMatchObject({ kind: "keep", version: entry.kind === "initialize" ? entry.to : 0 });
  }
  const clean = await compileFreshPackages({ packages: targets.map(entry => entry.prepared), persistenceMode: "classical" });
  const fixtureWasm = await compileLocalFixture(path.join(import.meta.dir, "evm_wallet_upgrade/evm_signed_rpc_fixture.mo"), path.join(repositoryRoot, "apps/evm_wallet"));
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256(new Uint8Array(await readFile(binary)))).toBe(binaryDigest);
  const temporary = await mkdtemp(path.join(tmpdir(), "neutron-evm-browser-upgrade-"));
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
    const deployer = principal(145), owner = principal(146);
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
    const existing = await initialize(baseline, initial, 0x83);
    await assertNewAppsFresh(existing.callApp);
    const assertExisting = await seedExistingApps(existing.callApp, direct, existing.canister, owner);
    const assertKernel = await seedKernelState(existing.callApp, direct, existing.canister, owner);
    const before = await existing.actor.kernel_runtime_info();
    const caller = requiredAppInstance(normalizeAppInstances(before.apps), "kitchensink");
    const callerIdentity = { app_id: caller.scope.app_id, installation_uid: BigInt(caller.scope.installation_uid), endpoint: "app:kitchensink:browser-upgrade-fixture" };
    await seedAndCaptureNewApps(existing.callApp, callerIdentity);
    const swapsBefore = await existing.callApp("uniswap", "uniswap_list_v1", upgradeSwapListMethod, [null]);
    console.log(`${label}: seed real released signature with uncertain broadcast and nonempty evidence`);
    const pending = await seedSignedPending({ ...existing, direct, owner, caller: callerIdentity });
    const assertTokenEvidence = await seedReleasedTokenEvidence(existing.callApp, callerIdentity);
    const assertBrowserRecovery = await captureBrowserRecovery({ ...existing, direct, owner, signedEvidence: pending.evidence });
    console.log(`${label}: one checked transaction for all three successors`);
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
    for (const { prepared } of targets) expect(requiredAppInstance(normalizeAppInstances(after.apps), prepared.manifest.id).version).toBe(prepared.manifest.version);
    await assertExisting();
    await assertKernel();
    expect(await existing.callApp("uniswap", "uniswap_list_v1", upgradeSwapListMethod, [null])).toEqual(swapsBefore);
    await assertTokenEvidence();
    const browserRecovery = await assertBrowserRecovery();
    console.log(`${label}: retained signed bytes recovered without outcalls or resigning; clean target initialization`);
    const fresh = await initialize(targets, clean, 0x84);
    await assertNewAppsFresh(fresh.callApp);
    const freshRuntime = await fresh.actor.kernel_runtime_info();
    expect(normalizeMemoryInventory(freshRuntime.memories)).toEqual(normalizeMemoryInventory(after.memories));
    expect(await fresh.callApp("wallet", "wallet_transfers_pending_v2", IDL.Func([IDL.Null], [IDL.Vec(IDL.Reserved)], ["query"]), [null])).toEqual([]);
    expect(direct.externalInstallModes).toEqual(["install", "install"]);
    const evidence = {
      status: "passed", qualification: label,
      scope: "Exact batch52 predecessor and one combined checked actor upgrade, clean successor initialization, actual released custody signature, scripted browser-observation API recovery. No browser UI, external-chain acceptance or production financial calls.",
      predecessors: baseline.map(describeArchive), candidates: candidates.map(describeArchive), targets: targets.map(describeArchive),
      fixture_wasm_sha256: sha256(fixtureWasm), signed_pending: pending.evidence, browser_recovery: browserRecovery,
      deployment_id_before: before.deployment_id, deployment_id_after: after.deployment_id,
      memory_plan: upgraded.migrationPlan, runtime_memories: normalizeMemoryInventory(after.memories), clean_runtime_memories: normalizeMemoryInventory(freshRuntime.memories),
      external_install_modes: direct.externalInstallModes, gateway_created: false,
    };
    const output = process.env.NEUTRON_EVM_BROWSER_UPGRADE_EVIDENCE_DIR;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(path.resolve(output), `${label}.json`), JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n", { flag: "wx" });
    }
    console.log(`${label}: passed`);
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
