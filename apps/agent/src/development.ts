import type { JsonObject, JsonValue } from "neutron-tools/app";
import { canisterIdFromUrl } from "neutron-tools/src/runtime.js";
import type {
  AgentProgress,
  AgentSnapshot,
  AgentToolActivity,
} from "./chat_types.ts";

const DEVELOPMENT_GLOBAL = "__NEUTRON_AGENT_DEV__" as const;
const DEFAULT_TRACE_LIMIT = 256;
const MAX_PROMPT_CHARACTERS = 16_000;

export type AgentDevelopmentInspection = JsonObject & {
  snapshot: AgentSnapshot | null;
  draft: string;
  activeTool: AgentToolActivity | null;
  chatPending: boolean;
};

export type AgentDevelopmentTraceEvent = JsonObject & {
  sequence: number;
  timestamp: number;
  runId: number | null;
  type: "prepared" | "submitted" | "progress" | "final" | "error";
  data: JsonValue;
};

export type AgentDevelopmentTracePage = JsonObject & {
  oldestSequence: number;
  latestSequence: number;
  truncated: boolean;
  events: AgentDevelopmentTraceEvent[];
};

export type AgentDevelopmentApi = Readonly<{
  version: 1;
  prepare(text: unknown): { prepared: true; characters: number };
  inspect(): AgentDevelopmentInspection;
  readTrace(afterSequence?: unknown): AgentDevelopmentTracePage;
  clearTrace(): { latestSequence: number };
}>;

type AgentDevelopmentController = {
  prepare(text: string): void;
  inspect(): AgentDevelopmentInspection;
};

export class AgentDevelopmentBridge {
  readonly api: AgentDevelopmentApi;
  private controller: AgentDevelopmentController | null = null;
  private events: AgentDevelopmentTraceEvent[] = [];
  private sequence = 0;
  private runId = 0;

  constructor(private readonly traceLimit = DEFAULT_TRACE_LIMIT) {
    if (
      !Number.isSafeInteger(traceLimit) ||
      traceLimit < 1 ||
      traceLimit > DEFAULT_TRACE_LIMIT
    ) {
      throw new Error("Invalid Agent development trace limit");
    }
    this.api = Object.freeze({
      version: 1,
      prepare: (text) => this.prepare(text),
      inspect: () => this.inspect(),
      readTrace: (afterSequence) => this.readTrace(afterSequence),
      clearTrace: () => this.clearTrace(),
    });
  }

  attach(controller: AgentDevelopmentController): () => void {
    this.controller = controller;
    return () => {
      if (this.controller === controller) this.controller = null;
    };
  }

  beginRun(text: string): number | null {
    if (!this.controller) return null;
    const runId = ++this.runId;
    this.push(runId, "submitted", { text });
    return runId;
  }

  progress(runId: number | null, progress: AgentProgress): void {
    if (runId === null || !this.controller) return;
    this.push(runId, "progress", progress);
  }

