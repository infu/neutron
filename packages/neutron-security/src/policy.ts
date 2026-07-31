export const CYCLES_SYSTEM_IDENTIFIERS = new Set([
  "cyclesAccept",
  "cyclesAvailable",
  "cyclesBalance",
  "cyclesBurn",
  "cyclesRefunded",
]);

export const REGION_EXACT_IDENTIFIERS = new Set([
  "regionGrow",
  "regionId",
  "regionNew",
  "regionSize",
]);

const MEMORY_VALUE_SUFFIXES = [
  "Blob",
  "Float",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Nat8",
  "Nat16",
  "Nat32",
  "Nat64",
] as const;

export const REGION_LOAD_IDENTIFIERS = new Set<string>(
  MEMORY_VALUE_SUFFIXES.map((suffix) => `regionLoad${suffix}`),
);

export const REGION_STORE_IDENTIFIERS = new Set<string>(
  MEMORY_VALUE_SUFFIXES.map((suffix) => `regionStore${suffix}`),
);

export const STABLE_MEMORY_LOAD_IDENTIFIERS = new Set<string>(
  MEMORY_VALUE_SUFFIXES.map((suffix) => `stableMemoryLoad${suffix}`),
);

export const STABLE_MEMORY_STORE_IDENTIFIERS = new Set<string>(
  MEMORY_VALUE_SUFFIXES.map((suffix) => `stableMemoryStore${suffix}`),
);

export const STABLE_RUNTIME_IDENTIFIERS = new Set([
  "rts_logical_stable_memory_size",
  "rts_stable_memory_size",
]);

export const SYSTEM_TIMER_IDENTIFIERS = new Set([
  "cancelTimer",
  "setTimer",
]);

export const SYSTEM_CANDID_LIMIT_IDENTIFIERS = new Set([
  "getCandidLimits",
  "getCandidTypeLimits",
  "setCandidLimits",
  "setCandidTypeLimits",
]);

export const SYSTEM_ENVIRONMENT_IDENTIFIERS = new Set([
  "envVar",
  "envVarNames",
]);

export const SYSTEM_CALLER_INFO_IDENTIFIERS = new Set([
  "callerInfoData",
  "callerInfoSigner",
]);

export const DANGER_RULE_ORDER = [
  "actor",
  "actorOfPrincipal",
  "call_raw",
  "createActor",
  "cyclesAdd",
  "cyclesSystem",
  "cyclesTransfer",
  "getCertificate",
  "regionMemory",
  "setCertifiedData",
  "stableMemoryGrow",
  "stableMemoryLoad",
  "stableMemorySize",
  "stableMemoryStore",
  "stableRuntimeMemory",
  "stableVarQuery",
  "systemCapability",
  "systemCandidLimits",
  "systemCallerInfo",
  "systemEnvironment",
  "systemTimer",
  "toActor",
] as const;

export type DangerRule = (typeof DANGER_RULE_ORDER)[number];

export type DangerousPolicyFacts = {
  hasActorReference: boolean;
  hasActorUrl: boolean;
  hasCallContextTransfer: boolean;
  hasSystemCapability: boolean;
  hasWithCycles: boolean;
  identifiers: ReadonlySet<string>;
};

const includesAny = (
  identifiers: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
): boolean => {
  for (const candidate of candidates) {
    if (identifiers.has(candidate)) return true;
  }
  return false;
};

export function findingsFromPolicyFacts({
  hasActorReference,
  hasActorUrl,
  hasCallContextTransfer,
  hasSystemCapability,
  hasWithCycles,
  identifiers,
}: DangerousPolicyFacts): DangerRule[] {
  const findings = new Set<DangerRule>();

  if (hasActorReference || hasActorUrl) findings.add("actor");
  if (identifiers.has("actorOfPrincipal")) findings.add("actorOfPrincipal");
  if (identifiers.has("call_raw")) findings.add("call_raw");
  if (identifiers.has("createActor")) findings.add("createActor");
  if (identifiers.has("cyclesAdd")) findings.add("cyclesAdd");
  if (includesAny(identifiers, CYCLES_SYSTEM_IDENTIFIERS))
    findings.add("cyclesSystem");
  if (hasCallContextTransfer || hasWithCycles) findings.add("cyclesTransfer");
  if (identifiers.has("getCertificate")) findings.add("getCertificate");
  if (
    includesAny(identifiers, REGION_EXACT_IDENTIFIERS) ||
    includesAny(identifiers, REGION_LOAD_IDENTIFIERS) ||
    includesAny(identifiers, REGION_STORE_IDENTIFIERS)
  ) {
    findings.add("regionMemory");
  }
  if (identifiers.has("setCertifiedData")) findings.add("setCertifiedData");
  if (identifiers.has("stableMemoryGrow")) findings.add("stableMemoryGrow");
  if (includesAny(identifiers, STABLE_MEMORY_LOAD_IDENTIFIERS))
    findings.add("stableMemoryLoad");
  if (identifiers.has("stableMemorySize")) findings.add("stableMemorySize");
  if (includesAny(identifiers, STABLE_MEMORY_STORE_IDENTIFIERS))
    findings.add("stableMemoryStore");
  if (includesAny(identifiers, STABLE_RUNTIME_IDENTIFIERS))
    findings.add("stableRuntimeMemory");
  if (identifiers.has("stableVarQuery")) findings.add("stableVarQuery");
  if (hasSystemCapability) findings.add("systemCapability");
  if (includesAny(identifiers, SYSTEM_CANDID_LIMIT_IDENTIFIERS))
    findings.add("systemCandidLimits");
  if (includesAny(identifiers, SYSTEM_CALLER_INFO_IDENTIFIERS))
    findings.add("systemCallerInfo");
  if (includesAny(identifiers, SYSTEM_ENVIRONMENT_IDENTIFIERS))
    findings.add("systemEnvironment");
  if (includesAny(identifiers, SYSTEM_TIMER_IDENTIFIERS))
    findings.add("systemTimer");
  if (identifiers.has("toActor")) findings.add("toActor");

  return DANGER_RULE_ORDER.filter((rule) => findings.has(rule));
}
