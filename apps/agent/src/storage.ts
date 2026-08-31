import type { ModelMessage } from "ai";
import type {
  AgentChatTileEndpointId,
  OpenRouterModel,
  PendingStateChangeAttempt,
  PendingStateChangeJournal,
  PersistedAgentSharedState,
  PersistedAgentState,
  PersistedConversationState,
  TranscriptMessage,
} from "./chat_types.ts";

const DATABASE = "neutron-agent";
// Opening v2 fences the released flat-history runtime: IndexedDB will not run
// this upgrade until every live v1 connection has closed, so its final write
// is visible before one tile claims the legacy conversation.
const DATABASE_VERSION = 2;
const STORE = "state";
const LEGACY_CURRENT = "current";
const LEGACY_CONVERSATION_CLAIMED = "legacy-conversation-claimed";
const SHARED = "shared";
const CONVERSATION_PREFIX = "conversation:";
// v307 rewrites conversation records, so keep the v308 tile model outside
// that record while old frames finish closing during an upgrade.
const CONVERSATION_MODEL_PREFIX = "conversation-model:";
const MAX_MESSAGES = 160;
const MAX_MODELS = 600;
const MAX_TEXT = 64_000;
const MAX_MODEL_TURNS = 32;
const MAX_MODEL_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_VISIBLE_TRANSCRIPT_BYTES = 544 * 1024;
const MAX_MODEL_CATALOG_BYTES = 256 * 1024;
export const MAX_PENDING_STATE_CHANGE_ATTEMPTS = 32;
const SAFE_ATTEMPT_FIELD = /^[a-zA-Z0-9:_.-]+$/;
const AGENT_CHAT_TILE_ENDPOINT =
  /^app:agent:tile:chat:instance:[a-zA-Z0-9_-]{1,256}$/;

const emptySharedState = (): PersistedAgentSharedState => ({
  selectedModelId: null,
  models: [],
  modelsFetchedAt: 0,
});

export const emptyConversationState = (
  selectedModelId: string | null = null,
): PersistedConversationState => ({
  selectedModelId,
  messages: [],
  modelTurns: [],
  pendingStateChangeJournal: null,
});

