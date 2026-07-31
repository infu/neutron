import {
  MSG_BUS_MAX_PROGRESS_BYTES,
  MSG_BUS_MAX_PROGRESS_EVENTS,
  assertBoundedJson,
  isExecEnvelope,
  isJsonObject,
  toError,
  type JsonObject,
  type JsonValue,
  type MsgBusInvocationMetadata,
  type MsgBusToolDescriptor,
} from "neutron-tools/protocol";
import {
  getRegisteredEndpoint,
  subscribeEndpointChanges,
  type RegisteredEndpoint,
} from "./frame_context.ts";

/**
 * Private-port binary attachment protocol, version 1.
 *
 * This is deliberately parallel to neutron-tools' JSON-only exec protocol.
 * App-local adapters may retain `event.ports[0]` from the
 * `neutron:msgbus:connect` handshake and install an additional listener on it.
 * They advertise an attachment-capable tool through its ordinary descriptor:
 *
 *   annotations["neutron:attachments"] = {
 *     version: 1,
 *     input?:  { name, mediaTypes, maxBytes, required: true },
 *     output?: { name, mediaTypes, maxBytes, required: true },
 *   }
 *
 * Calls use AttachmentExecEnvelope with action `tools.call`. The kernel
 * forwards the same envelope with action `__neutron_msgbus_tools_call`, a
 * source-bound caller, and (when present) invocation metadata. Responses use
 * AttachmentResponseEnvelope. Progress remains bounded JSON. Every data field
 * is posted in the transfer list; buffers are never put through the JSON SDK.
 * A custom attachment handler may copy forwarded invocation metadata to a
 * nested attachment call. An ordinary neutron-tools handler cannot see that
 * metadata, so it first calls the scoped kernel tool `attachments.delegate`
 * and supplies the returned one-use `delegationToken` at the top level of its
 * next attachment request. The kernel consumes that token and never forwards
 * it to the target.
 */

export const ATTACHMENT_ANNOTATION_KEY = "neutron:attachments";
export const ATTACHMENT_PROTOCOL_VERSION = 1;
export const MAX_TOOL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT = 32 * 1024 * 1024;
export const MAX_ATTACHMENT_IN_FLIGHT_BYTES_GLOBAL = 64 * 1024 * 1024;
export const ATTACHMENT_DELEGATION_TTL_MS = 10_000;
export const MAX_ATTACHMENT_DELEGATIONS_GLOBAL = 64;
export const MAX_ATTACHMENT_DELEGATIONS_PER_ENDPOINT = 4;

export type AttachmentDeclaration = {
  name: string;
  mediaTypes: string[];
  maxBytes: number;
  required: true;
};

export type ToolAttachmentContract = {
  version: 1;
  input?: AttachmentDeclaration;
  output?: AttachmentDeclaration;
};

export type ToolAttachment = {
  name: string;
  mediaType: string;
  byteLength: number;
  data: ArrayBuffer;
};

type AttachmentExecPayload = {
  action: string;
  payload: JsonValue;
  context?: { invocation?: MsgBusInvocationMetadata };
};

export type AttachmentExecEnvelope = {
  type: "neutron:msgbus:attachment:exec";
  version: 1;
  id: number;
  delegationToken?: string;
  payload: AttachmentExecPayload;
  attachments: ToolAttachment[];
};

export type AttachmentResponseEnvelope = {
  type: "neutron:msgbus:attachment:response";
  version: 1;
  id: number;
  ok?: JsonValue;
  error?: JsonValue;
  attachments?: ToolAttachment[];
};

export type AttachmentProgressEnvelope = {
  type: "neutron:msgbus:attachment:progress";
  version: 1;
  id: number;
  value: JsonValue;
};

export type AttachmentCallResult = {
  value: JsonValue;
  attachments: ToolAttachment[];
};

export type AttachmentCapacityReservation = {
  readonly signal: AbortSignal;
  bindEndpoint(endpoint: RegisteredEndpoint): void;
  resize(bytes: number): void;
  retainUntilSettlement(): void;
  release(): void;
};

type PendingAttachmentCall = {
  endpoint: RegisteredEndpoint;
  sessionId?: string;
  port: MessagePort;
  resolve: (result: AttachmentCallResult) => void;
  reject: (error: Error) => void;
  onProgress?: (value: JsonValue) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  progressCount: number;
};

