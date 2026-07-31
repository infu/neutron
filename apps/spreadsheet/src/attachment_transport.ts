import {
  exposeTool,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";

export const ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;

export type AttachmentDeclaration = {
  name: string;
  mediaTypes: string[];
  maxBytes: number;
  required: true;
};

export type AttachmentContract = {
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

export type AttachmentCall = {
  target: MsgBusEndpointId;
  name: string;
  arguments?: JsonObject;
};

export type AttachmentCallResult = {
  value: JsonValue;
  attachments: ToolAttachment[];
};

type Invocation = {
  id: string;
  rootId: string;
  capability: string;
  agentConsent?: boolean;
};

type AttachmentHandlerContext = {
  caller?: { endpoint: string; appId?: string; role?: string };
  reportProgress(value: JsonValue): void;
  callTool(
    call: AttachmentCall,
    attachments?: ToolAttachment[],
    options?: AttachmentCallOptions,
  ): Promise<AttachmentCallResult>;
};

export type AttachmentHandler = (
  args: JsonObject,
  attachments: ToolAttachment[],
  context: AttachmentHandlerContext,
) => Promise<AttachmentCallResult> | AttachmentCallResult;

export type AttachmentCallOptions = {
  timeoutSeconds?: number;
  onProgress?: (value: JsonValue) => void;
  /** One-use token minted by a scoped kernel invocation for the next nested call. */
  delegationToken?: string;
};

export type AttachmentToolOptions = {
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  attachments: AttachmentContract;
};

type AttachmentExecEnvelope = {
  type: "neutron:msgbus:attachment:exec";
  version: 1;
  id: number;
  payload: {
    action: string;
    payload: JsonValue;
    context?: { invocation?: Invocation };
  };
  attachments: ToolAttachment[];
  delegationToken?: string;
};

type AttachmentResponseEnvelope = {
  type: "neutron:msgbus:attachment:response";
  version: 1;
  id: number;
  ok?: JsonValue;
  error?: JsonValue;
  attachments?: ToolAttachment[];
};

type AttachmentProgressEnvelope = {
  type: "neutron:msgbus:attachment:progress";
  version: 1;
  id: number;
  value: JsonValue;
};

type PendingCall = {
  resolve: (result: AttachmentCallResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (value: JsonValue) => void;
};

type RegisteredHandler = {
  contract: AttachmentContract;
  handler: AttachmentHandler;
};

const handlers = new Map<string, RegisteredHandler>();
const pending = new Map<number, PendingCall>();
const waiters = new Set<{
  resolve: (port: MessagePort) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let kernelPort: MessagePort | undefined;
let nextId = 0;

installConnectionCapture();

export function exposeAttachmentTool(
  name: string,
  options: AttachmentToolOptions,
  handler: AttachmentHandler,
): void {
  validateContract(options.attachments);
  handlers.set(name, { contract: options.attachments, handler });
  exposeTool(
    name,
    {
      title: options.title,
      description: options.description,
      inputSchema: options.inputSchema,
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      annotations: {
        ...options.annotations,
        "neutron:attachments": options.attachments as unknown as JsonValue,
      },
    },
    async () => {
      throw transportError(
        "ATTACHMENT_API_REQUIRED",
        `Tool '${name}' requires the binary attachment API`,
      );
    },
  );
}

export async function callToolWithAttachments(
  call: AttachmentCall,
  attachments: ToolAttachment[] = [],
  options: AttachmentCallOptions = {},
): Promise<AttachmentCallResult> {
  return callWithInvocation(call, attachments, options, undefined);
}

async function callWithInvocation(
  call: AttachmentCall,
  attachments: ToolAttachment[],
  options: AttachmentCallOptions,
  invocation: Invocation | undefined,
): Promise<AttachmentCallResult> {
  validateCall(call);
  validateAttachmentList(attachments);
  if (
    options.delegationToken !== undefined &&
    (typeof options.delegationToken !== "string" ||
      options.delegationToken.length < 1 ||
      options.delegationToken.length > 2_048)
  ) {
    throw transportError("ATTACHMENT_DELEGATION_INVALID", "Invalid attachment delegation token");
  }
  const port = await waitForPort();
  const id = ++nextId;
  const timeoutSeconds = Math.min(
    Math.max(options.timeoutSeconds ?? 60, 1),
    300,
  );
  const envelope: AttachmentExecEnvelope = {
    type: "neutron:msgbus:attachment:exec",
    version: 1,
    id,
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
    ...(options.delegationToken ? { delegationToken: options.delegationToken } : {}),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        transportError(
          "ATTACHMENT_TIMEOUT",
          `Attachment call timed out after ${timeoutSeconds} seconds`,
        ),
      );
    }, timeoutSeconds * 1_000);
    pending.set(id, {
      resolve,
      reject,
      timer,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    try {
      port.postMessage(
        envelope,
        attachments.map((attachment) => attachment.data),
      );
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(toError(error));
    }
  });
}

function installConnectionCapture(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent || !isConnectEnvelope(event.data)) return;
    const port = event.ports[0];
    if (!port) return;
    if (kernelPort && kernelPort !== port) {
      rejectPending("Message bus attachment connection was replaced");
    }
    kernelPort = port;
    port.addEventListener("message", handlePortMessage);
    port.start();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(port);
    }
    waiters.clear();
  });
}

