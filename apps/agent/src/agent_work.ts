import type { AgentWorkState, AgentWorkSnapshot } from "./chat_types.ts";

export const emptyAgentWork = (): AgentWorkState => ({
  goal: null,
  queue: [],
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  startedAt: null,
  wakeAt: null,
});

export function normalizeAgentWork(value: unknown): AgentWorkState {
  if (!value || typeof value !== "object") return emptyAgentWork();
  const state = value as AgentWorkState;
  const result = emptyAgentWork();
  const goal = state.goal;
  if (goal && typeof goal.objective === "string" &&
    ["running", "waiting", "paused", "needs_input", "complete"].includes(goal.status)) {
    result.goal = {
      objective: goal.objective,
      instructions: Array.isArray(goal.instructions)
        ? goal.instructions.filter((text) => typeof text === "string") : [],
      status: goal.status,
      checkpoint: typeof goal.checkpoint === "string" ? goal.checkpoint : "",
      updatedAt: Number.isFinite(goal.updatedAt) ? goal.updatedAt : 0,
    };
  }
  result.queue = Array.isArray(state.queue) ? state.queue.filter((input) =>
    input && typeof input.id === "string" && typeof input.text === "string" &&
    (input.mode === "steer" || input.mode === "queue")) : [];
  for (const key of ["steps", "inputTokens", "outputTokens"] as const) {
    result[key] = Number.isFinite(state[key]) && state[key] >= 0 ? state[key] : 0;
  }
  for (const key of ["startedAt", "wakeAt"] as const) {
    result[key] = Number.isFinite(state[key]) ? state[key] : null;
  }
  return result;
}

export function agentWorkSnapshot(state: AgentWorkState): AgentWorkSnapshot {
  return {
    goal: state.goal ? {
      objective: state.goal.objective,
      status: state.goal.status,
      checkpoint: state.goal.checkpoint,
      updatedAt: state.goal.updatedAt,
    } : null,
    queued: state.queue.length,
    nextMessage: state.queue[0]?.text.slice(0, 512) ?? null,
    steps: state.steps,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    startedAt: state.startedAt,
    wakeAt: state.wakeAt,
  };
}

export type AgentCommand =
  | { kind: "goal"; objective: string }
  | { kind: "resume" | "pause" | "clear" | "status" }
  | { kind: "message" | "queue"; text: string };

export function parseAgentCommand(text: string): AgentCommand {
  const trimmed = text.trim();
  if (trimmed === "/goal") return { kind: "status" };
  if (/^\/goal\s+/u.test(trimmed)) {
    const objective = trimmed.replace(/^\/goal\s+/u, "");
    if (objective === "resume" || objective === "pause" || objective === "clear") {
      return { kind: objective };
    }
    return { kind: "goal", objective };
  }
  if (/^\/queue\s+/u.test(trimmed)) {
    return { kind: "queue", text: trimmed.replace(/^\/queue\s+/u, "") };
  }
  return { kind: "message", text: trimmed };
}

/** Browser timers have a signed 32-bit delay. Chunk scheduling, not the wait. */
export function sleepUntil(
  seconds: number,
  signal: AbortSignal,
  steering: AbortSignal,
): Promise<{ elapsedSeconds: number; wakeReason: "elapsed" | "steering" }> {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return Promise.reject(new Error("Sleep seconds must be a finite non-negative number"));
  }
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      steering.removeEventListener("abort", wake);
    };
    const finish = (wakeReason: "elapsed" | "steering") => {
      cleanup();
      resolve({ elapsedSeconds: (Date.now() - start) / 1_000, wakeReason });
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Agent stopped"));
    };
    const wake = () => finish("steering");
    const tick = () => {
      const remaining = seconds * 1_000 - (Date.now() - start);
      if (remaining <= 0) finish("elapsed");
      else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
    };
    signal.addEventListener("abort", abort, { once: true });
    steering.addEventListener("abort", wake, { once: true });
    if (signal.aborted) abort();
    else if (steering.aborted) wake();
    else tick();
  });
}
