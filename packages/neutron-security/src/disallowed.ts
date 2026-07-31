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
} from "./policy.ts";

export type AstPattern = (node: unknown) => boolean;

type AstNode = {
  name?: unknown;
  args?: unknown;
};

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null;

const argsOf = (value: unknown): unknown[] =>
  isAstNode(value) && Array.isArray(value.args) ? value.args : [];

const idText = (value: unknown): string | undefined => {
  if (!isAstNode(value) || value.name !== "ID") return undefined;
  const [text] = argsOf(value);
  return typeof text === "string" ? text : undefined;
};

const acquiredIdentifier = (value: unknown): string | undefined => {
  if (!isAstNode(value)) return undefined;
  if (value.name === "DotE") {
    const [, member] = argsOf(value);
    return typeof member === "string" ? member : idText(member);
  }
  if (value.name === "ValPF") {
    const [field] = argsOf(value);
    return typeof field === "string" ? field : undefined;
  }
  return undefined;
};

const hasIdentifier = (value: unknown, name: string): boolean =>
  acquiredIdentifier(value) === name;

const hasIdentifierFrom = (
  value: unknown,
  names: ReadonlySet<string>,
): boolean => {
  const identifier = acquiredIdentifier(value);
  return identifier !== undefined && names.has(identifier);
};

export const actor: AstPattern = (value) => {
  if (!isAstNode(value)) return false;
  if (value.name === "ActorUrlE" || value.name === "Shared") return true;
  if (value.name === "FuncT") {
    const [sort] = argsOf(value);
    if (typeof sort === "string" && sort.startsWith("Shared")) return true;
  }
  if (
    value.name === "ClassD" ||
    value.name === "ObjBlockE" ||
    value.name === "ObjT"
  ) {
    return argsOf(value).some((argument) => argument === "Actor");
  }
  return false;
};

export const actorOfPrincipal: AstPattern = (value) =>
  hasIdentifier(value, "actorOfPrincipal");

export const call_raw: AstPattern = (value) =>
  hasIdentifier(value, "call_raw");

export const createActor: AstPattern = (value) =>
  hasIdentifier(value, "createActor");

export const cyclesAdd: AstPattern = (value) =>
  hasIdentifier(value, "cyclesAdd");

export const cyclesSystem: AstPattern = (value) =>
  hasIdentifierFrom(value, CYCLES_SYSTEM_IDENTIFIERS);

// Both `(with cycles = amount)` and `(context with)` are erased by the
// simplified AST. The source-aware policy supplies this finding.
export const cyclesTransfer: AstPattern = () => false;

export const getCertificate: AstPattern = (value) =>
  hasIdentifier(value, "getCertificate");

export const regionMemory: AstPattern = (value) =>
  hasIdentifierFrom(value, REGION_EXACT_IDENTIFIERS) ||
  hasIdentifierFrom(value, REGION_LOAD_IDENTIFIERS) ||
  hasIdentifierFrom(value, REGION_STORE_IDENTIFIERS);

export const setCertifiedData: AstPattern = (value) =>
  hasIdentifier(value, "setCertifiedData");

export const stableMemoryGrow: AstPattern = (value) =>
  hasIdentifier(value, "stableMemoryGrow");

export const stableMemoryLoad: AstPattern = (value) =>
  hasIdentifierFrom(value, STABLE_MEMORY_LOAD_IDENTIFIERS);

export const stableMemorySize: AstPattern = (value) =>
  hasIdentifier(value, "stableMemorySize");

export const stableMemoryStore: AstPattern = (value) =>
  hasIdentifierFrom(value, STABLE_MEMORY_STORE_IDENTIFIERS);

export const stableRuntimeMemory: AstPattern = (value) =>
  hasIdentifierFrom(value, STABLE_RUNTIME_IDENTIFIERS);

export const stableVarQuery: AstPattern = (value) =>
  hasIdentifier(value, "stableVarQuery");

// `<system>` is also erased by the simplified AST.
export const systemCapability: AstPattern = () => false;

export const systemCandidLimits: AstPattern = (value) =>
  hasIdentifierFrom(value, SYSTEM_CANDID_LIMIT_IDENTIFIERS);

export const systemCallerInfo: AstPattern = (value) =>
  hasIdentifierFrom(value, SYSTEM_CALLER_INFO_IDENTIFIERS);

export const systemEnvironment: AstPattern = (value) =>
  hasIdentifierFrom(value, SYSTEM_ENVIRONMENT_IDENTIFIERS);

export const systemTimer: AstPattern = (value) =>
  hasIdentifierFrom(value, SYSTEM_TIMER_IDENTIFIERS);

export const toActor: AstPattern = (value) => hasIdentifier(value, "toActor");
