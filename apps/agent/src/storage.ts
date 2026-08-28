import type {
  OpenRouterModel,
  PendingStateChangeAttempt,
  PendingStateChangeJournal,
  PersistedAgentState,
  TranscriptMessage,
} from "./chat_types.ts";
import type { ModelMessage } from "ai";

const DATABASE = "neutron-agent";
const STORE = "state";
const CURRENT = "current";
const MAX_MESSAGES = 160;
const MAX_MODELS = 600;
const MAX_TEXT = 64_000;
const MAX_MODEL_TURNS = 32;
const MAX_MODEL_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_STATE_CHANGE_ATTEMPTS = 32;
const SAFE_ATTEMPT_FIELD = /^[a-zA-Z0-9:_.-]+$/;

const emptyState = (): PersistedAgentState => ({
  selectedModelId: null,
  models: [],
  modelsFetchedAt: 0,
  messages: [],
  modelTurns: [],
  pendingStateChangeJournal: null,
});

export class AgentStorage {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<AgentStorage> {
    const request = indexedDB.open(DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    });
    return new AgentStorage(await requestResult(request));
  }

  async load(): Promise<PersistedAgentState> {
    const transaction = this.database.transaction(STORE, "readonly");
    const value = await requestResult(
      transaction.objectStore(STORE).get(CURRENT)
    );
    return normalizePersistedState(value);
  }

  async save(state: PersistedAgentState): Promise<void> {
    const transaction = this.database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(normalizeState(state), CURRENT);
    await transactionDone(transaction);
  }

  async clearConversation(state: PersistedAgentState): Promise<void> {
    await this.save({ ...state, messages: [], modelTurns: [] });
  }
}

function normalizeState(state: PersistedAgentState): PersistedAgentState {
  return {
    selectedModelId:
      typeof state.selectedModelId === "string" ? state.selectedModelId : null,
    models: state.models.slice(0, MAX_MODELS).map(normalizeModel),
    modelsFetchedAt:
      Number.isFinite(state.modelsFetchedAt) && state.modelsFetchedAt > 0
        ? state.modelsFetchedAt
        : 0,
    messages: normalizeMessages(state.messages),
    modelTurns: normalizeModelTurns(state.modelTurns),
    pendingStateChangeJournal: normalizePendingStateChangeJournal(
      state.pendingStateChangeJournal,
    ),
  };
}

export function normalizePersistedState(value: unknown): PersistedAgentState {
  if (!isRecord(value)) return emptyState();
  return normalizeState({
    selectedModelId:
      typeof value.selectedModelId === "string" ? value.selectedModelId : null,
    models: Array.isArray(value.models)
      ? value.models.filter(isRecord).map(normalizeModel)
      : [],
    modelsFetchedAt:
      typeof value.modelsFetchedAt === "number" ? value.modelsFetchedAt : 0,
    messages: normalizeMessages(value.messages),
    modelTurns: Array.isArray(value.modelTurns)
      ? normalizeModelTurns(value.modelTurns)
      : [],
    pendingStateChangeJournal: normalizePendingStateChangeJournal(
      value.pendingStateChangeJournal,
    ),
  });
}

function normalizePendingStateChangeJournal(
  value: unknown,
): PendingStateChangeJournal | null {
  if (!isRecord(value)) return null;
  const rawAttempts = Array.isArray(value.attempts) ? value.attempts : [];
  const attempts: PendingStateChangeAttempt[] = [];
  const keys = new Set<string>();
  let overflow = value.overflow === true;
  for (const candidate of rawAttempts) {
    if (!isRecord(candidate)) continue;
    const target = boundedSafeAttemptField(candidate.target, 240);
    const name = boundedSafeAttemptField(candidate.name, 128);
    if (!target || !name) continue;
    const key = `${target}\n${name}`;
    if (keys.has(key)) continue;
    if (attempts.length >= MAX_PENDING_STATE_CHANGE_ATTEMPTS) {
      overflow = true;
      continue;
    }
    keys.add(key);
    attempts.push({ target, name });
  }
  return attempts.length > 0 || overflow ? { attempts, overflow } : null;
}

function normalizeMessages(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: TranscriptMessage[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      (candidate.role !== "user" && candidate.role !== "assistant")
    ) {
      continue;
    }
    const message = normalizeMessage(candidate);
    if (message.text.trim()) messages.push(message);
  }
  return messages.slice(-MAX_MESSAGES);
}

function normalizeModel(value: Record<string, unknown>): OpenRouterModel {
  return {
    id: boundedString(value.id, 240),
    name: boundedString(value.name, 240),
    contextLength:
      typeof value.contextLength === "number" &&
      Number.isFinite(value.contextLength) &&
      value.contextLength > 0
        ? Math.floor(value.contextLength)
        : 0,
    promptPrice: boundedString(value.promptPrice, 80),
    completionPrice: boundedString(value.completionPrice, 80),
    supportsToolChoice: value.supportsToolChoice === true,
    supportsReasoning: value.supportsReasoning === true,
  };
}

export function normalizeModelTurns(value: unknown): ModelMessage[][] {
  if (!Array.isArray(value)) return [];
  const normalized: Array<{ turn: ModelMessage[]; bytes: number }> = [];
  for (const candidate of value.slice(-MAX_MODEL_TURNS)) {
    const turn = normalizeModelTurn(candidate);
    if (!turn) continue;
    const bytes = jsonBytes(turn);
    if (bytes > MAX_MODEL_HISTORY_BYTES) continue;
    normalized.push({ turn, bytes });
  }

  const selected: ModelMessage[][] = [];
  let used = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const entry = normalized[index]!;
    if (used + entry.bytes > MAX_MODEL_HISTORY_BYTES) break;
    selected.unshift(entry.turn);
    used += entry.bytes;
  }
  return selected;
}

function normalizeModelTurn(value: unknown): ModelMessage[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
  if (!Array.isArray(cloned)) return null;
  if (
    !cloned.every(
      (message) =>
        isRecord(message) &&
        (message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool") &&
        (typeof message.content === "string" || Array.isArray(message.content)),
    ) ||
    cloned[0]?.role !== "user" ||
    typeof cloned[0]?.content !== "string" ||
    cloned.slice(1).some((message) => message.role === "user")
  ) {
    return null;
  }
  return cloned as ModelMessage[];
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeMessage(value: Record<string, unknown>): TranscriptMessage {
  return {
    id: boundedString(value.id, 120) || randomId(),
    role: value.role === "user" ? "user" : "assistant",
    text: boundedString(value.text, MAX_TEXT),
  };
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function boundedSafeAttemptField(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !SAFE_ATTEMPT_FIELD.test(value)
  ) {
    return "";
  }
  return value;
}

function randomId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed"))
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"))
    );
  });
}
