import { validate as validateJsonSchema, type Schema } from "jsonschema";
import {
  MSG_BUS_MAX_PROGRESS_BYTES,
  MSG_BUS_MAX_PROGRESS_EVENTS,
  assertBoundedJson,
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
  if (!action) throw new Error("Action is required");
  assertBoundedJson(payload);
  installPortListener(port);

  const normalizedOptions =
    typeof options === "number" ? { timeout: options } : options;
  const timeout = normalizedOptions.timeout ?? 0;
  const id = ++nextId;
  const context = normalizedOptions.transportContext;

  return new Promise<T>((resolve, reject) => {
    const timeoutCallback = timeout
      ? setTimeout(() => {
          callbacks.delete(id);
          reject(new Error(`Timeout after ${timeout} seconds`));
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
      ...(timeoutCallback ? { timeout: timeoutCallback } : {}),
    });

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
    } catch (error) {
      if (timeoutCallback) clearTimeout(timeoutCallback);
      callbacks.delete(id);
      reject(error);
    }
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
    try {
      assertBoundedJson(
        event.data.value,
        "Progress payload",
        MSG_BUS_MAX_PROGRESS_BYTES,
      );
    } catch {
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
  if (Object.hasOwn(event.data, "error")) {
    callback.reject(toError(event.data.error));
  } else {
    callback.resolve(event.data.ok ?? null);
  }
}
