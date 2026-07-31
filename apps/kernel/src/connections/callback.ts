import {
  CONNECTION_CALLBACK_CHANNEL,
  completeConnectionCallback,
  failConnectionCallback,
} from "../reducer/connections.ts";

type CallbackMessage = {
  type: "neutron:connection:callback";
  flow: string;
  code?: string;
  error?: string;
};

type CallbackResult = {
  type: "neutron:connection:result";
  flow: string;
  ok: boolean;
  error?: string;
};

const channel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(CONNECTION_CALLBACK_CHANNEL);
const handledFlows = new Set<string>();

channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = parseCallbackMessage(event.data);
  if (!message) return;
  void handleCallback(message);
});

async function handleCallback(message: CallbackMessage): Promise<void> {
  if (handledFlows.has(message.flow)) return;
  handledFlows.add(message.flow);
  if (handledFlows.size > 128) {
    const oldest = handledFlows.values().next().value;
    if (typeof oldest === "string") handledFlows.delete(oldest);
  }
  if (message.error) {
    failConnectionCallback(message.flow, new Error("Authorization was denied."));
    postResult({
      type: "neutron:connection:result",
      flow: message.flow,
      ok: false,
      error: "Authorization was denied.",
    });
    return;
  }
  if (!message.code) return;

  try {
    await completeConnectionCallback(message.flow, message.code);
    postResult({
      type: "neutron:connection:result",
      flow: message.flow,
      ok: true,
    });
  } catch (error) {
    const text = safeError(error);
    failConnectionCallback(message.flow, new Error(text));
    postResult({
      type: "neutron:connection:result",
      flow: message.flow,
      ok: false,
      error: text,
    });
  }
}

function postResult(result: CallbackResult): void {
  channel?.postMessage(result);
}

function parseCallbackMessage(value: unknown): CallbackMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.type !== "neutron:connection:callback" ||
    typeof record.flow !== "string" ||
    record.flow.length < 16 ||
    record.flow.length > 256
  ) {
    return null;
  }
  const code =
    typeof record.code === "string" && record.code.length <= 4096
      ? record.code
      : undefined;
  const error =
    typeof record.error === "string" && record.error.length <= 256
      ? record.error
      : undefined;
  if (!code && !error) return null;
  return {
    type: "neutron:connection:callback",
    flow: record.flow,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 256) || "Connection failed";
}
