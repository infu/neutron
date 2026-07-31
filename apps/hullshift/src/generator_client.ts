import {
  WORKER_PROTOCOL_VERSION,
  deserializeAnalysis,
  isWorkerRequest,
  isWorkerResponse,
  type SerializedAnalysis,
  type SerializedGeneratedLevel,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker_protocol.ts";
import type { LevelDefinition } from "./model.ts";
import type { GenerationProgress } from "./generator.ts";

type JobResult =
  | { type: "generated"; result: SerializedGeneratedLevel }
  | { type: "analyzed"; analysis: SerializedAnalysis };

type PendingJob = {
  readonly id: string;
  readonly expected: JobResult["type"];
  readonly resolve: (result: JobResult) => void;
  readonly reject: (reason: Error) => void;
  readonly onProgress: ((progress: GenerationProgress) => void) | undefined;
};

export class GeneratorWorkerClient {
  readonly #workerSource: string;
  #worker: Worker | null = null;
  #ready: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((reason: Error) => void) | null = null;
  #pending: PendingJob | null = null;
  #nextJob = 1;

  constructor(workerSource: string) {
    this.#workerSource = workerSource;
  }

  async generate(
    seed: string,
    difficulty: number,
    onProgress?: (progress: GenerationProgress) => void,
  ): Promise<SerializedGeneratedLevel> {
    const result = await this.#run(
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "generate",
        jobId: this.#jobId(),
        seed,
        difficulty,
      },
      "generated",
      onProgress,
    );
    if (result.type !== "generated") throw new Error("Hullshift worker returned the wrong result kind");
    return result.result;
  }

  async analyze(
    level: LevelDefinition,
    onProgress?: (progress: GenerationProgress) => void,
  ): Promise<SerializedAnalysis> {
    const result = await this.#run(
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "analyze",
        jobId: this.#jobId(),
        level,
      },
      "analyzed",
      onProgress,
    );
    if (result.type !== "analyzed") throw new Error("Hullshift worker returned the wrong result kind");
    return result.analysis;
  }

  cancel(): boolean {
    if (this.#worker === null || this.#pending === null) return false;
    try {
      this.#worker.postMessage({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "cancel",
        jobId: this.#pending.id,
      } satisfies WorkerRequest);
      return true;
    } catch (reason) {
      this.#fail(asError(reason, "Hullshift worker cancellation failed"));
      return false;
    }
  }

  dispose(reason = "Hullshift generation worker stopped"): void {
    const error = new Error(reason);
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectReady?.(error);
    this.#ready = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(error);
  }

  async #run(
    request: Exclude<WorkerRequest, { type: "cancel" }>,
    expected: PendingJob["expected"],
    onProgress?: PendingJob["onProgress"],
  ): Promise<JobResult> {
    if (this.#pending !== null) throw new Error("A Hullshift generation job is already active");
    if (!isWorkerRequest(request)) {
      throw new Error("Hullshift worker request is invalid or exceeds the message limit");
    }
    let resolveResult!: (result: JobResult) => void;
    let rejectResult!: (reason: Error) => void;
    const result = new Promise<JobResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending: PendingJob = {
      id: request.jobId,
      expected,
      resolve: resolveResult,
      reject: rejectResult,
      onProgress,
    };
    // Reserve the single job slot before waiting for `ready`. This prevents a
    // second call from racing startup and also makes startup cancellable.
    this.#pending = pending;
    try {
      await this.#ensureReady();
      if (this.#pending === pending) {
        const worker = this.#worker;
        if (worker === null) throw new Error("Hullshift generation worker stopped during startup");
        worker.postMessage(request);
      }
    } catch (reason) {
      pending.reject(asError(reason, "Hullshift generation worker could not start"));
    }
    try {
      return await result;
    } finally {
      if (this.#pending === pending) {
        this.#pending = null;
        // Each job gets a fresh worker. This makes idle resident CPU use zero
        // and guarantees cancellation cannot leak mutable analyzer state.
        this.#worker?.terminate();
        this.#worker = null;
        this.#ready = null;
        this.#resolveReady = null;
        this.#rejectReady = null;
      }
    }
  }

  #jobId(): string {
    const id = this.#nextJob;
    this.#nextJob += 1;
    return `job_${id.toString(36)}`;
  }

  #ensureReady(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    if (this.#workerSource.length === 0) {
      return Promise.reject(new Error("Hullshift generator worker source is unavailable"));
    }
    const blob = new Blob([this.#workerSource], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    let worker: Worker;
    try {
      worker = new Worker(url, { name: "Hullshift generation and analysis" });
    } finally {
      URL.revokeObjectURL(url);
    }
    this.#worker = worker;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    worker.addEventListener("message", this.#handleMessage);
    worker.addEventListener("error", this.#handleError);
    worker.addEventListener("messageerror", this.#handleMessageError);
    return this.#ready;
  }

  #handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isWorkerResponse(event.data)) {
      this.#fail(new Error("Hullshift worker sent an invalid protocol message"));
      return;
    }
    const response = event.data;
    if (response.type === "ready") {
      if (this.#resolveReady === null) {
        this.#fail(new Error("Hullshift worker sent an unexpected ready message"));
        return;
      }
      this.#resolveReady?.();
      this.#resolveReady = null;
      this.#rejectReady = null;
      return;
    }
    if (this.#resolveReady !== null) {
      this.#fail(new Error("Hullshift worker sent a result before it was ready"));
      return;
    }
    const pending = this.#pending;
    if (pending === null || response.jobId !== pending.id) return;
    if (response.type === "progress") {
      try {
        pending.onProgress?.(response.progress);
      } catch (reason) {
        this.#fail(asError(reason, "Hullshift worker progress handler failed"));
      }
      return;
    }
    if (response.type === "cancelled") {
      pending.reject(new GenerationCancelledError());
      return;
    }
    if (response.type === "error") {
      pending.reject(new GeneratorWorkerError(response.code, response.message));
      return;
    }
    if (response.type !== pending.expected) {
      pending.reject(new Error("Hullshift worker result did not match its request"));
      return;
    }
    if (response.type === "generated") {
      pending.resolve({
        type: "generated",
        result: {
          ...response.result,
          analysis: deserializeAnalysis(response.result.analysis),
        },
      });
    } else {
      pending.resolve({ type: "analyzed", analysis: deserializeAnalysis(response.analysis) });
    }
  };

  #handleError = (event: ErrorEvent): void => {
    this.#fail(new Error(event.message || "Hullshift worker crashed"));
  };

  #handleMessageError = (): void => {
    this.#fail(new Error("Hullshift worker result could not be decoded"));
  };

  #fail(reason: Error): void {
    this.#rejectReady?.(reason);
    this.#pending?.reject(reason);
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
  }
}

export class GenerationCancelledError extends Error {
  constructor() {
    super("Hullshift generation was cancelled");
    this.name = "GenerationCancelledError";
  }
}

export class GeneratorWorkerError extends Error {
  readonly code: Extract<WorkerResponse, { type: "error" }>["code"];

  constructor(code: GeneratorWorkerError["code"], message: string) {
    super(message);
    this.name = "GeneratorWorkerError";
    this.code = code;
  }
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
