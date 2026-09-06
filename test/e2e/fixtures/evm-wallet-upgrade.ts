import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import type { APIRequestContext } from "@playwright/test";
import { assertPreparedPackageArchiveIdentity, preparePackageInstall, wasmMemoryPersistenceForMode, type AppRegistry, type KernelRuntimeInfo, type PreparedPackageInstall } from "neutron-compiler/src/install.js";
import { persistenceModeFromCompilerId } from "neutron-compiler/src/compile.js";
import { parseDeploymentBuildRecordJson, type CompleteDeploymentBuildRecord, type DeploymentBuildRecord } from "neutron-compiler/src/deployment_record.js";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { createKernelActor, localIdentityFromSeed } from "../../../packages/neutron-provision/src/kernel.ts";
import type { LocalNeutronRuntime } from "../../../packages/neutron-provision/src/local_session.ts";
import { assertWalletSnapshotCacheRefresh, decodeWalletUpgradeSnapshot } from "./evm-wallet-upgrade-snapshot.ts";

/**
 * Opt-in evidence helpers for actual browser Update transactions. Importing
 * this module performs no I/O. No provisioner journal is edited and no
 * install/reinstall endpoint is invoked here. Candidate versions are provided
 * in the explicit descriptor, so changing a release requires new exact pins.
 */
export type UpgradePackagePin = { id: string; version: number; sha256: string };
export type UpgradeArchivePin = UpgradePackagePin & { path: string; size: number };
export type EvmLocalUpgradeDescriptor = {
  format: "neutron-evm-local-browser-upgrade-v1";
  canisterId: string;
  expectedRootKeyBase64: string;
  /** Complete current installation, not just the apps being updated. */
  expectedInstalled: UpgradePackagePin[];
  /** Browser file picker is single-file; these upgrades run in this order. */
  candidates: UpgradeArchivePin[];
  evidenceDirectory: string;
  /** Existing representative data required before the first upgrade. */
  minimumEvmOperations: number;
  minimumUniswapSwaps: number;
};
export type LoadedUpgrade = {
  descriptor: EvmLocalUpgradeDescriptor;
  descriptorSha256: string;
  candidates: Array<{ pin: UpgradeArchivePin; bytes: Buffer; prepared: PreparedPackageInstall }>;
  evidenceDirectory: string;
};
type Provenance = { format: 1; apps: Record<string, {
  kind: string; acquisition?: string; package_digest: string;
}> };
type ProbeEvidence = { appId: string; functionName: string; candidName: string; argumentBase64: string; replyBase64: string; replySha256: string; count?: number };
export type EvmUpgradeEvidence = {
  observedAt: string;
  runtime: KernelRuntimeInfo;
  registry: AppRegistry;
  provenance: Provenance;
  manifests: Record<string, Record<string, unknown>>;
  /** Older provisioned baselines may have no installed build record. */
  buildRecord: DeploymentBuildRecord | null;
  memoryProbes: ProbeEvidence[];
  assets: Record<string, { bodySha256: string; certificateHeaderPresent: boolean; status: number }>;
  certification: {
    boundary: "pocketic_14_http_gateway";
    gatewayVerification: "enabled";
    independentClientVerification: false;
    processIdentity: string;
    binarySha256: string;
    disableVerificationEnvironment: "absent" | "false";
  };
};

