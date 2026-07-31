import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import type { KernelRuntimeInfo } from "neutron-compiler/src/install.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import {
  canonicalNonAnonymousPrincipal,
  canonicalPrincipals,
  IcProvisionClient,
  MANAGEMENT_CANISTER_ID,
  type CanisterOperationalState,
  type CertifiedCanisterState,
  type KernelAccessSnapshot,
} from "./ic_client.ts";
import {
  collectDeploymentObservationV1,
  createDeploymentEvidenceV1,
  persistDeploymentProofBundle,
  sweepUnreferencedDeploymentProofBundles,
  type DeploymentEvidenceProviderV1,
  type DeploymentEvidenceV1,
} from "./deployment_evidence.ts";
import {
  loadExistingBlastIdentity,
  type BlastIdentity,
} from "./identity.ts";
import { MAX_PACKAGE_ARCHIVES } from "./artifact.ts";
import {
  adoptionReceiptFingerprint,
  PROVISION_JOURNAL_SCHEMA,
  readSession,
  withMainnetExecutionLock,
  withSessionLock,
  writeSession,
  type AdoptionPackage,
  type AdoptionReceipt,
  type ProvisionJournal,
} from "./session.ts";
export type AdoptOptions = {
  configSha256: string;
  host: string;
  identityId: number;
  targetSubnet: string;
  controllers: string[];
  canisterId: string;
  sessionPath: string;
  execute: boolean;
};

export type AdoptResult = {
  mode: "plan" | "executed";
  principal: string;
  canisterId: string;
  receipt: AdoptionReceipt;
  session: ProvisionJournal | null;
};

export type AdoptClient = Pick<
  IcProvisionClient,
  | "certifiedState"
  | "operationalState"
  | "kernelActor"
  | "kernelAccessSnapshot"
>;

export type AdoptDependencies = {
  loadIdentity?: (id: number) => Promise<BlastIdentity>;
  createClient?: (input: {
    host: string;
    identity: Identity;
    logger: Pick<Console, "log">;
  }) => Promise<AdoptClient>;
  deploymentEvidenceProvider?: DeploymentEvidenceProviderV1;
  now?: () => Date;
  logger?: Pick<Console, "log">;
};

type AdoptionSnapshot = Omit<
  AdoptionReceipt,
  | "adoptedAt"
  | "deploymentEvidence"
  | "fingerprint"
>;