function handlePortMessage(event: MessageEvent): void {
  const value = event.data;
  if (isAttachmentResponse(value)) {
    const callback = pending.get(value.id);
    if (!callback) return;
    clearTimeout(callback.timer);
    pending.delete(value.id);
    if (Object.hasOwn(value, "error")) {
      callback.reject(errorFromJson(value.error));
      return;
    }
    const attachments = value.attachments ?? [];
    try {
      validateAttachmentList(attachments);
      callback.resolve({ value: value.ok ?? null, attachments });
    } catch (error) {
      callback.reject(toError(error));
    }
    return;
  }
  if (isAttachmentProgress(value)) {
    pending.get(value.id)?.onProgress?.(value.value);
    return;
  }
  if (isAttachmentExec(value)) {
    void handleIncomingCall(value);
  }
}

async function handleIncomingCall(request: AttachmentExecEnvelope): Promise<void> {
  const port = kernelPort;
  if (!port) return;
  const response = (
    value: AttachmentResponseEnvelope,
    attachments: ToolAttachment[] = [],
  ): void => {
    port.postMessage(
      value,
      attachments.map((attachment) => attachment.data),
    );
  };
  try {
    if (
      request.payload.action !== "__neutron_msgbus_tools_call" ||
      !isObject(request.payload.payload)
    ) {
      throw transportError(
        "ATTACHMENT_ENVELOPE_INVALID",
        "Invalid forwarded attachment action",
      );
    }
    const payload = request.payload.payload;
    const name = stringField(payload, "name");
    const registered = handlers.get(name);
    if (!registered) {
      throw transportError("TOOL_NOT_FOUND", `Unknown tool '${name}'`);
    }
    const args =
      payload.arguments === undefined
        ? {}
        : requireObject(payload.arguments, "arguments");
    validateAttachmentsAgainstContract(
      request.attachments,
      registered.contract.input,
      "input",
    );
    const caller = isObject(payload.caller)
      ? {
          endpoint: stringField(payload.caller, "endpoint"),
          ...(typeof payload.caller.appId === "string"
            ? { appId: payload.caller.appId }
            : {}),
          ...(typeof payload.caller.role === "string"
            ? { role: payload.caller.role }
            : {}),
        }
      : undefined;
    const invocation = request.payload.context?.invocation;
    const result = await registered.handler(args, request.attachments, {
      ...(caller ? { caller } : {}),
      reportProgress(value) {
        assertJson(value);
        port.postMessage({
          type: "neutron:msgbus:attachment:progress",
          version: 1,
          id: request.id,
          value,
        } satisfies AttachmentProgressEnvelope);
      },
      callTool(call, attachments = [], options = {}) {
        return callWithInvocation(call, attachments, options, invocation);
      },
    });
    assertJson(result.value);
    validateAttachmentsAgainstContract(
      result.attachments,
      registered.contract.output,
      "output",
    );
    response(
      {
        type: "neutron:msgbus:attachment:response",
        version: 1,
        id: request.id,
        ok: result.value,
        ...(result.attachments.length > 0
          ? { attachments: result.attachments }
          : {}),
      },
      result.attachments,
    );
  } catch (error) {
    response({
      type: "neutron:msgbus:attachment:response",
      version: 1,
      id: request.id,
      error: serializeError(error),
    });
  }
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
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(declaration.name) ||
    declaration.required !== true ||
    declaration.mediaTypes.length === 0 ||
    declaration.mediaTypes.some((value) => !isMediaType(value)) ||
    !Number.isSafeInteger(declaration.maxBytes) ||
    declaration.maxBytes < 1 ||
    declaration.maxBytes > ATTACHMENT_MAX_BYTES
  ) {
    throw new Error("Invalid attachment declaration");
  }
}

function validateAttachmentsAgainstContract(
  attachments: ToolAttachment[],
  declaration: AttachmentDeclaration | undefined,
  direction: "input" | "output",
): void {
  validateAttachmentList(attachments);
  if (!declaration) {
    if (attachments.length > 0) {
      throw transportError(
        "ATTACHMENT_UNDECLARED",
        `Tool does not declare an ${direction} attachment`,
      );
    }
    return;
  }
  const attachment = attachments[0];
  if (!attachment) {
    throw transportError(
      "ATTACHMENT_API_REQUIRED",
      `Tool requires ${direction} attachment '${declaration.name}'`,
    );
  }
  if (
    attachment.name !== declaration.name ||
    !declaration.mediaTypes
      .map(normalizeMediaType)
      .includes(normalizeMediaType(attachment.mediaType)) ||
    attachment.byteLength > declaration.maxBytes
  ) {
    throw transportError(
      "ATTACHMENT_INVALID",
      `Invalid ${direction} attachment '${attachment.name}'`,
    );
  }
}