export class AgentStorage {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(databaseName = DATABASE): Promise<AgentStorage> {
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    });
    return new AgentStorage(await requestResult(request));
  }

  async loadShared(): Promise<PersistedAgentSharedState> {
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const current = await requestResult(store.get(SHARED));
    const value =
      current === undefined
        ? await requestResult(store.get(LEGACY_CURRENT))
        : current;
    const normalized = normalizePersistedSharedState(value);
    store.put(normalized, SHARED);
    await transactionDone(transaction);
    return normalized;
  }

  async saveShared(state: PersistedAgentSharedState): Promise<void> {
    const transaction = this.database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(
      normalizePersistedSharedState(state),
      SHARED,
    );
    await transactionDone(transaction);
  }

  async loadConversation(
    historyId: AgentChatTileEndpointId,
    inheritedModelId: string | null = null,
  ): Promise<PersistedConversationState> {
    const id = requireAgentChatTileEndpoint(historyId);
    const key = conversationKey(id);
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const storedShared = await requestResult(store.get(SHARED));
    let defaultModelId =
      storedShared === undefined
        ? inheritedModelId
        : normalizePersistedSharedState(storedShared).selectedModelId;
    const storedModelId = await requestResult(
      store.get(conversationModelKey(id)),
    );
    const stored = await requestResult(store.get(key));
    if (stored !== undefined) {
      const conversation = conversationWithModelSelection(
        stored,
        defaultModelId,
        storedModelId,
      );
      store.put(conversationRecord(conversation), key);
      store.put(conversation.selectedModelId, conversationModelKey(id));
      store.put(true, LEGACY_CONVERSATION_CLAIMED);
      store.delete(LEGACY_CURRENT);
      await transactionDone(transaction);
      return conversation;
    }

    if (
      (await requestResult(store.get(LEGACY_CONVERSATION_CLAIMED))) === true
    ) {
      store.delete(LEGACY_CURRENT);
      const conversation = conversationWithModelSelection(
        undefined,
        defaultModelId,
        storedModelId,
      );
      store.put(conversationRecord(conversation), key);
      store.put(conversation.selectedModelId, conversationModelKey(id));
      await transactionDone(transaction);
      return conversation;
    }

    const legacy = await requestResult(store.get(LEGACY_CURRENT));
    if (legacy !== undefined && storedShared === undefined) {
      const legacyShared = normalizePersistedSharedState(legacy);
      store.put(legacyShared, SHARED);
      defaultModelId = legacyShared.selectedModelId;
    }
    const claimed = legacyConversation(legacy, defaultModelId, storedModelId);
    const conversation = claimed ?? conversationWithModelSelection(
      undefined,
      defaultModelId,
      storedModelId,
    );
    store.put(true, LEGACY_CONVERSATION_CLAIMED);
    store.delete(LEGACY_CURRENT);
    store.put(conversationRecord(conversation), key);
    store.put(conversation.selectedModelId, conversationModelKey(id));
    await transactionDone(transaction);
    return conversation;
  }

  async peekConversation(
    historyId: AgentChatTileEndpointId,
    inheritedModelId: string | null = null,
  ): Promise<PersistedConversationState> {
    const id = requireAgentChatTileEndpoint(historyId);
    const key = conversationKey(id);
    const transaction = this.database.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const storedShared = await requestResult(store.get(SHARED));
    const defaultModelId =
      storedShared === undefined
        ? inheritedModelId
        : normalizePersistedSharedState(storedShared).selectedModelId;
    const storedModelId = await requestResult(
      store.get(conversationModelKey(id)),
    );
    const stored = await requestResult(store.get(key));
    if (stored !== undefined) {
      return conversationWithModelSelection(
        stored,
        defaultModelId,
        storedModelId,
      );
    }
    if (
      (await requestResult(store.get(LEGACY_CONVERSATION_CLAIMED))) === true
    ) {
      return conversationWithModelSelection(
        undefined,
        defaultModelId,
        storedModelId,
      );
    }
    return legacyConversation(
      await requestResult(store.get(LEGACY_CURRENT)),
      defaultModelId,
      storedModelId,
    ) ?? conversationWithModelSelection(
      undefined,
      defaultModelId,
      storedModelId,
    );
  }

  async saveConversation(
    historyId: AgentChatTileEndpointId,
    state: PersistedConversationState,
  ): Promise<void> {
    const id = requireAgentChatTileEndpoint(historyId);
    const key = conversationKey(id);
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const conversation = normalizePersistedConversationState(state);
    store.put(conversationRecord(conversation), key);
    store.put(conversation.selectedModelId, conversationModelKey(id));
    store.put(true, LEGACY_CONVERSATION_CLAIMED);
    store.delete(LEGACY_CURRENT);
    await transactionDone(transaction);
  }

  async saveModelSelection(
    historyId: AgentChatTileEndpointId,
    selectedModelId: string,
    shared: PersistedAgentSharedState,
  ): Promise<PersistedConversationState> {
    const id = requireAgentChatTileEndpoint(historyId);
    const key = conversationKey(id);
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const conversation = conversationWithModelSelection(
      await requestResult(store.get(key)),
      shared.selectedModelId,
      await requestResult(store.get(conversationModelKey(id))),
    );
    conversation.selectedModelId = boundedString(selectedModelId, 240);
    store.put(normalizePersistedSharedState(shared), SHARED);
    store.put(conversationRecord(conversation), key);
    store.put(conversation.selectedModelId, conversationModelKey(id));
    store.put(true, LEGACY_CONVERSATION_CLAIMED);
    store.delete(LEGACY_CURRENT);
    await transactionDone(transaction);
    return conversation;
  }

  async deleteConversation(
    historyId: AgentChatTileEndpointId,
  ): Promise<void> {
    const id = requireAgentChatTileEndpoint(historyId);
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.delete(conversationKey(id));
    store.delete(conversationModelKey(id));
    await transactionDone(transaction);
  }

  async deleteAllConversations(
    inheritedModelId: string | null = null,
  ): Promise<void> {
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const storedShared = await requestResult(store.get(SHARED));
    const defaultModelId =
      storedShared === undefined
        ? inheritedModelId
        : normalizePersistedSharedState(storedShared).selectedModelId;
    const keys = await requestResult(store.getAllKeys());
    for (const key of keys) {
      if (typeof key === "string" && key.startsWith(CONVERSATION_PREFIX)) {
        const id = requireAgentChatTileEndpoint(
          key.slice(CONVERSATION_PREFIX.length),
        );
        const current = conversationWithModelSelection(
          await requestResult(store.get(key)),
          defaultModelId,
          await requestResult(store.get(conversationModelKey(id))),
        );
        store.put(
          conversationRecord(emptyConversationState(current.selectedModelId)),
          key,
        );
        store.put(current.selectedModelId, conversationModelKey(id));
      }
    }
    store.delete(LEGACY_CURRENT);
    store.put(true, LEGACY_CONVERSATION_CLAIMED);
    await transactionDone(transaction);
  }
}

export function requireAgentChatTileEndpoint(
  value: unknown,
): AgentChatTileEndpointId {
  if (typeof value !== "string" || !AGENT_CHAT_TILE_ENDPOINT.test(value)) {
    throw new Error("Agent controls require an authenticated Agent chat tile");
  }
  return value as AgentChatTileEndpointId;
}

