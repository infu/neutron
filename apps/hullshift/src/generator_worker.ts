import { generateLevel, type GenerationProgress } from "./generator.ts";
import { GENERATOR_VERSION } from "./share_code.ts";
import { analyzeLevel } from "./solver.ts";
import { cargoAnalysis, solveCargo } from "./cargo_puzzles.ts";
import { freightAnalysis } from "./freight_puzzles.ts";
import { solveFreight } from "./freight_solver.ts";
import {
  MAX_WORKER_MESSAGE_BYTES,
  WORKER_PROTOCOL_VERSION,
  serializeAnalysis,
  workerMessageBytes,
  isWorkerRequest,
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
        { generatorVersion: request.generatorVersion ?? GENERATOR_VERSION, seed: request.seed, difficulty: request.difficulty },
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

    const analysis = request.level.objective === "freight"
      ? freightAnalysis(request.level, await solveFreight(request.level, request.current?.snapshot, request.current?.knownRoute, hooks), 0, "Systems deck", request.current?.snapshot)
      : request.level.objective === "cargo"
      ? cargoAnalysis(request.level, await solveCargo(request.level, hooks), 0)
      : await analyzeLevel(request.level, hooks);
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
  return isWorkerRequest(value) ? value : null;
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