function validateAttachmentList(value: unknown): asserts value is ToolAttachment[] {
  if (!Array.isArray(value) || value.length > 1) {
    throw transportError(
      "ATTACHMENT_INVALID",
      "At most one attachment is allowed",
    );
  }
  for (const attachment of value) {
    if (
      !isObject(attachment) ||
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(String(attachment.name)) ||
      !isMediaType(attachment.mediaType) ||
      !Number.isSafeInteger(attachment.byteLength) ||
      Number(attachment.byteLength) < 0 ||
      Number(attachment.byteLength) > ATTACHMENT_MAX_BYTES ||
      !(attachment.data instanceof ArrayBuffer) ||
      attachment.data.byteLength !== attachment.byteLength
    ) {
      throw transportError("ATTACHMENT_INVALID", "Invalid attachment");
    }
  }
}

function validateCall(call: AttachmentCall): void {
  if (
    !call.target ||
    !call.name ||
    (call.arguments !== undefined && !isObject(call.arguments))
  ) {
    throw new Error("Invalid attachment tool call");
  }
  assertJson(call.arguments ?? {});
}

function waitForPort(): Promise<MessagePort> {
  if (kernelPort) return Promise.resolve(kernelPort);
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(
          transportError(
            "ATTACHMENT_UNAVAILABLE",
            "Attachment message bus connection timed out",
          ),
        );
      }, 5_000),
    };
    waiters.add(waiter);
  });
}

function rejectPending(message: string): void {
  for (const [id, callback] of pending) {
    clearTimeout(callback.timer);
    callback.reject(transportError("ATTACHMENT_DISCONNECTED", message));
    pending.delete(id);
  }
}

function isConnectEnvelope(value: unknown): boolean {
  return (
    isObject(value) &&
    value.type === "neutron:msgbus:connect" &&
    value.version === 1 &&
    typeof value.sessionId === "string"
  );
}

function isAttachmentExec(value: unknown): value is AttachmentExecEnvelope {
  return (
    isObject(value) &&
    value.type === "neutron:msgbus:attachment:exec" &&
    value.version === 1 &&
    Number.isSafeInteger(value.id) &&
    isObject(value.payload) &&
    Array.isArray(value.attachments)
  );
}

function isAttachmentResponse(
  value: unknown,
): value is AttachmentResponseEnvelope {
  return (
    isObject(value) &&
    value.type === "neutron:msgbus:attachment:response" &&
    value.version === 1 &&
    Number.isSafeInteger(value.id) &&
    (Object.hasOwn(value, "ok") !== Object.hasOwn(value, "error"))
  );
}

function isAttachmentProgress(
  value: unknown,
): value is AttachmentProgressEnvelope {
  return (
    isObject(value) &&
    value.type === "neutron:msgbus:attachment:progress" &&
    value.version === 1 &&
    Number.isSafeInteger(value.id) &&
    isJson(value.value)
  );
}

function assertJson(value: unknown): asserts value is JsonValue {
  if (!isJson(value)) throw new Error("Value must be JSON-compatible");
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > 1024 * 1024) throw new Error("JSON payload exceeds 1 MiB");
}

function isJson(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((entry) => isJson(entry, seen));
    seen.delete(value);
    return valid;
  }
  if (!isObject(value)) return false;
  const valid = Object.values(value).every((entry) => isJson(entry, seen));
  seen.delete(value);
  return valid;
}

function serializeError(error: unknown): JsonValue {
  if (!(error instanceof Error)) return String(error);
  const record = error as Error & {
    code?: unknown;
    details?: unknown;
    retryAfterMs?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(isJson(record.details) ? { details: record.details } : {}),
    ...(typeof record.retryAfterMs === "number" &&
    Number.isFinite(record.retryAfterMs)
      ? { retryAfterMs: record.retryAfterMs }
      : {}),
  };
}

function errorFromJson(value: JsonValue | undefined): Error {
  if (!isObject(value)) return new Error(String(value ?? "Attachment call failed"));
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

function transportError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "AttachmentTransportError";
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: code,
  });
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  assertJson(value);
  return value as JsonObject;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return field;
}

function normalizeMediaType(value: string): string {
  return value.trim().toLowerCase();
}

function isMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9!#$&^_.+;= -]+)?$/iu.test(
      value.trim(),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
