import type {
  ChatRuntimeMethod,
  ChatRuntimeRequest,
  ChatSnapshot,
  ChatWorkerOutbound,
} from "./chat_types.ts";
import { GemmaChatRuntime } from "./gemma_runtime.ts";

export type RuntimeBridge = {
  status(): ChatSnapshot;
  call(
    method: ChatRuntimeMethod,
    arguments_?: { text?: string }
  ): Promise<ChatSnapshot>;
  isAvailable(): boolean;
};

export class RuntimeBridgeManager {
  private bridgePromise: Promise<RuntimeBridge> | null = null;
  private bridge: RuntimeBridge | null = null;

  constructor(private readonly createBridge: () => Promise<RuntimeBridge>) {}

  async status(): Promise<ChatSnapshot> {
    return (await this.getBridge()).status();
  }

  async call(
    method: ChatRuntimeMethod,
    arguments_?: { text?: string }
  ): Promise<ChatSnapshot> {
    let bridge = await this.getBridge();
    if (!bridge.isAvailable()) {
      this.replaceBridge(bridge);
      bridge = await this.getBridge();
    }
    return bridge.call(method, arguments_);
  }

  private getBridge(): Promise<RuntimeBridge> {
    if (this.bridgePromise) return this.bridgePromise;

    const bridgePromise = this.createBridge();
    this.bridgePromise = bridgePromise;
    void bridgePromise.then(
      (bridge) => {
        if (this.bridgePromise === bridgePromise) this.bridge = bridge;
      },
      () => {
        if (this.bridgePromise === bridgePromise) {
          this.bridgePromise = null;
          this.bridge = null;
        }
      }
    );
    return bridgePromise;
  }

  private replaceBridge(bridge: RuntimeBridge): void {
    if (this.bridge !== bridge) return;
    this.bridge = null;
    this.bridgePromise = null;
  }
}

export async function createRuntimeBridge(): Promise<RuntimeBridge> {
  if (typeof Worker !== "undefined") {
    try {
      return await createWorkerBridge(
        new Worker("./model-worker.js", { type: "module" })
      );
    } catch {
      // The resident frame remains the model owner when worker WebGPU is absent.
    }
  }
  return createLocalBridge();
}

export function createLocalBridge(): RuntimeBridge {
  let snapshot: ChatSnapshot;
  const runtime = new GemmaChatRuntime((next) => {
    snapshot = next;
  });
  snapshot = runtime.snapshot();
  return {
    status: () => snapshot,
    isAvailable: () => true,
    async call(method, arguments_) {
      switch (method) {
        case "status":
          return runtime.snapshot();
        case "load":
          return runtime.load();
        case "generate":
          return runtime.generate(arguments_?.text ?? "");
        case "stop":
          return runtime.stop();
        case "reset":
          return runtime.reset();
      }
    },
  };
}

export function createWorkerBridge(
  worker: Worker,
  startupTimeoutMs = 3000
): Promise<RuntimeBridge> {
  return new Promise((resolve, reject) => {
    const callbacks = new Map<
      number,
      { resolve: (snapshot: ChatSnapshot) => void; reject: (error: Error) => void }
    >();
    let nextId = 0;
    let snapshot: ChatSnapshot | null = null;
    let failure: Error | null = null;
    let startupSettled = false;
    const timer = setTimeout(
      () => fail(new Error("Model worker startup timed out")),
      startupTimeoutMs
    );

    function fail(error: Error): void {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      worker.terminate();

      if (!startupSettled) {
        startupSettled = true;
        reject(error);
      } else if (snapshot) {
        snapshot = {
          ...snapshot,
          stage: "error",
          statusText: error.message,
          modelLoaded: false,
          loadProgress: null,
        };
      }

      for (const callback of callbacks.values()) callback.reject(error);
      callbacks.clear();
    }

    worker.addEventListener("error", (event) => {
      const message =
        typeof ErrorEvent !== "undefined" &&
        event instanceof ErrorEvent &&
        event.message
          ? `Model worker failed to load: ${event.message}`
          : "Model worker failed to load";
      fail(new Error(message));
    });
    worker.addEventListener("messageerror", () => {
      fail(new Error("Model worker returned an unreadable response"));
    });
    worker.addEventListener("message", (event: MessageEvent<ChatWorkerOutbound>) => {
      if (failure) return;
      try {
        const response = event.data;
        if (response.type === "ready") {
          snapshot = response.snapshot;
          if (!snapshot.webGpuAvailable) {
            fail(new Error("Model worker does not expose WebGPU"));
            return;
          }
          if (!startupSettled) {
            startupSettled = true;
            clearTimeout(timer);
            const bridge: RuntimeBridge = {
              status() {
                if (!snapshot) throw new Error("Model worker has no status");
                return snapshot;
              },
              isAvailable() {
                return failure === null;
              },
              call(method, arguments_) {
                if (failure) return Promise.reject(failure);
                const id = ++nextId;
                const request: ChatRuntimeRequest = {
                  id,
                  method,
                  ...(arguments_ ? { arguments: arguments_ } : {}),
                };
                return new Promise<ChatSnapshot>((resolveCall, rejectCall) => {
                  callbacks.set(id, { resolve: resolveCall, reject: rejectCall });
                  try {
                    worker.postMessage(request);
                  } catch (error) {
                    fail(asError(error, "Model worker request failed"));
                  }
                });
              },
            };
            resolve(bridge);
          }
          return;
        }
        if (response.type === "status") {
          snapshot = response.snapshot;
          return;
        }
        const callback = callbacks.get(response.id);
        if (!callback) return;
        callbacks.delete(response.id);
        if ("error" in response) callback.reject(new Error(response.error));
        else {
          snapshot = response.ok;
          callback.resolve(response.ok);
        }
      } catch (error) {
        fail(asError(error, "Model worker response failed"));
      }
    });
  });
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