export function parseEvmLocalUpgradeDescriptor(value: unknown): EvmLocalUpgradeDescriptor {
  assert(value && typeof value === "object" && !Array.isArray(value), "Upgrade descriptor must be an object");
  const descriptor = value as EvmLocalUpgradeDescriptor;
  assert.equal(descriptor.format, "neutron-evm-local-browser-upgrade-v1");
  assert.equal(typeof descriptor.canisterId, "string");
  assert(descriptor.canisterId.length > 0);
  assert.equal(typeof descriptor.expectedRootKeyBase64, "string");
  assert(Buffer.from(descriptor.expectedRootKeyBase64, "base64").length > 0);
  assert.equal(typeof descriptor.evidenceDirectory, "string");
  for (const count of [descriptor.minimumEvmOperations, descriptor.minimumUniswapSwaps]) assert(Number.isSafeInteger(count) && count >= 0);
  assert(Array.isArray(descriptor.expectedInstalled) && descriptor.expectedInstalled.length > 0);
  assert(Array.isArray(descriptor.candidates) && descriptor.candidates.length > 0);
  for (const pins of [descriptor.expectedInstalled, descriptor.candidates]) {
    assert.equal(new Set(pins.map(pin => pin.id)).size, pins.length, "Duplicate app pin");
    for (const pin of pins) {
      assert(pin && typeof pin === "object");
      assert(/^[a-z0-9][a-z0-9_-]*$/u.exec(pin.id)?.[0] === pin.id);
      assert(!["__proto__", "constructor", "prototype"].includes(pin.id));
      assert(Number.isSafeInteger(pin.version) && pin.version > 0);
      assert(/^[0-9a-f]{64}/u.exec(pin.sha256)?.[0] === pin.sha256);
    }
  }
  for (const pin of descriptor.candidates) {
    assert.equal(typeof pin.path, "string");
    assert(Number.isSafeInteger(pin.size) && pin.size > 0);
    const before = descriptor.expectedInstalled.find(app => app.id === pin.id);
    assert(before && pin.version > before.version, `Candidate ${pin.id} must be a strictly higher installed release`);
  }
  return descriptor;
}

export async function loadEvmLocalUpgradeDescriptor(file: string, repositoryRoot: string): Promise<LoadedUpgrade> {
  const descriptorBytes = await readFile(file);
  const descriptor = parseEvmLocalUpgradeDescriptor(JSON.parse(descriptorBytes.toString("utf8")));
  const evidenceDirectory = containedPath(repositoryRoot, descriptor.evidenceDirectory);
  assert(path.relative(path.join(repositoryRoot, ".neutron"), evidenceDirectory).startsWith("..") === false,
    "Upgrade evidence must remain under this repository's .neutron directory");
  const candidates = [];
  for (const pin of descriptor.candidates) {
    const archivePath = containedPath(repositoryRoot, pin.path);
    assert((await lstat(archivePath)).isFile(), "Candidate must be a regular archive file");
    const bytes = await readFile(archivePath);
    assert.equal(bytes.length, pin.size, `${pin.id} archive size changed`);
    assert.equal(sha256(bytes), pin.sha256, `${pin.id} archive bytes changed`);
    const prepared = preparePackageInstall(new Uint8Array(bytes), { expectedIdentity: pin });
    assert.equal(prepared.manifest.id, pin.id);
    assert.equal(prepared.manifest.version, pin.version);
    candidates.push({ pin, bytes, prepared });
  }
  return { descriptor, descriptorSha256: sha256(descriptorBytes), candidates, evidenceDirectory };
}

