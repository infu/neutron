import type { DeclaredCapabilityPlanEntry } from "neutron-tools/src/capabilities/plan.js";
import {
  projectRuntimeCapabilityRegistrationsV1,
  type RuntimeCapabilityRegistrationV1,
} from "neutron-tools/src/capabilities/runtime.js";
import {
  assertCapabilityPlanFingerprint,
  parseCapabilityPlanWireV1,
  projectCapabilitySettingsWireV1,
  type CapabilityPlanWireV1,
  type CapabilitySettingsWireV1,
} from "neutron-tools/src/capabilities/wire.js";

export const ResidentFrameSecurityMode = Object.freeze({
  CREDENTIALLESS_OPAQUE_V1: "credentialless_opaque_v1",
  CREDENTIALLESS_EPHEMERAL_DEDICATED_V1:
    "credentialless_ephemeral_dedicated_v1",
  PERSISTENT_DEDICATED_V1: "persistent_dedicated_v1",
} as const);

export type ResidentFrameSecurityMode =
  (typeof ResidentFrameSecurityMode)[keyof typeof ResidentFrameSecurityMode];

export type ResidentFrameSecurityBinding = Readonly<{
  mode: ResidentFrameSecurityMode;
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: string;
}>;

export type CapabilityPlanCarrier = {
  capability_plan: CapabilityPlanWireV1;
  capability_plan_fingerprint: string;
};

type VerifiedPlan = {
  fingerprint: string;
  source: CapabilityPlanWireV1;
  plan: CapabilityPlanWireV1;
  settings?: CapabilitySettingsWireV1;
};

const verifiedPlans = new WeakMap<object, VerifiedPlan>();

type DeclaredCapabilityConfig<
  Id extends DeclaredCapabilityPlanEntry["id"],
> = DeclaredCapabilityPlanEntry extends infer Entry
  ? Entry extends { id: Id; config: infer Config }
    ? Config
    : never
  : never;

export function declaredCapability<
  Id extends DeclaredCapabilityPlanEntry["id"],
>(
  app: CapabilityPlanCarrier | null | undefined,
  id: Id,
): DeclaredCapabilityConfig<Id> | undefined {
  if (!app) return undefined;
  const plan = verifiedCapabilityPlan(app);
  const entry = plan.entries.find(
    (candidate) => candidate.id === id,
  ) as Extract<DeclaredCapabilityPlanEntry, { id: Id }> | undefined;
  if (!entry) return undefined;
  return entry.config as DeclaredCapabilityConfig<Id>;
}

export function capabilitySettings(
  app: CapabilityPlanCarrier,
): CapabilitySettingsWireV1 {
  const plan = verifiedCapabilityPlan(app);
  const cached = verifiedPlans.get(app);
  if (cached?.settings) return cached.settings;
  const settings = projectCapabilitySettingsWireV1(plan);
  verifiedPlans.set(app, {
    fingerprint: app.capability_plan_fingerprint,
    source: app.capability_plan,
    plan,
    settings,
  });
  return settings;
}

export function runtimeCapabilityRegistrations(
  app: CapabilityPlanCarrier,
): RuntimeCapabilityRegistrationV1[] {
  const plan = verifiedCapabilityPlan(app);
  return projectRuntimeCapabilityRegistrationsV1({
    version: 1,
    app: plan.app,
    entries: plan.entries,
  });
}

export function hasPersistentBackgroundStorage(
  app: CapabilityPlanCarrier | null | undefined,
): boolean {
  return (
    declaredCapability(app, "persistent_browser_storage")?.surface ===
    "background"
  );
}

export function usesUnprefixedAppFrameOrigin(
  app: CapabilityPlanCarrier | null | undefined,
): boolean {
  return (
    residentFrameSecurityMode(app) !==
    ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1
  );
}

export function residentFrameSecurityMode(
  app: CapabilityPlanCarrier | null | undefined,
): ResidentFrameSecurityMode {
  if (!app) return ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1;
  const persistent =
    declaredCapability(app, "persistent_browser_storage")?.surface ===
    "background";
  const dedicated = dedicatedResidentOriginConfig(app);
  const declaredMode = selectResidentFrameSecurityMode({
    persistentBrowserStorage: persistent,
    credentiallessEphemeralDedicatedOrigin: dedicated !== undefined,
  });
  const endpointMode = backgroundEndpointSecurityMode(app);
  if (endpointMode !== undefined && endpointMode !== declaredMode) {
    throw new Error(
      "Resident frame security does not match the installed capability plan",
    );
  }
  return endpointMode ?? declaredMode;
}

