import { validate as validateJsonSchema, type Schema } from "jsonschema";
import {
  MSG_BUS_MAX_PROGRESS_EVENTS,
  assertBoundedJson,
  assertMsgBusActionName,
  isProgressEnvelope,
  isResponseEnvelope,
  toError,
  type ExecEnvelope,
  type JsonValue,
  type MsgBusCallOptions,
  type MsgBusInvocationMetadata,
} from "./protocol.ts";

export * from "./protocol.ts";

export type ExposedActionContext = {
  source: MessageEventSource;
  origin: string;
  reportProgress?: (value: JsonValue) => void;
  invocation?: MsgBusInvocationMetadata;
  signal?: AbortSignal;
};

export type ExposedAction<
  TPayload extends JsonValue = JsonValue,
  TResult extends JsonValue = JsonValue,
> = (
  payload: TPayload,
  context: ExposedActionContext,
) => TResult | Promise<TResult>;

export type ExposedActionOptions = {
  schema?: Schema;
};

type RegisteredAction = {
  action: ExposedAction;
  schema?: Schema;
};

type PortCallback = {
  resolve: (value: JsonValue) => void;
  reject: (reason?: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  port: MessagePort;
  onProgress?: (value: JsonValue) => void;
  progressCount: number;
  cleanup?: () => void;
};

const actions = new Map<string, RegisteredAction>();
const callbacks = new Map<number, PortCallback>();
const installedPorts = new WeakSet<MessagePort>();
let nextId = 0;

export function expose<TPayload extends JsonValue = JsonValue>(
  name: string,
  action: ExposedAction<TPayload>,
  options: ExposedActionOptions = {},
): void {
  if (!name) throw new Error("Action name is required");
  if (typeof action !== "function") throw new Error("Action must be a function");
  const registered: RegisteredAction = {
    action: action as ExposedAction,
  };
  if (options.schema) registered.schema = options.schema;
  actions.set(name, registered);
}

export function executeExposedAction(
  action: string,
  payload: JsonValue,
  context: ExposedActionContext,
): Promise<JsonValue> | JsonValue {
  const registered = actions.get(action);
  if (!registered) throw new Error(`Unknown action '${action}'`);
  if (registered.schema) {
    const result = validateJsonSchema(payload, registered.schema);
    if (!result.valid) {
      throw new Error(
        `Invalid payload for action '${action}': ${result.errors
          .map((error) => error.stack)
          .join("; ")}`,
      );
    }
  }
  return registered.action(payload, context);
}

export function execPort<T extends JsonValue = JsonValue>(
  port: MessagePort,
  action: string,
  payload: JsonValue = null,
  options: number | MsgBusCallOptions = 0,
): Promise<T> {
  assertMsgBusActionName(action);
  assertBoundedJson(payload);
  installPortListener(port);

  const normalizedOptions =
    typeof options === "number" ? { timeout: options } : options;
  const timeout = normalizedOptions.timeout ?? 0;
  const id = ++nextId;
  const context = normalizedOptions.transportContext;
  const signal = normalizedOptions.signal;
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let posted = false;
    const finish = (error: Error, cancel: boolean): void => {
      if (settled) return;
      settled = true;
      const callback = callbacks.get(id);
      if (callback?.port === port) callbacks.delete(id);
      if (callback?.timeout) clearTimeout(callback.timeout);
      callback?.cleanup?.();
      if (cancel && posted) postRequestCancellation(port, id);
      reject(error);
    };
    const abort = (): void => {
      if (signal) finish(abortReason(signal), true);
    };
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timeoutCallback = timeout
      ? setTimeout(() => {
          finish(new Error(`Timeout after ${timeout} seconds`), true);
        }, timeout * 1_000)
      : undefined;

    callbacks.set(id, {
      resolve: resolve as (value: JsonValue) => void,
      reject,
      port,
      ...(normalizedOptions.onProgress
        ? { onProgress: normalizedOptions.onProgress }
        : {}),
      progressCount: 0,
      cleanup,
      ...(timeoutCallback ? { timeout: timeoutCallback } : {}),
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (settled) return;

    try {
      port.postMessage({
        type: "exec",
        id,
        payload: {
          action,
          payload,
          ...(context ? { context } : {}),
        },
      } satisfies ExecEnvelope);
      posted = true;
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error(String(error)),
        false,
      );
    }
  });
}

/**
 * Cancel and reject every Kernel request bound to one retired app port.
 * The caller remains responsible for closing the port after this returns.
 */
export function retireExecPort(
  port: MessagePort,
  reason: Error = new Error("Message bus endpoint retired"),
): void {
  for (const [id, callback] of callbacks) {
    if (callback.port !== port) continue;
    callbacks.delete(id);
    if (callback.timeout) clearTimeout(callback.timeout);
    callback.cleanup?.();
    postRequestCancellation(port, id);
    callback.reject(reason);
  }
}

function postRequestCancellation(port: MessagePort, id: number): void {
  try {
    port.postMessage({
      type: "neutron:msgbus:cancel",
      version: 1,
      id,
    });
  } catch {
    // Local settlement remains authoritative after peer disconnection.
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Message-bus request cancelled"), {
        name: "AbortError",
      });
}

function installPortListener(port: MessagePort): void {
  if (installedPorts.has(port)) return;
  port.addEventListener("message", (event) => {
    handlePortMessage(event, port);
  });
  port.start();
  installedPorts.add(port);
}

function handlePortMessage(event: MessageEvent, port: MessagePort): void {
  if (isProgressEnvelope(event.data)) {
    const callback = callbacks.get(event.data.id);
    if (
      !callback ||
      callback.port !== port ||
      !callback.onProgress ||
      callback.progressCount >= MSG_BUS_MAX_PROGRESS_EVENTS
    ) {
      return;
    }
    callback.progressCount += 1;
    try {
      callback.onProgress(event.data.value);
    } catch {
      // A consumer callback cannot change final request completion.
    }
    return;
  }

  if (!isResponseEnvelope(event.data)) return;
  const callback = callbacks.get(event.data.id);
  if (!callback || callback.port !== port) return;
  if (callback.timeout) clearTimeout(callback.timeout);
  callbacks.delete(event.data.id);
  callback.cleanup?.();
  if (Object.hasOwn(event.data, "error")) {
    callback.reject(toError(event.data.error));
  } else {
    callback.resolve(event.data.ok ?? null);
  }
}
