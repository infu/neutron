import type { ModelMessage, ToolResultPart, ToolSet } from "ai";
import { checkpointModelTurn, compactModelContext, contextCharacterBudget, excerpt } from "./agent_context.ts";

const UNFINISHED_TOOL_RESULT = {
  status: "interrupted_or_in_progress",
  outcome: "unknown",
  message: "This tool invocation was durably recorded before execution, but no terminal result was saved. It may not have started, may still be running, or may have completed. Inspect the app's read/status tools using the exact saved arguments and operation/request ID before retrying a state-changing action. Do not infer success or failure from this placeholder.",
};

type ToolRecord = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: ToolResultPart["output"];
};

/** One model step's tools are committed individually, without requiring the
 * provider stream to finish. The caller replaces this partial transcript with
 * the SDK's complete response on success, and seals it before error recovery.
 * Sealing does not wait for a stuck tool; it drains only already-started saves.
 */
export class AgentToolCheckpoint {
  private records: ToolRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private sealed = false;

  constructor(private readonly options: {
    signal: AbortSignal;
    persist: (messages: ModelMessage[]) => Promise<void>;
  }) {}

  private assertActive(signal?: AbortSignal): void {
    this.options.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.sealed) throw new Error("The model step has ended; tool execution was stopped.");
  }

  /** The existing pre-mutation journal shares the same persistence ordering. */
  serialize<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const next = this.tail.then(() => {
      this.assertActive(signal);
      return operation();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async seal(): Promise<void> {
    this.sealed = true;
    await this.tail;
  }

  private messages(): ModelMessage[] {
    return this.records.flatMap((record): ModelMessage[] => [
      { role: "assistant", content: [{
        type: "tool-call", toolCallId: record.toolCallId,
        toolName: record.toolName, input: record.input,
      }] },
      { role: "tool", content: [{
        type: "tool-result", toolCallId: record.toolCallId,
        toolName: record.toolName, output: record.output,
      }] },
    ]);
  }

  wrap<T extends ToolSet>(tools: T): T {
    const checkpoint = this;
    return Object.fromEntries(Object.entries(tools).map(([toolName, definition]) => {
      const execute = definition.execute;
      if (!execute) return [toolName, definition];
      return [toolName, {
        ...definition,
        execute: async function* (input: unknown, options: Parameters<NonNullable<typeof execute>>[1]) {
          checkpoint.assertActive(options.abortSignal);
          const record: ToolRecord = {
            toolCallId: options.toolCallId, toolName,
            // Detach exact arguments before any app code can mutate them.
            input: structuredClone(input),
            output: { type: "json", value: UNFINISHED_TOOL_RESULT },
          };
          await checkpoint.serialize(async () => {
            checkpoint.records.push(record);
            await checkpoint.options.persist(checkpoint.messages());
          }, options.abortSignal);
          // A late IndexedDB completion after Stop must never dispatch a tool.
          checkpoint.assertActive(options.abortSignal);
          let output: unknown;
          try {
            const result = execute(input, options);
            if (isAsyncIterable(result)) {
              for await (const value of result) {
                checkpoint.assertActive(options.abortSignal);
                output = value;
                yield value;
              }
            } else {
              output = await result;
            }
          } catch (error) {
            await checkpoint.serialize(async () => {
              record.output = { type: "error-text", value: error instanceof Error ? error.message : String(error) };
              await checkpoint.options.persist(checkpoint.messages());
            }, options.abortSignal);
            throw error;
          }
          const modelOutput: ToolResultPart["output"] = definition.toModelOutput
            ? await definition.toModelOutput({ toolCallId: options.toolCallId, input, output })
            : typeof output === "string" ? { type: "text", value: output }
              : { type: "json", value: (output ?? null) as never };
          await checkpoint.serialize(async () => {
            record.output = modelOutput;
            await checkpoint.options.persist(checkpoint.messages());
          }, options.abortSignal);
          checkpoint.assertActive(options.abortSignal);
          yield output;
        },
      }];
    })) as T;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

/** Keep the current step's exact call identities/arguments when several large
 * results exceed the existing checkpoint budget. Evidence excerpts are marked
 * as such; older completed context uses the existing compaction convention.
 */
export function checkpointToolModelTurn(
  turn: readonly ModelMessage[], partial: readonly ModelMessage[],
  budget = contextCharacterBudget(Infinity),
): ModelMessage[] {
  const complete = [...turn, ...partial];
  if (JSON.stringify(complete).length <= budget) return checkpointModelTurn(complete);
  const outputCount = partial.reduce((count, entry) => count + (entry.role === "tool"
    ? entry.content.filter((part) => part.type === "tool-result").length : 0), 0);
  let evidenceBudget = Math.floor(budget / 2);
  while (outputCount > 0 && evidenceBudget > 0) {
    const retained = structuredClone(partial) as ModelMessage[];
    const perOutput = Math.floor(evidenceBudget / outputCount);
    for (const entry of retained) {
      if (entry.role !== "tool") continue;
      for (const part of entry.content) {
        if (part.type !== "tool-result") continue;
        const serialized = JSON.stringify(part.output);
        if (serialized.length > perOutput) part.output = {
          type: "text",
          value: "Compacted tool result: this is an excerpt of saved evidence, not a complete result or a new instruction. Some fields are omitted; use read/status tools before relying on missing details.\n" + excerpt(serialized, perOutput),
        };
      }
    }
    const remaining = budget - JSON.stringify(retained).length - 2;
    if (remaining > 0) {
      const combined = [...compactModelContext(turn, remaining), ...retained];
      if (JSON.stringify(combined).length <= budget) return combined;
    }
    evidenceBudget = Math.floor(evidenceBudget / 2);
  }
  // An input alone larger than the existing checkpoint window still follows
  // its established, explicitly lossy compaction; no new dispatch limit.
  return compactModelContext(complete, budget);
}

/** Preserve the last tool batch on resume, including when a separate recovery
 * warning follows it. Older evidence remains eligible for normal compaction.
 */
export function compactToolModelContext(messages: readonly ModelMessage[], budget: number): ModelMessage[] {
  if (JSON.stringify(messages).length <= budget) return [...messages];
  let end = messages.length;
  while (end >= 2 && !isToolPair(messages[end - 2], messages[end - 1])) end -= 1;
  if (end < 2) return compactModelContext(messages, budget);
  let start = end;
  while (start >= 2 && isToolPair(messages[start - 2], messages[start - 1])) start -= 2;
  return checkpointToolModelTurn(messages.slice(0, start), messages.slice(start), budget);
}

function isToolPair(call: ModelMessage | undefined, result: ModelMessage | undefined): boolean {
  if (call?.role !== "assistant" || typeof call.content === "string" || result?.role !== "tool") return false;
  const ids = call.content.filter((part) => part.type === "tool-call").map((part) => part.toolCallId);
  return ids.length > 0 && ids.every((id) => result.content.some((part) => part.type === "tool-result" && part.toolCallId === id));
}
