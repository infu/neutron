/** Frozen release pair; run from the repository root with the opt-in flag and pinned PocketIC binary. Uses disposable local canisters only. */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { compileFreshPackages, compilePackages, preparePackageInstall } from "neutron-compiler/src/install.ts";
import {
  DirectPocketIcCalls, createApplicationInstance, deployExactTransition,
  freshDeployment, freshPackageState, fundIcp, launchPocketIc,
  loadProvisionHarness, normalizeAppInstances, normalizeMemoryInventory,
  requiredPocketIcBinary, stopPocketIc,
} from "../../../../packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function pinned(id: string, version: number, digest: string) {
  const archive = new Uint8Array(await readFile(`apps/${id}/${id}.v0.${Math.floor(version / 100)}.${version % 100}.neutron`));
  expect(sha(archive)).toBe(digest);
  return { archive, prepared: preparePackageInstall(archive, { expectedIdentity: { id, version, sha256: digest } }) };
}
const qualify = process.env.NEUTRON_RUN_INSTALLED_ACQUISITION_UPGRADE === "1" ? test : test.skip;
qualify("exact Kernel363 and Marketplace123 upgrade together from Kernel362 and Marketplace122", async () => {
  const previous = await Promise.all([
    pinned("kernel", 362, "253f19c9d97d8d1a2138004de98a9645d79708582db2cc9fc90df891eebd87e5"),
    pinned("marketplace", 122, "ebce4f77fc05285a5f331515e42a2e9448de1d463b1fdd562c24018138640b42"),
  ]);
  const next = await Promise.all([
    pinned("kernel", 363, "bbfd5490115830ba45acc63bad6c9a9c1d7258a35cb80246c0186ac31cbe886a"),
    pinned("marketplace", 123, "74dbfa3edf839d8c80b3ded6f77fb674041bd53001164907fe888dfb70e304e2"),
  ]);
  const initial = await compileFreshPackages({ packages: previous.map(p => p.prepared), persistenceMode: "classical" });
  const state = freshPackageState(previous.map(p => p.prepared), initial);
  const compiled = await compilePackages({ packages: next.map(p => p.prepared),
    existingModules: state.existingModules, existingConfigs: state.existingConfigs, existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable, connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical", versionPolicy: "strict-upgrade" });
  expect(compiled.compatibilityDiagnostics).toEqual([]);
  expect(compiled.migrationPlan.destructiveMemoryRoots).toEqual([]);
  expect(compiled.migrationPlan.removedApps).toEqual([]);
  expect(compiled.migrationPlan.upgrades).toHaveLength(5);
  expect(compiled.migrationPlan.upgrades.every(root => root.kind === "keep")).toBe(true);
  const temporary = await mkdtemp(path.join(tmpdir(), "marketplace-paired-upgrade-"));
  const provision = await loadProvisionHarness();
  const launched = await launchPocketIc(requiredPocketIcBinary(), temporary);
  const client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
  let instanceId: number | undefined;
  try {
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"), true);
    instanceId = created.instanceId;
    const direct = new DirectPocketIcCalls(client, instanceId);
    const deployer = Principal.selfAuthenticating(new Uint8Array(32).fill(181));
    const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(182));
    const canister = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
    await fundIcp(direct, canister, 200_000_000n);
    await direct.installInitial(canister, deployer, initial);
    await direct.setControllers(canister, deployer, [deployer, canister]);
    const options = { controlUrl: launched.controlUrl, instanceId, canisterId: canister.toText(), client };
    const controller = provision.createDirectPocketIcKernelActor({ ...options, caller: deployer });
    await provision.seedFreshKernel({ actor: controller, canisterId: canister.toText(), deployment: freshDeployment(previous, initial), concurrency: 32, logger: { log() {} } });
    const token = new Uint8Array(32).fill(183);
    expect(await direct.kernelActivation(canister, deployer, { set: Uint8Array.from(Buffer.from(sha(token), "hex")) })).toEqual({ ready: null });
    expect(await direct.kernelActivation(canister, owner, { use: token })).toEqual({ authorized: null });
    const actor = provision.createDirectPocketIcKernelActor({ ...options, caller: owner });
    const preferences = IDL.Record({ beta_enabled: IDL.Bool, revision: IDL.Nat });
    const readPreferences = () => direct.actorCall(canister, owner, "get_release_preferences", IDL.Func([IDL.Null], [preferences], ["query"]), [null]);
    expect(await direct.actorCall(canister, owner, "set_release_preferences", IDL.Func([IDL.Bool], [preferences], []), [true])).toEqual({ beta_enabled: true, revision: 1n });
    const blob = IDL.Vec(IDL.Nat8), journal = new TextEncoder().encode('{"kind":"purchase","requestId":"retained","state":"review_required"}');
    const save = IDL.Func([IDL.Record({ id: IDL.Text, value: blob })], [IDL.Variant({ ok: IDL.Text, err: IDL.Text })], []);
    expect(await direct.actorCall(canister, owner, physicalAppMethodName("marketplace", "marketplace_save_draft"), save, [{ id: "retained", value: journal }])).toEqual({ ok: "retained" });
    const readJournal = () => direct.actorCall(canister, owner, physicalAppMethodName("marketplace", "marketplace_draft"), IDL.Func([IDL.Text], [IDL.Opt(blob)], ["query"]), ["retained"]);
    expect(await readJournal()).toEqual([journal]);
    const before = await actor.kernel_runtime_info();
    await deployExactTransition({ actor, canisterId: canister, packages: next.map(p => p.prepared), state, compiled, expectedDeploymentId: initial.deploymentId });
    const after = await actor.kernel_runtime_info();
    expect(normalizeMemoryInventory(after.memories)).toEqual(normalizeMemoryInventory(before.memories));
    expect(normalizeAppInstances(after.apps).map(app => [app.scope.app_id, app.version]).sort()).toEqual([["kernel", 363], ["marketplace", 123]]);
    expect(normalizeAppInstances(after.apps).map(app => app.scope)).toEqual(normalizeAppInstances(before.apps).map(app => app.scope));
    expect(await actor.kernel_install_status(null)).toEqual([]);
    expect(await readPreferences()).toEqual({ beta_enabled: true, revision: 1n });
    expect(await readJournal()).toEqual([journal]);
    expect(direct.externalInstallModes).toEqual(["install"]);
    const result = { status: "passed", qualification: "paired-checked-upgrade", packages: next.map(p => ({ id: p.prepared.manifest.id, version: p.prepared.manifest.version, sha256: sha(p.archive) })),
      predecessors: previous.map(p => ({ id: p.prepared.manifest.id, version: p.prepared.manifest.version, sha256: sha(p.archive) })),
      migrationPlan: compiled.migrationPlan, retainedBetaPreferences: true, retainedMarketplaceJournalSha256: sha(journal),
      externalInstallModes: direct.externalInstallModes, deploymentBefore: before.deployment_id, deploymentAfter: after.deployment_id };
    const output = ".neutron/release-receipts/marketplace-ownership-2026-09-13/paired-upgrade.json";
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  } finally {
    if (instanceId !== undefined) await client.deleteInstance(instanceId);
    await stopPocketIc(launched.server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