export function normalizePersistedSharedState(
  value: unknown,
): PersistedAgentSharedState {
  if (!isRecord(value)) return emptySharedState();
  const selectedModelId =
    typeof value.selectedModelId === "string" ? value.selectedModelId : null;
  const models = Array.isArray(value.models)
    ? value.models.filter(isRecord).slice(0, MAX_MODELS).map(normalizeModel)
    : [];
  return {
    selectedModelId,
    models: boundModelCatalog(models, selectedModelId),
    modelsFetchedAt:
      typeof value.modelsFetchedAt === "number" &&
      Number.isFinite(value.modelsFetchedAt) &&
      value.modelsFetchedAt > 0
        ? value.modelsFetchedAt
        : 0,
  };
}

export function normalizePersistedConversationState(
  value: unknown,
  inheritedModelId: string | null = null,
): PersistedConversationState {
  if (!isRecord(value)) return emptyConversationState(inheritedModelId);
  return {
    selectedModelId:
      typeof value.selectedModelId === "string"
        ? boundedString(value.selectedModelId, 240)
        : "selectedModelId" in value
          ? null
          : inheritedModelId,
    messages: normalizeMessages(value.messages),
    modelTurns: normalizeModelTurns(value.modelTurns),
    pendingStateChangeJournal: normalizePendingStateChangeJournal(
      value.pendingStateChangeJournal,
    ),
  };
}

/** Normalize the exact flat record written by Agent releases through v0.3.6. */
export function normalizePersistedState(value: unknown): PersistedAgentState {
  return {
    ...normalizePersistedSharedState(value),
    ...normalizePersistedConversationState(value),
  };
}

function legacyConversation(
  value: unknown,
  inheritedModelId: string | null = null,
  storedModelId: unknown = undefined,
): PersistedConversationState | null {
  const conversation = conversationWithModelSelection(
    value,
    inheritedModelId,
    storedModelId,
  );
  return conversation.messages.length > 0 ||
    conversation.modelTurns.length > 0 ||
    conversation.pendingStateChangeJournal !== null
    ? conversation
    : null;
}

function conversationKey(historyId: AgentChatTileEndpointId): string {
  return `${CONVERSATION_PREFIX}${historyId}`;
}

function conversationModelKey(historyId: AgentChatTileEndpointId): string {
  return `${CONVERSATION_MODEL_PREFIX}${historyId}`;
}

function modelSelection(
  stored: unknown,
  fallback: string | null,
): string | null {
  return stored === null
    ? null
    : typeof stored === "string"
      ? boundedString(stored, 240)
      : fallback;
}

function conversationWithModelSelection(
  value: unknown,
  inheritedModelId: string | null,
  storedModelId: unknown,
): PersistedConversationState {
  const conversation = normalizePersistedConversationState(
    value,
    inheritedModelId,
  );
  conversation.selectedModelId = modelSelection(
    storedModelId,
    conversation.selectedModelId,
  );
  return conversation;
}

function conversationRecord(
  state: PersistedConversationState,
): Omit<PersistedConversationState, "selectedModelId"> {
  const normalized = normalizePersistedConversationState(state);
  return {
    messages: normalized.messages,
    modelTurns: normalized.modelTurns,
    pendingStateChangeJournal: normalized.pendingStateChangeJournal,
  };
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

export function boundTranscriptMessages(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const units: TranscriptMessage[][] = [];
  for (const message of messages.slice(-MAX_MESSAGES)) {
    if (message.role === "user" || units.length === 0) {
      units.push([message]);
    } else {
      units.at(-1)!.push(message);
    }
  }
  const selected: TranscriptMessage[][] = [];
  let used = 2;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    const bytes = jsonBytes(unit);
    if (used + bytes <= MAX_VISIBLE_TRANSCRIPT_BYTES) {
      selected.unshift(unit);
      used += bytes;
      continue;
    }
    if (selected.length === 0) {
      const newest: TranscriptMessage[] = [];
      for (let messageIndex = unit.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = unit[messageIndex]!;
        const messageBytes = jsonBytes(message);
        if (used + messageBytes <= MAX_VISIBLE_TRANSCRIPT_BYTES) {
          newest.unshift(message);
          used += messageBytes;
        }
      }
      if (newest.length > 0) selected.unshift(newest);
    }
    break;
  }
  return selected.flat();
}

export function boundModelCatalog(
  models: readonly OpenRouterModel[],
  selectedModelId: string | null = null,
): OpenRouterModel[] {
  const unique = new Map<string, OpenRouterModel>();
  for (const model of models.slice(0, MAX_MODELS)) {
    if (model.id && !unique.has(model.id)) unique.set(model.id, model);
  }
  const preferred = selectedModelId ? unique.get(selectedModelId) : undefined;
  let used = 2 + (preferred ? jsonBytes(preferred) : 0);
  const retained = new Set(preferred ? [preferred.id] : []);
  for (const model of unique.values()) {
    if (retained.has(model.id)) continue;
    const bytes = jsonBytes(model);
    if (used + bytes + 1 > MAX_MODEL_CATALOG_BYTES) continue;
    retained.add(model.id);
    used += bytes + 1;
  }
  return Array.from(unique.values()).filter((model) => retained.has(model.id));
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
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed")),
    );
  });
}
