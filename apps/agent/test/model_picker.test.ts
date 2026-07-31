import { expect, test } from "bun:test";
import type { OpenRouterModel } from "../src/chat_types.ts";
import {
  filterModels,
  formatModelContext,
  formatModelPrice,
  isFreeModel,
  modelAuthorId,
  modelAuthorInitials,
  modelAuthorLabel,
  modelAuthorTone,
  modelDisplayName,
} from "../src/model_catalog.ts";

const model = (
  id: string,
  name: string,
  overrides: Partial<OpenRouterModel> = {},
): OpenRouterModel => ({
  id,
  name,
  contextLength: 128_000,
  promptPrice: "0.000003",
  completionPrice: "0.000015",
  supportsReasoning: false,
  supportsToolChoice: true,
  ...overrides,
});

const catalog = [
  model("anthropic/claude-sonnet-4", "Claude Sonnet 4", {
    contextLength: 200_000,
    supportsReasoning: true,
  }),
  model("openai/gpt-5-mini", "GPT-5 Mini", { supportsReasoning: true }),
  model("meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B Instruct", {
    promptPrice: "0",
    completionPrice: "0",
  }),
  model("mistralai/mistral-small", "Mistral Small"),
];

test("model author helpers derive friendly, stable identities", () => {
  expect(modelAuthorId(catalog[0]!)).toBe("anthropic");
  expect(modelAuthorLabel(catalog[0]!)).toBe("Anthropic");
  expect(modelAuthorLabel(catalog[2]!)).toBe("Meta");
  expect(modelAuthorLabel(model("new-model-lab/example", "Example"))).toBe(
    "New Model Lab",
  );
  expect(modelAuthorInitials(model("new-model-lab/example", "Example"))).toBe("NM");
  expect(
    modelDisplayName(model("anthropic/claude-sonnet-4", "Anthropic: Claude Sonnet 4")),
  ).toBe("Claude Sonnet 4");
  expect(modelDisplayName(model("openai/gpt", "GPT"))).toBe("GPT");
  expect(modelAuthorTone(catalog[0]!)).toBe(modelAuthorTone(catalog[0]!));
  expect(modelAuthorTone(catalog[0]!)).toBeGreaterThanOrEqual(0);
  expect(modelAuthorTone(catalog[0]!)).toBeLessThan(6);
});

test("model search matches names, exact ids, and publishers across terms", () => {
  expect(filterModels(catalog, { query: "sonnet" }).items.map(({ id }) => id)).toEqual([
    "anthropic/claude-sonnet-4",
  ]);
  expect(filterModels(catalog, { query: "OPENAI gpt" }).items.map(({ id }) => id)).toEqual([
    "openai/gpt-5-mini",
  ]);
  expect(filterModels(catalog, { query: "meta instruct" }).items.map(({ id }) => id)).toEqual([
    "meta-llama/llama-3.3-70b-instruct:free",
  ]);
  expect(
    filterModels(catalog, { query: "anthropic/claude-sonnet-4" }).items[0]?.id,
  ).toBe("anthropic/claude-sonnet-4");
});

test("model search ranks exact and prefix matches before contains matches", () => {
  const models = [
    model("lab/other-nova", "Other Nova"),
    model("lab/nova-pro", "Nova Pro"),
    model("lab/nova", "Nova"),
  ];
  expect(filterModels(models, { query: "nova" }).items.map(({ name }) => name)).toEqual([
    "Nova",
    "Nova Pro",
    "Other Nova",
  ]);
});

test("reasoning and free filters compose without mutating the catalog", () => {
  const before = catalog.map(({ id }) => id);
  expect(filterModels(catalog, { reasoningOnly: true }).total).toBe(2);
  expect(filterModels(catalog, { freeOnly: true }).items.map(({ id }) => id)).toEqual([
    "meta-llama/llama-3.3-70b-instruct:free",
  ]);
  expect(filterModels(catalog, { freeOnly: true, reasoningOnly: true }).total).toBe(0);
  expect(catalog.map(({ id }) => id)).toEqual(before);
});

test("model results expose the full supported catalog with a safe upper bound", () => {
  const largeCatalog = Array.from({ length: 605 }, (_, index) =>
    model(`lab/model-${index}`, `Model ${index.toString().padStart(3, "0")}`),
  );
  expect(filterModels(largeCatalog).total).toBe(605);
  expect(filterModels(largeCatalog).items).toHaveLength(600);
  expect(filterModels(largeCatalog, { limit: 2 }).items).toHaveLength(2);
  expect(filterModels(largeCatalog, { limit: Number.NaN }).items).toHaveLength(600);
});

test("free status requires valid zero input and output prices", () => {
  expect(isFreeModel(model("lab/free", "Free", {
    promptPrice: "0",
    completionPrice: "0.000000",
  }))).toBe(true);
  expect(isFreeModel(model("lab/partial", "Partial", {
    promptPrice: "0",
    completionPrice: "0.1",
  }))).toBe(false);
  expect(isFreeModel(model("lab/unknown", "Unknown", {
    promptPrice: "",
    completionPrice: "0",
  }))).toBe(false);
});

test("price formatting is precise and labels per-million-token values", () => {
  expect(formatModelPrice("0")).toBe("$0/M");
  expect(formatModelPrice("0.00001049")).toBe("$10.49/M");
  expect(formatModelPrice("0.00001050")).toBe("$10.5/M");
  expect(formatModelPrice("0.000000025")).toBe("$0.025/M");
  expect(formatModelPrice("0.000000075")).toBe("$0.075/M");
  expect(formatModelPrice("0.000000005")).toBe("$0.005/M");
  expect(formatModelPrice("")).toBe("Unknown");
  expect(formatModelPrice("nope")).toBe("Unknown");
  expect(formatModelPrice("-1")).toBe("Unknown");
});

test("context formatting stays compact", () => {
  expect(formatModelContext(128_000)).toBe("128K context");
  expect(formatModelContext(1_000_000)).toBe("1M context");
  expect(formatModelContext(1_500_000)).toBe("1.5M context");
  expect(formatModelContext(0)).toBe("Unknown context");
});
