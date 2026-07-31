import { getNeutronId } from "./config.ts";

export type RuntimeAuthoritySignal = Readonly<{
  version: 1;
  canisterId: string;
  deploymentId: string;
  phase: "pending" | "committed";
  kernelUpdated: boolean;
  sentAt: number;
  nonce: string;
}>;

type SignalListener = (signal: RuntimeAuthoritySignal) => void;

const SIGNAL_VERSION = 1;
const SIGNAL_PREFIX = "neutron:runtime-authority:v1";
const DEPLOYMENT_ID = /^[a-zA-Z0-9_-]{4,96}$/u;
const NONCE = /^[a-f0-9]{16,64}$/u;

export function announceRuntimeAuthorityChange(input: {
  deploymentId: string;
  phase: "pending" | "committed";
  kernelUpdated?: boolean;
}): void {
  const canisterId = currentNeutronId();
  const signal: RuntimeAuthoritySignal = Object.freeze({
    version: SIGNAL_VERSION,
    canisterId,
    deploymentId: input.deploymentId,
    phase: input.phase,
    kernelUpdated: input.kernelUpdated ?? false,
    sentAt: Date.now(),
    nonce: signalNonce(),
  });
  const encoded = JSON.stringify(signal);
  const channelName = signalChannelName(canisterId);

  if (typeof BroadcastChannel === "function") {
    try {
      const channel = new BroadcastChannel(channelName);
      channel.postMessage(signal);
      channel.close();
    } catch {
      // Storage below remains the broadly supported same-origin fallback.
    }
  }
  try {
    localStorage.setItem(channelName, encoded);
    localStorage.removeItem(channelName);
  } catch {
    // Private browsing and embedded contexts can deny storage. The periodic
    // runtime observation remains the cross-device and final fallback.
  }
}

export function subscribeRuntimeAuthorityChanges(
  listener: SignalListener,
): () => void {
  const canisterId = currentNeutronId();
  const channelName = signalChannelName(canisterId);
  let channel: BroadcastChannel | null = null;

  if (typeof BroadcastChannel === "function") {
    try {
      channel = new BroadcastChannel(channelName);
      channel.addEventListener("message", (event) => {
        const signal = parseRuntimeAuthoritySignal(event.data, canisterId);
        if (signal) listener(signal);
      });
    } catch {
      channel = null;
    }
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== channelName || event.newValue === null) return;
    let value: unknown;
    try {
      value = JSON.parse(event.newValue);
    } catch {
      return;
    }
    const signal = parseRuntimeAuthoritySignal(value, canisterId);
    if (signal) listener(signal);
  };
  globalThis.addEventListener?.("storage", onStorage);

  return () => {
    channel?.close();
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function parseRuntimeAuthoritySignal(
  value: unknown,
  expectedCanisterId: string,
): RuntimeAuthoritySignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !==
    [
      "canisterId",
      "deploymentId",
      "kernelUpdated",
      "nonce",
      "phase",
      "sentAt",
      "version",
    ].join("\0") ||
    record.version !== SIGNAL_VERSION ||
    record.canisterId !== expectedCanisterId ||
    typeof record.deploymentId !== "string" ||
    !DEPLOYMENT_ID.test(record.deploymentId) ||
    (record.phase !== "pending" && record.phase !== "committed") ||
    typeof record.kernelUpdated !== "boolean" ||
    typeof record.sentAt !== "number" ||
    !Number.isSafeInteger(record.sentAt) ||
    record.sentAt < 0 ||
    typeof record.nonce !== "string" ||
    !NONCE.test(record.nonce)
  ) {
    return null;
  }
  return Object.freeze({
    version: SIGNAL_VERSION,
    canisterId: expectedCanisterId,
    deploymentId: record.deploymentId,
    phase: record.phase,
    kernelUpdated: record.kernelUpdated,
    sentAt: record.sentAt,
    nonce: record.nonce,
  });
}

function signalChannelName(canisterId: string): string {
  return `${SIGNAL_PREFIX}:${canisterId}`;
}

function currentNeutronId(): string {
  return getNeutronId();
}

function signalNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16).padStart(12, "0")}${Math.floor(
    Math.random() * 0x1_0000_0000,
  )
    .toString(16)
    .padStart(8, "0")}`;
}
