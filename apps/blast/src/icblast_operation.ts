import { Principal } from "@dfinity/principal";
import type { JsonObject, JsonValue } from "neutron-tools/protocol";
import {
  assertBoundedBlastJson,
  assertBoundedBlastJsonEnvelope,
  boundedBlastJsonBytes,
  requiredBlastMethodName,
} from "./json.ts";
import { BLAST_LIMITS } from "./limits.ts";

const MANAGEMENT_CANISTER_ID = "aaaaa-aa";

export type IcblastMethodKind = "query" | "update" | "oneway";

export type IcblastMethodSchema = Readonly<{
  input: JsonObject;
  output: JsonObject;
}>;

export type IcblastScanResult = Readonly<{
  canister: string;
  methods: readonly Readonly<{ name: string; kind: IcblastMethodKind }>[];
}>;

export type IcblastSchemaResult = Readonly<{
  canister: string;
  method: string;
  kind: IcblastMethodKind;
  schema: IcblastMethodSchema;
}>;

export type IcblastValidationResult = Readonly<{
  canister: string;
  method: string;
  kind: IcblastMethodKind;
}> &
  (
    | Readonly<{ valid: true; errors: null }>
    | Readonly<{ valid: false; errors: Exclude<JsonValue, null> }>
  );

export type IcblastCallResult = Readonly<{
  canister: string;
  method: string;
  kind: IcblastMethodKind;
  identityMode: "local";
  result: JsonValue;
  resultBytes: number;
}>;

export type IcblastLocalOperationRequest =
  | Readonly<{ operation: "scan"; canister: string }>
  | Readonly<{ operation: "schema"; canister: string; method: string }>
  | Readonly<{
      operation: "validate_input";
      canister: string;
      method: string;
      args: JsonValue[];
    }>
  | Readonly<{
      operation: "query" | "update";
      canister: string;
      method: string;
      args: JsonValue[];
    }>;

export type IcblastLocalOperationResult =
  | IcblastScanResult
  | IcblastSchemaResult
  | IcblastValidationResult
  | IcblastCallResult;

export type IcblastActor = Readonly<
  Record<string, unknown> & {
    $idlFactory: (context: { IDL: unknown }) => unknown;
    $methods?: Readonly<{ get(method: string): unknown }>;
  }
>;

export type IcblastOperationAdapters = Readonly<{
  explainSchema(source: unknown, method: string): unknown;
  validateInput(
    schema: IcblastMethodSchema,
    args: JsonValue[],
  ): Readonly<{ ok: boolean; errors?: unknown }>;
  normalize(value: unknown): unknown;
}>;

export type IcblastOperationHooks = Readonly<{
  awaitOperation?<T>(operation: Promise<T>): Promise<T>;
  beforeInvoke?(kind: IcblastMethodKind): Promise<void> | void;
}>;

export class IcblastLocalInputValidationError extends Error {
  constructor(
    public readonly method: string,
    public readonly errors: Exclude<JsonValue, null>,
  ) {
    super(`Arguments do not match the live schema for '${method}'`);
    this.name = "IcblastLocalInputValidationError";
  }
}

export class IcblastLocalDispatchedCallError extends Error {
  constructor(
    public readonly details: Readonly<{
      canister: string;
      method: string;
      kind: IcblastMethodKind;
      resultStatus:
        | "dispatched_result_unknown"
        | "result_exceeds_processing_limit";
      resultBytes: number | null;
      dispatchStatus: "confirmed" | "unknown";
    }>,
    options?: ErrorOptions,
  ) {
    super("Local ICBlast call crossed its invocation boundary", options);
    this.name = "IcblastLocalDispatchedCallError";
  }
}

