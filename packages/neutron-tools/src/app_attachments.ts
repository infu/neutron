import {
  exposeTool,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type MsgBusInvocationMetadata,
} from "./app.ts";
import { kernelParentOriginFromAppUrl } from "./runtime.js";

const EXEC_TYPE = "neutron:msgbus:attachment:exec";
const RESPONSE_TYPE = "neutron:msgbus:attachment:response";
const PROGRESS_TYPE = "neutron:msgbus:attachment:progress";
const LOCAL_TOOL_ACTION = "__neutron_msgbus_tools_call";
const ATTACHMENT_ANNOTATION = "neutron:attachments";
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

export type AppToolAttachment = {
  name: string;
  mediaType: string;
  byteLength: number;
  data: ArrayBuffer;
};

export type AttachmentToolCaller = {
  endpoint: string;
  appId: string;
  role: "tile" | "background" | "tray";
  sessionId: string;
};

export type AttachmentToolContext = {
  caller?: AttachmentToolCaller;
  signal?: AbortSignal;
  /** Kernel-attested; true only while this handler belongs to an Agent Mode turn. */
  agentMode?: boolean;
  reportProgress(value: JsonValue): void;
  callTool(
    call: AttachmentToolCall,
    attachments?: AppToolAttachment[],
    options?: AttachmentCallOptions,
  ): Promise<AttachmentCallResult>;
};

export type AttachmentToolResult = {
  value: JsonValue;
  attachments?: AppToolAttachment[];
};

export type AttachmentCallResult = {
  value: JsonValue;
  attachments: AppToolAttachment[];
};

export type AttachmentToolCall = {
  target: MsgBusEndpointId;
  name: string;
  arguments?: JsonObject;
};

export type AttachmentCallOptions = {
  timeoutSeconds?: number;
  delegationToken?: string;
  onProgress?: (value: JsonValue) => void;
  signal?: AbortSignal;
};

type AttachmentDeclaration = {
  name: string;
  mediaTypes: string[];
  maxBytes: number;
  required: true;
};

type AttachmentContract = {
  version: 1;
  input?: AttachmentDeclaration;
  output?: AttachmentDeclaration;
};

type AttachmentToolHandler = (
  args: JsonObject,
  attachments: AppToolAttachment[],
  context: AttachmentToolContext,
) => AttachmentToolResult | Promise<AttachmentToolResult>;

const handlers = new Map<
  string,
  { contract: AttachmentContract; handler: AttachmentToolHandler }