export async function runAdopt(
  options: AdoptOptions,
  dependencies: AdoptDependencies = {},
): Promise<AdoptResult> {
  const logger = dependencies.logger ?? console;
  const now = dependencies.now ?? (() => new Date());
  const canisterId = canonicalAdoptionTarget(options.canisterId);
  const identity = await (
    dependencies.loadIdentity ?? loadExistingBlastIdentity
  )(options.identityId);
  if (identity.id !== options.identityId) {
    throw new Error("Loaded icblast identity does not match configured identity ID");
  }
  const deployerPrincipal = canonicalNonAnonymousPrincipal(
    identity.principal,
    "Configured icblast principal",
  );
  const targetSubnet = canonicalNonAnonymousPrincipal(
    options.targetSubnet,
    "Configured target subnet",
  );
  const expectedControllers = canonicalExpectedControllers(
    deployerPrincipal,
    canisterId,
    options.controllers,
  );
  const deploymentEvidenceProvider =
    dependencies.deploymentEvidenceProvider;
  if (!deploymentEvidenceProvider) {
    throw new Error(
      "Adoption requires a certified deployment evidence provider",
    );
  }

  await requireEmptyJournal(options.sessionPath);
  const client = await (
    dependencies.createClient ??
    ((input) => IcProvisionClient.create(input))
  )({ host: options.host, identity: identity.identity, logger });
  const expectedDeployment = await collectDeploymentObservationV1(
    deploymentEvidenceProvider,
    { subnetId: targetSubnet },
  );
  const expectedSnapshot = await observeAdoptionSnapshot({
    options,
    client,
    canisterId,
    deployerPrincipal,
    targetSubnet,
    expectedControllers,
  });
  if (!options.execute) {
    const observedDeployment = await collectDeploymentObservationV1(
      deploymentEvidenceProvider,
      { subnetId: targetSubnet },
    );
    const deploymentEvidence = createDeploymentEvidenceV1(
      expectedDeployment.observation,
      observedDeployment.observation,
      {
        expected: expectedDeployment.proofBundle,
        observed: observedDeployment.proofBundle,
      },
    );
    const receipt = createAdoptionReceipt(
      expectedSnapshot,
      deploymentEvidence,
      now,
    );
    printAdoption(receipt, logger, false);
    return {
      mode: "plan",
      principal: deployerPrincipal,
      canisterId,
      receipt,
      session: null,
    };
  }

  const session = await withMainnetExecutionLock(
    deployerPrincipal,
    () =>
      withSessionLock(options.sessionPath, async () => {
        await requireEmptyJournal(options.sessionPath);
        const observedDeployment = await collectDeploymentObservationV1(
          deploymentEvidenceProvider,
          { subnetId: targetSubnet },
        );
        // Re-prove the full canister/runtime/access snapshot after the
        // potentially slow registry query, closing the receipt window.
        const observedSnapshot = await observeAdoptionSnapshot({
          options,
          client,
          canisterId,
          deployerPrincipal,
          targetSubnet,
          expectedControllers,
        });
        if (!sameAdoptionSnapshot(expectedSnapshot, observedSnapshot)) {
          throw new Error(
            "Adoption evidence changed before the receipt could be written; inspect the canister and rerun adoption",
          );
        }
        const deploymentEvidence = createDeploymentEvidenceV1(
          expectedDeployment.observation,
          observedDeployment.observation,
          {
            expected: expectedDeployment.proofBundle,
            observed: observedDeployment.proofBundle,
          },
        );
        const receipt = createAdoptionReceipt(
          observedSnapshot,
          deploymentEvidence,
          now,
        );
        await sweepUnreferencedDeploymentProofBundles(options.sessionPath);
        await persistDeploymentProofBundle(
          options.sessionPath,
          expectedDeployment.proofBundle,
          deploymentEvidence.expected.evidenceSha256,
        );
        await persistDeploymentProofBundle(
          options.sessionPath,
          observedDeployment.proofBundle,
          deploymentEvidence.observed.evidenceSha256,
        );
        const timestamp = receipt.adoptedAt;
        const journal: ProvisionJournal = {
          schema: PROVISION_JOURNAL_SCHEMA,
          configSha256: options.configSha256,
          createdAt: timestamp,
          updatedAt: timestamp,
          runtime: { kind: "ic" },
          adoption: receipt,
        };
        await writeSession(options.sessionPath, journal, now());
        return journal;
      }),
  );

  printAdoption(session.adoption!, logger, true);
  logger.log(`Recorded schema-3 adoption receipt ${options.sessionPath}`);
  logger.log(`Existing Neutron adopted at https://${canisterId}.icp0.io/`);
  return {
    mode: "executed",
    principal: deployerPrincipal,
    canisterId,
    receipt: session.adoption!,
    session,
  };
}

async function observeAdoptionSnapshot({
  options,
  client,
  canisterId,
  deployerPrincipal,
  targetSubnet,
  expectedControllers,
}: {
  options: AdoptOptions;
  client: AdoptClient;
  canisterId: string;
  deployerPrincipal: string;
  targetSubnet: string;
  expectedControllers: string[];
}): Promise<AdoptionSnapshot> {
  const [certifiedBefore, operationalBefore] = await Promise.all([
    client.certifiedState(canisterId),
    client.operationalState(canisterId),
  ]);
  assertAdoptableTarget({
    canisterId,
    targetSubnet,
    expectedControllers,
    certified: certifiedBefore,
    operational: operationalBefore,
  });

  const [runtime, access] = await Promise.all([
    client.kernelActor(canisterId).kernel_runtime_info(),
    client.kernelAccessSnapshot(canisterId),
  ]);
  const normalizedRuntime = normalizeRuntime(runtime);
  const normalizedAccess = normalizeAccess({
    access,
    canisterId,
    deployerPrincipal,
    expectedControllers,
  });

  const [certifiedAfter, operationalAfter] = await Promise.all([
    client.certifiedState(canisterId),
    client.operationalState(canisterId),
  ]);
  assertAdoptableTarget({
    canisterId,
    targetSubnet,
    expectedControllers,
    certified: certifiedAfter,
    operational: operationalAfter,
  });
  assertObservationStable(
    certifiedBefore,
    operationalBefore,
    certifiedAfter,
    operationalAfter,
  );

  return {
    kind: "adopted",
    configSha256: options.configSha256,
    host: options.host,
    identityId: options.identityId,
    deployerPrincipal,
    targetSubnet,
    canisterId,
    controllers: expectedControllers,
    status: "running",
    moduleHash: operationalAfter.moduleHash!,
    settingsFingerprint: operationalAfter.settingsFingerprint,
    runtime: normalizedRuntime,
    access: normalizedAccess,
  };
}

