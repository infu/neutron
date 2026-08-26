import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import {
  ASSEMBLER_ID,
  LEGACY_V25_ASSEMBLER_ID,
} from "neutron-compiler/src/assemble.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import {
  assertSupportedCertificateVersionsMetadata,
  type SupportedCertificateVersionsMetadataV1,
} from "neutron-tools/src/wasm_metadata.js";
import {
  MAX_PACKAGE_ARCHIVES,
  type PackageArtifact,
} from "./artifact.ts";
import {
  assertDeploymentEvidenceV1,
  assertDeploymentObservationV1,
  readDeploymentProofBundle,
  readDeploymentProofBundleSync,
  rfc8785Jcs,
  type DeploymentEvidenceV1,
  type DeploymentObservationV1,
} from "./deployment_evidence.ts";
import {
  LEGACY_TRANSACTION_PAYLOAD_VERSION,
  TRANSACTION_PAYLOAD_VERSION,
  type TransactionPayloadVersion,
} from "./payload.ts";
import {
  assertPocketIcRuntimeDescriptor,
  type PocketIcRuntimeDescriptor,
} from "./pocketic_supervisor.ts";

export const PROVISION_JOURNAL_SCHEMA = 3;
export const LOCAL_FLEET_SCHEMA = 1;
export const LOCAL_FLEET_MAX_NODES = 16;

const MAX_SESSION_BYTES = 1024 * 1024;
const MANAGEMENT_CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_NAT_PATTERN = /^(0|[1-9][0-9]*)$/;
const ANONYMOUS_PRINCIPAL = Principal.anonymous().toText();
const DEPLOYMENT_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const EXCLUSIVE_LOCK_SCHEMA = 1;
const MAX_EXCLUSIVE_LOCK_BYTES = 8 * 1024;

type ExclusiveLockContents = {
  schema: typeof EXCLUSIVE_LOCK_SCHEMA;
  pid: number;
  processIdentity: string;
  nonce: string;
  acquiredAt: string;
};

export type TransactionPayloadReference = {
  version: TransactionPayloadVersion;
  sha256: string;
  bytes: number;
};

export type SessionPlan = {
  host: string;
  identityId: number;
  deployerPrincipal: string;
  targetSubnet: string;
  amountE8s: string;
  initialControllers: string[];
  packages: PackageArtifact[];
  compilerId: string;
  deploymentId: string;
  rawWasmSha256: string;
  wasmMetadata: SupportedCertificateVersionsMetadataV1;
  transportWasmSha256: string;
  transportWasmBytes: number;
  candidSha256: string;
  stableSha256: string;
  chunkHashes: string[];
  payload: TransactionPayloadReference;
  /** Registry proof pinned before any paid or mutating creation work. */
  deploymentEvidenceExpected: DeploymentObservationV1;
  fingerprint: string;
};

export type CreationState = {
  createdAt: string;
  plan: SessionPlan;
  transfer: {
    createdAtTimeNanos: string;
    feeE8s: string;
    blockIndex?: string;
  };
  canisterId?: string;
  controllersVerifiedAt?: string;
  wasmInstalledAt?: string;
  assetsSeededAt?: string;
  initialAccessVerifiedAt?: string;
  /** Complete only after a second independent registry observation. */
  deploymentEvidence?: DeploymentEvidenceV1;
  verifiedAt?: string;
  /** Self-authenticating final creation receipt. Absent while active. */
  fingerprint?: string;
};

export type ReinstallRunState = "running" | "stopped";

export type AdoptionPackage = {
  id: string;
  version: number;
};

export type AdoptionReceipt = {
  kind: "adopted";
  adoptedAt: string;
  /** Config authenticated at adoption; later schema-3 reinstalls do not rewrite it. */
  configSha256: string;
  host: string;
  identityId: number;
  deployerPrincipal: string;
  targetSubnet: string;
  canisterId: string;
  controllers: string[];
  status: "running";
  moduleHash: string;
  settingsFingerprint: string;
  runtime: {
    deploymentId: string;
    compilerId: string;
    assemblerId: string;
    packages: AdoptionPackage[];
  };
  access: {
    snapshotVersion: string;
    authorizedPrincipals: string[];
    controllerLimit: string;
  };
  deploymentEvidence: DeploymentEvidenceV1;
  fingerprint: string;
};

export type ReinstallPlan = {
  sourceSessionFingerprint: string;
  canisterId: string;
  identityId: number;
  deployerPrincipal: string;
  targetSubnet: string;
  controllers: string[];
  originalStatus: ReinstallRunState;
  previousModuleHash: string;
  settingsFingerprint: string;
  deploymentNonce: string;
  packages: PackageArtifact[];
  compilerId: string;
  deploymentId: string;
  rawWasmSha256: string;
  wasmMetadata: SupportedCertificateVersionsMetadataV1;
  transportWasmSha256: string;
  transportWasmBytes: number;
  candidSha256: string;
  stableSha256: string;
  chunkHashes: string[];
  payload: TransactionPayloadReference;
  /** Evidence carried from the permanent creation/adoption source receipt. */
  sourceDeploymentEvidence: DeploymentEvidenceV1;
  /** Registry proof pinned before the destructive transaction is published. */
  deploymentEvidenceExpected: DeploymentObservationV1;
  fingerprint: string;
};

export type ReinstallState = {
  createdAt: string;
  plan: ReinstallPlan;
  wasmStagedAt?: string;
  stoppedAt?: string;
  snapshotsDeletedAt?: string;
  wasmInstalledAt?: string;
  startedAt?: string;
  assetsSeededAt?: string;
  initialAccessVerifiedAt?: string;
  verifiedAt?: string;
  originalStatusRestoredAt?: string;
  /** Complete only after the final execution-time registry observation. */
  deploymentEvidence?: DeploymentEvidenceV1;
};

export type PocketIcRuntime = { kind: "pocketic" } & PocketIcRuntimeDescriptor;

export type JournalRuntime = { kind: "ic" } | PocketIcRuntime;

export type LocalNodeDeploymentPhase =
  | "pending"
  | "allocated"
  | "installing"
  | "installed"
  | "seeded"
  | "authorized"
  | "funded"
  | "verified";

export type LocalNodeDeploymentProgress = {
  nodeIndex: number;
  phase: LocalNodeDeploymentPhase;
  updatedAt: string;
};

export type LocalReinstallState = {
  startedAt: string;
  inputFingerprint: string;
  desiredNodeCount: number;
  nodes: LocalNodeDeploymentProgress[];
};

export type LocalFleetNode = {
  label: string;
  canisterId: string;
};

export type LocalFleet = {
  schema: typeof LOCAL_FLEET_SCHEMA;
  nodes: LocalFleetNode[];
};

type CurrentDeploymentBase = {
  canisterId: string;
  completedAt: string;
  planFingerprint: string;
  deploymentId: string;
  wasmMetadata: SupportedCertificateVersionsMetadataV1;
  transportWasmSha256: string;
  packages: PackageArtifact[];
  deploymentNonce?: string;
};

export type CurrentIcDeployment = CurrentDeploymentBase & {
  kind: "create" | "reinstall";
  sourceSessionFingerprint: string;
  deploymentEvidence: DeploymentEvidenceV1;
  fingerprint: string;
};

export type CurrentLocalDeployment = Omit<
  CurrentDeploymentBase,
  | "canisterId"
  | "deploymentNonce"
> & {
  kind: "local";
  deploymentNonce?: never;
};

export type CurrentDeployment =
  | CurrentIcDeployment
  | CurrentLocalDeployment;

export type ActiveTransaction =
  | {
      kind: "create";
      state: CreationState;
      completedAt?: string;
    }
  | {
      kind: "reinstall";
      state: ReinstallState;
      completedAt?: string;
    }
  | {
      kind: "local-reinstall";
      state: LocalReinstallState;
    };

export type ProvisionJournal = {
  schema: typeof PROVISION_JOURNAL_SCHEMA;
  configSha256: string;
  createdAt: string;
  updatedAt: string;
  runtime: JournalRuntime;
  origin?: CreationState;
  adoption?: AdoptionReceipt;
  current?: CurrentDeployment;
  localFleet?: LocalFleet;
  active?: ActiveTransaction;
};

/**
 * Hash only remote creation semantics. Gateway, local identity number, and
 * archive paths are provenance rather than IC intent.
 */
export function sessionPlanFingerprint(
  plan: Omit<SessionPlan, "fingerprint"> | SessionPlan,
): string {
  const semanticPlan = {
    deployerPrincipal: plan.deployerPrincipal,
    targetSubnet: plan.targetSubnet,
    amountE8s: plan.amountE8s,
    initialControllers: plan.initialControllers,
    packages: semanticPackages(plan.packages),
    compilerId: plan.compilerId,
    deploymentId: plan.deploymentId,
    rawWasmSha256: plan.rawWasmSha256,
    wasmMetadata: assertSupportedCertificateVersionsMetadata(
      plan.wasmMetadata,
      "creation plan.wasmMetadata",
    ),
    transportWasmSha256: plan.transportWasmSha256,
    transportWasmBytes: plan.transportWasmBytes,
    candidSha256: plan.candidSha256,
    stableSha256: plan.stableSha256,
    chunkHashes: plan.chunkHashes,
    payload: plan.payload,
    deploymentEvidenceExpected:
      plan.deploymentEvidenceExpected.fingerprint,
  };
  return createHash("sha256")
    .update("neutron-deployment-session-plan-v3\0")
    .update(JSON.stringify(semanticPlan))
    .digest("hex");
}

/**
 * Authenticate the live evidence used to recover an existing deployment into
 * a schema-3 journal. The observation time is provenance, not remote intent.
 */