type AttachmentDelegation = {
  endpoint: RegisteredEndpoint;
  sessionId?: string;
  port: MessagePort;
  metadata: MsgBusInvocationMetadata;
  expiresAt: number;
};

const pendingCalls = new Map<number, PendingAttachmentCall>();
const handledReplyMessages = new WeakMap<object, Set<RegisteredEndpoint>>();
const activeReservations = new Set<InternalReservation>();
const inFlightBytesByEndpoint = new Map<string, number>();
let inFlightBytesGlobal = 0;
let nextAttachmentCallId = 0;
const attachmentDelegations = new Map<string, AttachmentDelegation>();

export function attachmentError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "AttachmentProtocolError";
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: code,
  });
  return error;
}

export function issueAttachmentDelegation(
  endpoint: RegisteredEndpoint,
  metadata: MsgBusInvocationMetadata,
  now = Date.now(),
): { token: string; expiresAt: number } {
  pruneAttachmentDelegations(now);
  const metadataEnvelope = {
    type: "exec",
    id: 1,
    payload: {
      action: "attachments.delegate",
      payload: null,
      context: { invocation: metadata },
    },
  };
  if (!isExecEnvelope(metadataEnvelope)) {
    throw attachmentError(
      "ATTACHMENT_DELEGATION_INVALID",
      "Invalid attachment invocation metadata",
    );
  }
  if (!endpoint.port || !endpoint.sessionId) {
    throw attachmentError(
      "ATTACHMENT_DELEGATION_INVALID",
      "Attachment delegation requires an active private-port session",
    );
  }
  if (attachmentDelegations.size >= MAX_ATTACHMENT_DELEGATIONS_GLOBAL) {
    throw attachmentError(
      "ATTACHMENT_DELEGATION_BUSY",
      "Too many pending attachment delegations",
    );
  }
  let endpointCount = 0;
  for (const delegation of attachmentDelegations.values()) {
    if (delegation.endpoint === endpoint) endpointCount += 1;
  }
  if (endpointCount >= MAX_ATTACHMENT_DELEGATIONS_PER_ENDPOINT) {
    throw attachmentError(
      "ATTACHMENT_DELEGATION_BUSY",
      "This endpoint has too many pending attachment delegations",
    );
  }
  const token = createDelegationToken();
  const expiresAt = now + ATTACHMENT_DELEGATION_TTL_MS;
  attachmentDelegations.set(token, {
    endpoint,
    sessionId: endpoint.sessionId,
    port: endpoint.port,
    metadata: { ...metadata },
    expiresAt,
  });
  return { token, expiresAt };
}

export function consumeAttachmentDelegation(
  endpoint: RegisteredEndpoint,
  token: unknown,
  now = Date.now(),
): MsgBusInvocationMetadata {
  assertDelegationToken(token);
  const delegation = attachmentDelegations.get(token);
  // A syntactically valid token is spent by every consume attempt. This keeps
  // replay and cross-endpoint probing behavior deterministic.
  attachmentDelegations.delete(token);
  if (
    !delegation ||
    delegation.expiresAt <= now ||
    delegation.endpoint !== endpoint ||
    delegation.sessionId !== endpoint.sessionId ||
    delegation.port !== endpoint.port ||
    getRegisteredEndpoint(endpoint.endpointId) !== endpoint
  ) {
    throw attachmentError(
      "ATTACHMENT_DELEGATION_INVALID",
      "Attachment delegation is invalid or expired",
    );
  }
  return { ...delegation.metadata };
}

export function pruneAttachmentDelegations(now = Date.now()): void {
  for (const [token, delegation] of attachmentDelegations) {
    if (delegation.expiresAt <= now) attachmentDelegations.delete(token);
  }
}

export function attachmentDelegationSnapshot(): { pending: number } {
  pruneAttachmentDelegations();
  return { pending: attachmentDelegations.size };
}

