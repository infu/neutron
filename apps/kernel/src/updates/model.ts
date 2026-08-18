import type { RepositoryReleaseRecord } from "neutron-tools/repository";
import type {
  CapabilityInstallDisclosureWireV1,
  CapabilityPlanDiffV1,
} from "neutron-tools/src/capabilities/wire.js";
import type { NormalizedNeutronAppDependencyConfig } from "neutron-tools/src/schema.js";
import type {
  AppPermissionExplanation,
  Permission,
} from "../lib/perm.ts";
import type { CompileResult } from "neutron-compiler/src/install.js";
import type { DeploymentBuildReviewInput } from "../install_review/deployment_build_review.ts";

export const UPDATE_CHECK_WAVE_SIZE = 20;
export const UPDATE_RELEASE_MAX_BYTES = 16 * 1024;
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

export type UpdateCheckFailureCode =
  | "unavailable"
  | "timed_out"
  | "uncertified"
  | "redirected"
  | "wrong_origin"
  | "too_large"
  | "wrong_content_type"
  | "malformed_record"
  | "wrong_id"
  | "unverifiable"
  | "equivocation"
  | "source_regression";

export class UpdateCheckError extends Error {
  readonly code: UpdateCheckFailureCode;

  constructor(
    code: UpdateCheckFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpdateCheckError";
    this.code = code;
  }
}

export type InstalledUpdateApp = Readonly<{
  appId: string;
  name: string;
  version: number;
  updateSource?: string;
  packageDigest?: string;
}>;

export type FetchedRelease = Readonly<{
  source: string;
  record: RepositoryReleaseRecord;
  releaseDigest: string;
}>;

type UpdateResultBase = Readonly<{
  appId: string;
  name: string;
}>;

export type UpdateCheckResult =
  | (UpdateResultBase & {
      kind: "manual_only";
      installed: number;
    })
  | (UpdateResultBase & {
      kind: "queued";
      installed: number;
      source: string;
    })
  | (UpdateResultBase & {
      kind: "checking";
      installed: number;
      source: string;
    })
  | (UpdateResultBase & {
      kind: "cancelled";
      installed: number;
      source: string;
    })
  | (UpdateResultBase & {
      kind: "current";
      installed: number;
      source: string;
      release: RepositoryReleaseRecord;
      releaseDigest: string;
    })
  | (UpdateResultBase & {
      kind: "available";
      installed: number;
      source: string;
      release: RepositoryReleaseRecord;
      releaseDigest: string;
    })
  | (UpdateResultBase & {
      kind: "not_published";
      installed: number;
      source: string;
    })
  | (UpdateResultBase & {
      kind: "source_regression";
      installed: number;
      source: string;
      advertised: number;
    })
  | (UpdateResultBase & {
      kind: "failed";
      installed: number;
      source: string;
      reason: UpdateCheckFailureCode;
    });

export type UpdateSourceProgress = Readonly<{
  source: string;
  completed: number;
  total: number;
}>;

export type UpdateCheckSummary = Readonly<{
  checkedAt: number;
  results: readonly UpdateCheckResult[];
  sources: readonly string[];
}>;

export type UpdateReviewApp = Readonly<{
  appId: string;
  name: string;
  installedVersion: number;
  targetVersion: number;
  source: string;
  currentUpdateSource?: string;
  targetUpdateSource?: string;
  packageBytes: number;
  packageDigest: string;
  releaseDigest: string;
  capabilityPlanDiff: CapabilityPlanDiffV1;
  capabilityDisclosures: readonly CapabilityInstallDisclosureWireV1[];
  permissions: readonly Permission[];
  appExplanations: readonly AppPermissionExplanation[];
  dependencies: Readonly<Record<string, NormalizedNeutronAppDependencyConfig>>;
}>;

export type UpdateReview = Readonly<{
  apps: readonly UpdateReviewApp[];
  deploymentBuild: DeploymentBuildReviewInput;
  compiledSizeKiB: number;
  migrationPlan: CompileResult["migrationPlan"];
  diagnostics: readonly string[];
  compatibilityDiagnostics: readonly string[];
}>;

export function updateFailureMessage(code: UpdateCheckFailureCode): string {
  switch (code) {
    case "unavailable":
      return "The update source is unavailable.";
    case "timed_out":
      return "The update source took too long to respond.";
    case "uncertified":
      return "The update source was not served through a verified canister origin.";
    case "redirected":
      return "The update source redirected the request.";
    case "wrong_origin":
      return "The update response came from a different origin.";
    case "too_large":
      return "The update record exceeds Neutron's size limit.";
    case "wrong_content_type":
      return "The update source returned the wrong content type.";
    case "malformed_record":
      return "The update source returned an invalid release record.";
    case "wrong_id":
      return "The update source returned a different package ID.";
    case "unverifiable":
      return "Neutron has no package digest for this installed version. Install a newer package manually before trusting this source.";
    case "equivocation":
      return "The source published different bytes for the installed version.";
    case "source_regression":
      return "The source advertises an older release.";
  }
}
