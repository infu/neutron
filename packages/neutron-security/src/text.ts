import {
  CYCLES_SYSTEM_IDENTIFIERS,
  REGION_EXACT_IDENTIFIERS,
  REGION_LOAD_IDENTIFIERS,
  REGION_STORE_IDENTIFIERS,
  STABLE_MEMORY_LOAD_IDENTIFIERS,
  STABLE_MEMORY_STORE_IDENTIFIERS,
  STABLE_RUNTIME_IDENTIFIERS,
  SYSTEM_CANDID_LIMIT_IDENTIFIERS,
  SYSTEM_CALLER_INFO_IDENTIFIERS,
  SYSTEM_ENVIRONMENT_IDENTIFIERS,
  SYSTEM_TIMER_IDENTIFIERS,
  type DangerRule,
  findingsFromPolicyFacts,
} from "./policy.ts";
import {
  inspectMotokoSource,
  type MotokoSourceToken,
} from "./source.ts";

export type DangerousTextFinding = {
  line: number;
  code: string;
  context: {
    previous: string;
    current: string;
    next: string;
  };
};

const tokenMatchesRule = (
  { text }: MotokoSourceToken,
  rule: DangerRule,
): boolean => {
  switch (rule) {
    case "actor":
      return text === "actor" || text === "shared";
    case "cyclesSystem":
      return CYCLES_SYSTEM_IDENTIFIERS.has(text);
    case "cyclesTransfer":
      return text === "with";
    case "regionMemory":
      return (
        REGION_EXACT_IDENTIFIERS.has(text) ||
        REGION_LOAD_IDENTIFIERS.has(text) ||
        REGION_STORE_IDENTIFIERS.has(text)
      );
    case "stableMemoryLoad":
      return STABLE_MEMORY_LOAD_IDENTIFIERS.has(text);
    case "stableMemoryStore":
      return STABLE_MEMORY_STORE_IDENTIFIERS.has(text);
    case "stableRuntimeMemory":
      return STABLE_RUNTIME_IDENTIFIERS.has(text);
    case "systemCapability":
      return text === "system";
    case "systemCandidLimits":
      return SYSTEM_CANDID_LIMIT_IDENTIFIERS.has(text);
    case "systemCallerInfo":
      return SYSTEM_CALLER_INFO_IDENTIFIERS.has(text);
    case "systemEnvironment":
      return SYSTEM_ENVIRONMENT_IDENTIFIERS.has(text);
    case "systemTimer":
      return SYSTEM_TIMER_IDENTIFIERS.has(text);
    default:
      return text === rule;
  }
};

/**
 * Returns source-located policy candidates. Callers that enforce the policy
 * must intersect name-based candidates with authoritative AST acquisitions;
 * a harmless local may deliberately use the same spelling.
 */
export function checkForDangerousTextCode(
  code: string,
): DangerousTextFinding[] {
  const inspection = inspectMotokoSource(code);
  const findings = findingsFromPolicyFacts({
    hasActorReference: inspection.hasActorReference,
    hasActorUrl: false,
    hasCallContextTransfer: inspection.hasCallContextTransfer,
    hasSystemCapability: inspection.hasSystemCapability,
    hasWithCycles: inspection.hasWithCycles,
    identifiers: new Set(inspection.identifiers),
  });
  const lines = code.split("\n");

  return findings.map((finding) => {
    const line =
      inspection.tokens.find((token) => tokenMatchesRule(token, finding))
        ?.line ?? 1;
    return {
      line,
      code: finding,
      context: {
        previous: lines[line - 2] || "No previous line",
        current: lines[line - 1] || "",
        next: lines[line] || "No next line",
      },
    };
  });
}
