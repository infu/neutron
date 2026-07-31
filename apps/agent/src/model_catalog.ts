import type { OpenRouterModel } from "./chat_types.ts";

// Pure catalog helpers stay independent from the React picker for fast tests.

const AUTHOR_LABELS: Record<string, string> = {
  ai21: "AI21",
  amazon: "Amazon",
  anthropic: "Anthropic",
  "arcee-ai": "Arcee AI",
  "bytedance-seed": "ByteDance",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  google: "Google",
  "meta-llama": "Meta",
  microsoft: "Microsoft",
  minimax: "MiniMax",
  mistralai: "Mistral",
  moonshotai: "Moonshot AI",
  nousresearch: "Nous Research",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  perplexity: "Perplexity",
  qwen: "Qwen",
  "x-ai": "xAI",
  "z-ai": "Z.AI",
};

export type ModelFilterOptions = {
  query?: string;
  reasoningOnly?: boolean;
  freeOnly?: boolean;
  limit?: number;
};

export type ModelFilterResult = {
  items: OpenRouterModel[];
  total: number;
};

export function filterModels(
  models: OpenRouterModel[],
  {
    query = "",
    reasoningOnly = false,
    freeOnly = false,
    limit = 600,
  }: ModelFilterOptions = {},
): ModelFilterResult {
  const normalizedQuery = normalizeSearch(query);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const scored: Array<{ model: OpenRouterModel; score: number }> = [];

  for (const model of models) {
    if (reasoningOnly && !model.supportsReasoning) continue;
    if (freeOnly && !isFreeModel(model)) continue;

    const authorId = modelAuthorId(model);
    const author = modelAuthorLabel(model);
    const name = normalizeSearch(model.name);
    const displayName = normalizeSearch(modelDisplayName(model));
    const id = normalizeSearch(model.id);
    const authorSearch = normalizeSearch(`${authorId} ${author}`);
    const haystack = `${name} ${displayName} ${id} ${authorSearch}`;
    if (!terms.every((term) => haystack.includes(term))) continue;

    let score = 20;
    if (!normalizedQuery) score = 10;
    else if (
      name === normalizedQuery ||
      displayName === normalizedQuery ||
      id === normalizedQuery
    ) {
      score = 0;
    }
    else if (name.startsWith(normalizedQuery) || displayName.startsWith(normalizedQuery)) {
      score = 1;
    }
    else if (id.startsWith(normalizedQuery)) score = 2;
    else if (authorSearch.startsWith(normalizedQuery)) score = 3;
    else {
      score = terms.reduce((total, term) => {
        const nameIndex = name.indexOf(term);
        const idIndex = id.indexOf(term);
        const authorIndex = authorSearch.indexOf(term);
        const best = Math.min(
          nameIndex < 0 ? 1_000 : nameIndex,
          idIndex < 0 ? 1_000 : idIndex + 8,
          authorIndex < 0 ? 1_000 : authorIndex + 12,
        );
        return total + best;
      }, 10);
    }
    scored.push({ model, score });
  }

  scored.sort(
    (left, right) =>
      left.score - right.score ||
      left.model.name.localeCompare(right.model.name) ||
      left.model.id.localeCompare(right.model.id),
  );
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(600, Math.floor(limit)))
    : 600;
  return {
    items: scored.slice(0, boundedLimit).map((entry) => entry.model),
    total: scored.length,
  };
}

export function modelAuthorId(model: Pick<OpenRouterModel, "id">): string {
  const separator = model.id.indexOf("/");
  return separator > 0 ? model.id.slice(0, separator) : "openrouter";
}

export function modelAuthorLabel(model: Pick<OpenRouterModel, "id">): string {
  const id = modelAuthorId(model);
  return (
    AUTHOR_LABELS[id] ??
    id
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function modelDisplayName(
  model: Pick<OpenRouterModel, "id" | "name">,
): string {
  const name = model.name.trim();
  const normalizedName = name.toLowerCase();
  const prefixes = [modelAuthorLabel(model), modelAuthorId(model)];
  for (const prefix of prefixes) {
    const marker = `${prefix.toLowerCase()}:`;
    if (normalizedName.startsWith(marker)) {
      return name.slice(marker.length).trim() || name;
    }
  }
  return name;
}

export function modelAuthorInitials(
  model: Pick<OpenRouterModel, "id">,
): string {
  const label = modelAuthorLabel(model);
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }
  return label.slice(0, 2).toUpperCase() || "OR";
}

export function modelAuthorTone(model: Pick<OpenRouterModel, "id">): number {
  let hash = 0;
  for (const character of modelAuthorId(model)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % 6;
}

export function isFreeModel(
  model: Pick<OpenRouterModel, "promptPrice" | "completionPrice">,
): boolean {
  if (!model.promptPrice.trim() || !model.completionPrice.trim()) return false;
  const prompt = Number(model.promptPrice);
  const completion = Number(model.completionPrice);
  return (
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt === 0 &&
    completion === 0
  );
}

export function formatModelPrice(value: string): string {
  if (!value.trim()) return "Unknown";
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return "Unknown";
  const perMillion = perToken * 1_000_000;
  if (perMillion === 0) return "$0/M";
  const formatted = Number(perMillion.toPrecision(4)).toString();
  return `$${formatted}/M`;
}

export function formatModelContext(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Unknown context";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M context`;
  }
  return `${Math.round(value / 1_000)}K context`;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}
