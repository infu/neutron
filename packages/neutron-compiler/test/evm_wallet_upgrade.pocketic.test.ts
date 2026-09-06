/**
 * Opt-in, actual checked-upgrade qualification of the EVM Wallet release.
 *
 * NEUTRON_RUN_EVM_UPGRADE_POCKETIC=1 \
 * NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256='{"kernel":"<sha256>","wallet":"<sha256>","kitchensink":"<sha256>","evm_wallet":"<sha256>","uniswap":"<sha256>"}' \
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 * bun test packages/neutron-compiler/test/evm_wallet_upgrade.pocketic.test.ts
 *
 * Each case owns a fresh temporary PocketIC instance. One external #install
 * establishes the immutable production predecessor; every subsequent actor
 * change uses the compiler's reviewed checked install transaction. This test
 * never invokes reinstall, updates production, or rewrites release archives.
 *
 * The current install client qualifies actor state/upgrade semantics. It does
 * not claim to run an old browser compiler, browser UI, IndexedDB or reloads.
 * Run each case with -t separately when retaining evidence for a release to
 * give the large Motoko compiler a fresh process for each predecessor.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  compileFreshPackages, compilePackages,
  type CompileResult, type KernelPackageState, type PreparedPackageInstall,
} from "../src/install.ts";
import {
  DirectPocketIcCalls, advancePackageState, createApplicationInstance,
  deployExactTransition, freshDeployment, freshPackageState, fundIcp,
  launchPocketIc, loadProvisionHarness, normalizeAppInstances,
  normalizeMemoryInventory, requiredAppInstance, requiredPocketIcBinary,
  stopPocketIc, type DirectPocketIcClient,
} from "./legacy_kernel_upgrade.pocketic.test.ts";
import { predecessor, reviewedCandidate, sha256 } from "./evm_wallet_upgrade/archives.ts";
import { seedExistingApps, seedKernelState } from "./evm_wallet_upgrade/existing_apps.ts";
import { assertNewAppsFresh, seedAndCaptureNewApps, type CallApp } from "./evm_wallet_upgrade/new_apps.ts";

const qualify = process.env.NEUTRON_RUN_EVM_UPGRADE_POCKETIC === "1" ? test : test.skip;
const binaryDigest = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const principal = (seed: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(seed));

qualify("EVM release preserves Kernel336 Wallet312 Kitchen311 and new wallet journals through checked upgrades", async () => {
  await runQualification(312, true);
}, 1_800_000);

qualify("EVM release preserves skipped Wallet306 commands through checked Kernel336 successor upgrade", async () => {
  await runQualification(306, false);
}, 1_800_000);

function assertNonDestructive(compiled: CompileResult): void {
  expect(compiled.compatibilityDiagnostics).toEqual([]);
  expect(compiled.managedMemoryRetirements).toEqual([]);
  expect(compiled.migrationPlan.removedApps).toEqual([]);
  expect(compiled.migrationPlan.destructiveMemoryRoots).toEqual([]);
}

async function compileTransition(state: KernelPackageState, packages: PreparedPackageInstall[]): Promise<CompileResult> {
  const compiled = await compilePackages({
    packages,
    existingModules: state.existingModules,
    existingConfigs: state.existingConfigs,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical",
    versionPolicy: "strict-upgrade",
  });
  assertNonDestructive(compiled);
  return compiled;
}

async function runQualification(walletVersion: 306 | 312, withNewApps: boolean): Promise<void> {
  const label = `wallet${walletVersion}-kernel336-evm-release`;
  const initialArchives = await Promise.all([
    predecessor("kernel336"), predecessor("contacts305"),
    predecessor(walletVersion === 312 ? "wallet312" : "wallet306"),
    predecessor("kitchensink311"),
  ]);
  const existingCandidates = await Promise.all([
    reviewedCandidate("kernel"), reviewedCandidate("wallet"), reviewedCandidate("kitchensink"),
  ]);
  const newArchives = withNewApps ? await Promise.all([reviewedCandidate("evm_wallet"), reviewedCandidate("uniswap")]) : [];
  const hello = withNewApps ? await predecessor("hello201") : undefined;
  const initialPackages = initialArchives.map(({ prepared }) => prepared);
  const updatePackages = existingCandidates.map(({ prepared }) => prepared);

  console.log(`${label}: compiling exact predecessor archives`);
  const initial = await compileFreshPackages({ packages: initialPackages, persistenceMode: "classical" });
  let state = freshPackageState(initialPackages, initial);
  console.log(`${label}: compiling reviewed compatible successors`);
  const upgraded = await compileTransition(state, updatePackages);
  expect(upgraded.migrationPlan.upgrades.find((entry) => entry.owner === "kernel" && entry.memoryId === "kernel"))
    .toMatchObject({ kind: "migrate", from: 3, to: 4, path: [{ from: 3, to: 4 }] });
  for (const memoryId of ["wallet", "wallet_commands"]) {
    expect(upgraded.migrationPlan.upgrades.find((entry) => entry.owner === "wallet" && entry.memoryId === memoryId))
      .toMatchObject({ kind: "keep", version: 1 });
  }
  const initializedWalletRoots = ["wallet_bridge", "wallet_transfers"];
  // Later same-schema Wallet successors may add this independent journal.
  // Its absence in the first EVM release remains supported by this harness.
  if (updatePackages.find(({ manifest }) => manifest.id === "wallet")!.manifest.memory?.wallet_bridge_replacements) {
    initializedWalletRoots.push("wallet_bridge_replacements");
  }
  for (const memoryId of initializedWalletRoots) {
    expect(upgraded.migrationPlan.upgrades.find((entry) => entry.owner === "wallet" && entry.memoryId === memoryId))
      .toMatchObject({ kind: "initialize", to: 1 });
  }
  expect(upgraded.migrationPlan.upgrades.find((entry) => entry.owner === "kitchensink"))
    .toMatchObject({ kind: "keep", version: 1 });
  expect(upgraded.migrationPlan.upgrades.find((entry) => entry.owner === "kernel" && entry.memoryId === "kernel_activation"))
    .toMatchObject({ kind: "keep", version: 1 });

  // Compile every actor before creating the local instance or accepting any
  // time-limited Wallet review. These complete package-derived planning states
  // predict only code/registry metadata; deployExactTransition still binds each
  // real transition to the live predecessor journal and stable signature.
  let newCompiled: CompileResult | undefined;
  let keepCompiled: CompileResult | undefined;
  if (withNewApps) {
    const allExistingTargets = [initialArchives[1]!.prepared, ...updatePackages];
    const newPackages = newArchives.map(({ prepared }) => prepared);
    console.log(`${label}: precompiling first EVM/Uniswap installation`);
    newCompiled = await compileTransition(freshPackageState(allExistingTargets, upgraded), newPackages);
    for (const id of ["evm_wallet", "uniswap"]) {
      expect(newCompiled.migrationPlan.upgrades.find((entry) => entry.owner === id))
        .toMatchObject({ kind: "initialize", to: 1 });
    }
    console.log(`${label}: precompiling compatible journal restoration`);
    keepCompiled = await compileTransition(freshPackageState([...allExistingTargets, ...newPackages], newCompiled), [hello!.prepared]);
    for (const id of ["evm_wallet", "uniswap"]) {
      expect(keepCompiled.migrationPlan.upgrades.find((entry) => entry.owner === id))
        .toMatchObject({ kind: "keep", version: 1 });
    }
  }

  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256(new Uint8Array(await readFile(binary)))).toBe(binaryDigest);
  const temporary = await mkdtemp(path.join(tmpdir(), `neutron-${label}-`));
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  const evidence: Record<string, unknown> = {
    qualification: label,
    predecessors: initialArchives.map(({ archive, prepared }) => ({ id: prepared.manifest.id, version: prepared.manifest.version, bytes: archive.byteLength, sha256: sha256(archive) })),
    candidates: [...existingCandidates, ...newArchives].map(({ archive, prepared }) => ({ id: prepared.manifest.id, version: prepared.manifest.version, bytes: archive.byteLength, sha256: sha256(archive) })),
    scope: "checked actor upgrade via current compiler/install client; browser not exercised",
    transitions: [],
  };
  try {
    const launched = await launchPocketIc(binary, temporary);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
    // This established topology includes real ICP and a fiduciary subnet with
    // the management ECDSA key. No live Ethereum/RPC provider is contacted.
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"), true);
    instanceId = created.instanceId;
    const deployer = principal(131);
    const owner = principal(132);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
    await fundIcp(direct, canister, 200_000_000n);
    await direct.installInitial(canister, deployer, initial);
    await direct.setControllers(canister, deployer, [deployer, canister]);
    const actorOptions = { controlUrl: launched.controlUrl, instanceId, canisterId: canister.toText(), client };
    const deployerActor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: deployer });
    await provision.seedFreshKernel({ actor: deployerActor, canisterId: canister.toText(), deployment: freshDeployment(initialArchives, initial), concurrency: 32, logger: { log() {} } });
    const token = new Uint8Array(32).fill(0x71);
    expect(await direct.kernelActivation(canister, deployer, { set: Uint8Array.from(Buffer.from(sha256(token), "hex")) })).toEqual({ ready: null });
    expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
    const actor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: owner });
    const callApp: CallApp = (id, name, method, args) => direct.actorCall(canister, owner, physicalAppMethodName(id, name), method, args);
    const before = await actor.kernel_runtime_info();
    const assertExisting = await seedExistingApps(callApp, direct, canister, owner);
    const assertKernel = await seedKernelState(callApp, direct, canister, owner);
    console.log(`${label}: predecessor state seeded; checked atomic existing-app upgrade`);

    let deploymentId = initial.deploymentId;
    const transition = async (packages: PreparedPackageInstall[], compiled: CompileResult) => {
      const previous = await actor.kernel_runtime_info();
      const deployed = await deployExactTransition({ actor, canisterId: canister, packages, state, compiled, expectedDeploymentId: deploymentId });
      state = advancePackageState(state, packages, deployed);
      deploymentId = deployed.compiled.deploymentId;
      const after = await actor.kernel_runtime_info();
      expect(after.deployment_id).toBe(deploymentId);
      expect(await actor.kernel_install_status(null)).toEqual([]);
      for (const old of normalizeAppInstances(previous.apps)) {
        const current = requiredAppInstance(normalizeAppInstances(after.apps), old.scope.app_id);
        expect(current.scope).toEqual(old.scope);
        expect(current.browser_origin_nonce).toBe(old.browser_origin_nonce);
        expect(current.browser_origin_authority_epoch).toBe(old.browser_origin_authority_epoch);
      }
      (evidence.transitions as unknown[]).push({ deployment_id: deploymentId, memory_plan: compiled.migrationPlan, runtime_memories: normalizeMemoryInventory(after.memories) });
      return after;
    };
    const after = await transition(updatePackages, upgraded);
    for (const { manifest } of updatePackages) {
      expect(requiredAppInstance(normalizeAppInstances(after.apps), manifest.id).version).toBe(manifest.version);
    }
    const expectedRoots = normalizeMemoryInventory(before.memories).map<[string, string, number]>(([ownerId, id, version]) =>
      [ownerId, id, ownerId === "kernel" && id === "kernel" ? 4 : version],
    );
    expectedRoots.push(...initializedWalletRoots.map<[string, string, number]>((id) => ["wallet", id, 1]));
    expect(normalizeMemoryInventory(after.memories).sort()).toEqual(expectedRoots.sort());
    await assertExisting();
    await assertKernel();
    expect(await callApp("wallet", "wallet_transfers_pending_v2", IDL.Func([IDL.Null], [IDL.Vec(IDL.Reserved)], ["query"]), [null])).toEqual([]);
    expect(await callApp("wallet", "wallet_bridge_list_v1", IDL.Func([
      IDL.Record({ ledger: IDL.Opt(IDL.Principal), after: IDL.Opt(IDL.Vec(IDL.Nat8)), limit: IDL.Nat }),
    ], [IDL.Record({ records: IDL.Vec(IDL.Reserved), next: IDL.Opt(IDL.Vec(IDL.Nat8)) })], ["query"]), [
      { ledger: [], after: [], limit: 10n },
    ])).toEqual({ records: [], next: [] });

    if (withNewApps) {
      console.log(`${label}: checked first installation of reviewed EVM Wallet and Uniswap`);
      const packages = newArchives.map(({ prepared }) => prepared);
      const installed = await transition(packages, newCompiled!);
      await assertNewAppsFresh(callApp);
      const caller = requiredAppInstance(normalizeAppInstances(installed.apps), "kitchensink");
      const assertNew = await seedAndCaptureNewApps(callApp, {
        app_id: caller.scope.app_id,
        installation_uid: BigInt(caller.scope.installation_uid),
        endpoint: "app:kitchensink:checked-upgrade-fixture",
      });
      console.log(`${label}: checked Hello install to exercise new journal restoration`);
      await transition([hello!.prepared], keepCompiled!);
      await assertNew();
      await assertExisting();
      await assertKernel();
    }
    expect(direct.externalInstallModes).toEqual(["install"]);
    evidence.external_install_modes = direct.externalInstallModes;
    evidence.status = "passed";
    const output = process.env.NEUTRON_EVM_UPGRADE_EVIDENCE_DIR;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(path.resolve(output), `${label}.json`), JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
    }
    console.log(`${label}: exact archive checked-upgrade qualification passed`);
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}
