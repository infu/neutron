import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { decodeKnownCall, errorMessage, type Operation } from "./data.ts";
import {
  executeEffect,
  operationJson,
  parseEffect,
  prepareEffect,
  rejectEffect,
  refreshReviewEvidence,
  statusEffect,
  type Prepared,
  type ProviderKind,
  type ProviderRequest,
} from "./provider.ts";
export type PreparingReview = {
  kind: ProviderKind;
  request: ProviderRequest;
  startedAt: number;
};
export type ReviewPrompt = {
  id: string;
  prepared: Prepared;
  context: MsgBusToolContext;
  phase: "review" | "loading_evidence" | "executing" | "checking" | "uncertain";
  error: string | null;
  resolve: (value: JsonObject) => void;
  reject: (error: unknown) => void;
  removeAbort: () => void;
};
let prompts: ReviewPrompt[] = [];
let preparations: PreparingReview[] = [];
const listeners = new Set<() => void>();
export const subscribePrompts = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getPrompts = () => prompts;
export const getPreparations = () => preparations;
function emit() {
  prompts = [...prompts];
  preparations = [...preparations];
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
  return queueReview(kind, args, context);
}
export async function presentOwnEffect(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  context.signal?.throwIfAborted();
  const caller = requireEvmWalletCaller(context);
  if (context.agentMode)
    throw new Error("EVM Wallet owner review is unavailable to Agent invocations");
  if (
    caller.appId !== "evm_wallet" ||
    context.caller!.role !== "background" ||
    context.caller!.endpoint !== "app:evm_wallet:background"
  )
    throw new Error("EVM Wallet owner review requires its authenticated resident service");
  return queueReview(kind, args, context);
}
async function queueReview(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  // Display preparation as soon as the authenticated foreground handler starts.
  // There is no approval yet: the exact gas, nonce and simulation must arrive first.
  const preparation = { kind, request: parseEffect(kind, args), startedAt: Date.now() };
  const removePreparation = () => {
    preparations = preparations.filter((entry) => entry !== preparation);
    emit();
  };
  preparations.push(preparation);
  context.signal?.addEventListener("abort", removePreparation, { once: true });
  emit();
  let prepared: Prepared;
  try {
    prepared = await prepareEffect(kind, args, context);
  } finally {
    context.signal?.removeEventListener("abort", removePreparation);
    removePreparation();
  }
  if (prepared.operation.status !== "prepared")
    return operationJson(prepared.operation);
  const tx = prepared.operation.preparedTransaction ?? prepared.operation.intent.transaction;
  const needsEvidence = !!(tx && decodeKnownCall(tx.data));
  const id = prepared.operation.operationId;
  if (prompts.some((p) => p.id === id))
    throw new Error("This EVM request is already awaiting review");
  return new Promise((resolve, reject) => {
    const prompt: ReviewPrompt = {
      id,
      prepared,
      context,
      phase: needsEvidence ? "loading_evidence" : "review",
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
    // Saved observations are a separate read. Keep the prepared transaction
    // visible while it finishes instead of hiding the entire review behind it.
    if (needsEvidence && prompts.includes(prompt)) void loadPromptEvidence(prompt);
  });
}
async function loadPromptEvidence(prompt: ReviewPrompt): Promise<void> {
  try {
    const operation = await refreshReviewEvidence(prompt.prepared, prompt.context, false);
    if (!prompts.includes(prompt)) return;
    if (operation.status !== "prepared") {
      finish(prompt, operation);
      return;
    }
    prompt.prepared = { ...prompt.prepared, operation };
  } catch (error) {
    if (!prompts.includes(prompt)) return;
    prompt.error = `Saved token observations could not be loaded. ${errorMessage(error)}`;
  }
  prompt.phase = "review";
  emit();
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
      const tx = operation.preparedTransaction ?? operation.intent.transaction;
      if (tx && decodeKnownCall(tx.data)) {
        try {
          prompt.prepared = { ...prompt.prepared, operation: await refreshReviewEvidence(prompt.prepared, prompt.context, false) };
        } catch { /* Keep missing observations explicit in the revised review. */ }
        if (!prompts.includes(prompt)) return;
        if (prompt.prepared.operation.status !== "prepared") {
          finish(prompt, prompt.prepared.operation);
          return;
        }
      }
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
export async function refreshPromptEvidence(prompt: ReviewPrompt): Promise<void> {
  if (!prompts.includes(prompt) || prompt.phase !== "review") return;
  prompt.phase = "checking";
  prompt.error = null;
  emit();
  try {
    const operation = await refreshReviewEvidence(prompt.prepared, prompt.context);
    if (!prompts.includes(prompt)) return;
    if (operation.status !== "prepared") {
      finish(prompt, operation);
      return;
    }
    prompt.prepared = { ...prompt.prepared, operation };
    prompt.phase = "review";
    emit();
  } catch (error) {
    if (!prompts.includes(prompt)) return;
    prompt.phase = "review";
    prompt.error = `Token observations could not be refreshed. ${errorMessage(error)}`;
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
      const tx = operation.preparedTransaction ?? operation.intent.transaction;
      if (tx && decodeKnownCall(tx.data)) {
        try {
          prompt.prepared = {
            ...prompt.prepared,
            operation: await refreshReviewEvidence(prompt.prepared, prompt.context, false),
          };
        } catch { /* Missing observations stay explicit and can be refreshed. */ }
        if (!prompts.includes(prompt)) return;
        if (prompt.prepared.operation.status !== "prepared") {
          finish(prompt, prompt.prepared.operation);
          return;
        }
      }
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