export async function createEvmUpgradeReader(runtime: LocalNeutronRuntime, descriptor: EvmLocalUpgradeDescriptor, request: APIRequestContext) {
  assert.equal(runtime.canisterId, descriptor.canisterId, "Descriptor targets a different Neutron");
  const gateway = new URL(runtime.gatewayUrl);
  assert.equal(gateway.protocol, "http:");
  assert(["localhost", "127.0.0.1"].includes(gateway.hostname) && gateway.port === "8000", "Upgrade qualification is loopback-only");
  assert.equal(runtime.nodeLabel, "evm-wallet");
  const identity = localIdentityFromSeed(runtime.developerIdentitySeed);
  const kernel = await createKernelActor({ canisterId: runtime.canisterId, host: runtime.gatewayUrl, identity, fetchRootKey: true });
  const agent = Actor.agentOf(kernel) as HttpAgent;
  assert(agent.rootKey);
  assert.equal(Buffer.from(agent.rootKey).toString("base64"), descriptor.expectedRootKeyBase64, "Recorded local root key changed");
  const origin = localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl);
  assert(!new URL(origin).hostname.includes(".raw."), "Raw domains bypass HTTP certificate verification");
  const certification = await verifyPocketIcCertificationBoundary(runtime);
  // Generated Neutron wrappers take one packed input value. A source-level
  // zero-argument function has unit/null input on the actual Candid method.
  const unitArgument = new Uint8Array(IDL.encode([IDL.Null], [null]));

  async function capture(): Promise<EvmUpgradeEvidence> {
    const before = await kernel.kernel_runtime_info();
    assert.deepEqual(await kernel.kernel_install_status(null), [], "An installation is already pending");
    const assets: EvmUpgradeEvidence["assets"] = {};
    function asset(assetPath: string): Promise<Buffer>;
    function asset(assetPath: string, optional: true): Promise<Buffer | undefined>;
    async function asset(assetPath: string, optional = false): Promise<Buffer | undefined> {
      const response = await request.get(new URL(assetPath, origin).href, { headers: { "cache-control": "no-cache" } });
      const body = await response.body();
      assets[assetPath] = { bodySha256: sha256(body), certificateHeaderPresent: !!response.headers()["ic-certificate"], status: response.status() };
      if (optional && response.status() === 404) return undefined;
      assert(response.ok(), `Installed asset ${assetPath} is unavailable: ${response.status()}`);
      assert(assets[assetPath]!.certificateHeaderPresent, `Installed asset ${assetPath} omitted its IC certificate`);
      return body;
    }
    const registry = JSON.parse((await asset("/system/apps.json")).toString("utf8")) as AppRegistry;
    const provenance = JSON.parse((await asset("/system/install-provenance.json")).toString("utf8")) as Provenance;
    assert.equal(provenance.format, 1);
    const buildRecordBytes = await asset("/system/deployment-build-record.json", true);
    // Some legitimately provisioned baselines predate retention of the build
    // record. Record absence honestly; every newly reviewed/committed update
    // below must still contain the exact complete build record.
    const buildRecord = buildRecordBytes === undefined ? null : parseDeploymentBuildRecordJson(buildRecordBytes);
    const manifests: EvmUpgradeEvidence["manifests"] = {};
    for (const app of before.apps) {
      const id = app.scope.app_id;
      assert.equal(registry[id]?.version, Number(app.version), `Registry/runtime version mismatch for ${id}`);
      assert.equal(registry[id]?.capability_plan_fingerprint, app.capability_plan_fingerprint);
      manifests[id] = JSON.parse((await asset(`${id === "kernel" ? "" : `/app/${id}`}/pkg/neutron.json`)).toString("utf8")) as Record<string, unknown>;
      assert.equal(manifests[id]!.version, Number(app.version));
      assert.equal(manifests[id]!.id, id);
    }
    assert.deepEqual(Object.keys(registry).sort(), before.apps.map(app => app.scope.app_id).sort());
    const memoryProbes: ProbeEvidence[] = [];
    async function probe(appId: string, functionName: string, argument: Uint8Array, count?: (reply: Uint8Array) => number) {
      if (!registry[appId]) return;
      const fn = registry[appId]!.functions.find(candidate => candidate.name === functionName);
      assert(fn?.type === "query" && typeof fn.candid_name === "string", `${appId}.${functionName} is not a declared query`);
      const response = await agent.query(runtime.canisterId, { methodName: fn.candid_name, arg: argument });
      if (response.status !== "replied") throw new Error(`Read-only memory probe ${appId}.${functionName} was rejected: ${response.reject_message}`);
      const reply = new Uint8Array(response.reply.arg);
      memoryProbes.push({ appId, functionName, candidName: fn.candid_name, argumentBase64: Buffer.from(argument).toString("base64"),
        replyBase64: Buffer.from(reply).toString("base64"), replySha256: sha256(reply), ...(count ? { count: count(reply) } : {}) });
    }
    await probe("evm_wallet", "evm_wallet_snapshot_v1", unitArgument, reply => {
      const value = IDL.decode([IDL.Variant({ ok: IDL.Record({ accounts: IDL.Vec(IDL.Reserved) }), err: IDL.Text })], reply)[0] as { ok?: { accounts: unknown[] }; err?: string };
      assert(value.ok && value.ok.accounts.length > 0, "Persisted chain-key account is missing");
      return value.ok.accounts.length;
    });
    await probe("evm_wallet", "evm_wallet_history_v1", new Uint8Array(IDL.encode([IDL.Record({ offset: IDL.Nat, limit: IDL.Nat })], [{ offset: 0n, limit: 100_000n }])), reply => {
      const value = IDL.decode([IDL.Variant({ ok: IDL.Record({ operations: IDL.Vec(IDL.Reserved), total: IDL.Nat }), err: IDL.Text })], reply)[0] as { ok?: { operations: unknown[]; total: bigint } };
      assert(value.ok);
      assert.equal(BigInt(value.ok.operations.length), value.ok.total, "Memory probe must include every persisted EVM operation");
      assert(value.ok.operations.length >= descriptor.minimumEvmOperations);
      return value.ok.operations.length;
    });
    await probe("uniswap", "uniswap_list_v1", unitArgument, reply => {
      const swaps = IDL.decode([IDL.Vec(IDL.Reserved)], reply)[0] as unknown[];
      assert(swaps.length >= descriptor.minimumUniswapSwaps);
      return swaps.length;
    });
    await probe("wallet", "wallet_snapshot", unitArgument);
    await probe("wallet", "wallet_transfers_pending_v2", unitArgument);
    await probe("wallet", "wallet_bridge_list_v1", new Uint8Array(IDL.encode([
      IDL.Record({ ledger: IDL.Opt(IDL.Principal), after: IDL.Opt(IDL.Vec(IDL.Nat8)), limit: IDL.Nat }),
    ], [{ ledger: [], after: [], limit: 100_000n }])), reply => {
      const page = IDL.decode([IDL.Record({ records: IDL.Vec(IDL.Reserved), next: IDL.Opt(IDL.Vec(IDL.Nat8)) })], reply)[0] as { records: unknown[]; next: unknown[] };
      assert.equal(page.next.length, 0, "Memory probe must include every IC bridge intent");
      return page.records.length;
    });
    await probe("kitchensink", "read_profile", unitArgument);
    await probe("kitchensink", "read_counter", unitArgument);
    await probe("kitchensink", "scheduled_status", unitArgument);
    const after = await kernel.kernel_runtime_info();
    assert.equal(after.deployment_id, before.deployment_id, "Deployment changed during evidence capture");
    assert.equal(after.assembler_id, before.assembler_id, "Assembler changed during evidence capture");
    assert.deepEqual(after.apps, before.apps);
    assert.deepEqual(after.memories, before.memories);
    assert.deepEqual(await kernel.kernel_install_status(null), []);
    if (buildRecord !== null) assert.equal(buildRecord.state === "complete" ? buildRecord.deployment_id : buildRecord.observation.deployment_id,
      before.deployment_id, "Installed build record targets another deployment");
    return { observedAt: new Date().toISOString(), runtime: before, registry, provenance, manifests, buildRecord, memoryProbes, assets, certification };
  }
  return { capture, kernel, origin };
}