export function adoptionReceiptFingerprint(
  receipt: Omit<AdoptionReceipt, "fingerprint"> | AdoptionReceipt,
): string {
  const semanticReceipt = {
    configSha256: receipt.configSha256,
    host: receipt.host,
    identityId: receipt.identityId,
    deployerPrincipal: receipt.deployerPrincipal,
    targetSubnet: receipt.targetSubnet,
    canisterId: receipt.canisterId,
    controllers: receipt.controllers,
    status: receipt.status,
    moduleHash: receipt.moduleHash,
    settingsFingerprint: receipt.settingsFingerprint,
    runtime: receipt.runtime,
    access: receipt.access,
    deploymentEvidence: receipt.deploymentEvidence.fingerprint,
  };
  return createHash("sha256")
    .update("neutron-adoption-receipt-v2\0")
    .update(JSON.stringify(semanticReceipt))
    .digest("hex");
}

export function reinstallPlanFingerprint(
  plan: Omit<ReinstallPlan, "fingerprint"> | ReinstallPlan,
): string {
  const semanticPlan = {
    sourceSessionFingerprint: plan.sourceSessionFingerprint,
    canisterId: plan.canisterId,
    identityId: plan.identityId,
    deployerPrincipal: plan.deployerPrincipal,
    targetSubnet: plan.targetSubnet,
    controllers: plan.controllers,
    originalStatus: plan.originalStatus,
    previousModuleHash: plan.previousModuleHash,
    settingsFingerprint: plan.settingsFingerprint,
    deploymentNonce: plan.deploymentNonce,
    packages: semanticPackages(plan.packages),
    compilerId: plan.compilerId,
    deploymentId: plan.deploymentId,
    rawWasmSha256: plan.rawWasmSha256,
    wasmMetadata: assertSupportedCertificateVersionsMetadata(
      plan.wasmMetadata,
      "reinstall plan.wasmMetadata",
    ),
    transportWasmSha256: plan.transportWasmSha256,
    transportWasmBytes: plan.transportWasmBytes,
    candidSha256: plan.candidSha256,
    stableSha256: plan.stableSha256,
    chunkHashes: plan.chunkHashes,
    payload: plan.payload,
    sourceDeploymentEvidence:
      plan.sourceDeploymentEvidence.fingerprint,
    deploymentEvidenceExpected:
      plan.deploymentEvidenceExpected.fingerprint,
  };
  return createHash("sha256")
    .update("neutron-reinstall-session-plan-v3\0")
    .update(JSON.stringify(semanticPlan))
    .digest("hex");
}

export function creationReceiptFingerprint(
  state: Omit<CreationState, "fingerprint"> | CreationState,
): string {
  if (!state.canisterId || !state.deploymentEvidence) {
    throw new Error(
      "A creation receipt fingerprint requires a canister and complete deployment evidence",
    );
  }
  const semantic = {
    canisterId: state.canisterId,
    planFingerprint: state.plan.fingerprint,
    transferBlockIndex: state.transfer.blockIndex ?? null,
    deploymentEvidence: state.deploymentEvidence.fingerprint,
  };
  return createHash("sha256")
    .update("neutron-creation-receipt-v1\0")
    .update(rfc8785Jcs(semantic))
    .digest("hex");
}

export function currentDeploymentFingerprint(
  receipt:
    | Omit<CurrentIcDeployment, "fingerprint">
    | CurrentIcDeployment,
): string {
  if (!receipt.deploymentEvidence || !receipt.sourceSessionFingerprint) {
    throw new Error(
      "An IC current-deployment fingerprint requires source and deployment evidence",
    );
  }
  const semantic = {
    environment: "ic",
    kind: receipt.kind,
    canisterId: receipt.canisterId,
    planFingerprint: receipt.planFingerprint,
    sourceSessionFingerprint: receipt.sourceSessionFingerprint,
    deploymentId: receipt.deploymentId,
    wasmMetadata: assertSupportedCertificateVersionsMetadata(
      receipt.wasmMetadata,
      "current deployment.wasmMetadata",
    ),
    transportWasmSha256: receipt.transportWasmSha256,
    packages: semanticPackages(receipt.packages),
    deploymentNonce: receipt.deploymentNonce ?? null,
    deploymentEvidence: receipt.deploymentEvidence.fingerprint,
  };
  return createHash("sha256")
    .update("neutron-current-deployment-v2\0")
    .update(rfc8785Jcs(semantic))
    .digest("hex");
}

export function createProvisionJournal(
  configSha256: string,
  plan: SessionPlan,
  feeE8s: bigint,
  now = new Date(),
): ProvisionJournal {
  const timestamp = now.toISOString();
  const journal: ProvisionJournal = {
    schema: PROVISION_JOURNAL_SCHEMA,
    configSha256,
    createdAt: timestamp,
    updatedAt: timestamp,
    runtime: { kind: "ic" },
    active: {
      kind: "create",
      state: {
        createdAt: timestamp,
        plan,
        transfer: {
          createdAtTimeNanos: (BigInt(now.getTime()) * 1_000_000n).toString(),
          feeE8s: feeE8s.toString(),
        },
      },
    },
  };
  assertValidJournal(journal, "new provision journal");
  return journal;
}

export function createPocketIcJournal(
  configSha256: string,
  runtime: PocketIcRuntime,
  now = new Date(),
): ProvisionJournal {
  const timestamp = now.toISOString();
  const journal: ProvisionJournal = {
    schema: PROVISION_JOURNAL_SCHEMA,
    configSha256,
    createdAt: timestamp,
    updatedAt: timestamp,
    runtime,
  };
  assertValidJournal(journal, "new PocketIC provision journal");
  return journal;
}

export function replacePocketIcRuntime(
  journal: ProvisionJournal,
  runtime: PocketIcRuntime,
): void {
  if (journal.runtime.kind !== "pocketic") {
    throw new Error("Cannot attach PocketIC runtime to an IC provision journal");
  }
  journal.runtime = runtime;
}

export function startLocalReinstall(
  journal: ProvisionJournal,
  inputFingerprint: string,
  nodeLabels: readonly string[],
  now = new Date(),
): void {
  if (journal.runtime.kind !== "pocketic") {
    throw new Error("Local reinstall requires a PocketIC provision journal");
  }
  sha256String(inputFingerprint, "local reinstall input fingerprint");
  assertLocalNodeLabels(nodeLabels, "local reinstall node labels");
  const fleet = journal.localFleet ?? {
    schema: LOCAL_FLEET_SCHEMA,
    nodes: [],
  };
  if (fleet.nodes.length > nodeLabels.length) {
    throw new Error(
      `The local session already manages ${fleet.nodes.length} Neutrons; refusing to orphan nodes by shrinking the configured fleet to ${nodeLabels.length}`,
    );
  }
  for (const [index, node] of fleet.nodes.entries()) {
    if (node.label !== nodeLabels[index]) {
      throw new Error(
        `Local fleet node ${index + 1} is named ${node.label}; configured label ${nodeLabels[index] ?? "missing"} would change its identity`,
      );
    }
  }
  journal.localFleet = fleet;
  const existing =
    journal.active?.kind === "local-reinstall"
      ? journal.active.state as LocalReinstallState
      : undefined;
  if (existing !== undefined) {
    if (existing.inputFingerprint !== inputFingerprint) {
      throw new Error(
        "A different local deployment is already active; restore its pinned config and finish it before starting another",
      );
    }
    return;
  }
  journal.active = {
    kind: "local-reinstall",
    state: {
      startedAt: now.toISOString(),
      inputFingerprint,
      desiredNodeCount: nodeLabels.length,
      nodes: localFleet(journal).nodes.map((_node, nodeIndex) => ({
        nodeIndex,
        phase: "pending",
        updatedAt: now.toISOString(),
      })),
    },
  };
}

export function recordLocalCanister(
  journal: ProvisionJournal,
  label: string,
  canisterId: string,
  now = new Date(),
): void {
  if (
    journal.schema !== PROVISION_JOURNAL_SCHEMA ||
    journal.active?.kind !== "local-reinstall"
  ) {
    throw new Error("Provision journal has no active local reinstall");
  }
  const fleet = localFleet(journal);
  const state = journal.active.state as LocalReinstallState;
  if (fleet.nodes.length >= state.desiredNodeCount) {
    throw new Error("Local Neutron fleet already has its desired node count");
  }
  if (fleet.nodes.some((node) => node.label === label)) {
    throw new Error(`Local Neutron fleet already contains label ${label}`);
  }
  const canonicalId = canonicalPrincipal(
    canisterId,
    "local Neutron canister ID",
  );
  if (fleet.nodes.some((node) => node.canisterId === canonicalId)) {
    throw new Error(`Local Neutron fleet already contains ${canonicalId}`);
  }
  const nodeIndex = fleet.nodes.length;
  fleet.nodes.push({ label, canisterId: canonicalId });
  state.nodes.push({
    nodeIndex,
    phase: "allocated",
    updatedAt: now.toISOString(),
  });
}

export function recordLocalNodePhase(
  journal: ProvisionJournal,
  nodeIndex: number,
  phase: Exclude<LocalNodeDeploymentPhase, "pending" | "allocated">,
  now = new Date(),
): void {
  if (
    journal.schema !== PROVISION_JOURNAL_SCHEMA ||
    journal.active?.kind !== "local-reinstall"
  ) {
    throw new Error("Provision journal has no active local reinstall");
  }
  const state = journal.active.state as LocalReinstallState;
  const progress = state.nodes[nodeIndex];
  if (progress === undefined || progress.nodeIndex !== nodeIndex) {
    throw new Error(`Local Neutron node ${nodeIndex} is not recorded`);
  }
  if (localPhaseRank(phase) < localPhaseRank(progress.phase)) {
    throw new Error(
      `Local Neutron node ${nodeIndex} cannot move backward from ${progress.phase} to ${phase}`,
    );
  }
  progress.phase = phase;
  progress.updatedAt = now.toISOString();
}

