/**
 * Exact-package preference initialization, authorization, and checked upgrades.
 *
 * NEUTRON_RUN_RELEASE_PREFERENCES_POCKETIC=1 \
 * NEUTRON_RELEASE_PREFERENCES_CANDIDATE_SHA256=<reviewed-candidate-sha256> \
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 * bun test apps/kernel/test/release_preferences_upgrade.pocketic.test.ts
 *
 * Uses isolated disposable actors. Kernel361/362 are retained published evidence,
 * never rebuilt; both subsequent upgrades use the checked in-product install.
 * Installing Hello201 after the Kernel update exercises another actor upgrade
 * with the exact same Kernel package and preference schema, without inventing
 * an unreleased Kernel version. Browser synchronization is tested separately.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  compileFreshPackages,
  compilePackages,
  preparePackageInstall,
  type KernelPackageState,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.ts";

type PreparedArchive = Readonly<{
  archive: Uint8Array;
  prepared: PreparedPackageInstall;
}>;
type DirectCanisterCall = {
  sender: Principal;
  canisterId: Principal;
  method: string;
  payload: Uint8Array;
  effectivePrincipal?: { CanisterId: string };
};
type DirectPocketIcClient = {
  deleteInstance(instanceId: number): Promise<void>;
  queryCanister(instanceId: number, call: DirectCanisterCall): Promise<Uint8Array>;
  submitIngressMessage(instanceId: number, call: DirectCanisterCall): Promise<unknown>;
  awaitIngressMessage(instanceId: number, message: unknown): Promise<Uint8Array>;
};

// Resolve the other project's test harness at runtime so the Kernel composite
// build does not own compiler tests or their provision test dependencies.
// Import before test execution because that module also registers opt-in tests.
const harnessUrl: string = new URL(
  "../../../packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts", import.meta.url,
).href;
const checkedUpgradeHarness = process.env.NEUTRON_RUN_RELEASE_PREFERENCES_POCKETIC === "1"
  ? await import(harnessUrl) : undefined;

const qualify = process.env.NEUTRON_RUN_RELEASE_PREFERENCES_POCKETIC === "1"
  ? test : test.skip;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(151));
const deployer = Principal.selfAuthenticating(new Uint8Array(32).fill(152));
const backup = Principal.selfAuthenticating(new Uint8Array(32).fill(153));
const outsider = Principal.selfAuthenticating(new Uint8Array(32).fill(154));
const Preferences = IDL.Record({ beta_enabled: IDL.Bool, revision: IDL.Nat });
const getPreferences = IDL.Func([IDL.Null], [Preferences], ["query"]);
const setPreferences = IDL.Func([IDL.Bool], [Preferences], []);
const Blob = IDL.Vec(IDL.Nat8);
const Scope = IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64 });
const CallError = IDL.Record({ code: IDL.Text, message: IDL.Text });
const CycleRequest = IDL.Record({
  id: Blob, app_scope: Scope,
  call: IDL.Record({ canister: IDL.Principal, method: IDL.Text, args: Blob, cycles: IDL.Nat }),
  allow_partial: IDL.Bool,
});
const CycleReceipt = IDL.Record({
  request: CycleRequest, sequence: IDL.Nat, created_at: IDL.Nat64, updated_at: IDL.Nat64,
  dispatched: IDL.Bool, actual_cycles: IDL.Nat,
  result: IDL.Opt(IDL.Variant({ ok: Blob, err: CallError })),
  charged_cycles: IDL.Opt(IDL.Nat),
});
const executeCycles = IDL.Func([CycleRequest], [IDL.Variant({ ok: CycleReceipt, err: CallError })], []);
const readCycles = IDL.Func([IDL.Record({ app_scope: Scope, id: Blob })], [IDL.Opt(CycleReceipt)], ["query"]);
const RuntimeApp = IDL.Record({
  app_id: IDL.Text, version: IDL.Nat, capability_plan_fingerprint: IDL.Text,
  resident_frame_security: IDL.Variant({
    credentialless_opaque_v1: IDL.Null, credentialless_ephemeral_dedicated_v1: IDL.Null,
    persistent_dedicated_v1: IDL.Null,
  }),
});
const beginChecked = IDL.Func([IDL.Record({
  journal: IDL.Record({
    deployment_id: IDL.Text,
    copies: IDL.Vec(IDL.Record({ source: IDL.Text, target: IDL.Text })),
    clear_prefixes: IDL.Vec(IDL.Text), target_app_inventory: IDL.Vec(RuntimeApp),
  }),
  expected_deployment_id: IDL.Text, expected_release_preferences_revision: IDL.Opt(IDL.Nat),
})], [IDL.Null], []);
const persistence = IDL.Variant({ keep: IDL.Null, replace: IDL.Null });
const installCode = IDL.Func([IDL.Record({
  wasm: Blob, candid: IDL.Text, deployment_id: IDL.Text,
  wasm_memory_persistence: persistence, expected_release_preferences_revision: IDL.Opt(IDL.Nat),
})], [IDL.Null], []);
const installChunked = IDL.Func([IDL.Record({
  deployment_id: IDL.Text, chunk_hashes: IDL.Vec(Blob), wasm_module_hash: Blob,
  wasm_memory_persistence: persistence, expected_release_preferences_revision: IDL.Opt(IDL.Nat),
})], [IDL.Null], []);

async function archive(
  pathname: URL, id: string, version: number, expectedDigest: string, expectedBytes?: number,
): Promise<PreparedArchive> {
  const bytes = new Uint8Array(await readFile(pathname));
  expect(digest(bytes), `${id}${version} archive digest`).toBe(expectedDigest);
  if (expectedBytes !== undefined) expect(bytes.byteLength).toBe(expectedBytes);
  return { archive: bytes, prepared: preparePackageInstall(bytes, {
    expectedIdentity: { id, version, sha256: expectedDigest },
  }) };
}

async function candidateArchive(): Promise<PreparedArchive> {
  const pin = process.env.NEUTRON_RELEASE_PREFERENCES_CANDIDATE_SHA256;
  if (!pin || !/^[a-f0-9]{64}$/u.test(pin)) {
    throw new Error("Set NEUTRON_RELEASE_PREFERENCES_CANDIDATE_SHA256 to the reviewed candidate archive digest");
  }
  const manifest = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8"));
  expect(manifest.id).toBe("kernel");
  expect(manifest.version).toBeGreaterThan(361);
  const version = `${Math.floor(manifest.version / 10_000)}.${Math.floor(manifest.version / 100) % 100}.${manifest.version % 100}`;
  return archive(new URL(`../kernel.v${version}.neutron`, import.meta.url), "kernel", manifest.version, pin);
}

async function compileSuccessor(state: KernelPackageState, packages: PreparedPackageInstall[]) {
  const result = await compilePackages({
    packages, existingModules: state.existingModules,
    existingConfigs: state.existingConfigs, existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable, connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical", versionPolicy: "strict-upgrade",
  });
  expect(result.compatibilityDiagnostics).toEqual([]);
  expect(result.managedMemoryRetirements).toEqual([]);
  expect(result.migrationPlan.removedApps).toEqual([]);
  expect(result.migrationPlan.destructiveMemoryRoots).toEqual([]);
  return result;
}

for (const predecessor of [
  { version: 361, archive: "kernel.v0.3.61.neutron", digest: "34a003ee2e01d045df211c0bf52609b472956f7f9ec5085c9a045d2457ef7ca4" },
  { version: 362, archive: "kernel.v0.3.62.neutron", digest: "253f19c9d97d8d1a2138004de98a9645d79708582db2cc9fc90df891eebd87e5" },
]) qualify(`Kernel${predecessor.version} roots and release preferences survive two checked actor upgrades`, async () => {
  const {
    DirectPocketIcCalls, advancePackageState, createApplicationInstance,
    deployExactTransition, freshDeployment, freshPackageState, launchPocketIc,
    loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
    requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  } = checkedUpgradeHarness!;
  const [previous, candidate, hello] = await Promise.all([
    archive(new URL(`../${predecessor.archive}`, import.meta.url), "kernel", predecessor.version, predecessor.digest),
    candidateArchive(),
    archive(new URL("../../hello/hello.v0.2.1.neutron", import.meta.url), "hello", 201,
      "82613cc3882c7404e51e09308e27a4885062f5f622663becf18cca0a046b8c27", 185_021),
  ]);
  const retainedPreferences = predecessor.version >= 362;
  if (retainedPreferences) expect(previous.prepared.manifest.memory?.kernel_release_preferences).toMatchObject({ version: 1 });
  else expect(previous.prepared.manifest.memory?.kernel_release_preferences).toBeUndefined();
  expect(candidate.prepared.manifest.memory?.kernel_release_preferences).toMatchObject({
    version: 1, migrations: [],
  });
  console.log(`Release preferences: compiling clean target and retained Kernel${predecessor.version}`);
  const fresh = await compileFreshPackages({ packages: [candidate.prepared], persistenceMode: "classical" });
  const initial = await compileFreshPackages({ packages: [previous.prepared], persistenceMode: "classical" });
  const state = freshPackageState([previous.prepared], initial);
  const upgraded = await compileSuccessor(state, [candidate.prepared]);
  expect(upgraded.migrationPlan.upgrades).toEqual([
    { kind: "keep", owner: "kernel", memoryId: "kernel", version: 4 },
    { kind: "keep", owner: "kernel", memoryId: "kernel_activation", version: 1 },
    { kind: "keep", owner: "kernel", memoryId: "kernel_cycle_calls", version: 1 },
    retainedPreferences
      ? { kind: "keep", owner: "kernel", memoryId: "kernel_release_preferences", version: 1 }
      : { kind: "initialize", owner: "kernel", memoryId: "kernel_release_preferences", to: 1 },
  ]);
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(digest(new Uint8Array(await readFile(binary)))).toBe(
    "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4",
  );
  const temporary = await mkdtemp(path.join(tmpdir(), "neutron-release-preferences-"));
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  try {
    const launched = await launchPocketIc(binary, temporary);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"));
    instanceId = created.instanceId;
    const direct = new DirectPocketIcCalls(client, instanceId);
    const read = (canister: Principal, caller = owner) =>
      direct.actorCall(canister, caller, "get_release_preferences", getPreferences, [null]);
    const write = (canister: Principal, enabled: boolean, caller = owner) =>
      direct.actorCall(canister, caller, "set_release_preferences", setPreferences, [enabled]);
    const rejectUnauthorized = async (canister: Principal) => {
      for (const caller of [Principal.anonymous(), outsider]) {
        await expect(read(canister, caller)).rejects.toThrow();
        await expect(write(canister, false, caller)).rejects.toThrow();
      }
    };

    const cleanCanister = await direct.createCanister(owner, created.defaultEffectiveCanisterId);
    await direct.installInitial(cleanCanister, owner, fresh);
    expect(await read(cleanCanister)).toEqual({ beta_enabled: false, revision: 0n });
    expect(await write(cleanCanister, false)).toEqual({ beta_enabled: false, revision: 0n });
    expect(await write(cleanCanister, true)).toEqual({ beta_enabled: true, revision: 1n });
    await rejectUnauthorized(cleanCanister);
    expect(await read(cleanCanister)).toEqual({ beta_enabled: true, revision: 1n });

    const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
    await direct.installInitial(canister, deployer, initial);
    await direct.setControllers(canister, deployer, [deployer, canister]);
    const actorOptions = { controlUrl: launched.controlUrl, instanceId, canisterId: canister.toText(), client };
    const bootstrapActor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: deployer });
    await provision.seedFreshKernel({ actor: bootstrapActor, canisterId: canister.toText(),
      deployment: freshDeployment([previous], initial), concurrency: 32, logger: { log() {} } });
    const token = new Uint8Array(32).fill(0x67);
    expect(await direct.kernelActivation(canister, deployer, {
      set: Uint8Array.from(Buffer.from(digest(token), "hex")),
    })).toEqual({ ready: null });
    expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
    await direct.actorCall(canister, owner, "kernel_authorized_add", IDL.Func([IDL.Principal], [], []), [backup]);
    const actor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: owner });
    if (retainedPreferences) expect(await write(canister, true)).toEqual({ beta_enabled: true, revision: 1n });
    const before = await actor.kernel_runtime_info();
    const kernelScope = requiredAppInstance(normalizeAppInstances(before.apps), "kernel").scope;
    const request = {
      id: new Uint8Array(16).fill(0x68),
      app_scope: { ...kernelScope, installation_uid: BigInt(kernelScope.installation_uid) },
      call: { canister: Principal.fromText("aaaaa-aa"), method: "retained-refusal", args: new Uint8Array([9, 7, 5]), cycles: 1n },
      allow_partial: false,
    };
    // A real terminal refusal fills the released cycle root without a remote
    // dispatch. This retains request bytes, indexes, result, and sequence.
    const receipt = await direct.actorCall(canister, owner, "kernel_owner_cycle_call_execute_v1", executeCycles, [request]) as {
      ok: { dispatched: boolean; sequence: bigint; result: { err: { code: string } }[] };
    };
    expect(receipt.ok.dispatched).toBe(false);
    expect(receipt.ok.sequence).toBe(1n);
    expect(receipt.ok.result[0]?.err.code).toBe("capability_missing");
    const verifyRetainedRoots = async () => {
      expect(await direct.isAuthorized(canister, owner)).toBe(true);
      expect(await direct.isAuthorized(canister, backup)).toBe(true);
      expect(await direct.isAuthorized(canister, deployer)).toBe(false);
      expect(await direct.kernelActivation(canister, outsider, { use: token })).toEqual({ already_activated: null });
      expect(await direct.isAuthorized(canister, outsider)).toBe(false);
      expect(await direct.actorCall(canister, owner, "kernel_owner_cycle_call_status_v1", readCycles,
        [{ app_scope: request.app_scope, id: request.id }])).toEqual([receipt.ok]);
      expect(await direct.actorCall(canister, owner, "kernel_owner_cycle_call_execute_v1", executeCycles, [request])).toEqual(receipt);
      const runtime = await actor.kernel_runtime_info();
      for (const root of normalizeMemoryInventory(before.memories)) {
        expect(normalizeMemoryInventory(runtime.memories)).toContainEqual(root);
      }
      expect(requiredAppInstance(normalizeAppInstances(runtime.apps), "kernel").scope).toEqual(kernelScope);
      expect(await actor.kernel_install_status(null)).toEqual([]);
    };

    console.log(`Release preferences: checked Kernel${predecessor.version} to candidate upgrade with nonempty predecessor roots`);
    const deployed = await deployExactTransition({ actor, canisterId: canister,
      packages: [candidate.prepared], state, compiled: upgraded, expectedDeploymentId: initial.deploymentId });
    await verifyRetainedRoots();
    expect(await read(canister)).toEqual(retainedPreferences ? { beta_enabled: true, revision: 1n } : { beta_enabled: false, revision: 0n });
    expect(await write(canister, true)).toEqual({ beta_enabled: true, revision: 1n });
    expect(await write(canister, true, backup)).toEqual({ beta_enabled: true, revision: 1n });
    await rejectUnauthorized(canister);
    expect(await read(canister, backup)).toEqual({ beta_enabled: true, revision: 1n });

    const nextState = advancePackageState(state, [candidate.prepared], deployed);
    const next = await compileSuccessor(nextState, [hello.prepared]);
    expect(next.migrationPlan.upgrades.filter(({ owner }) => owner === "kernel")).toEqual([
      { kind: "keep", owner: "kernel", memoryId: "kernel", version: 4 },
      { kind: "keep", owner: "kernel", memoryId: "kernel_activation", version: 1 },
      { kind: "keep", owner: "kernel", memoryId: "kernel_cycle_calls", version: 1 },
      { kind: "keep", owner: "kernel", memoryId: "kernel_release_preferences", version: 1 },
    ]);
    console.log("Release preferences: checked Hello install with unchanged Kernel preference memory");
    let verifiedBeginGuard = false;
    let verifiedDispatchGuards = false;
    // Exercise the revision field on the wire independently of the reusable
    // provision adapter, including the stale requests that must trap.
    const guardedActor = new Proxy(actor, {
      get(target, property, receiver) {
        if (property === "kernel_install_begin_checked") return async (input: Record<string, unknown>) => {
          await expect(direct.actorCall(canister, owner, "kernel_install_begin_checked", beginChecked,
            [{ ...input, expected_release_preferences_revision: [0n] }])).rejects.toThrow();
          expect(await actor.kernel_install_status(null)).toEqual([]);
          await direct.actorCall(canister, owner, "kernel_install_begin_checked", beginChecked,
            [{ ...input, expected_release_preferences_revision: [1n] }]);
          expect(await actor.kernel_install_status(null)).toHaveLength(1);
          verifiedBeginGuard = true;
        };
        if (property === "kernel_install_code" || property === "kernel_install_code_chunked") {
          return async (input: { deployment_id: string }) => {
            const pending = await actor.kernel_install_status(null);
            const common = { deployment_id: input.deployment_id,
              wasm_memory_persistence: { keep: null }, expected_release_preferences_revision: [0n] };
            await expect(direct.actorCall(canister, owner, "kernel_install_code", installCode,
              [{ ...common, wasm: new Uint8Array(), candid: "" }])).rejects.toThrow();
            expect(await actor.kernel_install_status(null)).toEqual(pending);
            await expect(direct.actorCall(canister, owner, "kernel_install_code_chunked", installChunked,
              [{ ...common, chunk_hashes: [new Uint8Array(32)], wasm_module_hash: new Uint8Array(32) }])).rejects.toThrow();
            expect(await actor.kernel_install_status(null)).toEqual(pending);
            expect((await actor.kernel_runtime_info()).deployment_id).toBe(upgraded.deploymentId);
            verifiedDispatchGuards = true;
            return direct.actorCall(canister, owner, property,
              property === "kernel_install_code" ? installCode : installChunked,
              [{ ...input, expected_release_preferences_revision: [1n] }]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await deployExactTransition({ actor: guardedActor, canisterId: canister,
      packages: [hello.prepared], state: nextState, compiled: next, expectedDeploymentId: upgraded.deploymentId });
    expect(verifiedBeginGuard).toBe(true);
    expect(verifiedDispatchGuards).toBe(true);
    await verifyRetainedRoots();
    expect(await read(canister)).toEqual({ beta_enabled: true, revision: 1n });
    await rejectUnauthorized(canister);
    expect(await read(canister)).toEqual({ beta_enabled: true, revision: 1n });
    expect(await write(canister, false, backup)).toEqual({ beta_enabled: false, revision: 2n });
    expect(await write(canister, false)).toEqual({ beta_enabled: false, revision: 2n });
    // The cycle sequence is durable too; retries above did not allocate IDs.
    const nextReceipt = await direct.actorCall(canister, owner, "kernel_owner_cycle_call_execute_v1", executeCycles,
      [{ ...request, id: new Uint8Array(16).fill(0x69) }]) as { ok: { sequence: bigint } };
    expect(nextReceipt.ok.sequence).toBe(2n);
    expect(direct.externalInstallModes).toEqual(["install", "install"]);
    console.log(`Release preferences: passed clean install and two checked upgrades for Kernel${candidate.prepared.manifest.version} (${digest(candidate.archive)})`);
  } finally {
    if (client !== undefined && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
