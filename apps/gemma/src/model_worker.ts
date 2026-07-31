import type {
  ChatRuntimeRequest,
  ChatSnapshot,
  ChatWorkerInbound,
  ChatWorkerOutbound,
} from "./chat_types.ts";
import { GemmaChatRuntime } from "./gemma_runtime.ts";

const workerScope = globalThis as unknown as {
  postMessage(message: ChatWorkerOutbound): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ChatWorkerInbound>) => void
  ): void;
};

const runtime = new GemmaChatRuntime((snapshot) => {
  workerScope.postMessage({ type: "status", snapshot });
});

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

workerScope.postMessage({ type: "ready", snapshot: runtime.snapshot() });

async function handleRequest(request: ChatRuntimeRequest): Promise<void> {
  try {
    let snapshot: ChatSnapshot;
    switch (request.method) {
      case "status":
        snapshot = runtime.snapshot();
        break;
      case "load":
        snapshot = await runtime.load();
        break;
      case "generate":
        snapshot = await runtime.generate(request.arguments?.text ?? "");
        break;
      case "stop":
        snapshot = runtime.stop();
        break;
      case "reset":
        snapshot = runtime.reset();
        break;
    }
    workerScope.postMessage({ type: "response", id: request.id, ok: snapshot });
  } catch (error) {
    workerScope.postMessage({
      type: "response",
      id: request.id,
      error: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