export function completeLocalReinstall(
  journal: ProvisionJournal,
  receipt: Omit<CurrentLocalDeployment, "kind" | "completedAt" | "canisterId">,
  now = new Date(),
): void {
  if (
    journal.schema !== PROVISION_JOURNAL_SCHEMA ||
    journal.runtime.kind !== "pocketic" ||
    journal.active?.kind !== "local-reinstall"
  ) {
    throw new Error("Provision journal has no active local reinstall");
  }
  const state = journal.active.state as LocalReinstallState;
  if (receipt.planFingerprint !== state.inputFingerprint) {
    throw new Error("Local deployment receipt does not match active input fingerprint");
  }
  const fleet = localFleet(journal);
  if (
    fleet.nodes.length !== state.desiredNodeCount ||
    state.nodes.length !== fleet.nodes.length ||
    state.nodes.some(
      (progress, nodeIndex) =>
        progress.nodeIndex !== nodeIndex || progress.phase !== "verified",
    )
  ) {
    throw new Error(
      "Local deployment cannot complete until every desired fleet node is verified",
    );
  }
  journal.current = {
    kind: "local",
    completedAt: now.toISOString(),
    ...receipt,
  };
  delete journal.active;
}

export function localDeploymentCanisterIds(
  journal: ProvisionJournal,
): string[] {
  return journal.localFleet?.nodes.map(({ canisterId }) => canisterId) ?? [];
}

export function localDeploymentNodes(
  journal: ProvisionJournal,
): LocalFleetNode[] {
  return journal.localFleet?.nodes.map((node) => ({ ...node })) ?? [];
}

export function localDeploymentPrimaryCanisterId(
  journal: ProvisionJournal,
): string {
  const primary = localDeploymentCanisterIds(journal)[0];
  if (primary === undefined) {
    throw new Error("Local provision session has no Neutron fleet");
  }
  return primary;
}

function localFleet(journal: ProvisionJournal): LocalFleet {
  if (
    journal.schema !== PROVISION_JOURNAL_SCHEMA ||
    journal.localFleet === undefined
  ) {
    throw new Error("Provision journal has no schema-3 local fleet");
  }
  return journal.localFleet;
}

function localPhaseRank(phase: LocalNodeDeploymentPhase): number {
  return [
    "pending",
    "allocated",
    "installing",
    "installed",
    "seeded",
    "authorized",
    "funded",
    "verified",
  ].indexOf(phase);
}

function assertLocalNodeLabels(
  labels: readonly string[],
  label: string,
): void {
  if (
    labels.length < 1 ||
    labels.length > LOCAL_FLEET_MAX_NODES ||
    new Set(labels).size !== labels.length
  ) {
    throw new Error(
      `${label} must contain 1 through ${LOCAL_FLEET_MAX_NODES} unique labels`,
    );
  }
  for (const [index, nodeLabel] of labels.entries()) {
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(nodeLabel)) {
      throw new Error(`${label}[${index}] is invalid`);
    }
  }
}

export function createReinstallTransaction(
  plan: ReinstallPlan,
  now = new Date(),
): Extract<ActiveTransaction, { kind: "reinstall" }> {
  const transaction = {
    kind: "reinstall" as const,
    state: {
      createdAt: now.toISOString(),
      plan,
    },
  };
  return transaction;
}

export function currentDeployment(
  kind: "create" | "reinstall",
  plan: SessionPlan | ReinstallPlan,
  canisterId: string,
  completedAt: string,
  deploymentEvidence: DeploymentEvidenceV1,
  sourceSessionFingerprint: string,
): CurrentIcDeployment {
  const base: Omit<CurrentIcDeployment, "fingerprint"> = {
    kind,
    canisterId,
    completedAt,
    planFingerprint: plan.fingerprint,
    deploymentId: plan.deploymentId,
    wasmMetadata: plan.wasmMetadata,
    transportWasmSha256: plan.transportWasmSha256,
    packages: plan.packages,
    ...(kind === "reinstall"
      ? { deploymentNonce: (plan as ReinstallPlan).deploymentNonce }
      : {}),
    deploymentEvidence,
    sourceSessionFingerprint,
  };
  return { ...base, fingerprint: currentDeploymentFingerprint(base) };
}

export async function readSession(
  sessionPath: string,
): Promise<ProvisionJournal | null> {
  const parsed = await readPrivateStateFile(
    sessionPath,
    "provision journal",
    MAX_SESSION_BYTES,
  );
  if (parsed === null) return null;
  assertValidJournal(parsed, `provision journal ${sessionPath}`);
  await assertJournalDeploymentProofs(sessionPath, parsed);
  return parsed;
}

/** Read a fully current PocketIC owner journal and return its runtime. */
export async function readPocketIcRuntimeAttachment(
  sessionPath: string,
): Promise<PocketIcRuntime> {
  const label = `PocketIC supervisor owner journal ${sessionPath}`;
  const parsed = await readPrivateStateFile(
    sessionPath,
    "provision journal",
    MAX_SESSION_BYTES,
  );
  if (parsed === null) {
    throw new Error(`${label} is unavailable`);
  }
  assertValidJournal(parsed, label);
  const runtime = parsed.runtime;
  if (runtime.kind !== "pocketic") {
    throw new Error(`${label} targets the IC, not PocketIC`);
  }
  return runtime;
}

/**
 * Synchronous journal reader for process/bootstrap consumers that cannot make
 * runtime discovery asynchronous. It deliberately shares the same private-file
 * and closed-schema boundary as the provisioner's asynchronous reader.
 */
export function readSessionSync(
  sessionPath: string,
): ProvisionJournal | null {
  const parsed = readPrivateStateFileSync(
    sessionPath,
    "provision journal",
    MAX_SESSION_BYTES,
  );
  if (parsed === null) return null;
  assertValidJournal(parsed, `provision journal ${sessionPath}`);
  assertJournalDeploymentProofsSync(sessionPath, parsed);
  return parsed;
}

export function assertSessionMatchesPlan(
  journal: ProvisionJournal,
  plan: SessionPlan,
): void {
  const stored =
    journal.active?.kind === "create"
      ? journal.active.state.plan
      : journal.origin?.plan;
  if (!stored) throw new Error("Provision journal has no creation intent");
  const storedFingerprint = sessionPlanFingerprint(stored);
  const planFingerprint = sessionPlanFingerprint(plan);
  if (
    stored.fingerprint !== storedFingerprint ||
    plan.fingerprint !== planFingerprint
  ) {
    throw new Error("Provision journal contains an invalid creation fingerprint");
  }
  if (storedFingerprint !== planFingerprint) {
    throw new Error(
      "Provisioning intent differs from the existing journal. Restore its original configuration and artifact bytes, or choose a new deployment config before spending ICP.",
    );
  }
}

export async function writeSession(
  sessionPath: string,
  journal: ProvisionJournal,
  now = new Date(),
): Promise<void> {
  const resolved = path.resolve(sessionPath);
  journal.updatedAt = now.toISOString();
  assertValidJournal(journal, `provision journal ${resolved}`);
  await assertJournalDeploymentProofs(resolved, journal);
  await writePrivateStateFile(resolved, journal, "provision journal");
}

async function readPrivateStateFile(
  filename: string,
  kind: string,
  maximumBytes: number,
): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error(`Refusing symlink ${kind} ${filename}`);
    }
    throw error;
  }
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    assertPrivateOwnedFile(metadata, `${kind} ${filename}`);
    if (metadata.size > maximumBytes) {
      throw new Error(`Malformed ${kind} ${filename}: file is too large`);
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Malformed ${kind} ${filename}: invalid JSON`, {
      cause: error,
    });
  }
}

function readPrivateStateFileSync(
  filename: string,
  kind: string,
  maximumBytes: number,
): unknown | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error(`Refusing symlink ${kind} ${filename}`);
    }
    throw error;
  }
  let bytes: Buffer;
  try {
    const metadata = fstatSync(descriptor);
    assertPrivateOwnedFile(metadata, `${kind} ${filename}`);
    if (metadata.size > maximumBytes) {
      throw new Error(`Malformed ${kind} ${filename}: file is too large`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Malformed ${kind} ${filename}: invalid JSON`, {
      cause: error,
    });
  }
}

async function writePrivateStateFile(
  resolved: string,
  value: unknown,
  kind: string,
): Promise<void> {
  resolved = path.resolve(resolved);
  const directory = path.dirname(resolved);
  await ensureSecureDirectory(directory);
  await assertSafeExistingStateFile(resolved, kind);
  const temporary = `${resolved}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporary, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporary, resolved);
    await fsyncDirectory(directory);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function withSessionLock<T>(
  sessionPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path.resolve(sessionPath)}.lock`;
  await ensureSecureDirectory(path.dirname(lockPath));
  return withExclusiveLock(
    lockPath,
    `Provision journal is locked by another process: ${lockPath}. Remove a stale lock only after confirming no provisioner is running.`,
    operation,
  );
}

export async function withMainnetExecutionLock<T>(
  deployerPrincipal: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = mainnetExecutionLockPath(deployerPrincipal);
  return withExclusiveLock(
    lockPath,
    `Mainnet provisioning is already running for deployer ${deployerPrincipal}. Wait for it to finish; do not bypass the lock with another session.`,
    operation,
  );
}

