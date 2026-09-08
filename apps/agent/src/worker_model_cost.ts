import type { OpenRouterModel } from "./chat_types.ts";

function knownPrice(value: string): number | null {
  if (!value.trim()) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/** Compare both token rates: a cheaper input rate cannot offset a higher
 * output rate when the worker's eventual token usage is not known. */
export function isWorkerModelAllowed(
  parentModelId: string,
  candidate: OpenRouterModel,
  models: readonly OpenRouterModel[],
): boolean {
  if (candidate.id === parentModelId) return true;
  // OpenRouter author namespaces share one provider. Subscription IDs have a
  // separate namespace and must never implicitly spend OpenRouter credits.
  if (candidate.id.startsWith("chatgpt/") !== parentModelId.startsWith("chatgpt/")) return false;
  const parent = models.find((model) => model.id === parentModelId);
  if (!parent) return false;
  const parentPrompt = knownPrice(parent.promptPrice);
  const parentCompletion = knownPrice(parent.completionPrice);
  const candidatePrompt = knownPrice(candidate.promptPrice);
  const candidateCompletion = knownPrice(candidate.completionPrice);
  return parentPrompt !== null && parentCompletion !== null
    && candidatePrompt !== null && candidateCompletion !== null
    && candidatePrompt <= parentPrompt && candidateCompletion <= parentCompletion;
}
