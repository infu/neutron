import packagedWorkerSource from "./packaged_source.ts";
import {
  WAGYU_VERIFICATION_WORKER_NAME,
  WAGYU_VERIFICATION_WORKER_PROTOCOL,
  type WagyuWorkerLikeV1,
  type WagyuWorkerResponseV1,
} from "./types.ts";

const BOOTSTRAP_CHANNEL_BYTES = 32;
const MAX_PACKAGED_WORKER_SOURCE_BYTES = 8 * 1_024 * 1_024;

type QueuedMessage = {
  readonly message: unknown;
  readonly transfer: readonly Transferable[];
};

/**
 * Create the verifier from build-embedded, package-owned bytes.
 *
 * The HTTP URL of the app is deliberately never passed to Worker(). This is
 * required for Neutron's sandboxed app frames, whose origin is intentionally
 * opaque. The only global Worker message is a one-shot transfer of a private
 * MessagePort; all trust configuration and verifier work then stays on that
 * port.
 */
export function createPackagedWagyuVerificationWorker(): WagyuWorkerLikeV1 {
  requireBrowserWorkerPrimitives();
  const sourceBytes = new TextEncoder().encode(packagedWorkerSource);
  if (
    sourceBytes.byteLength < 1 ||
    sourceBytes.byteLength > MAX_PACKAGED_WORKER_SOURCE_BYTES
  ) {
    throw new Error(
      "Packaged Wagyu verification Worker source is unavailable or oversized",
    );
  }

  const channelId = secureChannelId();
  const channel = new MessageChannel();
  const workerBlob = new Blob([sourceBytes], {
    type: "text/javascript;charset=utf-8",
  });
  const workerUrl = URL.createObjectURL(workerBlob);
  let nativeWorker: Worker;
  try {
    nativeWorker = new Worker(workerUrl, {
      name: WAGYU_VERIFICATION_WORKER_NAME,
    });
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    throw error;
  } finally {
    URL.revokeObjectURL(workerUrl);
  }

  const clientListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  const queued: QueuedMessage[] = [];
  const inFlight = new Set<string>();
  let connected = false;
  let closed = false;

  const emit = (data: unknown): void => {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of clientListeners) listener(event);
  };

  const fail = (reason: string): void => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    channel.port1.close();
    channel.port2.close();
    nativeWorker.terminate();
    for (const requestId of inFlight) {
      emit(workerUnavailableResponse(requestId, reason));
    }
    inFlight.clear();
  };

  const flush = (): void => {
    for (const item of queued.splice(0)) {
      channel.port1.postMessage(item.message, [...item.transfer]);
    }
  };

  channel.port1.addEventListener("message", (event) => {
    if (closed) return;
    if (!connected) {
      if (!isConnectedMessage(event.data, channelId)) {
        fail("Verification Worker private-channel handshake failed");
        return;
      }
      connected = true;
      try {
        flush();
      } catch {
        fail("Verification Worker private channel could not be opened");
      }
      return;
    }
    const responseId = workerResponseId(event.data);
    if (responseId !== null) inFlight.delete(responseId);
    emit(event.data);
  });
  channel.port1.addEventListener("messageerror", () => {
    fail("Verification Worker returned an unreadable private-channel message");
  });
  channel.port1.start();

  nativeWorker.addEventListener("error", (event) => {
    event.preventDefault();
    fail("Packaged verification Worker failed to start or execute");
  });

  try {
    nativeWorker.postMessage(
      {
        protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
        type: "connect",
        channelId,
      },
      [channel.port2],
    );
  } catch (error) {
    fail("Packaged verification Worker private channel could not be created");
    throw error;
  }

  return {
    postMessage(message, transfer = []) {
      if (closed) {
        throw new Error("Packaged verification Worker is closed");
      }
      trackWorkerRequest(inFlight, message);
      if (connected) {
        channel.port1.postMessage(message, [...transfer]);
      } else {
        queued.push({ message, transfer: [...transfer] });
      }
    },
    addEventListener(_type, listener) {
      clientListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      clientListeners.delete(listener);
    },
    terminate() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      inFlight.clear();
      clientListeners.clear();
      channel.port1.close();
      channel.port2.close();
      nativeWorker.terminate();
    },
  };
}

function requireBrowserWorkerPrimitives(): void {
  if (
    typeof globalThis.Worker !== "function" ||
    typeof globalThis.MessageChannel !== "function" ||
    typeof globalThis.Blob !== "function" ||
    typeof globalThis.URL?.createObjectURL !== "function" ||
    typeof globalThis.URL?.revokeObjectURL !== "function"
  ) {
    throw new Error("Browser Worker isolation support is unavailable");
  }
}

function secureChannelId(): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure Worker channel randomness is unavailable");
  }
  const bytes = new Uint8Array(BOOTSTRAP_CHANNEL_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isConnectedMessage(value: unknown, channelId: string): boolean {
  return (
    isRecord(value) &&
    value.protocol === WAGYU_VERIFICATION_WORKER_PROTOCOL &&
    value.type === "connected" &&
    value.channelId === channelId
  );
}

function trackWorkerRequest(
  inFlight: Set<string>,
  value: unknown,
): void {
  if (
    !isRecord(value) ||
    value.protocol !== WAGYU_VERIFICATION_WORKER_PROTOCOL ||
    typeof value.requestId !== "string"
  ) {
    return;
  }
  if (value.type === "cancel") {
    inFlight.delete(value.requestId);
  } else if (value.type === "init" || value.type === "task") {
    inFlight.add(value.requestId);
  }
}

function workerResponseId(value: unknown): string | null {
  if (
    !isRecord(value) ||
    value.protocol !== WAGYU_VERIFICATION_WORKER_PROTOCOL ||
    value.type !== "response" ||
    typeof value.requestId !== "string"
  ) {
    return null;
  }
  return value.requestId;
}

function workerUnavailableResponse(
  requestId: string,
  reason: string,
): WagyuWorkerResponseV1 {
  return {
    protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
    type: "response",
    requestId,
    result: {
      state: "unavailable",
      code: "worker_bootstrap_failed",
      reason,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