export function mainnetExecutionLockPath(deployerPrincipal: string): string {
  const key = createHash("sha256")
    .update("mainnet\0")
    .update(deployerPrincipal)
    .digest("hex");
  const uid = process.getuid?.() ?? "unknown";
  return path.join(
    tmpdir(),
    `neutron-provision-${uid}`,
    `mainnet-${key}.lock`,
  );
}

function assertValidJournal(
  value: unknown,
  label: string,
): asserts value is ProvisionJournal {
  const journal = record(value, label);
  const schema = journal.schema;
  if (schema !== PROVISION_JOURNAL_SCHEMA) {
    throw new Error(`Unsupported provision journal schema in ${label}`);
  }
  exactKeys(
    journal,
    ["schema", "configSha256", "createdAt", "updatedAt", "runtime"],
    ["origin", "adoption", "current", "localFleet", "active"],
    label,
  );
  sha256String(journal.configSha256, `${label}.configSha256`);
  const createdAt = canonicalTimestamp(journal.createdAt, `${label}.createdAt`);
  const updatedAt = canonicalTimestamp(journal.updatedAt, `${label}.updatedAt`);
  if (updatedAt < createdAt) invalid(label, "updatedAt predates createdAt");
  assertValidRuntime(journal.runtime, `${label}.runtime`);
  const runtime = journal.runtime as JournalRuntime;

  let origin: CreationState | undefined;
  if (journal.origin !== undefined) {
    assertValidCreationState(journal.origin, `${label}.origin`, updatedAt);
    origin = journal.origin as CreationState;
    if (
      !origin.canisterId ||
      !origin.verifiedAt ||
      !origin.deploymentEvidence ||
      !origin.fingerprint
    ) {
      invalid(label, "origin must be a fully verified creation receipt");
    }
  }
  let adoption: AdoptionReceipt | undefined;
  if (journal.adoption !== undefined) {
    assertValidAdoptionReceipt(
      journal.adoption,
      `${label}.adoption`,
      createdAt,
      updatedAt,
    );
    adoption = journal.adoption as AdoptionReceipt;
  }
  if (origin && adoption) {
    invalid(label, "origin and adoption receipts are mutually exclusive");
  }
  let current: CurrentDeployment | undefined;
  if (journal.current !== undefined) {
    assertValidCurrentDeployment(
      journal.current,
      `${label}.current`,
      updatedAt,
    );
    current = journal.current as CurrentDeployment;
  }
  let localFleet: LocalFleet | undefined;
  if (journal.localFleet !== undefined) {
    assertValidLocalFleet(journal.localFleet, `${label}.localFleet`);
    localFleet = journal.localFleet as LocalFleet;
  }
  let active: ActiveTransaction | undefined;
  if (journal.active !== undefined) {
    assertValidActiveTransaction(
      journal.active,
      `${label}.active`,
      updatedAt,
    );
    active = journal.active as ActiveTransaction;
  }

  if (runtime.kind === "pocketic") {
    if (origin) invalid(label, "PocketIC journal must not contain IC origin receipt");
    if (adoption) {
      invalid(label, "PocketIC journal must not contain IC adoption receipt");
    }
    if (current && current.kind !== "local") {
      invalid(label, "PocketIC current deployment must be local");
    }
    if (active && active.kind !== "local-reinstall") {
      invalid(label, "PocketIC journal has an IC active transaction");
    }
    if (current?.kind === "local" && localFleet === undefined) {
      invalid(label, "completed local deployment requires localFleet");
    }
    if (
      current?.kind === "local" &&
      localFleet !== undefined &&
      localFleet.nodes.length === 0
    ) {
      invalid(label, "completed local deployment requires a non-empty localFleet");
    }
    if (
      localFleet !== undefined &&
      current?.kind !== "local" &&
      active?.kind !== "local-reinstall"
    ) {
      invalid(
        label,
        "localFleet requires a completed or active local deployment",
      );
    }
    if (active?.kind === "local-reinstall") {
      const state = active.state as LocalReinstallState;
      if (
        localFleet === undefined ||
        localFleet.nodes.length !== state.nodes.length ||
        state.nodes.some(
          ({ nodeIndex }) => nodeIndex >= localFleet!.nodes.length,
        )
      ) {
        invalid(label, "active local deployment does not match localFleet");
      }
    }
    return;
  }

  if (
    active?.kind === "local-reinstall" ||
    current?.kind === "local" ||
    localFleet !== undefined
  ) {
    invalid(label, "IC journal contains PocketIC deployment state");
  }
  const source = origin ?? adoption;
  if (!source) {
    if (!active || active.kind !== "create" || current) {
      invalid(
        label,
        "a journal without origin or adoption must contain only an active creation",
      );
    }
  } else if (origin) {
    if (!current) invalid(label, "a completed origin requires current deployment state");
    if (active?.kind === "create") {
      if (!active.completedAt) {
        invalid(label, "an origin cannot coexist with unfinished creation");
      }
      if (active.state.plan.fingerprint !== origin.plan.fingerprint) {
        invalid(label, "completed active creation differs from origin");
      }
    }
    if (active?.kind === "reinstall") {
      if (
        active.state.plan.sourceSessionFingerprint !==
          origin.fingerprint ||
        active.state.plan.canisterId !== origin.canisterId
      ) {
        invalid(label, "active reinstall does not match origin");
      }
    }
  } else {
    if (active?.kind === "create") {
      invalid(label, "an adoption cannot coexist with a creation transaction");
    }
    if (current?.kind === "create") {
      invalid(label, "an adoption cannot claim a paid creation deployment");
    }
    if (active?.kind === "reinstall") {
      if (
        active.state.plan.sourceSessionFingerprint !== adoption!.fingerprint ||
        active.state.plan.canisterId !== adoption!.canisterId
      ) {
        invalid(label, "active reinstall does not match adoption");
      }
    }
  }

  if (active?.kind === "reinstall" && active.completedAt && !current) {
    invalid(label, "completed active reinstall requires current deployment state");
  }

  if (current && source) {
    const sourceCanisterId =
      "plan" in source ? source.canisterId! : source.canisterId;
    if (current.canisterId !== sourceCanisterId) {
      invalid(label, "current deployment canister does not match source receipt");
    }
    const sourceFingerprint =
      "plan" in source ? source.fingerprint! : source.fingerprint;
    if (current.sourceSessionFingerprint !== sourceFingerprint) {
      invalid(label, "current deployment does not match its source receipt");
    }
    if (current.kind === "create") {
      if (!origin) invalid(label, "current creation requires paid origin receipt");
      if (
        current.planFingerprint !== origin!.plan.fingerprint ||
        current.deploymentId !== origin!.plan.deploymentId ||
        !sameWasmMetadata(current.wasmMetadata, origin!.plan.wasmMetadata) ||
        current.transportWasmSha256 !== origin!.plan.transportWasmSha256 ||
        current.canisterId !== origin!.canisterId ||
        (active?.kind === "create" &&
          active.completedAt !== undefined &&
          current.completedAt !== active.completedAt) ||
        current.sourceSessionFingerprint !== origin!.fingerprint ||
        current.deploymentEvidence.fingerprint !==
          origin!.deploymentEvidence!.fingerprint
      ) {
        invalid(label, "current creation receipt does not match origin");
      }
    } else if (active?.kind === "reinstall" && active.completedAt) {
      const plan = active.state.plan;
      if (
        current.planFingerprint !== plan.fingerprint ||
        current.deploymentId !== plan.deploymentId ||
        !sameWasmMetadata(current.wasmMetadata, plan.wasmMetadata) ||
        current.transportWasmSha256 !== plan.transportWasmSha256 ||
        current.deploymentNonce !== plan.deploymentNonce ||
        current.canisterId !== plan.canisterId ||
        current.completedAt !== active.completedAt ||
        current.sourceSessionFingerprint !==
          plan.sourceSessionFingerprint ||
        current.deploymentEvidence.fingerprint !==
          active.state.deploymentEvidence!.fingerprint
      ) {
        invalid(label, "current reinstall receipt does not match completed active transaction");
      }
    }
  }
}

function sameWasmMetadata(
  left: SupportedCertificateVersionsMetadataV1,
  right: SupportedCertificateVersionsMetadataV1,
): boolean {
  return (
    left.sectionName === right.sectionName &&
    left.sectionCount === right.sectionCount &&
    left.value === right.value
  );
}

