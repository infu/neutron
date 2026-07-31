import { generateLevel, type GenerationProgress } from "./generator.ts";
import { GENERATOR_VERSION } from "./share_code.ts";
import { analyzeLevel } from "./solver.ts";
import {
  MAX_WORKER_MESSAGE_BYTES,
  WORKER_PROTOCOL_VERSION,
  serializeAnalysis,
  workerMessageBytes,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker_protocol.ts";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(value: WorkerResponse): void;
};

const scope = self as unknown as WorkerScope;
const cancelled = new Set<string>();
let activeJobId: string | null = null;

scope.addEventListener("message", (event) => {
  const request = parseRequest(event.data);
  if (request === null) return;
  if (request.type === "cancel") {
    cancelled.add(request.jobId);
    return;
  }
  if (activeJobId !== null) {
    respond({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "error",
      jobId: request.jobId,
      code: "invalid_request",
      message: "The Hullshift worker already has an active job",
    });
    return;
  }
  activeJobId = request.jobId;
  void run(request).finally(() => {
    cancelled.delete(request.jobId);
    if (activeJobId === request.jobId) activeJobId = null;
  });
});

respond({ protocol: WORKER_PROTOCOL_VERSION, type: "ready" });

async function run(request: Exclude<WorkerRequest, { type: "cancel" }>): Promise<void> {
  const hooks = {
    onProgress(progress: GenerationProgress) {
      respond({ protocol: WORKER_PROTOCOL_VERSION, type: "progress", jobId: request.jobId, progress });
    },
    shouldCancel: () => cancelled.has(request.jobId),
    async yieldControl() {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
  try {
    if (request.type === "generate") {
      const generated = await generateLevel(
        { generatorVersion: GENERATOR_VERSION, seed: request.seed, difficulty: request.difficulty },
        hooks,
      );
      if (cancelled.has(request.jobId)) throw new WorkerCancelledError();
      respond({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "generated",
        jobId: request.jobId,
        result: { ...generated, analysis: serializeAnalysis(generated.analysis) },
      });
      return;
    }

    const analysis = await analyzeLevel(request.level, hooks);
    if (cancelled.has(request.jobId)) throw new WorkerCancelledError();
    respond({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "analyzed",
      jobId: request.jobId,
      analysis: serializeAnalysis(analysis),
    });
  } catch (reason) {
    if (reason instanceof WorkerCancelledError || cancelled.has(request.jobId)) {
      respond({ protocol: WORKER_PROTOCOL_VERSION, type: "cancelled", jobId: request.jobId });
      return;
    }
    respond({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "error",
      jobId: request.jobId,
      code: request.type === "generate" ? "generation_failed" : "analysis_failed",
      message: errorMessage(reason),
    });
  }
}

function parseRequest(value: unknown): WorkerRequest | null {
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
  if (size > MAX_WORKER_MESSAGE_BYTES || typeof value !== "object" || value === null) return null;
  const request = value as Partial<WorkerRequest>;
  if (
    request.protocol !== WORKER_PROTOCOL_VERSION ||
    typeof request.type !== "string" ||
    typeof request.jobId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(request.jobId)
  ) {
    return null;
  }
  if (request.type === "cancel") return request as WorkerRequest;
  if (
    request.type === "generate" &&
    typeof request.seed === "string" &&
    /^[0-9a-f]{16}$/.test(request.seed) &&
    Number.isInteger(request.difficulty) &&
    request.difficulty! >= 0 &&
    request.difficulty! <= 8
  ) {
    return request as WorkerRequest;
  }
  if (request.type === "analyze" && typeof request.level === "object" && request.level !== null) {
    return request as WorkerRequest;
  }
  return null;
}

function respond(response: WorkerResponse): void {
  if (workerMessageBytes(response) > MAX_WORKER_MESSAGE_BYTES) {
    throw new Error("Hullshift worker response exceeds the message budget");
  }
  scope.postMessage(response);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message.slice(0, 500) : "Hullshift worker failed";
}

class WorkerCancelledError extends Error {}
