import type { JsonValue } from "neutron-tools/protocol";
import type {
  IcblastLocalOperationRequest,
  IcblastLocalOperationResult,
  IcblastMethodKind,
} from "./icblast_operation.ts";

export const ICBLAST_WORKER_PROTOCOL_VERSION = 1 as const;

export type IcblastWorkerStartMessage = Readonly<{
  type: "blast:icblast:start";
  version: typeof ICBLAST_WORKER_PROTOCOL_VERSION;
  runtime: Readonly<{ host: string; local: boolean }>;
  identity: Readonly<{
    keyPair: CryptoKeyPair;
    principal: string;
  }>;
  request: IcblastLocalOperationRequest;
}>;

export type IcblastWorkerInvokeMessage = Readonly<{
  type: "blast:icblast:invoke";
  version: typeof ICBLAST_WORKER_PROTOCOL_VERSION;
}>;

export type IcblastWorkerReadyMessage = Readonly<{
  type: "blast:icblast:ready";
  version: typeof ICBLAST_WORKER_PROTOCOL_VERSION;
}>;

export type IcblastWorkerPreparedMessage = Readonly<{
  type: "blast:icblast:prepared";
  version: typeof ICBLAST_WORKER_PROTOCOL_VERSION;
  kind: IcblastMethodKind;
}>;

export type IcblastWorkerResultMessage = Readonly<{
  type: "blast:icblast:result";
  version: typeof ICBLAST_WORKER_PROTOCOL_VERSION;
  value: IcblastLocalOperationResult;
}>;

export type IcblastWorkerFailure =
  | Readonly<{ kind: "error"; error: string }>
  | Readonly<{
      kind: "input_validation";
      method: string;
      errors: Exclude<JsonValue, null>;
    }>
  | Readonly<{
      kind: "dispatched";
      canister: string;
      method: string;
      methodKind: IcblastMethodKind;
      resultStatus:
        | "dispatched_result_unknown"
        | "result_exceeds_processing_limit";
      resultBytes: number | null;
      dispatchStatus: "confirmed" | "unknown";
      error: string;
    }>;

export type IcblastWorkerErrorMessage = Readonly<{
  type: "blast:icblast:error";
  version: typeof ICBLAST_WORKER_PROTOCOL_VERSION;
  failure: IcblastWorkerFailure;
}>;

export type IcblastWorkerRequestMessage =
  | IcblastWorkerStartMessage
  | IcblastWorkerInvokeMessage;

export type IcblastWorkerResponseMessage =
  | IcblastWorkerReadyMessage
  | IcblastWorkerPreparedMessage
  | IcblastWorkerResultMessage
  | IcblastWorkerErrorMessage;

export function isIcblastWorkerStartMessage(
  value: unknown,
): value is IcblastWorkerStartMessage {
  if (
    !isObject(value) ||
    !isObject(value.runtime) ||
    !isObject(value.identity)
  ) {
    return false;
  }
  return (
    value.type === "blast:icblast:start" &&
    value.version === ICBLAST_WORKER_PROTOCOL_VERSION &&
    typeof value.runtime.host === "string" &&
    value.runtime.host.length > 0 &&
    value.runtime.host.length <= 2_048 &&
    typeof value.runtime.local === "boolean" &&
    typeof value.identity.principal === "string" &&
    value.identity.principal.length > 0 &&
    value.identity.principal.length <= 80 &&
    isCryptoKeyPair(value.identity.keyPair) &&
    isOperationRequest(value.request)
  );
}

export function isIcblastWorkerInvokeMessage(
  value: unknown,
): value is IcblastWorkerInvokeMessage {
  return (
    isObject(value) &&
    value.type === "blast:icblast:invoke" &&
    value.version === ICBLAST_WORKER_PROTOCOL_VERSION
  );
}

export function isIcblastWorkerResponseMessage(
  value: unknown,
): value is IcblastWorkerResponseMessage {
  if (!isObject(value) || value.version !== ICBLAST_WORKER_PROTOCOL_VERSION) {
    return false;
  }
  if (value.type === "blast:icblast:ready") return true;
  if (value.type === "blast:icblast:prepared") {
    return isMethodKind(value.kind);
  }
  if (value.type === "blast:icblast:result") {
    return Object.hasOwn(value, "value");
  }
  if (value.type !== "blast:icblast:error" || !isObject(value.failure)) {
    return false;
  }
  const failure = value.failure;
  if (failure.kind === "error") return isBoundedError(failure.error);
  if (failure.kind === "input_validation") {
    return (
      typeof failure.method === "string" &&
      failure.method.length > 0 &&
      Object.hasOwn(failure, "errors") &&
      failure.errors !== null
    );
  }
  return (
    failure.kind === "dispatched" &&
    typeof failure.canister === "string" &&
    typeof failure.method === "string" &&
    isMethodKind(failure.methodKind) &&
    (failure.resultStatus === "dispatched_result_unknown" ||
      failure.resultStatus === "result_exceeds_processing_limit") &&
    (failure.resultBytes === null ||
      isNonnegativeSafeInteger(failure.resultBytes)) &&
    (failure.resultStatus === "result_exceeds_processing_limit"
      ? failure.resultBytes !== null && failure.dispatchStatus === "confirmed"
      : failure.resultBytes === null) &&
    (failure.dispatchStatus === "confirmed" ||
      failure.dispatchStatus === "unknown") &&
    isBoundedError(failure.error)
  );
}

function isOperationRequest(
  value: unknown,
): value is IcblastLocalOperationRequest {
  if (
    !isObject(value) ||
    typeof value.canister !== "string" ||
    value.canister.length === 0 ||
    value.canister.length > 80
  ) {
    return false;
  }
  if (value.operation === "scan") return true;
  if (
    value.operation !== "schema" &&
    value.operation !== "validate_input" &&
    value.operation !== "query" &&
    value.operation !== "update"
  ) {
    return false;
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    return false;
  }
  return value.operation === "schema" || Array.isArray(value.args);
}

function isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
  if (!isObject(value)) return false;
  return (
    isCryptoKey(value.privateKey, "private") &&
    isCryptoKey(value.publicKey, "public")
  );
}

function isCryptoKey(value: unknown, type: KeyType): value is CryptoKey {
  if (!isObject(value)) return false;
  const key = value as Partial<CryptoKey>;
  return (
    key.type === type &&
    Array.isArray(key.usages) &&
    isObject(key.algorithm)
  );
}

function isMethodKind(value: unknown): value is IcblastMethodKind {
  return value === "query" || value === "update" || value === "oneway";
}

function isBoundedError(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_000;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
