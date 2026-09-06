/**
 * Nonempty published Wallet315 roots through a real checked successor upgrade.
 *
 * NEUTRON_RUN_IC_WALLET_JOURNAL_UPGRADE_POCKETIC=1
 * NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256='{"kernel":"<sha256>","wallet":"<sha256>"}'
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic
 * bun test packages/neutron-compiler/test/ic_wallet_journals_upgrade.pocketic.test.ts
 *
 * Optional NEUTRON_IC_WALLET_UPGRADE_INTERIM_HELLO=1 exercises this fixture
 * against a checked Hello installation retaining Wallet315. It is explicitly
 * harness evidence only and does not qualify a higher Wallet release.
 *
 * The local canonical ledger/minter are scripted state fixtures. This checks
 * actual public Wallet methods and actor upgrades, not external protocol or
 * browser behavior. It never reinstalls or touches retained user runtimes.
 */
import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { compileFreshPackages, compilePackages } from "../src/install.ts";
import {
  DirectPocketIcCalls, createApplicationInstance, deployExactTransition,
  freshDeployment, freshPackageState, fundIcp, launchPocketIc,
  loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
  requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  type DirectPocketIcClient,
} from "./legacy_kernel_upgrade.pocketic.test.ts";
import { predecessor, reviewedCandidate, sha256 } from "./evm_wallet_upgrade/archives.ts";
import type { CallApp } from "./evm_wallet_upgrade/new_apps.ts";
import { compileJournalCanisterFixture, installJournalCanisters } from "./evm_wallet_upgrade/wallet_journal_canisters.ts";
import { seedBridgeJournals } from "./evm_wallet_upgrade/wallet_bridge_journals.ts";
import { seedTransferJournals } from "./evm_wallet_upgrade/wallet_transfer_journals.ts";

const qualify = process.env.NEUTRON_RUN_IC_WALLET_JOURNAL_UPGRADE_POCKETIC === "1" ? test : test.skip;
const principal = (seed: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(seed));
const binaryDigest = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";