function assertValidAdoptionReceipt(
  value: unknown,
  label: string,
  journalCreatedAt: number,
  journalUpdatedAt: number,
): asserts value is AdoptionReceipt {
  const receipt = record(value, label);
  exactKeys(
    receipt,
    [
      "kind",
      "adoptedAt",
      "configSha256",
      "host",
      "identityId",
      "deployerPrincipal",
      "targetSubnet",
      "canisterId",
      "controllers",
      "status",
      "moduleHash",
      "settingsFingerprint",
      "runtime",
      "access",
      "deploymentEvidence",
      "fingerprint",
    ],
    [],
    label,
  );
  if (receipt.kind !== "adopted") invalid(label, "kind must be adopted");
  const adoptedAt = canonicalTimestamp(receipt.adoptedAt, `${label}.adoptedAt`);
  if (adoptedAt < journalCreatedAt || adoptedAt > journalUpdatedAt) {
    invalid(label, "adoptedAt is outside the journal timeline");
  }
  sha256String(receipt.configSha256, `${label}.configSha256`);
  canonicalHost(receipt.host, `${label}.host`);
  safeInteger(receipt.identityId, `${label}.identityId`, 0, 65_535);
  const deployer = canonicalPrincipal(
    receipt.deployerPrincipal,
    `${label}.deployerPrincipal`,
  );
  canonicalPrincipal(receipt.targetSubnet, `${label}.targetSubnet`);
  const canisterId = canonicalPrincipal(receipt.canisterId, `${label}.canisterId`);
  const controllers = canonicalPrincipalList(
    receipt.controllers,
    `${label}.controllers`,
    10,
  );
  if (!controllers.includes(deployer)) {
    invalid(label, "controllers must include deployerPrincipal");
  }
  if (!controllers.includes(canisterId)) {
    invalid(label, "controllers must include the Neutron self-controller");
  }
  if (receipt.status !== "running") {
    invalid(label, "status must be running");
  }
  sha256String(receipt.moduleHash, `${label}.moduleHash`);
  sha256String(receipt.settingsFingerprint, `${label}.settingsFingerprint`);

  const runtime = record(receipt.runtime, `${label}.runtime`);
  exactKeys(
    runtime,
    ["deploymentId", "compilerId", "assemblerId", "packages"],
    [],
    `${label}.runtime`,
  );
  nonEmptyString(runtime.deploymentId, `${label}.runtime.deploymentId`, 512);
  nonEmptyString(runtime.compilerId, `${label}.runtime.compilerId`, 512);
  if (
    runtime.assemblerId !== ASSEMBLER_ID &&
    runtime.assemblerId !== LEGACY_V25_ASSEMBLER_ID
  ) {
    invalid(
      label,
      `runtime.assemblerId must be ${ASSEMBLER_ID} or its exact ${LEGACY_V25_ASSEMBLER_ID} predecessor`,
    );
  }
  assertValidAdoptionPackages(runtime.packages, `${label}.runtime.packages`);

  const access = record(receipt.access, `${label}.access`);
  exactKeys(
    access,
    ["snapshotVersion", "authorizedPrincipals", "controllerLimit"],
    [],
    `${label}.access`,
  );
  canonicalNat(
    access.snapshotVersion,
    `${label}.access.snapshotVersion`,
    true,
  );
  const authorized = canonicalPrincipalList(
    access.authorizedPrincipals,
    `${label}.access.authorizedPrincipals`,
    1_000,
  );
  if (!authorized.includes(deployer)) {
    invalid(label, "authorizedPrincipals must include deployerPrincipal");
  }
  const controllerLimit = canonicalNat(
    access.controllerLimit,
    `${label}.access.controllerLimit`,
    false,
  );
  if (controllerLimit < BigInt(controllers.length)) {
    invalid(label, "controllerLimit is below the verified controller count");
  }
  assertDeploymentEvidenceV1(
    receipt.deploymentEvidence,
    `${label}.deploymentEvidence`,
  );
  if (
    (receipt.deploymentEvidence as DeploymentEvidenceV1).expected.subnetId !==
      receipt.targetSubnet
  ) {
    invalid(label, "deployment evidence subnet does not match targetSubnet");
  }

  sha256String(receipt.fingerprint, `${label}.fingerprint`);
  if (
    receipt.fingerprint !==
    adoptionReceiptFingerprint(receipt as unknown as AdoptionReceipt)
  ) {
    invalid(label, "stored fingerprint does not match adoption receipt");
  }
}

function assertValidAdoptionPackages(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PACKAGE_ARCHIVES
  ) {
    invalid(label, "must be a non-empty bounded array");
  }
  const ids = new Set<string>();
  let previousId = "";
  let kernelCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const pkg = record(value[index], `${label}[${index}]`);
    exactKeys(pkg, ["id", "version"], [], `${label}[${index}]`);
    if (!isValidAppId(pkg.id)) invalid(label, `[${index}].id is invalid`);
    if (ids.has(pkg.id as string)) invalid(label, `duplicates ${pkg.id as string}`);
    if (index > 0 && (pkg.id as string) <= previousId) {
      invalid(label, "must be sorted by app ID");
    }
    ids.add(pkg.id as string);
    previousId = pkg.id as string;
    if (pkg.id === "kernel") kernelCount += 1;
    safeInteger(pkg.version, `${label}[${index}].version`, 0);
  }
  if (kernelCount !== 1) invalid(label, "must contain exactly one kernel");
}

function assertValidActiveTransaction(
  value: unknown,
  label: string,
  updatedAt: number,
): void {
  const active = record(value, label);
  exactKeys(active, ["kind", "state"], ["completedAt"], label);
  if (active.kind === "create") {
    assertValidCreationState(active.state, `${label}.state`, updatedAt);
    if (active.completedAt !== undefined && !(active.state as CreationState).verifiedAt) {
      invalid(label, "completedAt requires verified creation state");
    }
  } else if (active.kind === "reinstall") {
    assertValidReinstallState(active.state, `${label}.state`, updatedAt);
    const state = active.state as ReinstallState;
    if (
      active.completedAt !== undefined &&
      (!state.verifiedAt ||
        (state.plan.originalStatus === "stopped" && !state.originalStatusRestoredAt))
    ) {
      invalid(label, "completedAt requires verified reinstall state and restored run state");
    }
  } else if (active.kind === "local-reinstall") {
    if (active.completedAt !== undefined) {
      invalid(label, "local reinstall is completed by replacing active state");
    }
    assertValidLocalReinstallState(active.state, `${label}.state`, updatedAt);
  } else {
    invalid(label, "kind must be create, reinstall, or local-reinstall");
  }
  if (active.completedAt !== undefined && active.kind !== "local-reinstall") {
    const completedAt = canonicalTimestamp(active.completedAt, `${label}.completedAt`);
    const state = active.state as CreationState | ReinstallState;
    const finalPhase =
      "originalStatusRestoredAt" in state && state.originalStatusRestoredAt
        ? canonicalTimestamp(
            state.originalStatusRestoredAt,
            `${label}.state.originalStatusRestoredAt`,
          )
        : canonicalTimestamp(state.verifiedAt, `${label}.state.verifiedAt`);
    if (completedAt < finalPhase || completedAt > updatedAt) {
      invalid(label, "completedAt is outside the completed phase timeline");
    }
  }
}

function assertValidCreationState(
  value: unknown,
  label: string,
  updatedAt: number,
): asserts value is CreationState {
  const state = record(value, label);
  exactKeys(
    state,
    ["createdAt", "plan", "transfer"],
    [
      "canisterId",
      "controllersVerifiedAt",
      "wasmInstalledAt",
      "assetsSeededAt",
      "initialAccessVerifiedAt",
      "deploymentEvidence",
      "verifiedAt",
      "fingerprint",
    ],
    label,
  );
  const createdAt = canonicalTimestamp(state.createdAt, `${label}.createdAt`);
  if (createdAt > updatedAt) invalid(label, "createdAt follows journal update");
  assertValidPlan(state.plan, `${label}.plan`);
  const transfer = record(state.transfer, `${label}.transfer`);
  exactKeys(
    transfer,
    ["createdAtTimeNanos", "feeE8s"],
    ["blockIndex"],
    `${label}.transfer`,
  );
  const transferTime = canonicalNat(
    transfer.createdAtTimeNanos,
    `${label}.transfer.createdAtTimeNanos`,
    false,
  );
  if (transferTime !== BigInt(createdAt) * 1_000_000n) {
    invalid(label, "transfer timestamp does not match creation time");
  }
  canonicalNat(transfer.feeE8s, `${label}.transfer.feeE8s`, false);
  if (transfer.blockIndex !== undefined) {
    canonicalNat(transfer.blockIndex, `${label}.transfer.blockIndex`, true);
  }
  if (state.canisterId !== undefined) {
    canonicalPrincipal(state.canisterId, `${label}.canisterId`);
  }
  assertPhaseTimeline(
    label,
    createdAt,
    updatedAt,
    state.canisterId === undefined,
    [
      ["controllersVerifiedAt", state.controllersVerifiedAt],
      ["wasmInstalledAt", state.wasmInstalledAt],
      ["assetsSeededAt", state.assetsSeededAt],
      ["initialAccessVerifiedAt", state.initialAccessVerifiedAt],
      ["verifiedAt", state.verifiedAt],
    ],
  );
  if (state.canisterId !== undefined && transfer.blockIndex === undefined) {
    invalid(label, "canisterId requires a completed ledger transfer");
  }
  if (state.deploymentEvidence !== undefined) {
    assertDeploymentEvidenceV1(state.deploymentEvidence, `${label}.deploymentEvidence`);
    const evidence = state.deploymentEvidence as DeploymentEvidenceV1;
    const plan = state.plan as SessionPlan;
    if (
      evidence.expected.fingerprint !==
        plan.deploymentEvidenceExpected.fingerprint
    ) {
      invalid(label, "deployment evidence does not match the planned expectation");
    }
    if (evidence.expected.subnetId !== plan.targetSubnet) {
      invalid(label, "deployment evidence subnet does not match the creation target");
    }
  }
  if (state.fingerprint !== undefined) {
    if (!state.verifiedAt || !state.deploymentEvidence || !state.canisterId) {
      invalid(label, "fingerprint requires a complete verified creation receipt");
    }
    sha256String(state.fingerprint, `${label}.fingerprint`);
    if (
      state.fingerprint !==
      creationReceiptFingerprint(state as unknown as CreationState)
    ) {
      invalid(label, "stored fingerprint does not match creation receipt");
    }
  } else if (state.deploymentEvidence !== undefined) {
    invalid(label, "completed deployment evidence requires a receipt fingerprint");
  }
  if (
    state.verifiedAt !== undefined &&
    (!state.deploymentEvidence || !state.fingerprint)
  ) {
    invalid(label, "verified creation requires complete deployment evidence");
  }
}