export function assertEvmInstalledPins(evidence: EvmUpgradeEvidence, expected: UpgradePackagePin[]): void {
  assert.deepEqual(evidence.runtime.apps.map(app => app.scope.app_id).sort(), expected.map(app => app.id).sort(), "Installed app set changed");
  for (const pin of expected) {
    const app = evidence.runtime.apps.find(app => app.scope.app_id === pin.id);
    assert(app);
    assert.equal(Number(app.version), pin.version, `${pin.id} installed release differs`);
    assert.equal(evidence.provenance.apps[pin.id]?.package_digest, pin.sha256, `${pin.id} installed archive differs`);
  }
}

/** Checked before accepting the browser dialog, then checked against commit. */
export function assertEvmUpgradeBuild(record: DeploymentBuildRecord, before: EvmUpgradeEvidence, candidate: UpgradeArchivePin, canisterId: string, prepared: PreparedPackageInstall): asserts record is CompleteDeploymentBuildRecord {
  assert.equal(record.state, "complete");
  if (record.state !== "complete") throw new Error("Upgrade review lacks a complete deployment record");
  assert.equal(record.previous.deployment_id, before.runtime.deployment_id);
  assert.equal(record.installation.target_canister, canisterId);
  assert.equal(record.installation.mode, "upgrade");
  // Match the browser/compiler contract. Classical Motoko restores managed
  // state from stable memory into a replaced linear heap; enhanced persistence
  // keeps that heap. A mode switch is outside this qualification's scope.
  const persistenceMode = persistenceModeFromCompilerId(before.runtime.compiler_id);
  assert.equal(persistenceModeFromCompilerId(record.build.compiler_id), persistenceMode,
    "Candidate unexpectedly changes compiler persistence mode");
  assert.equal(record.installation.wasm_memory_persistence, wasmMemoryPersistenceForMode(persistenceMode));
  assert.deepEqual(record.warnings.removed_apps, []);
  assert.deepEqual(record.warnings.destructive_memory_roots, []);
  const targetMemories = candidateMemoryInventory(before, candidate, prepared);
  const existingKeys = new Set(before.runtime.memories.map(memory => `${memory.owner}/${memory.id}`));
  const expectedChanges = targetMemories.map(memory => existingKeys.has(`${memory.owner}/${memory.id}`)
    ? { kind: "keep", owner: memory.owner, memory_id: memory.id, version: Number(memory.version) }
    : { kind: "initialize", owner: memory.owner, memory_id: memory.id, to: Number(memory.version) });
  const sortChanges = <T extends { owner: string; memory_id: string }>(changes: readonly T[]) => [...changes].sort((a, b) => `${a.owner}/${a.memory_id}`.localeCompare(`${b.owner}/${b.memory_id}`));
  assert.deepEqual(sortChanges(record.warnings.memory_changes), sortChanges(expectedChanges),
    "Build must keep every existing root and initialize only the sealed candidate's declared additions");
  const memories = normalizeMemories(before.runtime.memories);
  assert.deepEqual(normalizeMemories(record.previous.memories), memories);
  assert.deepEqual(normalizeMemories(record.target.memories), normalizeMemories(targetMemories));
  const supplied = record.packages.find(pkg => pkg.app_id === candidate.id);
  assert(supplied);
  assert.equal(supplied.version, candidate.version);
  assert.deepEqual(supplied.archive, { state: "verified", sha256: candidate.sha256, bytes: candidate.size });
  for (const app of before.runtime.apps) {
    const targetApp: CompleteDeploymentBuildRecord["target"]["apps"][number] | undefined = record.target.apps.find(value => value.app_id === app.scope.app_id);
    assert(targetApp);
    assert.equal(targetApp.version, app.scope.app_id === candidate.id ? candidate.version : Number(app.version));
  }
  assert.equal(record.target.apps.length, before.runtime.apps.length);
}

