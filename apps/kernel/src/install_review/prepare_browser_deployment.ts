import {
  prepareCompleteDeploymentBuildRecord,
  retainedDeploymentPackageEvidenceFromRecord,
  type AppRegistry,
  type CompileResult,
  type KernelPackageState,
  type KernelRuntimeInfo,
  type PreparedPackageInstall,
  type RetainedDeploymentPackageEvidence,
} from "neutron-compiler/src/install.js";
import type { PreparedCompleteDeploymentBuild } from "neutron-compiler/src/deployment_record.js";
import {
  parseNeutronPackageRecordStructure,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import { hashContent } from "neutron-tools/src/hash.js";
import type { InstallProvenance } from "../repository/provenance.ts";
import {
  deploymentRecordExpectedModuleHash,
  deploymentRecordRuntimeInconsistency,
  loadInstalledDeploymentBuildRecord,
  type InstalledDeploymentBuildRecordInspection,
} from "../settings/deployment_build_record.ts";
import {
  loadInstalledPackageRecordInventory,
  type InstalledPackageRecordInspection,
  type InstalledPackageRecordInventory,
} from "../settings/installed_package_record.ts";
import {
  createDeploymentBuildReviewModel,
  type DeploymentBuildReviewInput,
  type RetainedPackageRecordReviewEvidence,
} from "./deployment_build_review.ts";

export type PreparedBrowserDeployment = Readonly<{
  /** Sealed record and exact transport/JSON bytes produced by the compiler layer. */
  prepared: PreparedCompleteDeploymentBuild;
  /** Display/export inputs for the user-visible pre-dispatch review. */
  review: DeploymentBuildReviewInput;
}>;

export type BrowserDeploymentEvidenceReaders = Readonly<{
  loadDeploymentRecord?: () => Promise<InstalledDeploymentBuildRecordInspection>;
  loadPackageRecords?: (
    apps: AppRegistry,
  ) => Promise<InstalledPackageRecordInventory>;
}>;

/**
 * Prepare one whole-deployment record before dispatch. Existing evidence is
 * carried only when it is bound to the exact checked runtime; missing v306-era
 * data remains explicit instead of being invented. No canister write occurs.
 */
export async function prepareBrowserDeployment({
  compiled,
  expectedDeploymentId,
  packages,
  provenance,
  readers = {},
  removedApps = [],
  runtime,
  state,
  targetCanisterId,
}: Readonly<{
  compiled: CompileResult;
  expectedDeploymentId: string;
  packages: readonly PreparedPackageInstall[];
  provenance: InstallProvenance;
  readers?: BrowserDeploymentEvidenceReaders;
  removedApps?: readonly string[];
  runtime: KernelRuntimeInfo;
  state: KernelPackageState;
  targetCanisterId: string;
}>): Promise<PreparedBrowserDeployment> {
  if (runtime.deployment_id !== expectedDeploymentId) {
    throw new Error(
      "Deployment evidence baseline does not match the checked runtime",
    );
  }

  const [installedDeployment, installedPackages] = await Promise.all([
    readers.loadDeploymentRecord
      ? readers.loadDeploymentRecord()
      : loadInstalledDeploymentBuildRecord({ canisterId: targetCanisterId }),
    (readers.loadPackageRecords ?? loadInstalledPackageRecordInventory)(
      state.apps,
    ),
  ]);
  const carried = carriedDeploymentEvidence(
    installedDeployment,
    runtime,
    targetCanisterId,
    state.apps,
  );
  const suppliedIds = new Set(packages.map(({ manifest }) => manifest.id));
  const targetIds = new Set(
    compiled.appInstanceInventory.map(({ app_id }) => app_id),
  );
  const retainedPackageEvidence: Record<
    string,
    RetainedDeploymentPackageEvidence
  > = Object.create(null) as Record<
    string,
    RetainedDeploymentPackageEvidence
  >;
  const retainedPackageRecords: Record<
    string,
    RetainedPackageRecordReviewEvidence
  > = Object.create(null) as Record<
    string,
    RetainedPackageRecordReviewEvidence
  >;

  for (const appId of [...targetIds].sort()) {
    if (suppliedIds.has(appId)) continue;
    const installed = state.apps[appId];
    if (!installed) {
      throw new Error(`Retained target package ${appId} is not installed`);
    }
    const previous = carried[appId];
    const provenanceDigest = provenance.apps[appId]?.package_digest;
    const archive = reconcileRetainedArchive(
      appId,
      previous?.archive,
      provenanceDigest,
    );
    const packageInformation = reconcileRetainedPackageInformation(
      appId,
      installed.version,
      installedPackages[appId],
      previous?.package_information,
      retainedPackageRecords,
    );
    retainedPackageEvidence[appId] = Object.freeze({
      version: installed.version,
      archive,
      package_information: packageInformation,
    });
  }

  const prepared = prepareCompleteDeploymentBuildRecord({
    targetCanisterId,
    packages: [...packages],
    state,
    compiled,
    expectedDeploymentId,
    ...(removedApps.length > 0 ? { removedApps } : {}),
    retainedPackageEvidence,
  });
  const review = Object.freeze({
    record: prepared.record,
    suppliedPackages: Object.freeze([...packages]),
    retainedPackageRecords: Object.freeze(retainedPackageRecords),
  });
  // Seal the display/export reconciliation before any caller publishes a
  // final approval surface. Rendering must never be the first validation.
  createDeploymentBuildReviewModel(review);
  return Object.freeze({
    prepared,
    review,
  });
}

function carriedDeploymentEvidence(
  inspection: InstalledDeploymentBuildRecordInspection,
  runtime: KernelRuntimeInfo,
  targetCanisterId: string,
  apps: AppRegistry,
): Readonly<Record<string, RetainedDeploymentPackageEvidence>> {
  if (inspection.status === "legacy") return Object.freeze({});
  if (inspection.status === "unavailable") {
    throw new Error(
      `Installed deployment build record is unavailable: ${inspection.message}`,
    );
  }
  if (inspection.status === "invalid") {
    throw new Error(
      `Installed deployment build record is invalid: ${inspection.message}`,
    );
  }
  const deploymentId = deploymentRecordExpectedModuleHash(
    inspection.record,
  ).deployment_id;
  if (deploymentId !== runtime.deployment_id) {
    throw new Error(
      `Installed deployment build record describes ${deploymentId}, expected ${runtime.deployment_id}`,
    );
  }
  const inconsistency = deploymentRecordRuntimeInconsistency(
    inspection.record,
    runtime,
  );
  if (inconsistency !== null) {
    throw new Error(
      `Installed deployment build record is inconsistent: ${inconsistency}`,
    );
  }
  return retainedDeploymentPackageEvidenceFromRecord(inspection.record, {
    targetCanisterId,
    deploymentId: runtime.deployment_id,
    apps,
  });
}

function reconcileRetainedArchive(
  appId: string,
  carried: RetainedDeploymentPackageEvidence["archive"] | undefined,
  provenanceSha256: string | undefined,
): RetainedDeploymentPackageEvidence["archive"] {
  if (carried && carried.state !== "legacy_unavailable") {
    if (provenanceSha256 && provenanceSha256 !== carried.sha256) {
      throw new Error(
        `Installed package archive evidence for ${appId} conflicts with install provenance`,
      );
    }
    return carried;
  }
  return provenanceSha256
    ? Object.freeze({
        state: "outer_archive_digest_only" as const,
        sha256: provenanceSha256,
      })
    : Object.freeze({ state: "legacy_unavailable" as const });
}

function reconcileRetainedPackageInformation(
  appId: string,
  installedVersion: number,
  inspection: InstalledPackageRecordInspection | undefined,
  carried: RetainedDeploymentPackageEvidence["package_information"] | undefined,
  retainedRecords: Record<string, RetainedPackageRecordReviewEvidence>,
): RetainedDeploymentPackageEvidence["package_information"] {
  if (!inspection || inspection.status === "loading") {
    throw new Error(
      `Installed Package Information Record status for ${appId} is unavailable`,
    );
  }
  if (inspection.status === "invalid" || inspection.status === "unavailable") {
    throw new Error(
      `Installed Package Information Record for ${appId} is ${inspection.status}: ${inspection.message}`,
    );
  }
  if (inspection.status === "declared") {
    const exactRecord = parseNeutronPackageRecordStructure(
      inspection.recordBytes,
    );
    const exactSha256 = hashContent(inspection.recordBytes);
    if (exactSha256 !== inspection.recordSha256) {
      throw new Error(
        `Installed Package Information Record for ${appId} SHA-256 does not match its exact bytes`,
      );
    }
    if (
      exactRecord.package.id !== appId ||
      exactRecord.package.version !== installedVersion
    ) {
      throw new Error(
        `Installed Package Information Record for ${appId} does not match installed version ${installedVersion}`,
      );
    }
    if (!samePackageInformationRecord(exactRecord, inspection.record)) {
      throw new Error(
        `Installed Package Information Record for ${appId} changed after parsing`,
      );
    }
    if (
      carried?.state === "verified" &&
      carried.sha256 !== exactSha256
    ) {
      throw new Error(
        `Installed Package Information Record for ${appId} conflicts with the deployment record`,
      );
    }
    if (carried?.state === "not_supplied") {
      throw new Error(
        `Installed Package Information Record for ${appId} appeared without a package replacement`,
      );
    }
    const recordBytes = inspection.recordBytes.slice();
    retainedRecords[appId] = Object.freeze({
      record: exactRecord,
      recordBytes,
      sha256: exactSha256,
    });
    return Object.freeze({
      state: "verified" as const,
      sha256: exactSha256,
    });
  }

  if (carried?.state === "verified") {
    throw new Error(
      `Installed Package Information Record for ${appId} is missing but the deployment record says it was verified`,
    );
  }
  return carried ?? Object.freeze({ state: "legacy_unavailable" as const });
}

function samePackageInformationRecord(
  left: NeutronPackageRecordV1,
  right: NeutronPackageRecordV1,
): boolean {
  try {
    const normalizedRight = parseNeutronPackageRecordStructure(
      new TextEncoder().encode(JSON.stringify(right)),
    );
    return JSON.stringify(left) === JSON.stringify(normalizedRight);
  } catch {
    return false;
  }
}