function assertValidReinstallState(
  value: unknown,
  label: string,
  updatedAt: number,
): asserts value is ReinstallState {
  const state = record(value, label);
  exactKeys(
    state,
    ["createdAt", "plan"],
    [
      "wasmStagedAt",
      "stoppedAt",
      "snapshotsDeletedAt",
      "wasmInstalledAt",
      "startedAt",
      "assetsSeededAt",
      "initialAccessVerifiedAt",
      "verifiedAt",
      "originalStatusRestoredAt",
      "deploymentEvidence",
    ],
    label,
  );
  const createdAt = canonicalTimestamp(state.createdAt, `${label}.createdAt`);
  if (createdAt > updatedAt) invalid(label, "createdAt follows journal update");
  assertValidReinstallPlan(state.plan, `${label}.plan`);
  const plan = state.plan as ReinstallPlan;
  assertPhaseTimeline(label, createdAt, updatedAt, false, [
    ["wasmStagedAt", state.wasmStagedAt],
    ["stoppedAt", state.stoppedAt],
    ["snapshotsDeletedAt", state.snapshotsDeletedAt],
    ["wasmInstalledAt", state.wasmInstalledAt],
    ["startedAt", state.startedAt],
    ["assetsSeededAt", state.assetsSeededAt],
    ["initialAccessVerifiedAt", state.initialAccessVerifiedAt],
    ["verifiedAt", state.verifiedAt],
  ]);
  if (state.originalStatusRestoredAt !== undefined) {
    if (plan.originalStatus !== "stopped" || !state.verifiedAt) {
      invalid(label, "originalStatusRestoredAt requires verified originally stopped state");
    }
    const restored = canonicalTimestamp(
      state.originalStatusRestoredAt,
      `${label}.originalStatusRestoredAt`,
    );
    const restoreFloor = state.initialAccessVerifiedAt
      ? canonicalTimestamp(
          state.initialAccessVerifiedAt,
          `${label}.initialAccessVerifiedAt`,
        )
      : createdAt;
    if (restored < restoreFloor || restored > updatedAt) {
      invalid(label, "originalStatusRestoredAt is outside phase timeline");
    }
  }
  if (state.deploymentEvidence !== undefined) {
    assertDeploymentEvidenceV1(state.deploymentEvidence, `${label}.deploymentEvidence`);
    const evidence = state.deploymentEvidence as DeploymentEvidenceV1;
    if (
      evidence.expected.fingerprint !==
        plan.deploymentEvidenceExpected.fingerprint
    ) {
      invalid(label, "deployment evidence does not match the reinstall expectation");
    }
  }
  if (state.verifiedAt !== undefined && !state.deploymentEvidence) {
    invalid(label, "verified reinstall requires complete deployment evidence");
  }
}

function assertValidLocalReinstallState(
  value: unknown,
  label: string,
  updatedAt: number,
): void {
  const state = record(value, label);
  exactKeys(
    state,
    ["startedAt", "inputFingerprint", "desiredNodeCount", "nodes"],
    [],
    label,
  );
  const startedAt = canonicalTimestamp(state.startedAt, `${label}.startedAt`);
  if (startedAt > updatedAt) invalid(label, "startedAt follows journal update");
  sha256String(state.inputFingerprint, `${label}.inputFingerprint`);
  const desiredNodeCount = safeInteger(
    state.desiredNodeCount,
    `${label}.desiredNodeCount`,
    1,
    LOCAL_FLEET_MAX_NODES,
  );
  if (
    !Array.isArray(state.nodes) ||
    state.nodes.length > desiredNodeCount
  ) {
    invalid(label, "nodes must be a bounded deployment-progress array");
  }
  state.nodes.forEach((entry, index) => {
    const progress = record(entry, `${label}.nodes[${index}]`);
    exactKeys(
      progress,
      ["nodeIndex", "phase", "updatedAt"],
      [],
      `${label}.nodes[${index}]`,
    );
    const nodeIndex = safeInteger(
      progress.nodeIndex,
      `${label}.nodes[${index}].nodeIndex`,
      0,
      LOCAL_FLEET_MAX_NODES - 1,
    );
    if (nodeIndex !== index) {
      invalid(label, "node progress must be ordered by canonical node index");
    }
    if (
      progress.phase !== "pending" &&
      progress.phase !== "allocated" &&
      progress.phase !== "installing" &&
      progress.phase !== "installed" &&
      progress.phase !== "seeded" &&
      progress.phase !== "authorized" &&
      progress.phase !== "funded" &&
      progress.phase !== "verified"
    ) {
      invalid(`${label}.nodes[${index}].phase`, "is unsupported");
    }
    const phaseUpdatedAt = canonicalTimestamp(
      progress.updatedAt,
      `${label}.nodes[${index}].updatedAt`,
    );
    if (phaseUpdatedAt < startedAt || phaseUpdatedAt > updatedAt) {
      invalid(
        `${label}.nodes[${index}]`,
        "updatedAt is outside the active deployment timeline",
      );
    }
  });
}

function assertValidLocalFleet(value: unknown, label: string): void {
  const fleet = record(value, label);
  exactKeys(fleet, ["schema", "nodes"], [], label);
  if (fleet.schema !== LOCAL_FLEET_SCHEMA) {
    invalid(label, `schema must be ${LOCAL_FLEET_SCHEMA}`);
  }
  if (
    !Array.isArray(fleet.nodes) ||
    fleet.nodes.length > LOCAL_FLEET_MAX_NODES
  ) {
    invalid(
      `${label}.nodes`,
      `must contain at most ${LOCAL_FLEET_MAX_NODES} nodes`,
    );
  }
  const labels = new Set<string>();
  const canisterIds = new Set<string>();
  fleet.nodes.forEach((entry, index) => {
    const node = record(entry, `${label}.nodes[${index}]`);
    exactKeys(
      node,
      ["label", "canisterId"],
      [],
      `${label}.nodes[${index}]`,
    );
    if (
      typeof node.label !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(node.label)
    ) {
      invalid(`${label}.nodes[${index}].label`, "is invalid");
    }
    const canisterId = canonicalPrincipal(
      node.canisterId,
      `${label}.nodes[${index}].canisterId`,
    );
    if (labels.has(node.label) || canisterIds.has(canisterId)) {
      invalid(label, "contains duplicate labels or canister IDs");
    }
    labels.add(node.label);
    canisterIds.add(canisterId);
  });
}

function assertValidRuntime(value: unknown, label: string): void {
  const runtime = record(value, label);
  if (runtime.kind === "ic") {
    exactKeys(runtime, ["kind"], [], label);
    return;
  }
  if (runtime.kind !== "pocketic") invalid(label, "kind must be ic or pocketic");
  const { kind: _kind, ...descriptor } = runtime;
  try {
    assertPocketIcRuntimeDescriptor(descriptor);
  } catch (error) {
    throw new Error(`Malformed ${label}: invalid PocketIC runtime descriptor`, {
      cause: error,
    });
  }
}

function assertValidCurrentDeployment(
  value: unknown,
  label: string,
  updatedAt: number,
): void {
  const current = record(value, label);
  const isLocal = current.kind === "local";
  exactKeys(
    current,
    [
      "kind",
      "completedAt",
      "planFingerprint",
      "deploymentId",
      "wasmMetadata",
      "transportWasmSha256",
      "packages",
      ...(isLocal
        ? []
        : [
            "canisterId",
            "sourceSessionFingerprint",
            "deploymentEvidence",
            "fingerprint",
          ]),
    ],
    ["deploymentNonce"],
    label,
  );
  if (
    current.kind !== "create" &&
    current.kind !== "reinstall" &&
    current.kind !== "local"
  ) {
    invalid(label, "kind must be create, reinstall, or local");
  }
  if (!isLocal) {
    canonicalPrincipal(current.canisterId, `${label}.canisterId`);
  }
  const completedAt = canonicalTimestamp(current.completedAt, `${label}.completedAt`);
  if (completedAt > updatedAt) invalid(label, "completedAt follows journal update");
  sha256String(current.planFingerprint, `${label}.planFingerprint`);
  nonEmptyString(current.deploymentId, `${label}.deploymentId`, 512);
  assertSupportedCertificateVersionsMetadata(
    current.wasmMetadata,
    `${label}.wasmMetadata`,
  );
  sha256String(current.transportWasmSha256, `${label}.transportWasmSha256`);
  assertValidPackageArtifacts(current.packages, `${label}.packages`);
  if (
    (current.packages as PackageArtifact[]).filter(({ id }) => id === "kernel")
      .length !== 1
  ) {
    invalid(label, "packages must contain exactly one kernel");
  }
  if (current.kind === "create" || current.kind === "local") {
    if (current.deploymentNonce !== undefined) {
      invalid(label, "creation/local current state must not have deploymentNonce");
    }
  } else if (
    typeof current.deploymentNonce !== "string" ||
    !DEPLOYMENT_NONCE_PATTERN.test(current.deploymentNonce)
  ) {
    invalid(label, "reinstall current state requires deploymentNonce");
  }
  if (!isLocal) {
    sha256String(
      current.sourceSessionFingerprint,
      `${label}.sourceSessionFingerprint`,
    );
    assertDeploymentEvidenceV1(
      current.deploymentEvidence,
      `${label}.deploymentEvidence`,
    );
    sha256String(current.fingerprint, `${label}.fingerprint`);
    if (
      current.fingerprint !==
      currentDeploymentFingerprint(current as unknown as CurrentIcDeployment)
    ) {
      invalid(label, "stored fingerprint does not match current deployment");
    }
  }
}