export function parseToolAttachmentContract(
  descriptor: MsgBusToolDescriptor,
): ToolAttachmentContract | null {
  const raw = descriptor.annotations?.[ATTACHMENT_ANNOTATION_KEY];
  if (raw === undefined) return null;
  if (
    !isJsonObject(raw) ||
    raw.version !== ATTACHMENT_PROTOCOL_VERSION ||
    hasUnexpectedKeys(raw, ["version", "input", "output"]) ||
    (raw.input === undefined && raw.output === undefined)
  ) {
    throw attachmentError(
      "ATTACHMENT_DECLARATION_INVALID",
      `Tool '${descriptor.name}' has an invalid attachment declaration`,
    );
  }
  const input =
    raw.input === undefined
      ? undefined
      : parseAttachmentDeclaration(raw.input, descriptor.name, "input");
  const output =
    raw.output === undefined
      ? undefined
      : parseAttachmentDeclaration(raw.output, descriptor.name, "output");
  return {
    version: ATTACHMENT_PROTOCOL_VERSION,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  };
}

function parseAttachmentDeclaration(
  value: JsonValue,
  tool: string,
  direction: "input" | "output",
): AttachmentDeclaration {
  if (
    !isJsonObject(value) ||
    hasUnexpectedKeys(value, ["name", "mediaTypes", "maxBytes", "required"]) ||
    !isAttachmentName(value.name) ||
    !Array.isArray(value.mediaTypes) ||
    value.mediaTypes.length < 1 ||
    value.mediaTypes.length > 16 ||
    !value.mediaTypes.every(isMediaType) ||
    new Set(value.mediaTypes.map(normalizeMediaType)).size !==
      value.mediaTypes.length ||
    !Number.isSafeInteger(value.maxBytes) ||
    Number(value.maxBytes) < 1 ||
    Number(value.maxBytes) > MAX_TOOL_ATTACHMENT_BYTES ||
    value.required !== true
  ) {
    throw attachmentError(
      "ATTACHMENT_DECLARATION_INVALID",
      `Tool '${tool}' has an invalid ${direction} attachment declaration`,
    );
  }
  return {
    name: value.name,
    mediaTypes: value.mediaTypes.map(normalizeMediaType),
    maxBytes: Number(value.maxBytes),
    required: true,
  };
}

export function validateToolAttachments(
  attachments: ToolAttachment[],
  declaration: AttachmentDeclaration | undefined,
  direction: "input" | "output",
): void {
  assertToolAttachmentArray(attachments);
  if (!declaration) {
    if (attachments.length !== 0) {
      throw attachmentError(
        "ATTACHMENT_UNDECLARED",
        `Tool does not declare an ${direction} attachment`,
      );
    }
    return;
  }
  if (attachments.length === 0) {
    throw attachmentError(
      "ATTACHMENT_API_REQUIRED",
      `Tool requires the declared ${direction} attachment '${declaration.name}'`,
    );
  }
  const attachment = attachments[0]!;
  if (attachment.name !== declaration.name) {
    throw attachmentError(
      "ATTACHMENT_INVALID",
      `Expected ${direction} attachment '${declaration.name}'`,
    );
  }
  const mediaType = normalizeMediaType(attachment.mediaType);
  if (!declaration.mediaTypes.includes(mediaType)) {
    throw attachmentError(
      "ATTACHMENT_MEDIA_TYPE",
      `Attachment '${attachment.name}' has an unsupported media type`,
    );
  }
  if (attachment.byteLength > declaration.maxBytes) {
    throw attachmentError(
      "ATTACHMENT_LIMIT",
      `Attachment '${attachment.name}' exceeds its declared byte limit`,
    );
  }
}

export function assertAttachmentExecEnvelope(
  value: unknown,
): AttachmentExecEnvelope {
  if (
    !isRecord(value) ||
    value.type !== "neutron:msgbus:attachment:exec" ||
    value.version !== ATTACHMENT_PROTOCOL_VERSION ||
    !isMessageId(value.id) ||
    hasUnexpectedKeys(value, [
      "type",
      "version",
      "id",
      "delegationToken",
      "payload",
      "attachments",
    ]) ||
    !isRecord(value.payload) ||
    hasUnexpectedKeys(value.payload, ["action", "payload", "context"]) ||
    !Array.isArray(value.attachments)
  ) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Invalid attachment request envelope",
    );
  }
  if (value.delegationToken !== undefined) {
    assertDelegationToken(value.delegationToken);
  }
  const execCandidate = {
    type: "exec",
    id: value.id,
    payload: value.payload,
  };
  if (!isExecEnvelope(execCandidate)) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Invalid attachment request payload",
    );
  }
  const attachments = value.attachments as unknown[];
  assertToolAttachmentArray(attachments);
  assertAttachmentMetadataBounded(
    value.payload as unknown as AttachmentExecPayload,
    attachments,
    typeof value.delegationToken === "string"
      ? value.delegationToken
      : undefined,
  );
  return value as AttachmentExecEnvelope;
}

