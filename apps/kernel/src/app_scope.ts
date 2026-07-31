import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { assertAppVersion } from "neutron-tools/src/version.js";
import {
  isResidentFrameSecurityMode,
  type ResidentFrameSecurityMode,
} from "./capabilities/plan.ts";
import { MAX_INSTALLED_APP_INSTANCES } from "./runtime_limits.ts";

export type AppScope = Readonly<{
  appId: string;
  installationUid: string;
}>;

export type AppInstanceProjection = Readonly<{
  scope: AppScope;
  version: number;
  deploymentId: string;
  capabilityPlanFingerprint: string;
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: string;
  residentFrameSecurity: ResidentFrameSecurityMode;
}>;

const U64_MAX = 18_446_744_073_709_551_615n;

export function normalizeAppInstanceInventory(
  value: unknown,
  expectedDeploymentId: string,
): Readonly<Record<string, AppInstanceProjection>> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_INSTALLED_APP_INSTANCES
  ) {
    throw new Error("Runtime app-instance inventory is invalid");
  }
  if (!isDeploymentId(expectedDeploymentId)) {
    throw new Error("Runtime deployment id is invalid");
  }

  const instances: Record<string, AppInstanceProjection> = {};
  const installationUids = new Set<string>();
  const originNonces = new Set<string>();
  let previousAppId: string | null = null;
  for (const candidate of value) {
    const record = exactRecord(candidate, [
      "scope",
      "version",
      "deployment_id",
      "capability_plan_fingerprint",
      "browser_origin_nonce",
      "browser_origin_authority_epoch",
      "resident_frame_security",
    ]);
    const scope = exactRecord(record.scope, ["app_id", "installation_uid"]);
    const appId = scope.app_id;
    if (!isValidAppId(appId)) {
      throw new Error("Runtime app instance has an invalid app id");
    }
    if (
      previousAppId !== null &&
      compareCanonicalText(previousAppId, appId) >= 0
    ) {
      throw new Error("Runtime app-instance inventory is not canonical");
    }
    previousAppId = appId;

    const installationUid = natural64(scope.installation_uid, "installation uid");
    if (installationUid === "0" || installationUids.has(installationUid)) {
      throw new Error("Runtime app installation uid is invalid or repeated");
    }
    installationUids.add(installationUid);

    const version = naturalNumber(record.version, "app version");
    assertAppVersion(version, "Runtime app version");
    if (record.deployment_id !== expectedDeploymentId) {
      throw new Error("Runtime app instance belongs to another deployment");
    }
    if (
      typeof record.capability_plan_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.capability_plan_fingerprint)
    ) {
      throw new Error("Runtime app capability fingerprint is invalid");
    }
    if (
      typeof record.browser_origin_nonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(record.browser_origin_nonce) ||
      originNonces.has(record.browser_origin_nonce)
    ) {
      throw new Error("Runtime browser-origin nonce is invalid or repeated");
    }
    originNonces.add(record.browser_origin_nonce);
    const browserOriginAuthorityEpoch = natural64(
      record.browser_origin_authority_epoch,
      "browser-origin authority epoch",
    );
    if (browserOriginAuthorityEpoch === "0") {
      throw new Error("Runtime browser-origin authority epoch is invalid");
    }
    const residentFrameSecurity = parseResidentFrameSecurity(
      record.resident_frame_security,
    );

    instances[appId] = Object.freeze({
      scope: Object.freeze({ appId, installationUid }),
      version,
      deploymentId: expectedDeploymentId,
      capabilityPlanFingerprint: record.capability_plan_fingerprint,
      browserOriginNonce: record.browser_origin_nonce,
      browserOriginAuthorityEpoch,
      residentFrameSecurity,
    });
  }
  return Object.freeze(instances);
}

export function sameAppScope(
  left: AppScope | null | undefined,
  right: AppScope | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.appId === right.appId &&
    left.installationUid === right.installationUid
  );
}

/**
 * Browser authority is bound to the complete runtime projection, not only the
 * long-lived installation uid. Every actor deployment receives a new
 * deployment id, including same-version rebuilds whose manifest and
 * capability plan are otherwise identical.
 */
export function sameAppInstance(
  left: AppInstanceProjection | null | undefined,
  right: AppInstanceProjection | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    sameAppScope(left.scope, right.scope) &&
    left.version === right.version &&
    left.deploymentId === right.deploymentId &&
    left.capabilityPlanFingerprint === right.capabilityPlanFingerprint &&
    left.browserOriginNonce === right.browserOriginNonce &&
    left.browserOriginAuthorityEpoch === right.browserOriginAuthorityEpoch &&
    left.residentFrameSecurity === right.residentFrameSecurity
  );
}

export function sameAppInstanceInventory(
  left: Readonly<Record<string, AppInstanceProjection>>,
  right: Readonly<Record<string, AppInstanceProjection>>,
): boolean {
  const leftIds = Object.keys(left).sort(compareCanonicalText);
  const rightIds = Object.keys(right).sort(compareCanonicalText);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every(
      (appId, index) =>
        appId === rightIds[index] &&
        sameAppInstance(left[appId], right[appId]),
    )
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime app-instance record is invalid");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareCanonicalText);
  const expected = [...keys].sort(compareCanonicalText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Runtime app-instance record has unknown or missing fields");
  }
  return record;
}

function natural64(value: unknown, label: string): string {
  let number: bigint;
  if (typeof value === "bigint") {
    number = value;
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    number = BigInt(value);
  } else {
    throw new Error(`Runtime ${label} is invalid`);
  }
  if (number < 0n || number > U64_MAX) {
    throw new Error(`Runtime ${label} is invalid`);
  }
  return String(number);
}

function naturalNumber(value: unknown, label: string): number {
  const text = natural64(value, label);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Runtime ${label} exceeds browser limits`);
  }
  return number;
}

function isDeploymentId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{4,96}$/u.test(value);
}

function parseResidentFrameSecurity(
  value: unknown,
): ResidentFrameSecurityMode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime resident frame security mode is invalid");
  }
  const entries = Object.entries(value);
  const [mode, payload] = entries[0] ?? [];
  if (
    entries.length !== 1 ||
    payload !== null ||
    !isResidentFrameSecurityMode(mode)
  ) {
    throw new Error("Runtime resident frame security mode is invalid");
  }
  return mode;
}