function assertValidReinstallPlan(value: unknown, label: string): void {
  const plan = record(value, label);
  exactKeys(
    plan,
    [
      "sourceSessionFingerprint",
      "canisterId",
      "identityId",
      "deployerPrincipal",
      "targetSubnet",
      "controllers",
      "originalStatus",
      "previousModuleHash",
      "settingsFingerprint",
      "deploymentNonce",
      "packages",
      "compilerId",
      "deploymentId",
      "rawWasmSha256",
      "wasmMetadata",
      "transportWasmSha256",
      "transportWasmBytes",
      "candidSha256",
      "stableSha256",
      "chunkHashes",
      "payload",
      "sourceDeploymentEvidence",
      "deploymentEvidenceExpected",
      "fingerprint",
    ],
    [],
    label,
  );
  sha256String(plan.sourceSessionFingerprint, `${label}.sourceSessionFingerprint`);
  canonicalPrincipal(plan.canisterId, `${label}.canisterId`);
  safeInteger(plan.identityId, `${label}.identityId`, 0, 65_535);
  const deployer = canonicalPrincipal(plan.deployerPrincipal, `${label}.deployerPrincipal`);
  canonicalPrincipal(plan.targetSubnet, `${label}.targetSubnet`);
  const controllers = canonicalPrincipalList(plan.controllers, `${label}.controllers`, 10);
  if (!controllers.includes(deployer)) invalid(label, "controllers must include deployerPrincipal");
  if (!controllers.includes(plan.canisterId as string)) {
    invalid(label, "controllers must include the Neutron self-controller");
  }
  if (plan.originalStatus !== "running" && plan.originalStatus !== "stopped") {
    invalid(label, "originalStatus must be running or stopped");
  }
  sha256String(plan.previousModuleHash, `${label}.previousModuleHash`);
  sha256String(plan.settingsFingerprint, `${label}.settingsFingerprint`);
  if (
    typeof plan.deploymentNonce !== "string" ||
    !DEPLOYMENT_NONCE_PATTERN.test(plan.deploymentNonce)
  ) {
    invalid(label, "deploymentNonce must be 16 bytes of lowercase hexadecimal");
  }
  assertValidDeploymentArtifacts(plan, label);
  assertDeploymentEvidenceV1(
    plan.sourceDeploymentEvidence,
    `${label}.sourceDeploymentEvidence`,
  );
  if (
    (plan.sourceDeploymentEvidence as DeploymentEvidenceV1).observed
      .subnetId !== plan.targetSubnet
  ) {
    invalid(label, "source deployment evidence subnet does not match targetSubnet");
  }
  assertDeploymentObservationV1(
    plan.deploymentEvidenceExpected,
    `${label}.deploymentEvidenceExpected`,
  );
  if (
    (plan.deploymentEvidenceExpected as DeploymentObservationV1).subnetId !==
    plan.targetSubnet
  ) {
    invalid(label, "deployment expectation subnet does not match targetSubnet");
  }
  if (plan.transportWasmSha256 === plan.previousModuleHash) {
    invalid(label, "uniquely stamped reinstall Wasm must differ from previous module");
  }
  sha256String(plan.fingerprint, `${label}.fingerprint`);
  if (plan.fingerprint !== reinstallPlanFingerprint(plan as unknown as ReinstallPlan)) {
    invalid(label, "stored fingerprint does not match stored plan");
  }
}

function assertValidPlan(value: unknown, label: string): asserts value is SessionPlan {
  const plan = record(value, label);
  exactKeys(
    plan,
    [
      "host",
      "identityId",
      "deployerPrincipal",
      "targetSubnet",
      "amountE8s",
      "initialControllers",
      "packages",
      "compilerId",
      "deploymentId",
      "rawWasmSha256",
      "wasmMetadata",
      "transportWasmSha256",
      "transportWasmBytes",
      "candidSha256",
      "stableSha256",
      "chunkHashes",
      "payload",
      "deploymentEvidenceExpected",
      "fingerprint",
    ],
    [],
    label,
  );
  canonicalHost(plan.host, `${label}.host`);
  safeInteger(plan.identityId, `${label}.identityId`, 0, 65_535);
  const deployer = canonicalPrincipal(plan.deployerPrincipal, `${label}.deployerPrincipal`);
  canonicalPrincipal(plan.targetSubnet, `${label}.targetSubnet`);
  canonicalNat(plan.amountE8s, `${label}.amountE8s`, false);
  const controllers = canonicalPrincipalList(
    plan.initialControllers,
    `${label}.initialControllers`,
    9,
  );
  if (!controllers.includes(deployer)) {
    invalid(label, "initialControllers must include deployerPrincipal");
  }
  assertValidDeploymentArtifacts(plan, label);
  assertDeploymentObservationV1(
    plan.deploymentEvidenceExpected,
    `${label}.deploymentEvidenceExpected`,
  );
  if (
    (plan.deploymentEvidenceExpected as DeploymentObservationV1).subnetId !==
    plan.targetSubnet
  ) {
    invalid(label, "deployment evidence subnet does not match targetSubnet");
  }
  sha256String(plan.fingerprint, `${label}.fingerprint`);
  if (plan.fingerprint !== sessionPlanFingerprint(plan as unknown as SessionPlan)) {
    invalid(label, "stored fingerprint does not match stored plan");
  }
}

function assertValidDeploymentArtifacts(
  plan: Record<string, unknown>,
  label: string,
): void {
  assertValidPackageArtifacts(plan.packages, `${label}.packages`);
  const packages = plan.packages as unknown[];
  if (!Array.isArray(packages)) invalid(label, "packages must be an array");
  // A fresh combined deployment always contains exactly one Kernel archive.
  let kernelCount = 0;
  for (const entry of packages) {
    if ((entry as { id?: unknown }).id === "kernel") kernelCount += 1;
  }
  if (kernelCount !== 1) invalid(label, "packages must contain exactly one kernel");
  nonEmptyString(plan.compilerId, `${label}.compilerId`, 512);
  nonEmptyString(plan.deploymentId, `${label}.deploymentId`, 512);
  sha256String(plan.rawWasmSha256, `${label}.rawWasmSha256`);
  assertSupportedCertificateVersionsMetadata(
    plan.wasmMetadata,
    `${label}.wasmMetadata`,
  );
  sha256String(plan.transportWasmSha256, `${label}.transportWasmSha256`);
  const transportWasmBytes = safeInteger(
    plan.transportWasmBytes,
    `${label}.transportWasmBytes`,
    1,
  );
  sha256String(plan.candidSha256, `${label}.candidSha256`);
  sha256String(plan.stableSha256, `${label}.stableSha256`);
  if (!Array.isArray(plan.chunkHashes)) invalid(label, "chunkHashes must be an array");
  const expectedChunkCount = Math.ceil(transportWasmBytes / MANAGEMENT_CHUNK_BYTES);
  if (plan.chunkHashes.length !== expectedChunkCount) {
    invalid(label, "chunkHashes length does not match transportWasmBytes");
  }
  for (let index = 0; index < plan.chunkHashes.length; index += 1) {
    sha256String(plan.chunkHashes[index], `${label}.chunkHashes[${index}]`);
  }
  const payload = record(plan.payload, `${label}.payload`);
  exactKeys(payload, ["version", "sha256", "bytes"], [], `${label}.payload`);
  if (
    payload.version !== LEGACY_TRANSACTION_PAYLOAD_VERSION &&
    payload.version !== TRANSACTION_PAYLOAD_VERSION
  ) {
    invalid(label, "uses unsupported transaction payload version");
  }
  sha256String(payload.sha256, `${label}.payload.sha256`);
  safeInteger(payload.bytes, `${label}.payload.bytes`, 1, 512 * 1024 * 1024);
}

function assertValidPackageArtifacts(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PACKAGE_ARCHIVES
  ) {
    invalid(label, "must be a non-empty bounded array");
  }
  const packageIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const artifact = record(value[index], `${label}[${index}]`);
    exactKeys(
      artifact,
      ["path", "id", "version", "sha256", "bytes"],
      [],
      `${label}[${index}]`,
    );
    const artifactPath = nonEmptyString(
      artifact.path,
      `${label}[${index}].path`,
      16_384,
    );
    if (!path.isAbsolute(artifactPath)) invalid(label, `[${index}].path must be absolute`);
    if (!isValidAppId(artifact.id)) invalid(label, `[${index}].id is invalid`);
    if (packageIds.has(artifact.id)) invalid(label, `duplicates ${artifact.id}`);
    packageIds.add(artifact.id);
    safeInteger(artifact.version, `${label}[${index}].version`, 0);
    sha256String(artifact.sha256, `${label}[${index}].sha256`);
    safeInteger(artifact.bytes, `${label}[${index}].bytes`, 1);
  }
}

function assertPhaseTimeline(
  label: string,
  createdAt: number,
  updatedAt: number,
  missingEarlierPhase: boolean,
  phases: ReadonlyArray<readonly [string, unknown]>,
): number {
  let previous = createdAt;
  for (const [name, raw] of phases) {
    if (raw === undefined) {
      missingEarlierPhase = true;
      continue;
    }
    if (missingEarlierPhase) invalid(label, `${name} skips an earlier phase`);
    const timestamp = canonicalTimestamp(raw, `${label}.${name}`);
    if (timestamp < previous || timestamp > updatedAt) {
      invalid(label, `${name} is outside completed phase timeline`);
    }
    previous = timestamp;
  }
  return previous;
}