/** Execute one operation against one already-discovered ICBlast actor. */
export async function executeIcblastLocalOperation(
  actor: IcblastActor,
  request: IcblastLocalOperationRequest,
  adapters: IcblastOperationAdapters,
  hooks: IcblastOperationHooks = {},
): Promise<IcblastLocalOperationResult> {
  const canister = assertExternalCanister(request.canister);
  if (
    typeof actor !== "object" ||
    actor === null ||
    typeof actor.$idlFactory !== "function"
  ) {
    throw new Error("ICBlast did not return a live interface-bound actor");
  }
  const methods = inspectActorMethods(actor);

  if (request.operation === "scan") {
    const result: IcblastScanResult = Object.freeze({
      canister,
      methods: [...methods]
        .map(([name, kind]) => Object.freeze({ name, kind }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
    assertBoundedBlastJson(
      result,
      "ICBlast method list",
      BLAST_LIMITS.canisterSchemaBytes,
    );
    return result;
  }

  const method = requiredBlastMethodName(request.method, "Canister method");
  const { kind, schema } = schemaFor(actor, methods, method, adapters);
  if (request.operation === "schema") {
    return Object.freeze({ canister, method, kind, schema });
  }

  const args = checkedIcblastArgs(request.args);
  const validation = validateFor(schema, args, adapters);
  if (request.operation === "validate_input") {
    return validation.valid
      ? Object.freeze({ canister, method, kind, valid: true, errors: null })
      : Object.freeze({
          canister,
          method,
          kind,
          valid: false,
          errors: validation.errors,
        });
  }
  if (!validation.valid) {
    throw new IcblastLocalInputValidationError(method, validation.errors);
  }

  const acceptedKind =
    kind === request.operation ||
    (request.operation === "update" && kind === "oneway");
  if (!acceptedKind) {
    throw new Error(
      `Refusing ${request.operation} route for live ${kind} method '${method}'`,
    );
  }
  const callable = actor.$methods?.get(method) ?? actor[method];
  if (typeof callable !== "function") {
    throw new Error(`ICBlast actor is missing method '${method}'`);
  }
  const icblastMethod = callable as Readonly<{
    prepare?: (...args: JsonValue[]) => unknown | Promise<unknown>;
  }>;
  if (typeof icblastMethod.prepare !== "function") {
    throw new Error(`ICBlast method '${method}' cannot prepare calls`);
  }
  const awaitOperation =
    hooks.awaitOperation ?? (async <T>(value: Promise<T>) => value);
  const prepared = await awaitOperation(
    Promise.resolve(icblastMethod.prepare(...args)),
  );
  if (
    typeof prepared !== "object" ||
    prepared === null ||
    typeof (prepared as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error(
      `ICBlast actor returned an invalid prepared call for '${method}'`,
    );
  }
  await hooks.beforeInvoke?.(kind);

  let rawResult: unknown;
  try {
    rawResult = await awaitOperation(
      Promise.resolve((prepared as { invoke(): unknown }).invoke()),
    );
  } catch (cause) {
    if (kind !== "query") {
      throw new IcblastLocalDispatchedCallError(
        {
          canister,
          method,
          kind,
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "unknown",
        },
        { cause },
      );
    }
    throw cause;
  }

  let bounded: Readonly<{ result: JsonValue; resultBytes: number }>;
  try {
    bounded =
      kind === "oneway"
        ? normalizeCallResult(null, (value) => value)
        : normalizeCallResult(rawResult, adapters.normalize);
  } catch (cause) {
    if (cause instanceof IcblastResultTooLargeError) {
      throw new IcblastLocalDispatchedCallError(
        {
          canister,
          method,
          kind,
          resultStatus: "result_exceeds_processing_limit",
          resultBytes: cause.resultBytes,
          dispatchStatus: "confirmed",
        },
        { cause },
      );
    }
    if (kind !== "query") {
      throw new IcblastLocalDispatchedCallError(
        {
          canister,
          method,
          kind,
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "confirmed",
        },
        { cause },
      );
    }
    throw cause;
  }
  return Object.freeze({
    canister,
    method,
    kind,
    identityMode: "local",
    result: bounded.result,
    resultBytes: bounded.resultBytes,
  });
}

/** Validate the complete value returned across the disposable Worker boundary. */
export function assertIcblastLocalOperationResult(
  request: IcblastLocalOperationRequest,
  value: unknown,
): asserts value is IcblastLocalOperationResult {
  assertBoundedBlastJsonEnvelope(
    value,
    "ICBlast Worker result",
    BLAST_LIMITS.scriptHostResponseBytes,
  );
  if (!isObject(value) || value.canister !== request.canister) {
    throw new Error("ICBlast Worker result has an invalid canister binding");
  }
  if (request.operation === "scan") {
    assertKeys(value, ["canister", "methods"]);
    if (
      !Array.isArray(value.methods) ||
      !value.methods.every(
        (entry) =>
          isObject(entry) &&
          Object.keys(entry).length === 2 &&
          typeof entry.name === "string" &&
          isMethodKind(entry.kind),
      )
    ) {
      throw new Error("ICBlast Worker returned an invalid method list");
    }
    return;
  }
  if (
    value.method !== request.method ||
    !isMethodKind(value.kind)
  ) {
    throw new Error("ICBlast Worker result has invalid method evidence");
  }
  if (request.operation === "schema") {
    assertKeys(value, ["canister", "kind", "method", "schema"]);
    if (
      !isObject(value.schema) ||
      !isObject(value.schema.input) ||
      !isObject(value.schema.output)
    ) {
      throw new Error("ICBlast Worker returned an invalid method schema");
    }
    return;
  }
  if (request.operation === "validate_input") {
    assertKeys(value, ["canister", "errors", "kind", "method", "valid"]);
    if (
      typeof value.valid !== "boolean" ||
      (value.valid && value.errors !== null) ||
      (!value.valid && value.errors === null)
    ) {
      throw new Error("ICBlast Worker returned invalid validation evidence");
    }
    return;
  }
  assertKeys(value, [
    "canister",
    "identityMode",
    "kind",
    "method",
    "result",
    "resultBytes",
  ]);
  if (
    value.identityMode !== "local" ||
    (request.operation === "query" && value.kind !== "query") ||
    (request.operation === "update" && value.kind === "query") ||
    !Number.isSafeInteger(value.resultBytes) ||
    (value.resultBytes as number) < 0 ||
    boundedBlastJsonBytes(
      value.result,
      "ICBlast Worker call result",
      BLAST_LIMITS.canisterResultBytes,
    ) !== value.resultBytes
  ) {
    throw new Error("ICBlast Worker returned invalid call-result evidence");
  }
}

export function assertExternalCanister(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    throw new Error("Canister id is invalid");
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (cause) {
    throw new Error("Canister id is invalid", { cause });
  }
  const canonical = principal.toText();
  if (canonical !== value) throw new Error("Canister id must be canonical");
  if (canonical === MANAGEMENT_CANISTER_ID) {
    throw new Error("Management canister calls are not available through Blast");
  }
  return canonical;
}

export function checkedIcblastArgs(args: JsonValue[] | undefined): JsonValue[] {
  const value = args ?? [];
  if (value.length > BLAST_LIMITS.canisterArgumentItems) {
    throw new Error(
      `Canister arguments exceed ${BLAST_LIMITS.canisterArgumentItems} items`,
    );
  }
  assertBoundedBlastJson(
    value,
    "Canister arguments",
    BLAST_LIMITS.scriptArgumentsBytes,
  );
  // The Worker may not become ready immediately. Snapshot now so caller-held
  // objects cannot grow or change after this bound check but before postMessage.
  const snapshot = structuredClone(value);
  assertBoundedBlastJson(
    snapshot,
    "Canister arguments",
    BLAST_LIMITS.scriptArgumentsBytes,
  );
  return snapshot;
}

function inspectActorMethods(
  actor: IcblastActor,
): ReadonlyMap<string, IcblastMethodKind> {
  const inertType = Object.freeze({ fill(_value: unknown): void {} });
  const idl = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, property) {
      if (property === "Service") return (fields: unknown): unknown => fields;
      if (property === "Func") {
        return (
          _input: unknown,
          _output: unknown,
          annotations: unknown = [],
        ): Readonly<{ annotations: readonly string[] }> => {
          if (
            !Array.isArray(annotations) ||
            !annotations.every((item) => typeof item === "string")
          ) {
            throw new Error("ICBlast method annotations are invalid");
          }
          return Object.freeze({ annotations: Object.freeze([...annotations]) });
        };
      }
      if (property === "Rec") return (): typeof inertType => inertType;
      return (..._args: unknown[]): typeof inertType => inertType;
    },
  });
  const service = actor.$idlFactory({ IDL: idl });
  if (!isObject(service)) throw new Error("ICBlast service interface is invalid");
  const methods = new Map<string, IcblastMethodKind>();
  for (const [name, raw] of Object.entries(service)) {
    const method = requiredBlastMethodName(name, "Canister method");
    if (!isObject(raw) || !Array.isArray(raw.annotations)) {
      throw new Error(`ICBlast method '${method}' has no mode evidence`);
    }
    const annotations = raw.annotations;
    if (!annotations.every((item) => typeof item === "string")) {
      throw new Error(`ICBlast method '${method}' has unsupported annotations`);
    }
    const known = annotations.filter(
      (annotation) =>
        annotation === "query" ||
        annotation === "composite_query" ||
        annotation === "oneway",
    );
    if (known.length !== annotations.length || known.length > 1) {
      throw new Error(`ICBlast method '${method}' has unsupported annotations`);
    }
    methods.set(
      method,
      known[0] === "query" || known[0] === "composite_query"
        ? "query"
        : known[0] === "oneway"
          ? "oneway"
          : "update",
    );
  }
  return methods;
}

function schemaFor(
  actor: IcblastActor,
  methods: ReadonlyMap<string, IcblastMethodKind>,
  method: string,
  adapters: IcblastOperationAdapters,
): Readonly<{ kind: IcblastMethodKind; schema: IcblastMethodSchema }> {
  const kind = methods.get(method);
  if (kind === undefined) throw new Error(`Method not found: ${method}`);
  const raw = adapters.explainSchema(actor, method);
  if (!isObject(raw) || !isObject(raw.input) || !isObject(raw.output)) {
    throw new Error("ICBlast returned an invalid method schema");
  }
  const schema: IcblastMethodSchema = Object.freeze({
    input: raw.input as JsonObject,
    output: raw.output as JsonObject,
  });
  assertBoundedBlastJson(
    schema,
    "ICBlast method schema",
    BLAST_LIMITS.canisterSchemaBytes,
  );
  return { kind, schema };
}

function validateFor(
  schema: IcblastMethodSchema,
  args: JsonValue[],
  adapters: IcblastOperationAdapters,
):
  | Readonly<{ valid: true; errors: null }>
  | Readonly<{ valid: false; errors: Exclude<JsonValue, null> }> {
  const validation = adapters.validateInput(schema, args);
  if (typeof validation?.ok !== "boolean") {
    throw new Error("ICBlast returned an invalid validation result");
  }
  const errors = normalizeJson(validation.errors ?? null, adapters);
  if (validation.ok !== (errors === null)) {
    throw new Error("ICBlast returned inconsistent validation diagnostics");
  }
  assertBoundedBlastJson(
    errors,
    "ICBlast validation diagnostics",
    BLAST_LIMITS.canisterSchemaBytes,
  );
  return validation.ok
    ? { valid: true, errors: null }
    : { valid: false, errors: errors as Exclude<JsonValue, null> };
}

function normalizeJson(
  value: unknown,
  adapters: Pick<IcblastOperationAdapters, "normalize">,
): JsonValue {
  const normalized = adapters.normalize(value);
  assertBoundedBlastJson(
    normalized,
    "ICBlast JSON value",
    BLAST_LIMITS.canisterResultBytes,
  );
  return normalized;
}

function normalizeCallResult(
  value: unknown,
  normalize: (value: unknown) => unknown,
): Readonly<{ result: JsonValue; resultBytes: number }> {
  const result = normalize(value);
  const resultBytes = boundedBlastJsonBytes(
    result,
    "Canister result",
    Number.MAX_SAFE_INTEGER,
  );
  if (resultBytes > BLAST_LIMITS.canisterResultBytes) {
    throw new IcblastResultTooLargeError(resultBytes);
  }
  return Object.freeze({ result: result as JsonValue, resultBytes });
}

class IcblastResultTooLargeError extends Error {
  constructor(public readonly resultBytes: number) {
    super(`Canister result is ${resultBytes} bytes`);
    this.name = "IcblastResultTooLargeError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMethodKind(value: unknown): value is IcblastMethodKind {
  return value === "query" || value === "update" || value === "oneway";
}

function assertKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("ICBlast Worker result has unexpected fields");
  }
}