export function assertAttachmentResponseEnvelope(
  value: unknown,
): AttachmentResponseEnvelope {
  if (
    !isRecord(value) ||
    value.type !== "neutron:msgbus:attachment:response" ||
    value.version !== ATTACHMENT_PROTOCOL_VERSION ||
    !isMessageId(value.id) ||
    hasUnexpectedKeys(value, [
      "type",
      "version",
      "id",
      "ok",
      "error",
      "attachments",
    ])
  ) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Invalid attachment response envelope",
    );
  }
  const hasOk = Object.hasOwn(value, "ok");
  const hasError = Object.hasOwn(value, "error");
  if (hasOk === hasError) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Attachment response must contain exactly one of ok or error",
    );
  }
  const responseValue = hasOk ? value.ok : value.error;
  assertBoundedJson(responseValue, "Attachment response JSON");
  const attachments = value.attachments ?? [];
  if (!Array.isArray(attachments)) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Invalid attachment response list",
    );
  }
  assertToolAttachmentArray(attachments);
  if (hasError && attachments.length !== 0) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Failed attachment responses cannot include data",
    );
  }
  assertAttachmentMetadataBounded(null, attachments);
  return value as AttachmentResponseEnvelope;
}

export function assertAttachmentProgressEnvelope(
  value: unknown,
): AttachmentProgressEnvelope {
  if (
    !isRecord(value) ||
    value.type !== "neutron:msgbus:attachment:progress" ||
    value.version !== ATTACHMENT_PROTOCOL_VERSION ||
    !isMessageId(value.id) ||
    hasUnexpectedKeys(value, ["type", "version", "id", "value"])
  ) {
    throw attachmentError(
      "ATTACHMENT_ENVELOPE_INVALID",
      "Invalid attachment progress envelope",
    );
  }
  assertBoundedJson(value.value, "Progress payload", MSG_BUS_MAX_PROGRESS_BYTES);
  return value as AttachmentProgressEnvelope;
}

export function isAttachmentWireMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.startsWith("neutron:msgbus:attachment:")
  );
}

export function attachmentEnvelopeId(value: unknown): number | null {
  return isRecord(value) && isMessageId(value.id) ? value.id : null;
}

export function attachmentBytes(attachments: readonly ToolAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
}

export function acquireAttachmentCapacity(
  endpoint: RegisteredEndpoint,
  bytes: number,
): AttachmentCapacityReservation {
  return new InternalReservation(endpoint, bytes);
}

class InternalReservation implements AttachmentCapacityReservation {
  readonly controller = new AbortController();
  readonly endpoints = new Map<
    string,
    {
      endpoint: RegisteredEndpoint;
      sessionId?: string;
      port?: MessagePort;
    }
  >();
  bytes = 0;
  released = false;
  retainedUntilSettlement = false;

  constructor(endpoint: RegisteredEndpoint, bytes: number) {
    this.endpoints.set(endpoint.endpointId, endpointBinding(endpoint));
    assertCapacityBytes(bytes);
    assertCapacityAvailable(this.endpoints.keys(), 0, bytes);
    this.bytes = bytes;
    applyCapacity(this.endpoints.keys(), bytes);
    activeReservations.add(this);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  bindEndpoint(endpoint: RegisteredEndpoint): void {
    this.assertActive();
    const existing = this.endpoints.get(endpoint.endpointId);
    if (
      existing?.endpoint === endpoint &&
      existing.sessionId === endpoint.sessionId &&
      existing.port === endpoint.port
    ) {
      return;
    }
    if (existing) {
      throw attachmentError(
        "ATTACHMENT_ENDPOINT_CHANGED",
        "Attachment endpoint changed during the call",
      );
    }
    assertCapacityAvailable([endpoint.endpointId], 0, this.bytes, false);
    this.endpoints.set(endpoint.endpointId, endpointBinding(endpoint));
    applyEndpointCapacity(endpoint.endpointId, this.bytes);
  }

  resize(bytes: number): void {
    this.assertActive();
    assertCapacityBytes(bytes);
    assertCapacityAvailable(this.endpoints.keys(), this.bytes, bytes);
    const delta = bytes - this.bytes;
    this.bytes = bytes;
    applyCapacity(this.endpoints.keys(), delta);
  }

  retainUntilSettlement(): void {
    this.assertActive();
    this.retainedUntilSettlement = true;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    activeReservations.delete(this);
    applyCapacity(this.endpoints.keys(), -this.bytes);
    this.bytes = 0;
  }

  cancel(message: string): void {
    if (this.released) return;
    this.controller.abort(
      attachmentError("ATTACHMENT_ENDPOINT_CHANGED", message),
    );
    if (!this.retainedUntilSettlement) this.release();
  }

  private assertActive(): void {
    if (this.released || this.signal.aborted) {
      throw attachmentError(
        "ATTACHMENT_ENDPOINT_CHANGED",
        "Attachment call is no longer active",
      );
    }
  }
}

function assertCapacityBytes(bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_TOOL_ATTACHMENT_BYTES * 2
  ) {
    throw attachmentError(
      "ATTACHMENT_LIMIT",
      "Invalid attachment in-flight byte reservation",
    );
  }
}