export async function assertEvmUpgradePreserved(before: EvmUpgradeEvidence, after: EvmUpgradeEvidence, candidate: UpgradeArchivePin, reviewed: CompleteDeploymentBuildRecord, prepared: PreparedPackageInstall): Promise<void> {
  assertEvmUpgradeBuild(reviewed, before, candidate, reviewed.installation.target_canister, prepared);
  assert.notEqual(after.runtime.deployment_id, before.runtime.deployment_id);
  assert.equal(after.runtime.deployment_id, reviewed.deployment_id);
  assert.deepEqual(after.buildRecord, reviewed, "Installed build record differs from the exact pre-acceptance download");
  assert.deepEqual(normalizeMemories(after.runtime.memories), normalizeMemories(reviewed.target.memories));
  for (const app of before.runtime.apps) {
    const current = after.runtime.apps.find(value => value.scope.app_id === app.scope.app_id);
    assert(current);
    assert.equal(String(current.scope.installation_uid), String(app.scope.installation_uid), `${app.scope.app_id} installation UID changed`);
    const expectedMemory = app.scope.app_id === candidate.id
      ? prepared.manifest.memory ?? {}
      : before.manifests[app.scope.app_id]?.memory ?? {};
    assert.deepEqual(after.manifests[app.scope.app_id]?.memory ?? {}, expectedMemory,
      `${app.scope.app_id} installed memory declarations differ from the exact reviewed archive`);
  }
  const scheduledProbe = (probe: ProbeEvidence) => probe.appId === "kitchensink" && ["read_counter", "scheduled_status"].includes(probe.functionName);
  const walletSnapshot = (probe: ProbeEvidence) => probe.appId === "wallet" && probe.functionName === "wallet_snapshot";
  assert.deepEqual(after.memoryProbes.filter(probe => !scheduledProbe(probe) && !walletSnapshot(probe)), before.memoryProbes.filter(probe => !scheduledProbe(probe) && !walletSnapshot(probe)), "Persisted app query results changed across the idle upgrade window");
  const previousSnapshot = before.memoryProbes.find(walletSnapshot), currentSnapshot = after.memoryProbes.find(walletSnapshot);
  assert(previousSnapshot && currentSnapshot, "Both actual IC Wallet snapshots are required");
  assert.deepEqual({ ...currentSnapshot, replyBase64: "", replySha256: "" }, { ...previousSnapshot, replyBase64: "", replySha256: "" }, "Wallet snapshot probe identity changed");
  assertWalletSnapshotCacheRefresh(await decodeWalletUpgradeSnapshot(previousSnapshot.replyBase64), await decodeWalletUpgradeSnapshot(currentSnapshot.replyBase64));
  assertKitchenScheduleProgress(before.memoryProbes, after.memoryProbes);
  assert.deepEqual(after.provenance.apps[candidate.id], { kind: "manual", acquisition: "file", package_digest: candidate.sha256 });
}