  complete(runId: number | null, snapshot: AgentSnapshot): void {
    if (runId === null || !this.controller) return;
    let assistant = null;
    for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
      const candidate = snapshot.messages[index];
      if (candidate?.role === "assistant") {
        assistant = candidate;
        break;
      }
    }
    this.push(runId, "final", {
      assistant,
      error: snapshot.error,
      messageCount: snapshot.messages.length,
      selectedModelId: snapshot.selectedModelId,
    });
  }

  fail(runId: number | null, message: string): void {
    if (runId === null || !this.controller) return;
    this.push(runId, "error", { message: message.slice(0, 512) });
  }

  private prepare(value: unknown): { prepared: true; characters: number } {
    const controller = this.requireController();
    if (typeof value !== "string") {
      throw new Error("Agent development prompt must be a string");
    }
    const text = value.trim();
    if (!text || text.length > MAX_PROMPT_CHARACTERS) {
      throw new Error(
        `Agent development prompt must contain 1 through ${MAX_PROMPT_CHARACTERS} characters`,
      );
    }
    controller.prepare(text);
    this.push(null, "prepared", { characters: text.length });
    return { prepared: true, characters: text.length };
  }

  private inspect(): AgentDevelopmentInspection {
    return cloneJson(this.requireController().inspect());
  }

  private readTrace(afterSequence: unknown): AgentDevelopmentTracePage {
    const after =
      afterSequence === undefined ? 0 : requiredSequence(afterSequence);
    const oldestSequence = this.events[0]?.sequence ?? this.sequence;
    return {
      oldestSequence,
      latestSequence: this.sequence,
      truncated:
        this.events.length > 0 && after < Math.max(0, oldestSequence - 1),
      events: cloneJson(
        this.events.filter((event) => event.sequence > after),
      ),
    };
  }

  private clearTrace(): { latestSequence: number } {
    this.events = [];
    return { latestSequence: this.sequence };
  }

  private push(
    runId: number | null,
    type: AgentDevelopmentTraceEvent["type"],
    data: JsonValue,
  ): void {
    this.events.push({
      sequence: ++this.sequence,
      timestamp: Date.now(),
      runId,
      type,
      data: cloneJson(data),
    });
    if (this.events.length > this.traceLimit) {
      this.events.splice(0, this.events.length - this.traceLimit);
    }
  }

  private requireController(): AgentDevelopmentController {
    if (!this.controller) {
      throw new Error("Agent development tile is no longer active");
    }
    return this.controller;
  }
}

const developmentBridge = new AgentDevelopmentBridge();

export function installAgentDevelopmentApi(
  controller: AgentDevelopmentController,
): () => void {
  if (
    typeof window === "undefined" ||
    window.parent === window ||
    !isLocalAgentDevelopmentUrl(window.location.href)
  ) {
    return () => undefined;
  }

  const detach = developmentBridge.attach(controller);
  const target = window as Window & {
    [DEVELOPMENT_GLOBAL]?: AgentDevelopmentApi;
  };
  if (
    Object.hasOwn(target, DEVELOPMENT_GLOBAL) &&
    target[DEVELOPMENT_GLOBAL] !== developmentBridge.api
  ) {
    detach();
    return () => undefined;
  }
  if (!Object.hasOwn(target, DEVELOPMENT_GLOBAL)) {
    Object.defineProperty(target, DEVELOPMENT_GLOBAL, {
      configurable: false,
      enumerable: false,
      value: developmentBridge.api,
      writable: false,
    });
  }
  return detach;
}

export function beginAgentDevelopmentRun(text: string): number | null {
  return developmentBridge.beginRun(text);
}

export function recordAgentDevelopmentProgress(
  runId: number | null,
  progress: AgentProgress,
): void {
  developmentBridge.progress(runId, progress);
}

export function completeAgentDevelopmentRun(
  runId: number | null,
  snapshot: AgentSnapshot,
): void {
  developmentBridge.complete(runId, snapshot);
}

export function failAgentDevelopmentRun(
  runId: number | null,
  message: string,
): void {
  developmentBridge.fail(runId, message);
}

export function isLocalAgentDevelopmentUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const context = {
    app: url.searchParams.get("app"),
    tile: url.searchParams.get("tile"),
    instance: url.searchParams.get("instance"),
    workspace: Number(url.searchParams.get("workspace")),
  };
  return (
    url.protocol === "http:" &&
    url.port === "8000" &&
    url.hostname.endsWith(".localhost") &&
    typeof canisterIdFromUrl(url) === "string" &&
    url.pathname === "/app/agent/index.html" &&
    context.app === "agent" &&
    context.tile === "chat" &&
    typeof context.instance === "string" &&
    /^[A-Za-z0-9_-]{1,256}$/u.test(context.instance) &&
    Number.isInteger(context.workspace) &&
    context.workspace >= 1 &&
    context.workspace <= 20
  );
}

function requiredSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Agent development trace cursor must be a non-negative integer");
  }
  return value as number;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

declare global {
  interface Window {
    __NEUTRON_AGENT_DEV__?: AgentDevelopmentApi;
  }
}