function assertCapacityAvailable(
  endpointIds: Iterable<string>,
  previousBytes: number,
  nextBytes: number,
  includeGlobal = true,
): void {
  const delta = nextBytes - previousBytes;
  if (
    includeGlobal &&
    inFlightBytesGlobal + delta > MAX_ATTACHMENT_IN_FLIGHT_BYTES_GLOBAL
  ) {
    throw attachmentError(
      "ATTACHMENT_BUSY",
      "Global attachment in-flight byte limit reached",
    );
  }
  for (const endpointId of endpointIds) {
    const active = inFlightBytesByEndpoint.get(endpointId) ?? 0;
    if (active + delta > MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT) {
      throw attachmentError(
        "ATTACHMENT_BUSY",
        "Endpoint attachment in-flight byte limit reached",
      );
    }
  }
}

function applyCapacity(endpointIds: Iterable<string>, delta: number): void {
  inFlightBytesGlobal += delta;
  for (const endpointId of endpointIds) applyEndpointCapacity(endpointId, delta);
}

function applyEndpointCapacity(endpointId: string, delta: number): void {
  const next = (inFlightBytesByEndpoint.get(endpointId) ?? 0) + delta;
  if (next > 0) inFlightBytesByEndpoint.set(endpointId, next);
  else inFlightBytesByEndpoint.delete(endpointId);
}

export function attachmentCapacitySnapshot(): {
  global: number;
  endpoints: Record<string, number>;
  reservations: number;
} {
  return {
    global: inFlightBytesGlobal,
    endpoints: Object.fromEntries(inFlightBytesByEndpoint),
    reservations: activeReservations.size,
  };
}

export function attachmentTransportSnapshot(): { pendingCalls: number } {
  return { pendingCalls: pendingCalls.size };
}

