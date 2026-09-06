import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { errorMessage, type Operation } from "./data.ts";
import {
  executeEffect,
  operationJson,
  prepareEffect,
  rejectEffect,
  statusEffect,
  type Prepared,
  type ProviderKind,
} from "./provider.ts";
export type ReviewPrompt = {
  id: string;
  prepared: Prepared;
  context: MsgBusToolContext;
  phase: "review" | "executing" | "checking" | "uncertain";
  error: string | null;
  resolve: (value: JsonObject) => void;
  reject: (error: unknown) => void;
  removeAbort: () => void;
};
let prompts: ReviewPrompt[] = [];
const listeners = new Set<() => void>();
export const subscribePrompts = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getPrompts = () => prompts;
function emit() {
  prompts = [...prompts];
  for (const listener of listeners) listener();
}
function remove(prompt: ReviewPrompt): boolean {
  if (!prompts.includes(prompt)) return false;
  prompts = prompts.filter((x) => x !== prompt);
  prompt.removeAbort();
  emit();
  return true;
}
function finish(prompt: ReviewPrompt, operation: Operation) {
  const result = operationJson(operation);
  if (remove(prompt)) prompt.resolve(result);
}
export async function presentEffect(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  if (context.audience !== "foreground_tile")
    throw new Error(
      "EVM Wallet review requires Kernel foreground-tile attestation",
    );
  const prepared = await prepareEffect(kind, args, context);
  if (prepared.operation.status !== "prepared")
    return operationJson(prepared.operation);
  const id = prepared.operation.operationId;
  if (prompts.some((p) => p.id === id))
    throw new Error("This EVM request is already awaiting review");
  return new Promise((resolve, reject) => {
    const prompt: ReviewPrompt = {
      id,
      prepared,
      context,
      phase: "review",
      error: null,
      resolve,
      reject,
      removeAbort: () => undefined,
    };
    const abort = () => {
      if (remove(prompt))
        reject(
          context.signal?.reason ?? new Error("EVM Wallet review cancelled"),
        );
    };
    if (context.signal) {
      context.signal.addEventListener("abort", abort, { once: true });
      prompt.removeAbort = () =>
        context.signal?.removeEventListener("abort", abort);
    }
    prompts.push(prompt);
    emit();
    if (context.signal?.aborted) abort();
  });
}
export async function acceptPrompt(prompt: ReviewPrompt): Promise<void> {
  if (!prompts.includes(prompt) || prompt.phase !== "review") return;
  prompt.phase = "executing";
  prompt.error = null;
  emit();
  try {
    const operation = await executeEffect(prompt.prepared, prompt.context);
    if (!prompts.includes(prompt)) return;
    if (operation.status === "prepared") {
      prompt.prepared = { ...prompt.prepared, operation };
      prompt.phase = "review";
      prompt.error =
        operation.message ??
        "The prepared transaction changed. Review the new details before approving.";
      emit();
      return;
    }
    finish(prompt, operation);
  } catch (error) {
    if (!prompts.includes(prompt)) return;
    prompt.phase = "uncertain";
    prompt.error = `Outcome not confirmed. The request is saved as operation ${prompt.id}. Check its status before making another request. ${errorMessage(error)}`;
    emit();
  }
}
export async function declinePrompt(prompt: ReviewPrompt): Promise<void> {
  if (!prompts.includes(prompt) || prompt.phase !== "review") return;
  prompt.phase = "executing";
  emit();
  try {
    finish(prompt, await rejectEffect(prompt.prepared, prompt.context));
  } catch (error) {
    if (!prompts.includes(prompt)) return;
    prompt.phase = "review";
    prompt.error = errorMessage(error);
    emit();
  }
}
export async function checkPrompt(prompt: ReviewPrompt): Promise<void> {
  if (!prompts.includes(prompt) || prompt.phase !== "uncertain") return;
  prompt.phase = "checking";
  emit();
  try {
    const operation = await statusEffect(prompt.prepared, prompt.context);
    if (operation.status === "prepared") {
      prompt.prepared = { ...prompt.prepared, operation };
      prompt.phase = "review";
      prompt.error = operation.message;
      emit();
    } else finish(prompt, operation);
  } catch (error) {
    if (!prompts.includes(prompt)) return;
    prompt.phase = "uncertain";
    prompt.error = errorMessage(error);
    emit();
  }
}
export function closeUncertainPrompt(prompt: ReviewPrompt): void {
  if (prompt.phase !== "uncertain") return;
  if (remove(prompt))
    prompt.reject(
      new Error(
        prompt.error ??
          `Operation ${prompt.id} is unresolved; use the same request ID to check status.`,
      ),
    );
}
