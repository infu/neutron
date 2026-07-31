import type {
  ChatMessage,
  ChatSnapshot,
  ChatStage,
} from "./chat_types.ts";

const GEMMA_MODULE_URL =
  "https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/resolve/feade0377736bdb0931056468949503f547f4d70/gemma-4-e2b.js";
export const MODEL_ID = "Vzmoi/gemma-4-expr-tst";
export const MODEL_REVISION =
  "3c4e8ad4641c69e754e5f22e8fdf9275eb2c6408";
export const MODEL_DISPLAY_NAME = MODEL_ID.slice(MODEL_ID.lastIndexOf("/") + 1);
const MAX_TOKENS = 4096;
const SYSTEM_PROMPT =
  "You are Gemma, a helpful and concise chat assistant running locally in the user's browser.";

export type GemmaPromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type GemmaProgress = {
  status?: string;
  kind?: "bytes" | "tensors";
  message?: string;
  loaded?: number;
  total?: number | null;
  fraction?: number;
};

type GemmaGenerationChunk = {
  delta?: string;
  text?: string;
};

export type GemmaModel = {
  warmup(): Promise<void>;
  generate(
    messages: GemmaPromptMessage[],
    options: {
      maxNewTokens?: number;
      signal?: AbortSignal;
    }
  ): AsyncIterable<GemmaGenerationChunk>;
  reset(): void;
  dispose?(): void;
};

export type GemmaModule = {
  Gemma4Mobile: {
    load(
      modelId?: string | null,
      options?: {
        revision?: string;
        onProgress?: (progress: GemmaProgress) => void;
        signal?: AbortSignal;
        cache?: boolean;
      }
    ): Promise<GemmaModel>;
  };
};

type BrowserGpuAdapterInfo = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  backend?: string;
  driver?: string;
  type?: string;
};

type BrowserGpuAdapter = {
  features: {
    has(feature: string): boolean;
    values(): IterableIterator<string>;
  };
  info?: BrowserGpuAdapterInfo;
};

type BrowserGpu = {
  requestAdapter(options?: {
    powerPreference?: "low-power" | "high-performance";
  }): Promise<BrowserGpuAdapter | null>;
};

let gemmaModulePromise: Promise<GemmaModule> | null = null;

export type GemmaChatRuntimeDependencies = {
  hasWebGpu(): boolean;
  assertWebGpuSupport(): Promise<void>;
  loadModule(): Promise<GemmaModule>;
  now(): number;
};

const defaultDependencies: GemmaChatRuntimeDependencies = {
  hasWebGpu,
  assertWebGpuSupport: assertGemmaWebGpuSupport,
  loadModule: loadGemmaModule,
  now: () => performance.now(),
};

export class GemmaChatRuntime {
  private model: GemmaModel | null = null;
  private loadAbort: AbortController | null = null;
  private generateAbort: AbortController | null = null;
  private stage: ChatStage;
  private statusText: string;
  private loadProgress: number | null = null;
  private messages: ChatMessage[] = [];

  private readonly dependencies: GemmaChatRuntimeDependencies;

  constructor(
    private readonly onUpdate: (snapshot: ChatSnapshot) => void,
    dependencies: Partial<GemmaChatRuntimeDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
    const supported = this.dependencies.hasWebGpu();
    this.stage = supported ? "idle" : "error";
    this.statusText = supported
      ? `Load ${MODEL_DISPLAY_NAME} to begin.`
      : "WebGPU is unavailable in this browser context.";
  }

  snapshot(): ChatSnapshot {
    return {
      stage: this.stage,
      statusText: this.statusText,
      modelId: MODEL_ID,
      modelLoaded: Boolean(this.model),
      loadProgress: this.loadProgress,
      webGpuAvailable: this.dependencies.hasWebGpu(),
      messages: this.messages.map((message) => ({ ...message })),
    };
  }

  async load(): Promise<ChatSnapshot> {
    if (this.model) return this.snapshot();
    if (this.loadAbort) throw new Error("Model load is already in progress");
    if (!this.dependencies.hasWebGpu()) {
      throw new Error("WebGPU is unavailable in this browser context.");
    }

    const controller = new AbortController();
    let loadingModel: GemmaModel | null = null;
    this.loadAbort = controller;
    this.update("loading", "Checking WebGPU adapter...", 0.02);
    try {
      await this.dependencies.assertWebGpuSupport();
      throwIfAborted(controller.signal);
      this.update("loading", "Loading Gemma WebGPU runtime...", 0.05);
      const module = await this.dependencies.loadModule();
      throwIfAborted(controller.signal);
      this.update("loading", "Requesting WebGPU device...", 0.1);
      loadingModel = await module.Gemma4Mobile.load(MODEL_ID, {
        revision: MODEL_REVISION,
        signal: controller.signal,
        cache: true,
        onProgress: (progress) => {
          const sourceFraction = progressFraction(progress);
          const displayFraction =
            progress.kind === "tensors" ? null : sourceFraction;
          const nextProgress =
            displayFraction === null
              ? this.loadProgress
              : Math.max(
                  this.loadProgress ?? 0.1,
                  0.1 + displayFraction * 0.8
                );
          this.update("loading", progressLabel(progress), nextProgress);
        },
      });
      throwIfAborted(controller.signal);
      this.update("loading", "Warming model...", 0.94);
      await loadingModel.warmup();
      this.model = loadingModel;
      loadingModel = null;
      this.update("ready", "Ready for local chat.", 1);
    } catch (error) {
      console.error("[Gemma] model load failed", error);
      loadingModel?.dispose?.();
      if (this.loadAbort === controller) {
        if (isAbortError(error)) this.update("idle", "Model load stopped.", null);
        else this.update("error", formatError(error), null);
      }
      throw error;
    } finally {
      if (this.loadAbort === controller) this.loadAbort = null;
    }
    return this.snapshot();
  }

