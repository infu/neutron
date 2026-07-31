import { validate as validateJsonSchema, type Schema } from "jsonschema";
import type { NeutronBackendCallReservation } from "./capabilities/catalog.ts";
import { CANISTER_METHOD_MAX_LENGTH } from "./physical_names.ts";
import { normalizeUntrustedText } from "./schema.ts";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export type SelfCallObject = { [key: string]: SelfCallValue };
export type SelfCallValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | ArrayBuffer
  | SelfCallValue[]
  | SelfCallObject;

export const SELF_CALL_BINARY_MAX_BYTES = 1_900_000;
export const SELF_CALL_BINARY_MAX_COUNT = 512;
export const SELF_CALL_METADATA_MAX_BYTES = 64 * 1024;
export const SELF_CALL_VALUE_MAX_DEPTH = 32;
export const SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS = 4_096;

export type KernelSchemaPayload = JsonObject & {
  canister: string;
  method: string;
};

export type KernelCallPayload = {
  canister: string;
  method: string;
  args?: SelfCallValue[];
};

export type BackendCallReservationScope = NeutronBackendCallReservation;

export type BackendCallReservationAction =
  | { kind: "reserve"; scope: BackendCallReservationScope }
  | { kind: "release"; scope: BackendCallReservationScope };

export type BackendCallReservationsRequest = {
  actions: BackendCallReservationAction[];
  call?: {
    method: string;
    args?: SelfCallValue[];
  };
};

export type OpenAppTileRequest = JsonObject & {
  appId: string;
  tileId: string;
  workspace?: number;
  reuseExisting?: boolean;
  view?: string;
};

export type OpenAppTileResult = JsonObject & {
  instanceId: string;
  workspace: number;
  opened: boolean;
};

export type AppInstallOfferRequest =
  | {
      kind: "package_url";
      url: string;
    }
  | {
      kind: "repository_setup_url";
      url: string;
    };

export type AppInstallOfferResult = {
  presented: true;
  requestId: string;
};

export type TrayState = {
  badge: number | null;
};

export type VetKeysEnvironment = "production" | "local";
export const VET_KEYS_ERROR_CODES = [
  "not_declared",
  "not_reserved",
  "manifest_suspended",
  "disabled",
  "generation_unavailable",
  "invalid_request",
  "challenge_expired",
  "challenge_consumed",
  "busy",
  "low_cycles",
  "key_unavailable",
  "management_failure",
  "source_gone",
  "owner_required",
] as const;
export type VetKeysErrorCode = (typeof VET_KEYS_ERROR_CODES)[number];
export type VetKeysError = Error & {
  code: VetKeysErrorCode;
};
export type VetKeySlotStatus =
  | "enabled"
  | "disabled"
  | "manifest_suspended";
export type VetKeyGenerationStatus = "current" | "previous";

export type VetKeyGenerationSummary = JsonObject & {
  generation: string;
  status: VetKeyGenerationStatus;
  keyName: "key_1" | "test_key_1";
  publicFingerprint: number[] | null;
};