function assertKitchenScheduleProgress(before: ProbeEvidence[], after: ProbeEvidence[]): void {
  const decode = (probes: ProbeEvidence[]) => {
    const counter = probes.find(probe => probe.appId === "kitchensink" && probe.functionName === "read_counter");
    const schedule = probes.find(probe => probe.appId === "kitchensink" && probe.functionName === "scheduled_status");
    assert(counter && schedule, "Kitchen counter and scheduled-status evidence are both required");
    const value = IDL.decode([IDL.Nat], new Uint8Array(Buffer.from(counter.replyBase64, "base64")))[0] as bigint;
    const status = IDL.decode([IDL.Record({ task_id: IDL.Text, runs: IDL.Nat, last_counter: IDL.Nat, interval_seconds: IDL.Nat })], new Uint8Array(Buffer.from(schedule.replyBase64, "base64")))[0] as { task_id: string; runs: bigint; last_counter: bigint; interval_seconds: bigint };
    return { value, status };
  };
  const previous = decode(before), current = decode(after);
  assert.equal(current.status.task_id, previous.status.task_id);
  assert.equal(current.status.interval_seconds, previous.status.interval_seconds);
  assert(current.status.runs >= previous.status.runs, "Kitchen scheduled-run count was reset");
  const runs = current.status.runs - previous.status.runs;
  assert.equal(current.value - previous.value, runs, "Kitchen counter change does not match its scheduled ticks");
  if (runs === 0n) assert.equal(current.status.last_counter, previous.status.last_counter);
  else assert.equal(current.status.last_counter, current.value);
}

/** Exact additive inventory derived from an authenticated candidate archive. */
function candidateMemoryInventory(before: EvmUpgradeEvidence, candidate: UpgradeArchivePin, prepared: PreparedPackageInstall): KernelRuntimeInfo["memories"] {
  // Recheck the preparation's private seal, including its manifest and files;
  // a caller cannot grant additions by altering a detached manifest object.
  assertPreparedPackageArchiveIdentity(prepared);
  assert(prepared.archiveIdentity && prepared.archiveBytes, "Candidate must retain its authenticated archive");
  assert.equal(prepared.archiveIdentity.sha256, candidate.sha256);
  assert.equal(prepared.archiveIdentity.size, candidate.size);
  assert.equal(prepared.manifest.id, candidate.id);
  assert.equal(prepared.manifest.version, candidate.version);
  const oldManifest = before.manifests[candidate.id];
  assert(oldManifest, "Installed candidate manifest is missing");
  type MemoryDeclarations = NonNullable<PreparedPackageInstall["manifest"]["memory"]>;
  const previous = (oldManifest.memory ?? {}) as MemoryDeclarations;
  const next = prepared.manifest.memory ?? {};
  for (const [id, declaration] of Object.entries(previous)) {
    assert.deepEqual(next[id], declaration, `${candidate.id}/${id} changed a released schema, module entry, migration history or version`);
  }
  const target = before.runtime.memories.map(memory => ({ ...memory }));
  const knownKeys = new Set(target.map(memory => `${memory.owner}/${memory.id}`));
  assert.equal(knownKeys.size, target.length, "Duplicate existing managed-memory identity");
  for (const [id, declaration] of Object.entries(next)) {
    if (declaration.retired) {
      assert(Object.hasOwn(previous, id), "A newly declared root cannot start retired");
      continue;
    }
    const version = declaration.version ?? 1;
    const schema = declaration.schemas?.[String(version)];
    assert(schema && typeof schema.hash === "string" && typeof schema.entry === "string", `Missing packaged schema identity for ${candidate.id}/${id}`);
    assert(/^[0-9a-f]{64}/u.exec(schema.hash)?.[0] === schema.hash);
    assert(/^[0-9a-f]{64}/u.exec(schema.entry)?.[0] === schema.entry);
    assert(prepared.files.some(file => file.path === `mo/${schema.entry}.mo`), `Packaged schema module for ${candidate.id}/${id} is missing`);
    const memory = { owner: candidate.id, id, version, schema: schema.hash };
    const existing = target.find(root => root.owner === candidate.id && root.id === id);
    if (Object.hasOwn(previous, id)) {
      assert(existing, `Installed declared root ${candidate.id}/${id} is missing from runtime inventory`);
      assert.deepEqual(normalizeMemories([existing]), normalizeMemories([memory]), `Existing root ${candidate.id}/${id} no longer matches its released schema`);
    } else {
      assert(!existing, `Candidate addition ${candidate.id}/${id} already exists in runtime`);
      assert.deepEqual(declaration.migrations ?? [], [], "A new root must initialize directly, without migrating another root");
      target.push(memory);
    }
  }
  for (const memory of before.runtime.memories.filter(memory => memory.owner === candidate.id)) {
    assert(Object.hasOwn(previous, memory.id) && !previous[memory.id]!.retired, `Existing root ${candidate.id}/${memory.id} lacks its active installed declaration`);
  }
  return target;
}