function createAdoptionReceipt(
  snapshot: AdoptionSnapshot,
  deploymentEvidence: DeploymentEvidenceV1,
  now: () => Date,
): AdoptionReceipt {
  const base: Omit<AdoptionReceipt, "fingerprint"> = {
    ...snapshot,
    adoptedAt: now().toISOString(),
    deploymentEvidence,
  };
  return { ...base, fingerprint: adoptionReceiptFingerprint(base) };
}

function sameAdoptionSnapshot(
  left: AdoptionSnapshot,
  right: AdoptionSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertAdoptableTarget({
  canisterId,
  targetSubnet,
  expectedControllers,
  certified,
  operational,
}: {
  canisterId: string;
  targetSubnet: string;
  expectedControllers: string[];
  certified: CertifiedCanisterState;
  operational: CanisterOperationalState;
}): void {
  if (certified.subnetId !== targetSubnet) {
    throw new Error(
      `Canister ${canisterId} is on subnet ${certified.subnetId}, expected ${targetSubnet}`,
    );
  }
  if (!certified.moduleHash || certified.moduleHash !== operational.moduleHash) {
    throw new Error("Certified and management module state do not agree");
  }
  if (!sameStrings(certified.controllers, operational.controllers)) {
    throw new Error("Certified and management controller state do not agree");
  }
  if (!sameStrings(operational.controllers, expectedControllers)) {
    throw new Error(
      `Live controllers do not exactly match configured controllers plus self: expected ${expectedControllers.join(", ")}, found ${operational.controllers.join(", ")}`,
    );
  }
  if (operational.status !== "running") {
    throw new Error(
      `Adoption requires a running Neutron so its runtime and access can be verified; found ${operational.status}`,
    );
  }
}

function normalizeRuntime(runtime: KernelRuntimeInfo): {
  deploymentId: string;
  compilerId: string;
  assemblerId: string;
  packages: AdoptionPackage[];
} {
  const deploymentId = boundedText(
    runtime.deployment_id,
    "Kernel runtime deployment ID",
  );
  const compilerId = boundedText(
    runtime.compiler_id,
    "Kernel runtime compiler ID",
  );
  const assemblerId = boundedText(
    runtime.assembler_id,
    "Kernel runtime assembler ID",
  );
  if (assemblerId !== ASSEMBLER_ID) {
    throw new Error(
      `Kernel runtime assembler ${assemblerId} does not match ${ASSEMBLER_ID}`,
    );
  }
  if (!Array.isArray(runtime.apps) || runtime.apps.length === 0) {
    throw new Error("Kernel runtime has no installed app inventory");
  }
  if (runtime.apps.length > MAX_PACKAGE_ARCHIVES) {
    throw new Error("Kernel runtime app inventory exceeds the adoption limit");
  }
  const packages = runtime.apps.map((app, index) => {
    const id = app.scope?.app_id;
    if (!isValidAppId(id)) {
      throw new Error(`Kernel runtime app ${index} has an invalid app ID`);
    }
    if (app.deployment_id !== deploymentId) {
      throw new Error(
        `Kernel runtime app ${id} does not match runtime deployment ${deploymentId}`,
      );
    }
    return {
      id,
      version: naturalNumber(app.version, `Kernel runtime app ${id} version`),
    };
  });
  packages.sort((left, right) => left.id.localeCompare(right.id));
  const uniqueIds = new Set(packages.map(({ id }) => id));
  if (uniqueIds.size !== packages.length) {
    throw new Error("Kernel runtime app inventory contains duplicate app IDs");
  }
  if (packages.filter(({ id }) => id === "kernel").length !== 1) {
    throw new Error("Kernel runtime must contain exactly one kernel app");
  }
  return { deploymentId, compilerId, assemblerId, packages };
}

function normalizeAccess({
  access,
  canisterId,
  deployerPrincipal,
  expectedControllers,
}: {
  access: KernelAccessSnapshot;
  canisterId: string;
  deployerPrincipal: string;
  expectedControllers: string[];
}): AdoptionReceipt["access"] {
  const selfPrincipal = canonicalNonAnonymousPrincipal(
    access.selfPrincipal,
    "Kernel access self principal",
  );
  if (selfPrincipal !== canisterId) {
    throw new Error(
      `Kernel access snapshot belongs to ${selfPrincipal}, expected ${canisterId}`,
    );
  }
  const controllers = canonicalPrincipals(access.controllers);
  if (!sameStrings(controllers, expectedControllers)) {
    throw new Error("Kernel access controllers do not match certified controllers");
  }
  const authorizedPrincipals = canonicalPrincipals(
    access.authorizedPrincipals.map((principal) =>
      canonicalNonAnonymousPrincipal(principal, "Kernel authorized principal"),
    ),
  );
  if (!authorizedPrincipals.includes(deployerPrincipal)) {
    throw new Error(
      `Configured icblast principal ${deployerPrincipal} is not Kernel-authorized`,
    );
  }
  if (access.snapshotVersion < 0n) {
    throw new Error("Kernel access snapshot version must be a natural number");
  }
  if (access.controllerLimit < BigInt(expectedControllers.length)) {
    throw new Error(
      "Kernel access controller limit is below the verified controller count",
    );
  }
  return {
    snapshotVersion: access.snapshotVersion.toString(),
    authorizedPrincipals,
    controllerLimit: access.controllerLimit.toString(),
  };
}

function assertObservationStable(
  certifiedBefore: CertifiedCanisterState,
  operationalBefore: CanisterOperationalState,
  certifiedAfter: CertifiedCanisterState,
  operationalAfter: CanisterOperationalState,
): void {
  if (
    certifiedBefore.subnetId !== certifiedAfter.subnetId ||
    certifiedBefore.moduleHash !== certifiedAfter.moduleHash ||
    !sameStrings(certifiedBefore.controllers, certifiedAfter.controllers) ||
    operationalBefore.status !== operationalAfter.status ||
    operationalBefore.moduleHash !== operationalAfter.moduleHash ||
    operationalBefore.settingsFingerprint !==
      operationalAfter.settingsFingerprint ||
    !sameStrings(operationalBefore.controllers, operationalAfter.controllers)
  ) {
    throw new Error("Canister state changed during adoption verification");
  }
}

function canonicalExpectedControllers(
  deployerPrincipal: string,
  canisterId: string,
  configuredControllers: string[],
): string[] {
  const controllers = canonicalPrincipals([
    deployerPrincipal,
    canisterId,
    ...configuredControllers.map((controller) =>
      canonicalNonAnonymousPrincipal(controller, "Configured controller"),
    ),
  ]);
  if (controllers.length > 10) {
    throw new Error("Adoption supports at most ten total canister controllers");
  }
  return controllers;
}

export function canonicalAdoptionTarget(value: string): string {
  const canonical = canonicalNonAnonymousPrincipal(
    value,
    "Adoption target canister",
  );
  if (canonical !== value) {
    throw new Error("Adoption target canister must use canonical principal text");
  }
  if (canonical === MANAGEMENT_CANISTER_ID) {
    throw new Error("The management canister cannot be adopted");
  }
  const bytes = Principal.fromText(canonical).toUint8Array();
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 1) {
    throw new Error("Adoption target must be an opaque canister principal");
  }
  return canonical;
}

