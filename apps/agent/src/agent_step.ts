import { jsonSchema, streamText, tool, type ModelMessage } from "ai";

export type AgentStreamRunner = (
  options: Parameters<typeof streamText>[0],
) => Pick<ReturnType<typeof streamText>, "fullStream" | "responseMessages"> & {
  sources?: ReturnType<typeof streamText>["sources"];
};

export function agentClockTools() {
  return {
    current_time: tool({
      description: "Read the current UTC time before scheduling or checking a deadline.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false }),
      execute: async () => ({ utc: new Date().toISOString() }),
    }),
    sleep: tool({
      outputSchema: jsonSchema<{ elapsedSeconds: number; wakeReason: string }>({ type: "object" }),
      description: "Wait for N seconds without model requests. New instructions wake the wait early; Stop cancels it. Read the elapsed time and wake reason before continuing.",
      inputSchema: jsonSchema<{ seconds: number }>({
        type: "object", required: ["seconds"], additionalProperties: false,
        properties: { seconds: { type: "number", minimum: 0 } },
      }),
    }),
  };
}

export type AgentWaitRequest =
  | { toolCallId: string; name: "sleep"; seconds: number }
  | { toolCallId: string; name: "wait_agents"; ids?: string[] };

export const AGENT_OUTPUT_LIMIT_NOTICE = "Runtime notice: the model response reached its output limit (finish reason: length). This is an unfinished response, not task completion. Completed tool calls and their results above are saved; partial text is not a final report. This finish reason alone does not establish an input-context overflow or its cause.";

export const AGENT_OUTPUT_LIMIT_CONTINUATION = "Continue the unfinished response from the saved evidence. First synthesize a concise account of what is already established and what is still missing. Avoid repeating collection or completed actions; use further focused reads only for a specific remaining gap. Preserve uncertainty about failed or interrupted writes and reconcile them before retrying. If the evidence already answers the assigned task, return the concise final report now. A response limit is not a reason to abandon the task.";

/** A length finish preserves the completed SDK tool records for continuation,
 * but is never accepted as task completion. Errors and interrupted streams
 * still use the existing uncertain-write recovery path. Waiting happens after
 * this function returns, outside the model request deadline. */
export async function readAgentStep(result: ReturnType<AgentStreamRunner>, signal: AbortSignal) {
  let text = "";
  let finishReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const waits: AgentWaitRequest[] = [];
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
    if (part.type === "abort") throw new Error(part.reason ?? "Model stream was interrupted");
    if (part.type === "text-delta") text += part.text;
    if (part.type === "tool-call" && part.toolName === "sleep") {
      const seconds = (part.input as { seconds?: unknown }).seconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid sleep duration");
      waits.push({ toolCallId: part.toolCallId, name: "sleep", seconds });
    }
    if (part.type === "tool-call" && part.toolName === "wait_agents") {
      const ids = (part.input as { ids?: string[] }).ids;
      waits.push({ toolCallId: part.toolCallId, name: "wait_agents", ...(ids ? { ids } : {}) });
    }
    if (part.type === "finish") {
      finishReason = part.finishReason;
      inputTokens = part.totalUsage.inputTokens ?? 0;
      outputTokens = part.totalUsage.outputTokens ?? 0;
    }
  }
  signal.throwIfAborted();
  if (finishReason !== "stop" && finishReason !== "tool-calls" && finishReason !== "length") {
    throw new Error(`Model response ended before completion (${finishReason ?? "missing finish event"}). Resume to continue from saved progress.`);
  }
  const messages = await result.responseMessages;
  signal.throwIfAborted();
  return {
    text, finishReason, inputTokens, outputTokens, waits,
    messages: finishReason === "length"
      ? [...messages, { role: "assistant", content: AGENT_OUTPUT_LIMIT_NOTICE } satisfies ModelMessage]
      : messages,
  };
}

export function interruptedWait(request: AgentWaitRequest): ModelMessage {
  return { role: "tool", content: [{
    type: "tool-result", toolCallId: request.toolCallId, toolName: request.name,
    output: { type: "json", value: { wakeReason: "interrupted", elapsedSeconds: null } },
  }] };
}