  async generate(text: string): Promise<ChatSnapshot> {
    const prompt = text.trim();
    if (!prompt) throw new Error("Message text is required");
    if (!this.model) throw new Error("Load the model before generating");
    if (this.generateAbort) throw new Error("Generation is already in progress");

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: prompt,
    };
    const assistantMessage: ChatMessage = {
      id: createId("assistant"),
      role: "assistant",
      content: "",
    };
    const promptMessages: GemmaPromptMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...[...this.messages, userMessage].map(({ role, content }) => ({
        role,
        content,
      })),
    ];
    this.messages = [...this.messages, userMessage, assistantMessage];

    const controller = new AbortController();
    this.generateAbort = controller;
    let textSoFar = "";
    this.update("generating", "Generating response...");

    try {
      for await (const chunk of this.model.generate(promptMessages, {
        maxNewTokens: MAX_TOKENS,
        signal: controller.signal,
      })) {
        textSoFar = chunk.text ?? textSoFar + (chunk.delta ?? "");
        this.replaceMessage(assistantMessage.id, textSoFar);
        this.emit();
      }

      const finalText = textSoFar.trim() || "No response generated.";
      this.replaceMessage(assistantMessage.id, finalText);
      this.update("ready", "Ready for local chat.");
    } catch (error) {
      if (this.generateAbort === controller) {
        if (isAbortError(error)) {
          this.update("ready", "Generation stopped.");
        } else {
          const message = formatError(error);
          this.replaceMessage(assistantMessage.id, `Error: ${message}`);
          this.update("error", message);
        }
      }
      throw error;
    } finally {
      if (this.generateAbort === controller) this.generateAbort = null;
    }
    return this.snapshot();
  }

  stop(): ChatSnapshot {
    this.loadAbort?.abort();
    this.generateAbort?.abort();
    return this.snapshot();
  }

  reset(): ChatSnapshot {
    this.loadAbort?.abort();
    this.generateAbort?.abort();
    this.loadAbort = null;
    this.generateAbort = null;
    this.model?.reset();
    this.model?.dispose?.();
    this.model = null;
    this.messages = [];
    this.update(
      this.dependencies.hasWebGpu() ? "idle" : "error",
      this.dependencies.hasWebGpu()
        ? `Load ${MODEL_DISPLAY_NAME} to begin.`
        : "WebGPU is unavailable in this browser context.",
      null
    );
    return this.snapshot();
  }

  private replaceMessage(id: string, content: string): void {
    this.messages = this.messages.map((message) =>
      message.id === id ? { ...message, content } : message
    );
  }

  private update(
    stage: ChatStage,
    statusText: string,
    loadProgress = this.loadProgress
  ): void {
    this.stage = stage;
    this.statusText = statusText;
    this.loadProgress = loadProgress;
    this.emit();
  }

  private emit(): void {
    this.onUpdate(this.snapshot());
  }
}

function browserGpu(): BrowserGpu | null {
  return (navigator as Navigator & { gpu?: BrowserGpu }).gpu ?? null;
}

function hasWebGpu(): boolean {
  return Boolean(browserGpu());
}

async function assertGemmaWebGpuSupport(): Promise<void> {
  const gpu = browserGpu();
  if (!gpu) throw new Error("WebGPU is unavailable in this browser context.");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("The browser did not expose a WebGPU adapter.");
  const adapterName = formatAdapterInfo(adapter.info);
  const features = Array.from(adapter.features.values()).sort();
  if (!adapter.features.has("shader-f16")) {
    throw new Error(
      [
        "This WebGPU adapter is missing shader-f16, which Gemma 4 E2B requires.",
        adapterName ? `Adapter: ${adapterName}.` : null,
        features.length > 0 ? `Features: ${features.join(", ")}.` : null,
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
}

async function loadGemmaModule(): Promise<GemmaModule> {
  gemmaModulePromise ??= importGemmaTextModule();
  return gemmaModulePromise;
}

async function importGemmaTextModule(): Promise<GemmaModule> {
  const response = await fetch(GEMMA_MODULE_URL, { mode: "cors" });
  if (!response.ok) {
    throw new Error(
      `Failed to load Gemma WebGPU runtime: ${response.status} ${response.statusText}`
    );
  }
  const source = await response.text();
  const moduleUrl = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  try {
    const module = (await import(moduleUrl)) as GemmaModule;
    if (!module.Gemma4Mobile?.load) {
      throw new Error("Gemma WebGPU runtime did not expose Gemma4Mobile.load");
    }
    return module;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function progressLabel(progress: GemmaProgress): string {
  const base = progress.message ?? progress.status ?? "Loading model";
  if (
    typeof progress.loaded === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
  ) {
    if (progress.kind === "bytes") {
      return `${base} ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`;
    }
    return `${base} ${progress.loaded} / ${progress.total}`;
  }
  return base;
}

function progressFraction(progress: GemmaProgress): number | null {
  if (
    typeof progress.fraction === "number" &&
    Number.isFinite(progress.fraction)
  ) {
    return Math.min(1, Math.max(0, progress.fraction));
  }
  if (
    typeof progress.loaded === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
  ) {
    return Math.min(1, Math.max(0, progress.loaded / progress.total));
  }
  return null;
}

function formatAdapterInfo(info?: BrowserGpuAdapterInfo): string {
  if (!info) return "";
  return [
    info.description,
    info.vendor,
    info.architecture,
    info.device,
    info.backend,
    info.driver,
    info.type,
  ]
    .filter(Boolean)
    .join(" / ");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

function formatError(error: unknown): string {
  if (isAbortError(error)) return "Stopped";
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}