export function upgradeEvidenceJson(value: unknown): string {
  return `${JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
}
function normalizeMemories(memories: ReadonlyArray<KernelRuntimeInfo["memories"][number]>) {
  return memories.map(memory => ({ ...memory, version: String(memory.version) })).sort((a, b) => `${a.owner}/${a.id}`.localeCompare(`${b.owner}/${b.id}`));
}
function containedPath(root: string, relative: string): string {
  assert(!path.isAbsolute(relative), "Descriptor paths must be relative to the repository");
  const absolute = path.resolve(root, relative);
  const contained = path.relative(root, absolute);
  assert(contained && contained !== ".." && !contained.startsWith(`..${path.sep}`), "Descriptor path escapes the repository");
  return absolute;
}
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

async function verifyPocketIcCertificationBoundary(runtime: LocalNeutronRuntime): Promise<EvmUpgradeEvidence["certification"]> {
  // PocketIC14 (IC73e1c9b0) pins ic-gateway f33afac2. Its canonical,
  // non-raw domains verify response certificates by default; an inherited
  // environment flag can disable this, so inspect only that flag and never
  // persist or print the process environment.
  const journal = JSON.parse(await readFile(runtime.sessionPath, "utf8")) as { runtime?: {
    kind?: unknown; serverVersion?: unknown; pid?: unknown; processIdentity?: unknown; binarySha256?: unknown;
  } };
  const owner = journal.runtime;
  assert(owner?.kind === "pocketic" && owner.serverVersion === "14.0.0");
  assert(typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 1);
  assert.equal(owner.binarySha256, "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4");
  const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const identity = `linux:${owner.pid}:${startTime}`;
  assert.equal(identity, owner.processIdentity, "PocketIC process identity differs from recorded runtime");
  assert.equal(sha256(await readFile(`/proc/${owner.pid}/exe`)), owner.binarySha256);
  const environment = (await readFile(`/proc/${owner.pid}/environ`, "utf8")).split("\0");
  const disabled = environment.filter(entry => entry.startsWith("IC_UNSAFE_DISABLE_RESPONSE_VERIFICATION="));
  assert(disabled.length <= 1);
  assert(disabled.length === 0 || disabled[0] === "IC_UNSAFE_DISABLE_RESPONSE_VERIFICATION=false", "PocketIC gateway HTTP verification was disabled");
  return {
    boundary: "pocketic_14_http_gateway", gatewayVerification: "enabled", independentClientVerification: false,
    processIdentity: identity, binarySha256: String(owner.binarySha256),
    disableVerificationEnvironment: disabled.length === 0 ? "absent" : "false",
  };
}