function semanticPackages(packages: PackageArtifact[]): Array<{
  id: string;
  version: number;
  sha256: string;
  bytes: number;
}> {
  return packages.map(({ id, version, sha256, bytes }) => ({
    id,
    version,
    sha256,
    bytes,
  }));
}

export function journalDeploymentProofDigests(
  journal: ProvisionJournal,
): string[] {
  const digests = new Set<string>();
  const addObservation = (
    observation: DeploymentObservationV1 | undefined,
  ): void => {
    if (observation) digests.add(observation.evidenceSha256);
  };
  const addEvidence = (evidence: DeploymentEvidenceV1 | undefined): void => {
    if (!evidence) return;
    addObservation(evidence.expected);
    addObservation(evidence.observed);
  };
  if (journal.origin) {
    addObservation(journal.origin.plan.deploymentEvidenceExpected);
    addEvidence(journal.origin.deploymentEvidence);
  }
  addEvidence(journal.adoption?.deploymentEvidence);
  if (
    journal.current?.kind === "create" ||
    journal.current?.kind === "reinstall"
  ) {
    addEvidence(journal.current.deploymentEvidence);
  }
  if (journal.active?.kind === "create") {
    addObservation(
      journal.active.state.plan.deploymentEvidenceExpected,
    );
    addEvidence(journal.active.state.deploymentEvidence);
  } else if (journal.active?.kind === "reinstall") {
    addEvidence(journal.active.state.plan.sourceDeploymentEvidence);
    addObservation(
      journal.active.state.plan.deploymentEvidenceExpected,
    );
    addEvidence(journal.active.state.deploymentEvidence);
  }
  return [...digests].sort();
}

async function assertJournalDeploymentProofs(
  sessionPath: string,
  journal: ProvisionJournal,
): Promise<void> {
  await Promise.all(
    journalDeploymentProofDigests(journal).map((digest) =>
      readDeploymentProofBundle(sessionPath, digest),
    ),
  );
}

function assertJournalDeploymentProofsSync(
  sessionPath: string,
  journal: ProvisionJournal,
): void {
  for (const digest of journalDeploymentProofDigests(journal)) {
    readDeploymentProofBundleSync(sessionPath, digest);
  }
}

async function withExclusiveLock<T>(
  lockPath: string,
  collisionMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedPath = path.resolve(lockPath);
  await ensureSecureDirectory(path.dirname(resolvedPath));
  const processIdentity = await lockProcessIdentity(process.pid);
  if (processIdentity === null) {
    throw new Error("Unable to determine the provisioner process identity");
  }
  const contents: ExclusiveLockContents = {
    schema: EXCLUSIVE_LOCK_SCHEMA,
    pid: process.pid,
    processIdentity,
    nonce: randomBytes(16).toString("hex"),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `${resolvedPath}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      handle = await open(candidate, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(contents)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(candidate, resolvedPath);
        published = true;
        await fsyncDirectory(path.dirname(resolvedPath));
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(candidate, { force: true }).catch(() => undefined);
    }

    if (published) {
      try {
        return await operation();
      } finally {
        const current = await readExclusiveLockIfExists(resolvedPath);
        if (current?.nonce === contents.nonce) {
          await rm(resolvedPath);
          await fsyncDirectory(path.dirname(resolvedPath));
        }
      }
    }

    const existing = await readExclusiveLock(resolvedPath);
    const existingIdentity = await lockProcessIdentity(existing.pid);
    if (existingIdentity === existing.processIdentity) {
      throw new Error(collisionMessage);
    }
    const stalePath = `${resolvedPath}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      await rename(resolvedPath, stalePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const retired = await readExclusiveLock(stalePath);
    if (retired.nonce !== existing.nonce) {
      throw new Error(`Provision lock changed while retiring stale owner: ${resolvedPath}`);
    }
    await rm(stalePath);
    await fsyncDirectory(path.dirname(resolvedPath));
  }
  throw new Error(`Provision lock changed repeatedly; try again: ${resolvedPath}`);
}

async function readExclusiveLockIfExists(
  filename: string,
): Promise<ExclusiveLockContents | null> {
  try {
    return await readExclusiveLock(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readExclusiveLock(filename: string): Promise<ExclusiveLockContents> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error(`Refusing symlink provision lock ${filename}`);
    }
    throw error;
  }
  let source: string;
  try {
    const metadata = await handle.stat();
    assertPrivateOwnedFile(metadata, `provision lock ${filename}`);
    if (metadata.size > MAX_EXCLUSIVE_LOCK_BYTES) {
      throw new Error(`Provision lock is too large: ${filename}`);
    }
    source = (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Provision lock is not valid JSON: ${filename}`, {
      cause: error,
    });
  }
  const lock = record(parsed, "provision lock");
  exactKeys(
    lock,
    ["schema", "pid", "processIdentity", "nonce", "acquiredAt"],
    [],
    "provision lock",
  );
  if (lock.schema !== EXCLUSIVE_LOCK_SCHEMA) {
    throw new Error(`Unknown provision lock schema: ${filename}`);
  }
  const pid = safeInteger(lock.pid, "provision lock.pid", 1);
  const processIdentity = nonEmptyString(
    lock.processIdentity,
    "provision lock.processIdentity",
    1024,
  );
  if (typeof lock.nonce !== "string" || !/^[0-9a-f]{32}$/.test(lock.nonce)) {
    invalid("provision lock.nonce", "must be 16 lowercase hexadecimal bytes");
  }
  canonicalTimestamp(lock.acquiredAt, "provision lock.acquiredAt");
  return {
    schema: EXCLUSIVE_LOCK_SCHEMA,
    pid,
    processIdentity,
    nonce: lock.nonce,
    acquiredAt: lock.acquiredAt as string,
  };
}

async function lockProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        `/proc/${pid}/stat`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    let source: string;
    try {
      source = (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
    const commandEnd = source.lastIndexOf(")");
    if (commandEnd < 0) {
      throw new Error(`Unable to parse provisioner process identity for PID ${pid}`);
    }
    const fields = source.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/.test(startTime)) {
      throw new Error(`Unable to parse provisioner process start time for PID ${pid}`);
    }
    return `linux:${pid}:${startTime}`;
  }
  if (process.platform === "darwin") {
    const startedAt = await processStartFromPs(pid);
    return startedAt === null ? null : `darwin:${pid}:${startedAt}`;
  }
  throw new Error(`Provision lock process identity is unsupported on ${process.platform}`);
}

function processStartFromPs(pid: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", pid.toString()],
      { encoding: "utf8", maxBuffer: 4096 },
      (error, stdout) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH" || !stdout.trim()) {
            resolve(null);
            return;
          }
          reject(error);
          return;
        }
        const value = stdout.trim();
        resolve(value.length === 0 ? null : value);
      },
    );
  });
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Provision state directory must be a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Provision state directory is not owned by current user: ${directory}`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`Provision state directory must not be group/world-writable: ${directory}`);
  }
}

async function assertSafeExistingStateFile(
  filename: string,
  kind: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`Refusing symlink ${kind} ${filename}`);
  assertPrivateOwnedFile(metadata, `${kind} ${filename}`);
}

function assertPrivateOwnedFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} is not owned by current user`);
  }
  if ((Number(metadata.mode) & 0o077) !== 0) {
    throw new Error(`${label} must have mode 0600 or stricter`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown.length > 0) invalid(label, `has unknown field(s): ${unknown.join(", ")}`);
  if (missing.length > 0) invalid(label, `is missing field(s): ${missing.join(", ")}`);
}

function canonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") invalid(label, "must be an ISO timestamp");
  const date = new Date(value);
  const millis = date.getTime();
  if (!Number.isFinite(millis) || date.toISOString() !== value) {
    invalid(label, "must be a canonical ISO timestamp");
  }
  return millis;
}

function canonicalNat(value: unknown, label: string, allowZero: boolean): bigint {
  if (typeof value !== "string" || !CANONICAL_NAT_PATTERN.test(value)) {
    invalid(label, "must be a canonical decimal natural number");
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) invalid(label, "must be greater than zero");
  return parsed;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(label, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function canonicalPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "must be a principal");
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    invalid(label, "must be a valid principal");
  }
  const canonical = principal.toText();
  if (canonical !== value || canonical === ANONYMOUS_PRINCIPAL) {
    invalid(label, "must be a canonical non-anonymous principal");
  }
  return canonical;
}

function canonicalPrincipalList(
  value: unknown,
  label: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    invalid(label, `must contain 1 through ${maximum} principals`);
  }
  const principals = value.map((entry, index) =>
    canonicalPrincipal(entry, `${label}[${index}]`),
  );
  if (new Set(principals).size !== principals.length) invalid(label, "contains duplicates");
  const sorted = [...principals].sort();
  if (principals.some((principal, index) => principal !== sorted[index])) {
    invalid(label, "must be in canonical sorted order");
  }
  return principals;
}

function canonicalPrincipalArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    invalid(label, "must contain 1 through 16 principals");
  }
  const principals = value.map((entry, index) =>
    canonicalPrincipal(entry, `${label}[${index}]`),
  );
  if (new Set(principals).size !== principals.length) {
    invalid(label, "contains duplicates");
  }
  return principals;
}

function canonicalHost(value: unknown, label: string): void {
  if (typeof value !== "string") invalid(label, "must be an HTTPS origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(label, "must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    invalid(label, "must be a canonical bare HTTPS origin");
  }
}

function nonEmptyString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalid(label, `must be a non-empty string no longer than ${maximum}`);
  }
  return value;
}

function sha256String(value: unknown, label: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(label, "must be a lowercase SHA-256 digest");
  }
}

function invalid(label: string, problem: string): never {
  throw new Error(`Malformed ${label}: ${problem}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