>();
const installedPorts = new WeakSet<MessagePort>();
type PendingAppAttachmentCall = {
  resolve: (result: AttachmentCallResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (value: JsonValue) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};
const pendingCalls = new Map<number, PendingAppAttachmentCall>();
const incomingInvocationControllers = new Map<
  string,
  Set<AbortController>
>();
const portWaiters = new Set<{
  resolve: (port: MessagePort) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let kernelPort: MessagePort | undefined;
let nextCallId = 0;
let attachmentListenerWindow: Window | undefined;

export function exposeAttachmentTool(
  name: string,
  options: {
    title?: string;
    description?: string;
    inputSchema: JsonObject;
    outputSchema?: JsonObject;
    annotations?: JsonObject;
    attachments: AttachmentContract;
  },
  handler: AttachmentToolHandler,
): void {
  if (handlers.has(name)) throw new Error(`Attachment tool '${name}' is already exposed`);
  validateContract(options.attachments);
  handlers.set(name, { contract: options.attachments, handler });
  exposeTool(
    name,
    {
      ...(options.title ? { title: options.title } : {}),
      ...(options.description ? { description: options.description } : {}),
      inputSchema: options.inputSchema,
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      annotations: {
        ...(options.annotations ?? {}),
        [ATTACHMENT_ANNOTATION]: options.attachments as unknown as JsonValue,
      },
    },
    () => {
      const error = new Error(
        `Tool '${name}' requires the binary attachment API`,
      );
      error.name = "AttachmentProtocolError";
      Object.defineProperty(error, "code", {
        enumerable: true,
        value: "ATTACHMENT_API_REQUIRED",
      });
      throw error;
    },
  );
}

export async function callToolWithAttachments(
  call: AttachmentToolCall,
  attachments: AppToolAttachment[] = [],
  options: number | AttachmentCallOptions = {},
): Promise<AttachmentCallResult> {
  return callToolWithAttachmentsBound(call, attachments, options);
}

async function callToolWithAttachmentsBound(
  call: AttachmentToolCall,
  attachments: AppToolAttachment[],
  options: number | AttachmentCallOptions,
  invocation?: MsgBusInvocationMetadata,
): Promise<AttachmentCallResult> {
  if (!call.target || !call.name || !isJsonObject(call.arguments ?? {})) {
    throw new Error("Invalid attachment tool call");
  }
  validateAttachmentsShape(attachments);
  const normalizedOptions =
    typeof options === "number" ? { timeoutSeconds: options } : options;
  assertOptionalDelegationToken(normalizedOptions.delegationToken);
  if (
    normalizedOptions.delegationToken !== undefined &&
    invocation !== undefined
  ) {
    throw protocolError(
      "ATTACHMENT_DELEGATION_INVALID",
      "Attachment calls cannot combine delegation and invocation binding",
    );
  }
  if (normalizedOptions.signal?.aborted) {
    throw abortError(normalizedOptions.signal);
  }
  const port = await waitForPort();
  if (normalizedOptions.signal?.aborted) {
    throw abortError(normalizedOptions.signal);
  }
  const id = nextMessageId();
  const timeout = Math.min(
    Math.max(normalizedOptions.timeoutSeconds ?? 60, 1),
    300,
  );
  const envelope = {
    type: EXEC_TYPE,
    version: 1,
    id,
    ...(normalizedOptions.delegationToken
      ? { delegationToken: normalizedOptions.delegationToken }
      : {}),
    payload: {
      action: "tools.call",
      payload: {
        target: call.target,
        name: call.name,
        arguments: call.arguments ?? {},
      },
      ...(invocation ? { context: { invocation } } : {}),
    },
    attachments,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupPendingCall(id);
      reject(
        protocolError(
          "ATTACHMENT_TIMEOUT",
          `Attachment call timed out after ${timeout} seconds`,
        ),
      );
    }, timeout * 1_000);
    const pending: PendingAppAttachmentCall = {
      resolve,
      reject,
      timer,
      ...(normalizedOptions.onProgress
        ? { onProgress: normalizedOptions.onProgress }
        : {}),
      ...(normalizedOptions.signal
        ? { signal: normalizedOptions.signal }
        : {}),
    };
    pendingCalls.set(id, pending);
    if (normalizedOptions.signal) {
      pending.abortListener = () => {
        const active = pendingCalls.get(id);
        if (!active) return;
        cleanupPendingCall(id);
        reject(abortError(normalizedOptions.signal!));
      };
      normalizedOptions.signal.addEventListener(
        "abort",
        pending.abortListener,
        { once: true },
      );
    }
    try {
      port.postMessage(
        envelope,
        attachments.map((attachment) => attachment.data),
      );
    } catch (error) {
      cleanupPendingCall(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function assertOptionalDelegationToken(
  token: string | undefined,
): void {
  if (token !== undefined && !/^[a-f0-9]{48}$/u.test(token)) {
    throw protocolError(
      "ATTACHMENT_DELEGATION_INVALID",
      "Invalid attachment delegation token",
    );
  }
}

export function installAttachmentWindowListener(): void {
  if (typeof window === "undefined") return;
  if (attachmentListenerWindow === window) return;
  attachmentListenerWindow = window;
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.origin !== expectedKernelParentOrigin() ||
      !isConnectEnvelope(event.data)
    ) return;
    const port = event.ports[0];
    if (!port || installedPorts.has(port)) return;
    if (kernelPort && kernelPort !== port) {
      rejectPendingCalls("Message bus attachment connection was replaced");
      kernelPort.close();
    }
    kernelPort = port;
    installedPorts.add(port);
    port.addEventListener("message", (portEvent) => {
      if (kernelPort !== port) return;
      void handlePortMessage(port, portEvent.data);
    });
    port.start();
    for (const waiter of portWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(port);
    }
    portWaiters.clear();
  });
}

async function handlePortMessage(port: MessagePort, raw: unknown): Promise<void> {
  if (!isRecord(raw)) return;
  if (
    raw.type === "exec" &&
    isRecord(raw.payload) &&
    raw.payload.action === "__neutron_agent_turn_cancel" &&
    isRecord(raw.payload.payload) &&
    typeof raw.payload.payload.rootId === "string"
  ) {
    for (
      const controller of
      incomingInvocationControllers.get(raw.payload.payload.rootId) ?? []
    ) {
      controller.abort(
        protocolError(
          "ATTACHMENT_CANCELLED",
          "Attachment invocation was cancelled",
        ),
      );
    }
    return;
  }
  if (raw.type === RESPONSE_TYPE) {
    handleResponse(raw);
    return;
  }
  if (raw.type === PROGRESS_TYPE) {
    handleProgress(raw);
    return;
  }
  if (raw.type !== EXEC_TYPE) return;
  const possibleId = isMessageId(raw.id) ? raw.id : null;
  try {
    const request = parseRequest(raw);
    const toolCall = request.payload.payload;
    const registration = handlers.get(toolCall.name);
    if (!registration) return;
    validateAttachments(request.attachments, registration.contract.input);
    const invocation = request.payload.context?.invocation;
    const controller = invocation ? new AbortController() : undefined;
    if (invocation && controller) {
      const controllers =
        incomingInvocationControllers.get(invocation.rootId) ?? new Set();
      controllers.add(controller);
      incomingInvocationControllers.set(invocation.rootId, controllers);
    }
    let result: AttachmentToolResult;
    try {
      result = await registration.handler(
        toolCall.arguments,
        request.attachments,
        {
          ...(toolCall.caller ? { caller: toolCall.caller } : {}),
          ...(controller ? { signal: controller.signal } : {}),
          agentMode: invocation !== undefined,
          reportProgress(value) {
            if (!isJsonValue(value)) {
              throw protocolError(
                "ATTACHMENT_PROGRESS_INVALID",
                "Attachment progress must be JSON",
              );
            }
            port.postMessage({
              type: PROGRESS_TYPE,
              version: 1,
              id: request.id,
              value,
            });
          },
          callTool(call, attachments = [], options = {}) {
            return callToolWithAttachmentsBound(
              call,
              attachments,
              {
                ...options,
                ...(controller && options.signal === undefined
                  ? { signal: controller.signal }
                  : {}),
              },
              invocation,
            );
          },
        },
      );
    } finally {
      if (invocation && controller) {
        const controllers = incomingInvocationControllers.get(
          invocation.rootId,
        );
        controllers?.delete(controller);
        if (controllers?.size === 0) {
          incomingInvocationControllers.delete(invocation.rootId);
        }
      }
    }
    if (!isJsonValue(result.value)) {
      throw protocolError("ATTACHMENT_RESULT_INVALID", "Tool returned invalid JSON");
    }
    const output = result.attachments ?? [];
    validateAttachments(output, registration.contract.output);
    postResponse(port, request.id, { ok: result.value, attachments: output });
  } catch (error) {
    if (possibleId === null) return;
    try {
      postResponse(port, possibleId, { error: serializeError(error) });
    } catch {
      // The kernel owns timeout and disconnect cleanup.
    }
  }
}

function handleProgress(raw: Record<string, unknown>): void {
  if (
    raw.version !== 1 ||
    !isMessageId(raw.id) ||
    !isJsonValue(raw.value)
  ) {
    return;
  }
  try {
    pendingCalls.get(raw.id)?.onProgress?.(raw.value);
  } catch {
    // Progress consumers cannot affect the final response.
  }
}

function handleResponse(raw: Record<string, unknown>): void {
  if (
    raw.version !== 1 ||
    !isMessageId(raw.id) ||
    (Object.hasOwn(raw, "ok") === Object.hasOwn(raw, "error"))
  ) {
    return;
  }
  const pending = pendingCalls.get(raw.id);
  if (!pending) return;
  cleanupPendingCall(raw.id);
  if (Object.hasOwn(raw, "error")) {
    pending.reject(errorFromJson(raw.error));
    return;
  }
  const attachments = raw.attachments ?? [];
  try {
    validateAttachmentsShape(attachments);
    if (!isJsonValue(raw.ok)) throw new Error("Attachment response is not JSON");
    pending.resolve({
      value: raw.ok,
      attachments: attachments as AppToolAttachment[],
    });
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

type ParsedRequest = {
  id: number;
  payload: {
    action: typeof LOCAL_TOOL_ACTION;
    payload: {
      name: string;
      arguments: JsonObject;
      caller?: AttachmentToolCaller;
    };
    context?: { invocation?: MsgBusInvocationMetadata };
  };
  attachments: AppToolAttachment[];
};

function parseRequest(raw: Record<string, unknown>): ParsedRequest {
  if (
    raw.version !== 1 ||
    !isMessageId(raw.id) ||
    !isRecord(raw.payload) ||
    raw.payload.action !== LOCAL_TOOL_ACTION ||
    !isRecord(raw.payload.payload) ||
    typeof raw.payload.payload.name !== "string" ||
    !isJsonObject(raw.payload.payload.arguments) ||
    !Array.isArray(raw.attachments)
  ) {
    throw protocolError("ATTACHMENT_ENVELOPE_INVALID", "Invalid attachment request");
  }
  const caller = parseCaller(raw.payload.payload.caller);
  const context = raw.payload.context;
  if (context !== undefined && !isRecord(context)) {
    throw protocolError("ATTACHMENT_ENVELOPE_INVALID", "Invalid invocation context");
  }
  const invocation = isRecord(context) ? context.invocation : undefined;
  if (invocation !== undefined && !isInvocationMetadata(invocation)) {
    throw protocolError("ATTACHMENT_ENVELOPE_INVALID", "Invalid invocation metadata");
  }
  return {
    id: raw.id,
    payload: {
      action: LOCAL_TOOL_ACTION,
      payload: {
        name: raw.payload.payload.name,
        arguments: raw.payload.payload.arguments,
        ...(caller ? { caller } : {}),
      },
      ...(invocation ? { context: { invocation } } : {}),
    },
    attachments: raw.attachments as AppToolAttachment[],
  };
}

function isInvocationMetadata(
  value: unknown,
): value is MsgBusInvocationMetadata {
  return (
    isJsonObject(value) &&
    typeof value.id === "string" &&
    typeof value.rootId === "string" &&
    typeof value.capability === "string" &&
    (value.agentConsent === undefined ||
      typeof value.agentConsent === "boolean")
  );
}

function parseCaller(value: unknown): AttachmentToolCaller | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.endpoint !== "string" ||
    typeof value.appId !== "string" ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length < 16 ||
    value.sessionId.length > 128 ||
    !/^[a-zA-Z0-9_-]+$/u.test(value.sessionId) ||
    (value.role !== "tile" &&
      value.role !== "background" &&
      value.role !== "tray")
  ) {
    throw protocolError("ATTACHMENT_ENVELOPE_INVALID", "Invalid caller metadata");
  }
  return {
    endpoint: value.endpoint,
    appId: value.appId,
    role: value.role,
    sessionId: value.sessionId,
  };
}

function validateContract(contract: AttachmentContract): void {
  if (
    contract.version !== 1 ||
    (!contract.input && !contract.output)
  ) {
    throw new Error("Invalid attachment contract");
  }
  if (contract.input) validateDeclaration(contract.input);
  if (contract.output) validateDeclaration(contract.output);
}

function validateDeclaration(declaration: AttachmentDeclaration): void {
  if (
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(declaration.name) ||
    declaration.mediaTypes.length < 1 ||
    declaration.mediaTypes.length > 16 ||
    declaration.mediaTypes.some((value) => !isAttachmentMediaType(value)) ||
    !Number.isSafeInteger(declaration.maxBytes) ||
    declaration.maxBytes < 1 ||
    declaration.maxBytes > MAX_ATTACHMENT_BYTES ||
    declaration.required !== true
  ) {
    throw new Error("Invalid attachment declaration");
  }
}

function validateAttachments(
  values: unknown[],
  declaration: AttachmentDeclaration | undefined,
): asserts values is AppToolAttachment[] {
  if (values.length > 1) {
    throw protocolError("ATTACHMENT_COUNT", "Only one attachment is allowed");
  }
  if (!declaration) {
    if (values.length !== 0) {
      throw protocolError("ATTACHMENT_UNDECLARED", "Attachment was not declared");
    }
    return;
  }
  if (values.length !== 1) {
    throw protocolError("ATTACHMENT_API_REQUIRED", "Required attachment is missing");
  }
  const attachment = values[0];
  if (
    !isRecord(attachment) ||
    attachment.name !== declaration.name ||
    typeof attachment.mediaType !== "string" ||
    !declaration.mediaTypes.includes(attachment.mediaType.toLowerCase()) ||
    !Number.isSafeInteger(attachment.byteLength) ||
    Number(attachment.byteLength) < 0 ||
    Number(attachment.byteLength) > declaration.maxBytes ||
    !(attachment.data instanceof ArrayBuffer) ||
    attachment.data.byteLength !== attachment.byteLength
  ) {
    throw protocolError("ATTACHMENT_INVALID", "Invalid binary tool attachment");
  }
}

function validateAttachmentsShape(
  values: unknown,
): asserts values is AppToolAttachment[] {
  if (!Array.isArray(values) || values.length > 1) {
    throw protocolError("ATTACHMENT_COUNT", "Only one attachment is allowed");
  }
  for (const attachment of values) {
    if (
      !isRecord(attachment) ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(String(attachment.name)) ||
      typeof attachment.mediaType !== "string" ||
      !isAttachmentMediaType(attachment.mediaType) ||
      !Number.isSafeInteger(attachment.byteLength) ||
      Number(attachment.byteLength) < 0 ||
      Number(attachment.byteLength) > MAX_ATTACHMENT_BYTES ||
      !(attachment.data instanceof ArrayBuffer) ||
      attachment.data.byteLength !== attachment.byteLength
    ) {
      throw protocolError("ATTACHMENT_INVALID", "Invalid binary tool attachment");
    }
  }
}

function postResponse(
  port: MessagePort,
  id: number,
  response:
    | { ok: JsonValue; attachments: AppToolAttachment[] }
    | { error: JsonValue },
): void {
  const attachments = "attachments" in response ? response.attachments : [];
  port.postMessage(
    {
      type: RESPONSE_TYPE,
      version: 1,
      id,
      ...(attachments.length === 0
        ? "ok" in response
          ? { ok: response.ok }
          : { error: response.error }
        : { ok: (response as { ok: JsonValue }).ok, attachments }),
    },
    attachments.map((attachment) => attachment.data),
  );
}

function serializeError(error: unknown): JsonObject {
  const source = error instanceof Error ? error : new Error(String(error));
  const candidate = source as Error & {
    code?: unknown;
    details?: unknown;
  };
  return {
    name: source.name,
    message: source.message,
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(isJsonObject(candidate.details) ? { details: candidate.details } : {}),
  };
}

function protocolError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "AttachmentProtocolError";
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}