export type VetKeySlotSummary = JsonObject & {
  slot: string;
  purpose: string;
  keyHolder: string;
  status: VetKeySlotStatus;
  environment: VetKeysEnvironment;
  currentGeneration: string;
  previousGeneration: string | null;
  generations: VetKeyGenerationSummary[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  totalDerivations: string;
  approximateCycleSpend: string;
};

export type VetKeyPublicInfo = JsonObject & {
  canisterPrincipal: string;
  slot: string;
  generation: string;
  suite: "bls12_381_g2";
  keyName: "key_1" | "test_key_1";
  publicKey: number[];
  publicFingerprint: number[];
  derivationInput: number[];
};

export type VetKeysLifecycleRequest =
  | {
      action:
        | "reserve"
        | "enable"
        | "disable"
        | "rotate"
        | "retireSlot";
      slot: string;
    }
  | {
      action: "retireGeneration";
      slot: string;
      generation: string | bigint;
    }
  | {
      action: "transfer";
      slot: string;
      newHolder: string;
    };

export type VetKeysLifecycleResult = JsonObject & {
  slot: VetKeySlotSummary | null;
  retired: boolean;
};

export type VetKeysListResult = JsonObject & {
  slots: VetKeySlotSummary[];
};

export type VetKeyDeriveRequest = {
  slot: string;
  generation: string | bigint;
  transportPublicKey: Uint8Array | readonly number[];
  requestNonce: Uint8Array | readonly number[];
};

export type VetKeyDeriveChallenge = JsonObject & {
  type: "challenge";
  challengeId: string;
  expiresAt: string;
};

export type VetKeyDeriveResult = JsonObject & {
  encryptedKey: number[];
  publicInfo: VetKeyPublicInfo;
};

export type VetKeyDeriveOptions = {
  timeout?: number;
  onChallenge: (challenge: VetKeyDeriveChallenge) => void;
};

export type EthereumProviderRequestArguments = {
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
};

export type EthereumProviderProxy = {
  request(args: EthereumProviderRequestArguments): Promise<unknown>;
};

export type EthereumProviderConnection = {
  provider: EthereumProviderProxy;
  info: JsonObject & {
    name: string;
    rdns: string | null;
  };
  close(): Promise<void>;
};

export type AgentModeStatus = JsonObject & {
  eligible: boolean;
  enabled: boolean;
  running: boolean;
  entrypoints: string[];
};

export type JsonSchemaDocument = JsonObject;

export type MethodSchemaJson = JsonObject & {
  input: JsonSchemaDocument;
  output: JsonSchemaDocument;
};

export type MsgBusEndpointId =
  | "kernel"
  | `app:${string}:background`
  | `app:${string}:tile:${string}:instance:${string}`
  | `app:${string}:tray:instance:${string}`;

export type MsgBusToolDescriptor = JsonObject & {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchemaDocument;
  outputSchema?: JsonSchemaDocument;
  annotations?: JsonObject;
};

export const NEUTRON_TOOL_AUDIT_METADATA_ONLY = "metadata_only" as const;
export type NeutronToolAuditMode =
  typeof NEUTRON_TOOL_AUDIT_METADATA_ONLY;
export const NEUTRON_TOOL_CONTROL_CANCEL = "cancel" as const;
export type NeutronToolControlMode =
  typeof NEUTRON_TOOL_CONTROL_CANCEL;
export const NEUTRON_TOOL_VISIBILITY_SAME_APP = "same_app" as const;
export type NeutronToolVisibility =
  typeof NEUTRON_TOOL_VISIBILITY_SAME_APP;

export type MsgBusToolCall = JsonObject & {
  target: MsgBusEndpointId;
  name: string;
  arguments?: JsonObject;
};

export type MsgBusCallerContext = JsonObject & {
  endpoint: string;
  appId?: string;
  role?: string;
  sessionId?: string;
};

export type KernelPolicyErrorCode =
  | "UI_BUSY"
  | "APP_PAUSED"
  | "REQUEST_EXPIRED"
  | "REQUEST_CANCELLED"
  | "OWNER_REQUIRED"
  | "USER_INTERACTION_REQUIRED"
  | "INVOCATION_INVALID"
  | "INVALID_REQUEST"
  | "SCOPED_CONTEXT_REQUIRED"
  | "VETKEYS_UNAVAILABLE"
  | "AGENT_CONSENT_DENIED"
  | "AGENT_CONSENT_TIMEOUT"
  | "AGENT_CONSENT_LIMIT"
  | "AGENT_MODE_REVOKED"
  | "AGENT_MODE_LIMIT";

export class KernelPolicyError extends Error {
  readonly code: KernelPolicyErrorCode;
  readonly retryAfterMs?: number;

  constructor(
    code: KernelPolicyErrorCode,
    message: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "KernelPolicyError";
    this.code = code;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export type AgentConsentChallenge = JsonObject & {
  version: 1;
  id: string;
  rootId: string;
  expiresAt: number;
  requester: JsonObject & {
    appId: string;
    role: "tile" | "background" | "tray";
  };
  chain: Array<
    JsonObject & {
      appId: string;
      tool: string;
    }
  >;
  kind:
    | "frontend_tool"
    | "signed_canister_call"
    | "backend_access"
    | "connection"
    | "workspace_open";
  persistence: "none" | "session" | "durable";
  risk: "low" | "medium" | "high";
  action: JsonObject;
};

export type AgentConsentDecision = JsonObject & {
  decision: "allow" | "deny";
  reason: string;
};

export type AgentConsentHandler = (
  challenge: AgentConsentChallenge,
) => AgentConsentDecision | Promise<AgentConsentDecision>;

export type AgentConsentRegistration = {
  register(handler: AgentConsentHandler): () => void;
  onCancel(handler: () => void): () => void;
};

export type ScopedKernelClient = MsgBusClient & {
  querySelf<T extends SelfCallValue = JsonValue>(
    method: string,
    args?: SelfCallValue[],
    timeout?: number,
  ): Promise<T>;
  updateSelf<T extends SelfCallValue = JsonValue>(
    method: string,
    args?: SelfCallValue[],
    timeout?: number,
  ): Promise<T>;
};

export type MsgBusToolContext = {
  caller?: MsgBusCallerContext;
  reportProgress: (value: JsonValue) => void;
  kernel: ScopedKernelClient;
  signal?: AbortSignal;
  agentConsent?: AgentConsentRegistration;
  agentMode?: boolean;
};

export type MsgBusToolHandler = (
  args: JsonObject,
  context: MsgBusToolContext,
) => JsonValue | Promise<JsonValue>;

export type ExposedToolOptions = {
  title?: string;
  description?: string;
  inputSchema: JsonSchemaDocument;
  outputSchema?: JsonSchemaDocument;
  annotations?: JsonObject;
};

export type MsgBusClient = {
  listApps(timeout?: number): Promise<JsonValue>;
  describeApp(appId: string, timeout?: number): Promise<JsonValue>;
  listEndpoints(timeout?: number): Promise<JsonValue>;
  listTools(
    target?: MsgBusEndpointId,
    timeout?: number,
  ): Promise<MsgBusToolDescriptor[]>;
  callTool<T extends JsonValue = JsonValue>(
    call: MsgBusToolCall,
    options?: number | MsgBusCallOptions,
  ): Promise<T>;
};

export type MsgBusCallOptions = {
  timeout?: number;
  onProgress?: (value: JsonValue) => void;
  transportContext?: MsgBusTransportContext;
  control?: NeutronToolControlMode;
};

export type NeutronCanisterClient = {
  canister: string;
  methodSchema(method: string, timeout?: number): Promise<MethodSchemaJson>;
  callDialog(
    method: string,
    args?: SelfCallValue[],
    timeout?: number,
  ): Promise<JsonValue>;
};

export type JsonFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ExecEnvelope = {
  type: "exec";
  id: number;
  payload: {
    action: string;
    payload: JsonValue;
    context?: MsgBusTransportContext;
  };
};

export type MsgBusInvocationMetadata = JsonObject & {
  id: string;
  rootId: string;
  capability: string;
  agentConsent?: boolean;
};

export type MsgBusTransportContext = JsonObject & {
  invocation?: MsgBusInvocationMetadata;
};

export type ResponseEnvelope = {
  type: "response";
  id: number;
  ok?: JsonValue;
  error?: JsonValue;
};

export type ProgressEnvelope = {
  type: "progress";
  id: number;
  value: JsonValue;
};

export type SelfCallBlobPathSegment = string | number;

export type SelfCallWireBlob = {
  path: SelfCallBlobPathSegment[];
  byteLength: number;
  data: ArrayBuffer;
};

type SelfMethodCallExecEnvelope = {
  type: "neutron:self-call:exec";
  version: 1;
  id: number;
  tool:
    | "canister.query_self"
    | "canister.update_self"
    | "canister.call_dialog";
  method: string;
  args: JsonValue[];
  blobs: SelfCallWireBlob[];
  context?: { invocation: MsgBusInvocationMetadata };
};

type BackendAccessCallExecEnvelope = {
  type: "neutron:self-call:exec";
  version: 1;
  id: number;
  tool: "backend_calls.request";
  method: string;
  args: JsonValue[];
  blobs: SelfCallWireBlob[];
  actions: BackendCallReservationAction[];
  context?: { invocation: MsgBusInvocationMetadata };
};

export type SelfCallExecEnvelope =
  | SelfMethodCallExecEnvelope
  | BackendAccessCallExecEnvelope;

export type SelfCallResponseEnvelope = {
  type: "neutron:self-call:response";
  version: 1;
  id: number;
  ok?: JsonValue;
  error?: JsonValue;
  blobs?: SelfCallWireBlob[];
};

export type TileViewEnvelope = {
  type: "neutron:tile:view";
  version: 1;
  view: string;
};

export type AppStateChange = JsonObject & {
  topic: string;
  revision: string;
};

export type AppStateChangeEnvelope = AppStateChange & {
  type: "neutron:app:state";
  version: 1;
};

export type AppStateChangeListener = (change: AppStateChange) => void;

export type MsgBusConnectEnvelope = {
  type: "neutron:msgbus:connect";
  version: 1;
  sessionId: string;
};

export const msgBusLocalActions = {
  toolsList: "__neutron_msgbus_tools_list",
  toolsCall: "__neutron_msgbus_tools_call",
  agentConsentDecide: "__neutron_agent_consent_decide",
  agentTurnCancel: "__neutron_agent_turn_cancel",
} as const;

export const MSG_BUS_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MSG_BUS_MAX_SCHEMA_BYTES = 32 * 1024;
export const MSG_BUS_MAX_PROGRESS_BYTES = 64 * 1024;
export const MSG_BUS_MAX_PROGRESS_EVENTS = 2_000;
export const MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS = 300;
export const MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 10;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isJsonObject = (
  value: unknown,
): value is Record<string, unknown> =>
  isRecord(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

function isJsonValueInternal(
  value: unknown,
  ancestors: WeakSet<object>,
): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const ok = value.every((item) => isJsonValueInternal(item, ancestors));
    ancestors.delete(value);
    return ok;
  }
  if (!isJsonObject(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const ok = Object.values(value).every((item) =>
    isJsonValueInternal(item, ancestors)
  );
  ancestors.delete(value);
  return ok;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new WeakSet<object>());
}

export function jsonPayloadBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertBoundedJson(
  value: unknown,
  label = "Payload",
  maximumBytes = MSG_BUS_MAX_PAYLOAD_BYTES,
): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be JSON-compatible`);
  }
  if (jsonPayloadBytes(value) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
}

const isMessageId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function isTransportContext(value: unknown): value is MsgBusTransportContext {
  if (!isJsonObject(value)) return false;
  if (Object.keys(value).some((key) => key !== "invocation")) return false;
  if (value.invocation === undefined) return true;
  const invocation = value.invocation;
  return (
    isJsonObject(invocation) &&
    Object.keys(invocation).every((key) =>
      ["id", "rootId", "capability", "agentConsent"].includes(key)
    ) &&
    typeof invocation.id === "string" &&
    invocation.id.length >= 16 &&
    typeof invocation.rootId === "string" &&
    invocation.rootId.length >= 16 &&
    typeof invocation.capability === "string" &&
    invocation.capability.length >= 32 &&
    (invocation.agentConsent === undefined ||
      typeof invocation.agentConsent === "boolean")
  );
}

export function isExecEnvelope(value: unknown): value is ExecEnvelope {
  if (!isRecord(value) || value.type !== "exec" || !isMessageId(value.id)) {
    return false;
  }
  const payload = value.payload;
  return (
    isRecord(payload) &&
    typeof payload.action === "string" &&
    payload.action.length > 0 &&
    isJsonValue(payload.payload) &&
    (payload.context === undefined || isTransportContext(payload.context))
  );
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isRecord(value) || value.type !== "response" || !isMessageId(value.id)) {
    return false;
  }
  const hasOk = Object.hasOwn(value, "ok");
  const hasError = Object.hasOwn(value, "error");
  if (hasOk === hasError) return false;
  return hasOk ? isJsonValue(value.ok) : isJsonValue(value.error);
}

export function isProgressEnvelope(value: unknown): value is ProgressEnvelope {
  return (
    isRecord(value) &&
    value.type === "progress" &&
    isMessageId(value.id) &&
    isJsonValue(value.value)
  );
}

export function isAppStateChangeEnvelope(
  value: unknown,
): value is AppStateChangeEnvelope {
  return (
    isJsonObject(value) &&
    Object.keys(value).every((key) =>
      ["type", "version", "topic", "revision"].includes(key)
    ) &&
    value.type === "neutron:app:state" &&
    value.version === 1 &&
    typeof value.topic === "string" &&
    /^[a-z][a-z0-9_.-]{0,63}$/u.test(value.topic) &&
    typeof value.revision === "string" &&
    /^(0|[1-9][0-9]{0,127})$/u.test(value.revision)
  );
}

export function toError(value: unknown, fallback = "Request failed"): Error {
  if (value instanceof Error) return value;
  const error = new Error(errorText(value) ?? fallback);
  if (isRecord(value)) {
    if (typeof value.name === "string" && value.name.trim()) {
      error.name = value.name;
    }
    if (typeof value.stack === "string" && value.stack.trim()) {
      error.stack = value.stack;
    }
    if (typeof value.code === "string") {
      Object.defineProperty(error, "code", {
        configurable: true,
        enumerable: true,
        value: value.code,
      });
    }
    if (
      typeof value.retryAfterMs === "number" &&
      Number.isFinite(value.retryAfterMs)
    ) {
      Object.defineProperty(error, "retryAfterMs", {
        configurable: true,
        enumerable: true,
        value: value.retryAfterMs,
      });
    }
    if (
      typeof value.retryAfterSeconds === "string" &&
      /^(0|[1-9][0-9]{0,19})$/u.test(value.retryAfterSeconds)
    ) {
      Object.defineProperty(error, "retryAfterSeconds", {
        configurable: true,
        enumerable: true,
        value: value.retryAfterSeconds,
      });
    }
  }
  return error;
}

function errorText(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): string | null {
  if (value instanceof Error) return value.message || null;
  if (typeof value === "string") return value.trim() || null;
  if (depth >= 4 || typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = errorText(item, depth + 1, seen);
      if (message) return message;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "reason", "detail", "details"]) {
    const message = errorText(record[key], depth + 1, seen);
    if (message) return message;
  }
  const entries = Object.entries(record);
  if (entries.length === 1 && entries[0]?.[0] !== "code") {
    const [key, detail] = entries[0]!;
    const label = key.replaceAll("_", " ");
    const message = errorText(detail, depth + 1, seen);
    if (message) return `${label}: ${message}`;
    if (isRecord(detail)) {
      const fields = Object.entries(detail)
        .filter((entry): entry is [string, string | number | boolean] =>
          ["string", "number", "boolean"].includes(typeof entry[1])
        )
        .map(
          ([field, fieldValue]) =>
            `${field.replaceAll("_", " ")} ${String(fieldValue)}`
        );
      if (fields.length > 0) return `${label}: ${fields.join(", ")}`;
    }
  }
  return null;
}

export function serializeError(error: unknown): JsonValue {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? "",
      ...(isRecord(error) && typeof error.code === "string"
        ? { code: error.code }
        : {}),
      ...(isRecord(error) &&
      typeof error.retryAfterMs === "number" &&
      Number.isFinite(error.retryAfterMs)
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
      ...(isRecord(error) &&
      typeof error.retryAfterSeconds === "string" &&
      /^(0|[1-9][0-9]{0,19})$/u.test(error.retryAfterSeconds)
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
  return isJsonValue(error) ? error : String(error);
}

export function isVetKeysError(value: unknown): value is VetKeysError {
  if (!(value instanceof Error) || !isRecord(value)) return false;
  const codes = VET_KEYS_ERROR_CODES as readonly string[];
  if (typeof value.code !== "string" || !codes.includes(value.code)) {
    return false;
  }
  return value.retryAfterSeconds === undefined;
}

export function assertToolName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 128 ||
    !/^[a-zA-Z0-9_.-]+$/.test(name)
  ) {
    throw new Error("Invalid tool name");
  }
}

export function normalizeToolDescriptor(
  descriptor: MsgBusToolDescriptor,
): MsgBusToolDescriptor {
  if (!isJsonObject(descriptor)) throw new Error("Invalid tool descriptor");
  assertToolName(descriptor.name);
  if (!isJsonObject(descriptor.inputSchema)) {
    throw new Error("Tool inputSchema must be a JSON object");
  }
  if (
    descriptor.outputSchema !== undefined &&
    !isJsonObject(descriptor.outputSchema)
  ) {
    throw new Error("Tool outputSchema must be a JSON object");
  }
  const title = normalizeMetadata(descriptor.title, "Tool title", 120);
  const description = normalizeMetadata(
    descriptor.description,
    "Tool description",
    1000,
  );
  if (
    descriptor.annotations !== undefined &&
    !isJsonObject(descriptor.annotations)
  ) {
    throw new Error("Tool annotations must be a JSON object");
  }
  if (
    descriptor.annotations &&
    Object.prototype.hasOwnProperty.call(
      descriptor.annotations,
      "neutron:audit",
    ) &&
    descriptor.annotations["neutron:audit"] !==
      NEUTRON_TOOL_AUDIT_METADATA_ONLY
  ) {
    throw new Error("Unsupported neutron:audit tool annotation");
  }
  if (
    descriptor.annotations &&
    Object.prototype.hasOwnProperty.call(
      descriptor.annotations,
      "neutron:control",
    ) &&
    descriptor.annotations["neutron:control"] !==
      NEUTRON_TOOL_CONTROL_CANCEL
  ) {
    throw new Error("Unsupported neutron:control tool annotation");
  }
  if (
    descriptor.annotations &&
    Object.prototype.hasOwnProperty.call(
      descriptor.annotations,
      "neutron:visibility",
    ) &&
    descriptor.annotations["neutron:visibility"] !==
      NEUTRON_TOOL_VISIBILITY_SAME_APP
  ) {
    throw new Error("Unsupported neutron:visibility tool annotation");
  }
  assertSafeJsonSchema(descriptor.inputSchema, "Tool inputSchema");
  if (descriptor.outputSchema) {
    assertSafeJsonSchema(descriptor.outputSchema, "Tool outputSchema");
  }
  if (descriptor.annotations) {
    assertSafeAnnotationValue(descriptor.annotations, 0);
  }
  assertBoundedJson(
    descriptor.inputSchema,
    "Tool inputSchema",
    MSG_BUS_MAX_SCHEMA_BYTES,
  );
  if (descriptor.outputSchema) {
    assertBoundedJson(
      descriptor.outputSchema,
      "Tool outputSchema",
      MSG_BUS_MAX_SCHEMA_BYTES,
    );
  }
  assertBoundedJson(
    descriptor,
    "Tool descriptor",
    MSG_BUS_MAX_SCHEMA_BYTES * 2,
  );
  return {
    name: descriptor.name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    inputSchema: descriptor.inputSchema,
    ...(descriptor.outputSchema
      ? { outputSchema: descriptor.outputSchema }
      : {}),
    ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
  };
}

function assertSafeJsonSchema(
  schema: JsonSchemaDocument,
  label: string,
): void {
  let nodes = 0;
  const visit = (value: JsonValue, depth: number): void => {
    nodes++;
    if (nodes > 2000 || depth > 20) {
      throw new Error(`${label} is too complex`);
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "string") {
      try {
        normalizeUntrustedText(value, `${label} string metadata`, {
          minimumLength: 0,
          maximumLength: 4096,
        });
      } catch {
        throw new Error(`${label} contains unsafe string metadata`);
      }
      return;
    }
    if (!isJsonObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      try {
        normalizeUntrustedText(key, `${label} key`, {
          maximumLength: 256,
        });
      } catch {
        throw new Error(`${label} contains an unsafe key`);
      }
      if (
        key === "$ref" &&
        (typeof item !== "string" || !item.startsWith("#/"))
      ) {
        throw new Error(`${label} contains an external reference`);
      }
      if (
        key === "pattern" &&
        (typeof item !== "string" ||
          item.length > 256 ||
          item.includes("(") ||
          /\\[1-9]/.test(item))
      ) {
        throw new Error(`${label} contains an unsafe pattern`);
      }
      visit(item as JsonValue, depth + 1);
    }
  };
  visit(schema, 0);
}

function assertSafeAnnotationValue(value: JsonValue, depth: number): void {
  if (depth > 8) throw new Error("Tool annotations are too complex");
  if (typeof value === "string") {
    try {
      normalizeUntrustedText(value, "tool annotation metadata", {
        minimumLength: 0,
        maximumLength: 256,
      });
    } catch {
      throw new Error("Invalid tool annotation metadata");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeAnnotationValue(item, depth + 1);
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      normalizeMetadata(key, "Tool annotation key", 128);
      assertSafeAnnotationValue(item as JsonValue, depth + 1);
    }
  }
}

function normalizeMetadata(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeUntrustedText(value, label.toLowerCase(), {
      maximumLength,
    });
  } catch {
    throw new Error(`Invalid ${label.toLowerCase()}`);
  }
}

export function validateToolArguments(
  descriptor: MsgBusToolDescriptor,
  args: JsonObject,
): void {
  validateToolSchemaValue(
    descriptor.name,
    "arguments",
    args,
    descriptor.inputSchema,
  );
}

export function validateToolResult(
  descriptor: MsgBusToolDescriptor,
  result: JsonValue,
): void {
  if (!descriptor.outputSchema) return;
  validateToolSchemaValue(
    descriptor.name,
    "result",
    result,
    descriptor.outputSchema,
  );
}

function validateToolSchemaValue(
  toolName: string,
  label: string,
  value: JsonValue,
  schema: JsonSchemaDocument,
): void {
  const validation = validateJsonSchema(value, schema as Schema);
  if (!validation.valid) {
    throw new Error(
      `Invalid ${label} for tool '${toolName}': ${validation.errors
        .map((error) => error.stack)
        .join("; ")}`,
    );
  }
}

const canisterIdSchema: Schema = {
  type: "string",
  minLength: 1,
  pattern: "^[a-z0-9-]+$",
};

export const kernelSchemaPayloadSchema: Schema = {
  type: "object",
  required: ["canister", "method"],
  properties: {
    canister: canisterIdSchema,
    method: {
      type: "string",
      minLength: 1,
      maxLength: CANISTER_METHOD_MAX_LENGTH,
    },
  },
  additionalProperties: false,
};

export const kernelCallPayloadSchema: Schema = {
  type: "object",
  required: ["canister", "method"],
  properties: {
    canister: canisterIdSchema,
    method: {
      type: "string",
      minLength: 1,
      maxLength: CANISTER_METHOD_MAX_LENGTH,
    },
    args: { type: "array" },
  },
  additionalProperties: false,
};