export async function execEndpointWithAttachments(
  endpoint: RegisteredEndpoint,
  action: string,
  payload: JsonValue,
  attachments: ToolAttachment[],
  options: {
    timeoutSeconds: number;
    onProgress?: (value: JsonValue) => void;
    invocation?: MsgBusInvocationMetadata;
    signal?: AbortSignal;
  },
): Promise<AttachmentCallResult> {
  const port = endpoint.port;
  if (!port) {
    throw attachmentError(
      "ATTACHMENT_PRIVATE_PORT_REQUIRED",
      "Binary attachments require a connected private MessagePort",
    );
  }
  assertToolAttachmentArray(attachments);
  assertBoundedJson(payload, "Attachment call JSON");
  if (options.signal?.aborted) throw abortReason(options.signal);

  const id = nextMessageId();
  const envelope: AttachmentExecEnvelope = {
    type: "neutron:msgbus:attachment:exec",
    version: ATTACHMENT_PROTOCOL_VERSION,
    id,
    payload: {
      action,
      payload,
      ...(options.invocation
        ? { context: { invocation: options.invocation } }
        : {}),
    },
    attachments,
  };
  assertAttachmentExecEnvelope(envelope);

  return new Promise<AttachmentCallResult>((resolve, reject) => {
    const pending: PendingAttachmentCall = {
      endpoint,
      port,
      ...(endpoint.sessionId ? { sessionId: endpoint.sessionId } : {}),
      resolve,
      reject,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      progressCount: 0,
    };
    if (options.timeoutSeconds > 0) {
      pending.timeout = setTimeout(() => {
        rejectPendingCall(
          id,
          attachmentError(
            "ATTACHMENT_TIMEOUT",
            `Timeout after ${options.timeoutSeconds} seconds`,
          ),
        );
      }, options.timeoutSeconds * 1_000);
    }
    if (options.signal) {
      pending.abortListener = () =>
        rejectPendingCall(id, abortReason(options.signal!));
      options.signal.addEventListener("abort", pending.abortListener, {
        once: true,
      });
    }
    pendingCalls.set(id, pending);
    try {
      port.postMessage(
        envelope,
        attachments.map((attachment) => attachment.data),
      );
    } catch (error) {
      rejectPendingCall(
        id,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

export function handleAttachmentReply(
  endpoint: RegisteredEndpoint,
  value: unknown,
): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (
    value.type !== "neutron:msgbus:attachment:response" &&
    value.type !== "neutron:msgbus:attachment:progress"
  ) {
    return false;
  }
  const handledBy = handledReplyMessages.get(value);
  if (handledBy?.has(endpoint)) return true;
  if (handledBy) handledBy.add(endpoint);
  else handledReplyMessages.set(value, new Set([endpoint]));
  const id = attachmentEnvelopeId(value);
  if (id === null) return true;
  const pending = pendingCalls.get(id);
  if (!pending || pending.endpoint !== endpoint) return true;
  try {
    if (value.type === "neutron:msgbus:attachment:progress") {
      const progress = assertAttachmentProgressEnvelope(value);
      if (pending.progressCount >= MSG_BUS_MAX_PROGRESS_EVENTS) return true;
      pending.progressCount += 1;
      try {
        pending.onProgress?.(progress.value);
      } catch {
        // Progress consumers cannot affect the final attachment response.
      }
      return true;
    }
    const response = assertAttachmentResponseEnvelope(value);
    cleanupPendingCall(id, pending);
    if (Object.hasOwn(response, "error")) {
      pending.reject(toError(response.error));
    } else {
      pending.resolve({
        value: response.ok ?? null,
        attachments: response.attachments ?? [],
      });
    }
  } catch (error) {
    rejectPendingCall(
      id,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  return true;
}

export function postAttachmentResponse(
  port: MessagePort,
  id: number,
  response:
    | { ok: JsonValue; attachments?: ToolAttachment[] }
    | { error: JsonValue },
): void {
  const envelope: AttachmentResponseEnvelope = {
    type: "neutron:msgbus:attachment:response",
    version: ATTACHMENT_PROTOCOL_VERSION,
    id,
    ...response,
  };
  assertAttachmentResponseEnvelope(envelope);
  const attachments = "attachments" in response ? response.attachments ?? [] : [];
  port.postMessage(
    envelope,
    attachments.map((attachment) => attachment.data),
  );
}

export function postAttachmentProgress(
  port: MessagePort,
  id: number,
  value: JsonValue,
): void {
  const envelope: AttachmentProgressEnvelope = {
    type: "neutron:msgbus:attachment:progress",
    version: ATTACHMENT_PROTOCOL_VERSION,
    id,
    value,
  };
  assertAttachmentProgressEnvelope(envelope);
  port.postMessage(envelope);
}

function rejectPendingCall(id: number, error: Error): void {
  const pending = pendingCalls.get(id);
  if (!pending) return;
  cleanupPendingCall(id, pending);
  pending.reject(error);
}

function cleanupPendingCall(id: number, pending: PendingAttachmentCall): void {
  if (pending.timeout) clearTimeout(pending.timeout);
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener("abort", pending.abortListener);
  }
  pendingCalls.delete(id);
}

function nextMessageId(): number {
  nextAttachmentCallId =
    nextAttachmentCallId >= Number.MAX_SAFE_INTEGER
      ? 1
      : nextAttachmentCallId + 1;
  while (pendingCalls.has(nextAttachmentCallId)) {
    nextAttachmentCallId =
      nextAttachmentCallId >= Number.MAX_SAFE_INTEGER
        ? 1
        : nextAttachmentCallId + 1;
  }
  return nextAttachmentCallId;
}

export function assertToolAttachmentArray(
  value: unknown[],
): asserts value is ToolAttachment[] {
  if (value.length > 1) {
    throw attachmentError(
      "ATTACHMENT_COUNT",
      "At most one attachment is allowed in each direction",
    );
  }
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      hasUnexpectedKeys(candidate, [
        "name",
        "mediaType",
        "byteLength",
        "data",
      ]) ||
      !isAttachmentName(candidate.name) ||
      !isMediaType(candidate.mediaType) ||
      !Number.isSafeInteger(candidate.byteLength) ||
      Number(candidate.byteLength) < 0 ||
      Number(candidate.byteLength) > MAX_TOOL_ATTACHMENT_BYTES ||
      !(candidate.data instanceof ArrayBuffer) ||
      candidate.data.byteLength !== candidate.byteLength
    ) {
      throw attachmentError(
        "ATTACHMENT_INVALID",
        "Invalid binary tool attachment",
      );
    }
  }
}

function assertAttachmentMetadataBounded(
  payload: AttachmentExecPayload | null,
  attachments: unknown[],
  delegationToken?: string,
): void {
  const metadata = attachments.map((candidate) => {
    const attachment = candidate as ToolAttachment;
    return {
      name: attachment.name,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
    };
  });
  assertBoundedJson(
    {
      ...(payload ? { payload } : {}),
      ...(delegationToken ? { delegationToken } : {}),
      attachments: metadata,
    },
    "Attachment envelope metadata",
  );
}

function normalizeMediaType(value: string): string {
  return value.toLowerCase();
}

function isMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 160 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$/u.test(
      value,
    )
  );
}

function isAttachmentName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(value)
  );
}

function isMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : attachmentError("ATTACHMENT_CANCELLED", "Attachment call was cancelled");
}

function assertDelegationToken(value: unknown): asserts value is string {
  assertOpaqueToken(
    value,
    "ATTACHMENT_DELEGATION_INVALID",
    "Invalid attachment delegation token",
  );
}

function createDelegationToken(): string {
  return createOpaqueToken(
    attachmentDelegations,
    "ATTACHMENT_DELEGATION_INVALID",
    "attachment delegation",
  );
}

function assertOpaqueToken(
  value: unknown,
  code: string,
  message: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{48}$/u.test(value)) {
    throw attachmentError(code, message);
  }
}

function createOpaqueToken(
  existing: ReadonlyMap<string, unknown>,
  errorCode: string,
  label: string,
): string {
  if (
    typeof crypto === "undefined" ||
    typeof crypto.getRandomValues !== "function"
  ) {
    throw attachmentError(
      errorCode,
      `Secure randomness is unavailable for ${label}`,
    );
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (!existing.has(token)) return token;
  }
  throw attachmentError(
    errorCode,
    `Unable to create a unique ${label} token`,
  );
}

subscribeEndpointChanges(() => {
  for (const [token, delegation] of attachmentDelegations) {
    const current = getRegisteredEndpoint(delegation.endpoint.endpointId);
    if (
      current !== delegation.endpoint ||
      current.sessionId !== delegation.sessionId ||
      current.port !== delegation.port
    ) {
      attachmentDelegations.delete(token);
    }
  }
  for (const [id, pending] of pendingCalls) {
    const current = getRegisteredEndpoint(pending.endpoint.endpointId);
    if (
      current !== pending.endpoint ||
      current.sessionId !== pending.sessionId ||
      current.port !== pending.port
    ) {
      rejectPendingCall(
        id,
        attachmentError(
          "ATTACHMENT_ENDPOINT_CHANGED",
          "Attachment target changed during the call",
        ),
      );
    }
  }
  for (const reservation of activeReservations) {
    for (const binding of reservation.endpoints.values()) {
      const current = getRegisteredEndpoint(binding.endpoint.endpointId);
      if (
        current !== binding.endpoint ||
        current.sessionId !== binding.sessionId ||
        current.port !== binding.port
      ) {
        reservation.cancel("Attachment endpoint changed during the call");
        break;
      }
    }
  }
});

function endpointBinding(endpoint: RegisteredEndpoint): {
  endpoint: RegisteredEndpoint;
  sessionId?: string;
  port?: MessagePort;
} {
  return {
    endpoint,
    ...(endpoint.sessionId ? { sessionId: endpoint.sessionId } : {}),
    ...(endpoint.port ? { port: endpoint.port } : {}),
  };
}
