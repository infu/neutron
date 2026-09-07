/**
 * Exact-archive qualification of the explicitly selected fresh-account cutover.
 *
 * NEUTRON_RUN_FRESH_CUSTODY_CUTOVER_POCKETIC=1
 * NEUTRON_FRESH_CUSTODY_CANDIDATE_SHA256='{"kernel":"<sha256>","evm_wallet":"<sha256>"}'
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic
 * NEUTRON_FRESH_CUSTODY_EVIDENCE_DIR=<release evidence directory>
 * bun test packages/neutron-compiler/test/fresh_custody_cutover.pocketic.test.ts
 *
 * Kernel344 users intentionally uninstall Wallet before upgrading, then create
 * a different account under Kernel346. New app-ID custody survives subsequent
 * Wallet reinstalls.
 * Every transition after isolated initialization uses the checked install
 * transaction. Threshold signatures are real local PocketIC signatures,
 * independently verified with ethers; no external RPC or production mutation.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { getAddress, getBytes, verifyMessage } from "ethers";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  compileAndDeployPreparedPackages, compileFreshPackages, preparePackageInstall,
  uninstallApp, type DeployPreparedPackagesResult,
} from "../src/install.ts";
import {
  DirectPocketIcCalls, advancePackageState, createApplicationInstance,
  freshDeployment, freshPackageState, fundIcp, launchPocketIc,
  loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
  requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  type DirectPocketIcClient, type PreparedArchive,
} from "./legacy_kernel_upgrade.pocketic.test.ts";
import { predecessor, repositoryRoot, sha256 } from "./evm_wallet_upgrade/archives.ts";
import { upgradeCapabilityPageMethod, type Capability } from "./evm_wallet_upgrade/existing_apps.ts";
import { evmUpgradeMethods, type CallApp } from "./evm_wallet_upgrade/new_apps.ts";

const qualify = process.env.NEUTRON_RUN_FRESH_CUSTODY_CUTOVER_POCKETIC === "1" ? test : test.skip;
const pocketIcDigest = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const principal = (seed: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(seed));
const describeArchive = ({ archive, prepared }: PreparedArchive) => ({
  id: prepared.manifest.id, version: prepared.manifest.version,
  bytes: archive.byteLength, sha256: sha256(archive),
});
type Account = {
  id: string; slot: string; address: string; public_key: Uint8Array;
  key_fingerprint: Uint8Array; namespace_version: bigint;
};
type Operation = { status: string; address: string; review_revision: bigint; signature: [] | [string] };
const account = IDL.Record({
  id: IDL.Text, slot: IDL.Text, address: IDL.Text, public_key: IDL.Vec(IDL.Nat8),
  key_fingerprint: IDL.Vec(IDL.Nat8), namespace_version: IDL.Nat,
});
const accountsMethod = IDL.Func([IDL.Null], [IDL.Variant({ ok: IDL.Vec(account), err: IDL.Text })], []);
const helloMethod = IDL.Func([IDL.Text], [IDL.Text], []);
const setCapabilityMethod = IDL.Func([IDL.Record({
  app_id: IDL.Text, installation_uid: IDL.Nat64,
  kind: IDL.Variant({ wallet_custody_signing: IDL.Null }),
  resource_id: IDL.Text, enabled: IDL.Bool,
})], [IDL.Reserved], []);

function ok<T>(value: unknown): T {
  expect(value).toHaveProperty("ok");
  expect(value).not.toHaveProperty("err");
  return (value as { ok: T }).ok;
}

async function archive(id: "kernel" | "evm_wallet", version: number, digest: string): Promise<PreparedArchive> {
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  const semver = `${Math.floor(version / 10_000)}.${Math.floor(version / 100) % 100}.${version % 100}`;
  const bytes = new Uint8Array(await readFile(path.join(repositoryRoot, "apps", id, `${id}.v${semver}.neutron`)));
  expect(sha256(bytes), `${id}${version} immutable archive digest`).toBe(digest);
  return { archive: bytes, prepared: preparePackageInstall(bytes, { expectedIdentity: { id, version, sha256: digest } }) };
}

qualify("explicit pre-upgrade Wallet uninstall creates fresh app-ID custody while checked upgrades preserve unrelated state", async () => {
  const rawPins = process.env.NEUTRON_FRESH_CUSTODY_CANDIDATE_SHA256;
  if (!rawPins) throw new Error("Supply reviewed Kernel346 and EVM Wallet119 archive SHA-256 pins");
  const pins = JSON.parse(rawPins) as Record<string, string>;
  expect(Object.keys(pins).sort()).toEqual(["evm_wallet", "kernel"]);
  const [kernel344, wallet117, hello, kernel, wallet] = await Promise.all([
    archive("kernel", 344, "89fb9872b41460e39942cd33a8e984ad47104c0624fa15102416f6e09c6cec75"),
    archive("evm_wallet", 117, "fc299ca5292761bd6b300b9fd3205843788972594a37c4376f4a6a9f16f37b4c"),
    predecessor("hello201"), archive("kernel", 346, pins.kernel!), archive("evm_wallet", 119, pins.evm_wallet!),
  ]);
  const selections = [
    { name: "kernel344-explicit-fresh-account", archives: [kernel344, wallet117, hello], namespace: 1n },
    { name: "kernel346-clean-initialization", archives: [kernel, wallet, hello], namespace: 2n },
  ];
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256(new Uint8Array(await readFile(binary)))).toBe(pocketIcDigest);
  const temporary = await mkdtemp(path.join(tmpdir(), "neutron-fresh-custody-cutover-"));
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  const scenarios: Record<string, unknown>[] = [];
  try {
    const launched = await launchPocketIc(binary, temporary);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
    for (const selection of selections) {
      console.log(`fresh custody cutover: ${selection.name}, compile and initialize exact predecessor`);
      const initial = await compileFreshPackages({ packages: selection.archives.map(entry => entry.prepared), persistenceMode: "classical" });
      const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, selection.name), true);
      instanceId = created.instanceId;
      const direct = new DirectPocketIcCalls(client, instanceId);
      const deployer = principal(201), owner = principal(202), additionalOwner = principal(203);
      const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
      await fundIcp(direct, canister, 200_000_000n);
      let state = freshPackageState(selection.archives.map(entry => entry.prepared), initial);
      let deploymentId = initial.deploymentId;
      await direct.installInitial(canister, deployer, initial);
      await direct.setControllers(canister, deployer, [deployer, canister]);
      const actorOptions = { controlUrl: launched.controlUrl, instanceId, canisterId: canister.toText(), client };
      const deployerActor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: deployer });
      await provision.seedFreshKernel({ actor: deployerActor, canisterId: canister.toText(), deployment: freshDeployment(selection.archives, initial), concurrency: 32, logger: { log() {} } });
      const token = new Uint8Array(32).fill(0xb9);
      expect(await direct.kernelActivation(canister, deployer, { set: Uint8Array.from(Buffer.from(sha256(token), "hex")) })).toEqual({ ready: null });
      expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
      const actor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: owner });
      const callApp: CallApp = (id, name, method, args) => direct.actorCall(canister, owner, physicalAppMethodName(id, name), method, args);
      const currentWallet = async () => requiredAppInstance(normalizeAppInstances((await actor.kernel_runtime_info()).apps), "evm_wallet");
      const custody = async (): Promise<Capability[]> => {
        const entries: Capability[] = [];
        let after: [] | [string] = [];
        do {
          const page = await direct.actorCall(canister, owner, "kernel_capabilities_page", upgradeCapabilityPageMethod, [{ after, limit: 100n }]) as { entries: Capability[]; next: [] | [string] };
          entries.push(...page.entries);
          after = page.next;
        } while (after.length !== 0);
        return entries.filter(row => row.scope.app_id === "evm_wallet" && "wallet_custody_signing" in row.kind);
      };
      const readAccount = async () => {
        const accounts = ok<Account[]>(await callApp("evm_wallet", "evm_wallet_accounts_v1", accountsMethod, [null]));
        expect(accounts).toHaveLength(1);
        return accounts[0]!;
      };
      const sign = async (requestId: string) => {
        const installed = await currentWallet();
        const identity = { caller: {
          app_id: "evm_wallet", installation_uid: BigInt(installed.scope.installation_uid), endpoint: "app:evm_wallet:fresh-custody-cutover-test",
        }, request_id: requestId };
        const message = "0x66726573682d6170702d69642d637573746f6479";
        const prepared = ok<Operation>(await callApp("evm_wallet", "evm_wallet_prepare_v1", evmUpgradeMethods.prepare, [{
          identity, intent: { account_id: "main", chain_id: 1n, operation: { personal_message: { message } } },
        }]));
        expect(prepared.status).toBe("prepared");
        const before = (await custody())[0]!;
        const signed = ok<Operation>(await callApp("evm_wallet", "evm_wallet_execute_v1", evmUpgradeMethods.execute, [{ identity, review_revision: prepared.review_revision }]));
        expect(signed.status).toBe("signed");
        expect(signed.signature).toHaveLength(1);
        expect(verifyMessage(getBytes(message), signed.signature[0]!)).toBe(getAddress(signed.address));
        expect((await custody())[0]!.usage.succeeded).toBe(before.usage.succeeded! + 1n);
        return { address: signed.address, signature: signed.signature[0], message, installation_uid: installed.scope.installation_uid };
      };
      // Keep populated independent application memory and representative Kernel
      // core state alive through every checked removal, upgrade and reinstall.
      const marker = `retained unrelated state: ${selection.name}`;
      const markerPath = "/custody-cutover-unrelated-state.txt";
      await callApp("hello", "hello_world", helloMethod, [marker]);
      await direct.actorCall(canister, owner, "kernel_authorized_add", IDL.Func([IDL.Principal], [IDL.Null], []), [additionalOwner]);
      await actor.kernel_static({ store: { key: markerPath, val: { chunks: 1n, content: new TextEncoder().encode(marker), content_encoding: "identity", content_type: "text/plain" } } });
      const helloScope = requiredAppInstance(normalizeAppInstances((await actor.kernel_runtime_info()).apps), "hello").scope;
      const assertUnrelatedState = async () => {
        expect(await direct.isAuthorized(canister, owner)).toBe(true);
        expect(await direct.isAuthorized(canister, additionalOwner)).toBe(true);
        expect(await direct.readTextAsset(canister, markerPath)).toBe(marker);
        expect(await callApp("hello", "hello_world", helloMethod, [marker])).toBe(marker);
        expect(requiredAppInstance(normalizeAppInstances((await actor.kernel_runtime_info()).apps), "hello").scope).toEqual(helloScope);
      };
      await assertUnrelatedState();
      const originalWallet = await currentWallet();
      const originalAccount = await readAccount();
      expect(originalAccount.namespace_version).toBe(selection.namespace);
      const originalSignature = await sign("11111111111111111111111111111111");
      expect(originalSignature.address).toBe(originalAccount.address);
      const removals: DeployPreparedPackagesResult["compiled"]["migrationPlan"][] = [];
      const removeWallet = async () => {
        const removed = await uninstallApp({ actor, targetCanisterId: canister.toText(), state, appId: "evm_wallet", expectedDeploymentId: deploymentId });
        state = advancePackageState(state, [], removed, ["evm_wallet"]);
        deploymentId = removed.compiled.deploymentId;
        removals.push(removed.compiled.migrationPlan);
        const runtime = await actor.kernel_runtime_info();
        expect(normalizeAppInstances(runtime.apps).some(entry => entry.scope.app_id === "evm_wallet")).toBe(false);
        expect(normalizeMemoryInventory(runtime.memories).some(([owner]) => owner === "evm_wallet")).toBe(false);
        expect(await custody()).toEqual([]);
        await assertUnrelatedState();
      };
      const installWallet = async () => {
        const installed = await compileAndDeployPreparedPackages({ actor, targetCanisterId: canister.toText(), packages: [wallet.prepared], state, expectedDeploymentId: deploymentId, verifyTimeoutMs: 120_000 });
        state = advancePackageState(state, [wallet.prepared], installed);
        deploymentId = installed.compiled.deploymentId;
        const roots = installed.compiled.migrationPlan.upgrades.filter(entry => entry.owner === "evm_wallet");
        expect(roots).toHaveLength(3);
        expect(roots.every(entry => entry.kind === "initialize")).toBe(true);
        expect((await currentWallet()).version).toBe(119);
        expect(ok<{ accounts: Account[] }>(await callApp("evm_wallet", "evm_wallet_snapshot_v1", evmUpgradeMethods.snapshot, [null])).accounts).toEqual([]);
        expect(ok<Record<string, unknown>>(await callApp("evm_wallet", "evm_wallet_history_v1", evmUpgradeMethods.history, [{ offset: 0n, limit: 10n }]))).toEqual({ operations: [], total: 0n });
        await assertUnrelatedState();
      };

      let upgradePlan: DeployPreparedPackagesResult["compiled"]["migrationPlan"] | undefined;
      if (selection.archives[0]!.prepared.manifest.version < 346) {
        console.log(`fresh custody cutover: ${selection.name}, owner-selected Wallet uninstall BEFORE Kernel upgrade`);
        await removeWallet();
        expect(requiredAppInstance(normalizeAppInstances((await actor.kernel_runtime_info()).apps), "kernel").version).toBe(selection.archives[0]!.prepared.manifest.version);
        const upgraded = await compileAndDeployPreparedPackages({ actor, targetCanisterId: canister.toText(), packages: [kernel.prepared], state, expectedDeploymentId: deploymentId, verifyTimeoutMs: 120_000 });
        state = advancePackageState(state, [kernel.prepared], upgraded);
        deploymentId = upgraded.compiled.deploymentId;
        upgradePlan = upgraded.compiled.migrationPlan;
        expect(upgradePlan.upgrades.find(entry => entry.owner === "kernel" && entry.memoryId === "kernel"))
          .toMatchObject({ kind: "keep", version: 4 });
        expect(upgradePlan.upgrades.find(entry => entry.owner === "kernel" && entry.memoryId === "kernel_activation"))
          .toMatchObject({ kind: "keep", version: 1 });
        expect(upgradePlan.destructiveMemoryRoots).toEqual([]);
        expect(upgradePlan.removedApps).toEqual([]);
        await assertUnrelatedState();
        console.log(`fresh custody cutover: ${selection.name}, install Wallet119 under Kernel346`);
        await installWallet();
        expect((await currentWallet()).scope.installation_uid).not.toBe(originalWallet.scope.installation_uid);
      }
      const cutoverAccount = await readAccount();
      expect(cutoverAccount.namespace_version).toBe(2n);
      if (selection.namespace === 1n) {
        expect(cutoverAccount.address).not.toBe(originalAccount.address);
        expect(cutoverAccount.public_key).not.toEqual(originalAccount.public_key);
        expect(cutoverAccount.key_fingerprint).not.toEqual(originalAccount.key_fingerprint);
      } else {
        expect(cutoverAccount).toEqual(originalAccount);
      }
      expect((await sign("22222222222222222222222222222222")).address).toBe(cutoverAccount.address);
      const cutoverScope = (await currentWallet()).scope;
      const cutoverOrigin = (await currentWallet()).browser_origin_nonce;
      console.log(`fresh custody cutover: ${selection.name}, prove subsequent reinstall retains app-ID custody`);
      await removeWallet();
      await installWallet();
      const reinstalled = await currentWallet();
      expect(reinstalled.scope.installation_uid).not.toBe(cutoverScope.installation_uid);
      expect(reinstalled.browser_origin_nonce).not.toBe(cutoverOrigin);
      const resources = await custody();
      expect(resources).toHaveLength(1);
      expect(resources[0]!.scope.installation_uid).toBe(BigInt(reinstalled.scope.installation_uid));
      // Reinstalled custody needs only the normal capability grant. Disabled
      // access is denied even though the deterministic key still exists.
      const setEnabled = async (enabled: boolean) => direct.actorCall(canister, owner, "kernel_capability_set_enabled", setCapabilityMethod, [{ ...resources[0]!.scope, kind: resources[0]!.kind, resource_id: resources[0]!.resource_id, enabled }]);
      await setEnabled(false);
      expect(await callApp("evm_wallet", "evm_wallet_accounts_v1", accountsMethod, [null])).toHaveProperty("err");
      await setEnabled(true);
      const reinstalledAccount = await readAccount();
      expect(reinstalledAccount).toEqual(cutoverAccount);
      const finalSignature = await sign("33333333333333333333333333333333");
      expect(finalSignature.address).toBe(cutoverAccount.address);
      expect(await actor.kernel_install_status(null)).toEqual([]);
      expect(direct.externalInstallModes).toEqual(["install"]);
      await assertUnrelatedState();
      scenarios.push({ scenario: selection.name, predecessor_archives: selection.archives.map(describeArchive),
        original_account: originalAccount, cutover_account: cutoverAccount, reinstalled_account: reinstalledAccount,
        original_scope: originalWallet.scope, cutover_scope: cutoverScope, reinstalled_scope: reinstalled.scope,
        original_signature: originalSignature, final_signature: finalSignature, upgrade_plan: upgradePlan,
        removal_plans: removals, unrelated_state: { marker, hello_scope: helloScope, additional_owner: additionalOwner.toText() },
        final_memories: normalizeMemoryInventory((await actor.kernel_runtime_info()).memories), external_install_modes: direct.externalInstallModes });
      await client.deleteInstance(instanceId);
      instanceId = undefined;
      await rm(path.join(temporary, selection.name), { recursive: true, force: true });
    }
    const evidence = { status: "passed", scope: "Explicit pre-upgrade Wallet uninstall; exact reviewed archives, real checked local actors and threshold signatures; no production mutation", candidates: [kernel, wallet].map(describeArchive), scenarios };
    const output = process.env.NEUTRON_FRESH_CUSTODY_EVIDENCE_DIR;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(path.resolve(output), "fresh-custody-cutover-checked-actors.json"), JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
    }
    console.log("fresh custody cutover: both checked actor scenarios passed");
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