qualify("published Wallet315 preserves nonempty bridge and transfer journals through a checked actor upgrade", async () => {
  const interim = process.env.NEUTRON_IC_WALLET_UPGRADE_INTERIM_HELLO === "1";
  const initialArchives = await Promise.all([predecessor("kernel339"), predecessor("contacts306"), predecessor("wallet315")]);
  const candidates = interim ? [await predecessor("hello201")] : await Promise.all([reviewedCandidate("kernel"), reviewedCandidate("wallet")]);
  if (!interim) {
    expect(candidates.find(({ prepared }) => prepared.manifest.id === "wallet")!.prepared.manifest.version).toBeGreaterThan(315);
    expect(candidates.find(({ prepared }) => prepared.manifest.id === "kernel")!.prepared.manifest.version).toBeGreaterThanOrEqual(339);
  }
  // An unchanged published Kernel is retained in the planning state; strict
  // checked upgrade applies only the packages whose versions actually advance.
  const changed = candidates.filter(({ prepared }) => !initialArchives.some((old) => old.prepared.manifest.id === prepared.manifest.id && old.prepared.manifest.version === prepared.manifest.version));
  for (const candidate of candidates.filter((entry) => !changed.includes(entry))) {
    expect(sha256(candidate.archive)).toBe(sha256(initialArchives.find((old) => old.prepared.manifest.id === candidate.prepared.manifest.id)!.archive));
  }
  const label = interim ? "wallet315-nonempty-journals-interim-hello" : `wallet315-nonempty-journals-to-wallet${candidates.find(({ prepared }) => prepared.manifest.id === "wallet")!.prepared.manifest.version}`;
  const initialPackages = initialArchives.map(({ prepared }) => prepared);
  const updatePackages = changed.map(({ prepared }) => prepared);
  console.log(`${label}: compiling pinned Kernel339 / Contacts306 / Wallet315`);
  const initial = await compileFreshPackages({ packages: initialPackages, persistenceMode: "classical" });
  const state = freshPackageState(initialPackages, initial);
  console.log(`${label}: compiling checked successor before opening any Wallet reviews`);
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
  for (const memoryId of ["wallet", "wallet_commands", "wallet_bridge", "wallet_transfers"]) {
    expect(upgraded.migrationPlan.upgrades.find((row) => row.owner === "wallet" && row.memoryId === memoryId)).toMatchObject({ kind: "keep", version: 1 });
  }
  if (!interim) {
    expect(upgraded.migrationPlan.upgrades.find((row) => row.owner === "wallet" && row.memoryId === "wallet_bridge_replacements"))
      .toMatchObject({ kind: "initialize", to: 1 });
  }
  const fixtureWasm = await compileJournalCanisterFixture();
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256(new Uint8Array(await readFile(binary)))).toBe(binaryDigest);
  const temporary = await mkdtemp(path.join(tmpdir(), "neutron-wallet-journals-upgrade-"));
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  try {
    const launched = await launchPocketIc(binary, temporary);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"), true);
    instanceId = created.instanceId;
    const deployer = principal(141);
    const owner = principal(142);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const fixtures = await installJournalCanisters(client, instanceId, direct, deployer, fixtureWasm);
    const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
    await fundIcp(direct, canister, 200_000_000n);
    await direct.installInitial(canister, deployer, initial);
    await direct.setControllers(canister, deployer, [deployer, canister]);
    const actorOptions = { controlUrl: launched.controlUrl, instanceId, canisterId: canister.toText(), client };
    const deployerActor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: deployer });
    await provision.seedFreshKernel({ actor: deployerActor, canisterId: canister.toText(), deployment: freshDeployment(initialArchives, initial), concurrency: 32, logger: { log() {} } });
    const token = new Uint8Array(32).fill(0x79);
    expect(await direct.kernelActivation(canister, deployer, { set: Uint8Array.from(Buffer.from(sha256(token), "hex")) })).toEqual({ ready: null });
    expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
    const actor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: owner });
    const callApp: CallApp = (id, name, method, args) => direct.actorCall(canister, owner, physicalAppMethodName(id, name), method, args);
    const before = await actor.kernel_runtime_info();
    console.log(`${label}: seeding actual published Wallet journal methods`);
    const transfers = await seedTransferJournals(callApp, canister, fixtures);
    const bridges = await seedBridgeJournals(callApp, canister, fixtures);
    console.log(`${label}: checked actor upgrade with all nonempty roots`);
    const deployed = await deployExactTransition({ actor, canisterId: canister, packages: updatePackages, state, compiled: upgraded, expectedDeploymentId: initial.deploymentId });
    const after = await actor.kernel_runtime_info();
    expect(after.deployment_id).toBe(deployed.compiled.deploymentId);
    expect(await actor.kernel_install_status(null)).toEqual([]);
    for (const old of normalizeAppInstances(before.apps)) {
      const current = requiredAppInstance(normalizeAppInstances(after.apps), old.scope.app_id);
      expect(current.scope).toEqual(old.scope);
      expect(current.browser_origin_nonce).toBe(old.browser_origin_nonce);
      expect(current.browser_origin_authority_epoch).toBe(old.browser_origin_authority_epoch);
    }
    for (const { manifest } of updatePackages) expect(requiredAppInstance(normalizeAppInstances(after.apps), manifest.id).version).toBe(manifest.version);
    for (const root of normalizeMemoryInventory(before.memories)) expect(normalizeMemoryInventory(after.memories)).toContainEqual(root);
    const bridgeEvidence = await bridges.verify();
    const transferEvidence = await transfers.verify();
    expect(direct.externalInstallModes).toEqual(["install"]);
    const evidence = {
      qualification: label, status: "passed", successor_release_qualified: !interim,
      scope: "actual public Wallet315 calls and checked actor upgrade; scripted local ledger/minter, no external protocol or browser proof",
      predecessors: initialArchives.map(({ archive, prepared }) => ({ id: prepared.manifest.id, version: prepared.manifest.version, bytes: archive.byteLength, sha256: sha256(archive) })),
      candidates: candidates.map(({ archive, prepared }) => ({ id: prepared.manifest.id, version: prepared.manifest.version, bytes: archive.byteLength, sha256: sha256(archive) })),
      fixture_sha256: sha256(fixtureWasm),
      deployment_id: after.deployment_id, memory_plan: upgraded.migrationPlan,
      runtime_memories: normalizeMemoryInventory(after.memories),
      before_instances: normalizeAppInstances(before.apps), after_instances: normalizeAppInstances(after.apps),
      bridge_before: bridges.before, transfer_before: transfers.before,
      bridge_retention_and_replay: bridgeEvidence, transfer_retention_and_replay: transferEvidence,
      neutron_external_install_modes: direct.externalInstallModes,
    };
    const output = process.env.NEUTRON_EVM_UPGRADE_EVIDENCE_DIR;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(path.resolve(output), `${label}.json`), JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
    }
    console.log(`${label}: all retained journal state and exact retry checks passed`);
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