function errorFromJson(value: unknown): Error {
  if (!isRecord(value)) return new Error(String(value ?? "Attachment call failed"));
  const error = new Error(
    typeof value.message === "string" ? value.message : "Attachment call failed",
  );
  if (typeof value.name === "string") error.name = value.name;
  for (const key of ["code", "details", "retryAfterMs"] as const) {
    if (value[key] !== undefined) {
      Object.defineProperty(error, key, {
        configurable: true,
        enumerable: true,
        value: value[key],
      });
    }
  }
  return error;
}

function waitForPort(): Promise<MessagePort> {
  if (kernelPort) return Promise.resolve(kernelPort);
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        portWaiters.delete(waiter);
        reject(
          protocolError(
            "ATTACHMENT_UNAVAILABLE",
            "Attachment message bus connection timed out",
          ),
        );
      }, 5_000),
    };
    portWaiters.add(waiter);
  });
}

function rejectPendingCalls(message: string): void {
  for (const [id, pending] of pendingCalls) {
    cleanupPendingCall(id);
    pending.reject(protocolError("ATTACHMENT_DISCONNECTED", message));
  }
}

function cleanupPendingCall(id: number): void {
  const pending = pendingCalls.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener("abort", pending.abortListener);
  }
  pendingCalls.delete(id);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : protocolError("ATTACHMENT_CANCELLED", "Attachment call was cancelled");
}

function nextMessageId(): number {
  nextCallId = nextCallId >= Number.MAX_SAFE_INTEGER ? 1 : nextCallId + 1;
  while (pendingCalls.has(nextCallId)) {
    nextCallId = nextCallId >= Number.MAX_SAFE_INTEGER ? 1 : nextCallId + 1;
  }
  return nextCallId;
}

function isConnectEnvelope(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "neutron:msgbus:connect" &&
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length >= 16
  );
}

function expectedKernelParentOrigin(): string | null {
  try {
    return kernelParentOriginFromAppUrl(window.location.href);
  } catch {
    return null;
  }
}

function isMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isAttachmentMediaType(value: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$/u.test(
    value,
  );
}

installAttachmentWindowListener();