export function selectResidentFrameSecurityMode({
  persistentBrowserStorage,
  credentiallessEphemeralDedicatedOrigin,
}: {
  persistentBrowserStorage: boolean;
  credentiallessEphemeralDedicatedOrigin: boolean;
}): ResidentFrameSecurityMode {
  if (
    persistentBrowserStorage &&
    credentiallessEphemeralDedicatedOrigin
  ) {
    throw new Error(
      "Persistent browser storage and an ephemeral dedicated resident origin are mutually exclusive",
    );
  }
  if (credentiallessEphemeralDedicatedOrigin) {
    return ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1;
  }
  if (persistentBrowserStorage) {
    return ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1;
  }
  return ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1;
}

export function hasCredentiallessEphemeralDedicatedOrigin(
  app: CapabilityPlanCarrier | null | undefined,
): boolean {
  return (
    residentFrameSecurityMode(app) ===
    ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1
  );
}

export function assertResidentFrameSecurityBinding(
  binding: ResidentFrameSecurityBinding,
): void {
  if (
    !isResidentFrameSecurityMode(binding.mode) ||
    !/^[a-f0-9]{32}$/u.test(binding.browserOriginNonce) ||
    !/^[1-9][0-9]*$/u.test(binding.browserOriginAuthorityEpoch)
  ) {
    throw new Error("Resident frame security binding is invalid");
  }
  const epoch = BigInt(binding.browserOriginAuthorityEpoch);
  if (epoch > 18_446_744_073_709_551_615n) {
    throw new Error("Resident frame security binding is invalid");
  }
}

export function isResidentFrameSecurityMode(
  value: unknown,
): value is ResidentFrameSecurityMode {
  return (
    value === ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1 ||
    value ===
      ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1 ||
    value === ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1
  );
}

function backgroundEndpointSecurityMode(
  app: CapabilityPlanCarrier,
): ResidentFrameSecurityMode | undefined {
  const entries = verifiedCapabilityPlan(app).entries as ReadonlyArray<{
    id: string;
    config: unknown;
  }>;
  const matches = entries.filter(({ id }) => id === "background_endpoint");
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new Error("Resident background endpoint is duplicated");
  }
  const config = matches[0]!.config as
    | { frame_security?: unknown }
    | undefined;
  const mode = config?.frame_security;
  if (!isResidentFrameSecurityMode(mode)) {
    throw new Error("Resident background endpoint has invalid frame security");
  }
  return mode;
}

function dedicatedResidentOriginConfig(
  app: CapabilityPlanCarrier,
):
  | Readonly<{
      api: 1;
      surface: "background";
      mode: "credentialless_ephemeral_v1";
    }>
  | undefined {
  // Keep this runtime check deliberately independent from the authored schema.
  // A malformed or mixed plan must not silently downgrade to an opaque or
  // persistent frame even if a compiler/parser regression admitted it.
  const entries = verifiedCapabilityPlan(app).entries as ReadonlyArray<{
    id: string;
    config: unknown;
  }>;
  const matches = entries.filter(
    ({ id }) => id === "dedicated_resident_origin",
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new Error("Dedicated resident origin capability is duplicated");
  }
  const config = matches[0]!.config;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config as Record<string, unknown>).sort().join("\0") !==
      ["api", "mode", "surface"].join("\0")
  ) {
    throw new Error("Dedicated resident origin capability is invalid");
  }
  const value = config as Record<string, unknown>;
  if (
    value.api !== 1 ||
    value.surface !== "background" ||
    value.mode !== "credentialless_ephemeral_v1"
  ) {
    throw new Error("Dedicated resident origin capability is invalid");
  }
  return {
    api: 1,
    surface: "background",
    mode: "credentialless_ephemeral_v1",
  };
}

function verifiedCapabilityPlan(
  app: CapabilityPlanCarrier,
): CapabilityPlanWireV1 {
  const cached = verifiedPlans.get(app);
  if (
    cached?.fingerprint === app.capability_plan_fingerprint &&
    cached.source === app.capability_plan
  ) {
    return cached.plan;
  }
  if (
    !app.capability_plan ||
    typeof app.capability_plan_fingerprint !== "string"
  ) {
    throw new Error("Installed app capability plan is unavailable");
  }
  const plan = parseCapabilityPlanWireV1(app.capability_plan);
  assertCapabilityPlanFingerprint(plan, app.capability_plan_fingerprint);
  verifiedPlans.set(app, {
    fingerprint: app.capability_plan_fingerprint,
    source: app.capability_plan,
    plan,
  });
  return plan;
}