async function requireEmptyJournal(sessionPath: string): Promise<void> {
  if (await readSession(sessionPath)) {
    throw new Error(
      `Adoption requires an empty deployment session; refusing to overwrite ${sessionPath}`,
    );
  }
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function naturalNumber(value: bigint | number, label: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds the supported natural-number range`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a safe natural number`);
  }
  return value;
}

function printAdoption(
  receipt: AdoptionReceipt,
  logger: Pick<Console, "log">,
  execute: boolean,
): void {
  logger.log(
    execute
      ? "Neutron schema-3 adoption receipt"
      : "Neutron schema-3 adoption plan (live verification only)",
  );
  logger.log(`Target: ${receipt.canisterId}`);
  logger.log(
    `Blast identity: ${receipt.identityId} (${receipt.deployerPrincipal})`,
  );
  logger.log(`Subnet: ${receipt.targetSubnet}`);
  logger.log(`Controllers: ${receipt.controllers.join(", ")}`);
  logger.log(`Live module: ${receipt.moduleHash}`);
  logger.log(
    `Runtime: ${receipt.runtime.deploymentId} (${receipt.runtime.packages.length} apps)`,
  );
  logger.log("CMC payment: none; no canister will be created");
  logger.log(
    execute
      ? "Receipt write: enabled after a second live verification"
      : "Receipt write: disabled; rerun with --execute",
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  const canonicalLeft = canonicalPrincipals(left);
  const canonicalRight = canonicalPrincipals(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}
