import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import type {
  AgentChatTileEndpointId,
  OpenRouterModel,
  PendingStateChangeJournal,
  PersistedAgentState,
  PersistedConversationState,
} from "../src/chat_types.ts";
import {
  AgentStorage,
  requireAgentChatTileEndpoint,
} from "../src/storage.ts";

const tile = (id: string): AgentChatTileEndpointId =>
  `app:agent:tile:chat:instance:${id}`;

const conversation = (
  label: string,
  pendingStateChangeJournal: PendingStateChangeJournal | null = null,
  selectedModelId: string | null = null,
): PersistedConversationState => ({
  selectedModelId,
  messages: [
    { id: `${label}-user`, role: "user", text: `${label} question` },
    {
      id: `${label}-assistant`,
      role: "assistant",
      text: `${label} answer`,
    },
  ],
  modelTurns: [[
    { role: "user", content: `${label} question` },
    { role: "assistant", content: `${label} answer` },
  ]],
  pendingStateChangeJournal,
});

const model = (id: string): OpenRouterModel => ({
  id,
  name: `Model ${id}`,
  contextLength: 32_000,
  promptPrice: "0.000001",
  completionPrice: "0.000002",
  supportsToolChoice: true,
  supportsReasoning: false,
});

describe("Agent tile history storage", () => {
  test("accepts only authenticated Agent chat tile endpoint identities", () => {
    const valid = tile("A_b-9");
    expect(requireAgentChatTileEndpoint(valid)).toBe(valid);
    expect(
      requireAgentChatTileEndpoint(tile("x".repeat(256))),
    ).toBe(tile("x".repeat(256)));

    for (const invalid of [
      "app:agent:background",
      "app:agent:tile:chat",
      "app:agent:tile:chat:instance:",
      "app:other:tile:chat:instance:one",
      "app:agent:tile:other:instance:one",
      "app:agent:tile:chat:instance:one/two",
      "app:agent:tile:chat:instance:one.two",
      tile("x".repeat(257)),
      null,
      7,
    ]) {
      expect(() => requireAgentChatTileEndpoint(invalid)).toThrow(
        "authenticated Agent chat tile",
      );
    }
  });

  test("restores one tile across reloads without exposing it to another tile", async () => {
    const databaseName = uniqueDatabaseName("isolation");
    const first = await AgentStorage.open(databaseName);
    const tileA = tile("tile-a");
    const tileB = tile("tile-b");
    const stateA = conversation("alpha");
    const stateB = conversation("beta");

    await first.saveConversation(tileA, stateA);
    await first.saveConversation(tileB, stateB);

    const reloaded = await AgentStorage.open(databaseName);
    expect(await reloaded.loadConversation(tileA)).toEqual(stateA);
    expect(await reloaded.loadConversation(tileB)).toEqual(stateB);

    await reloaded.deleteConversation(tileA);
    expect(await reloaded.loadConversation(tileA)).toEqual({
      selectedModelId: null,
      messages: [],
      modelTurns: [],
      pendingStateChangeJournal: null,
    });
    expect(await reloaded.loadConversation(tileB)).toEqual(stateB);

    const shared = {
      selectedModelId: "provider/model",
      models: [model("provider/model")],
      modelsFetchedAt: 1_750_000_000_000,
    };
    await reloaded.saveShared(shared);
    await reloaded.saveConversation(tileA, stateA);
    await reloaded.deleteAllConversations();
    expect(await reloaded.loadConversation(tileA)).toEqual({
      selectedModelId: null,
      messages: [],
      modelTurns: [],
      pendingStateChangeJournal: null,
    });
    expect(await reloaded.loadConversation(tileB)).toEqual({
      selectedModelId: null,
      messages: [],
      modelTurns: [],
      pendingStateChangeJournal: null,
    });
    await reloaded.saveModelSelection(
      tileA,
      shared.selectedModelId!,
      shared,
    );
    expect((await reloaded.loadConversation(tileA)).messages).toEqual([]);
    expect((await reloaded.loadConversation(tileA)).modelTurns).toEqual([]);
    expect(await reloaded.loadShared()).toEqual(shared);
  });

  test("captures the current default model once for each new tile", async () => {
    const databaseName = uniqueDatabaseName("tile-models");
    const storage = await AgentStorage.open(databaseName);
    const modelA = model("provider/a");
    const modelB = model("provider/b");
    const shared = {
      selectedModelId: modelA.id,
      models: [modelA, modelB],
      modelsFetchedAt: 1,
    };
    await storage.saveShared(shared);

    const tileA = tile("model-a");
    const tileB = tile("model-b");
    expect((await storage.loadConversation(tileA, modelA.id)).selectedModelId)
      .toBe(modelA.id);

    shared.selectedModelId = modelB.id;
    await storage.saveShared(shared);
    // The storage transaction reads the current shared default even when a
    // resident still passes the stale value cached before a cross-tab change.
    expect((await storage.loadConversation(tileB, modelA.id)).selectedModelId)
      .toBe(modelB.id);
    expect((await storage.loadConversation(tileA, modelB.id)).selectedModelId)
      .toBe(modelA.id);

    await storage.saveModelSelection(tileA, modelB.id, shared);
    await storage.deleteAllConversations(modelB.id);

    const reloaded = await AgentStorage.open(databaseName);
    expect((await reloaded.loadConversation(tileA, modelA.id)).selectedModelId)
      .toBe(modelB.id);
    expect((await reloaded.loadConversation(tileB, modelA.id)).selectedModelId)
      .toBe(modelB.id);
  });

  test("keeps a tile model when a live v307 frame rewrites or clears it", async () => {
    const databaseName = uniqueDatabaseName("v307-model-fence");
    const storage = await AgentStorage.open(databaseName);
    const modelA = model("provider/a");
    const modelB = model("provider/b");
    const shared = {
      selectedModelId: modelA.id,
      models: [modelA, modelB],
      modelsFetchedAt: 1,
    };
    await storage.saveShared(shared);
    const historyId = tile("v307-model");
    expect((await storage.loadConversation(historyId)).selectedModelId).toBe(
      modelA.id,
    );

    shared.selectedModelId = modelB.id;
    await storage.saveShared(shared);
    const database = await openCurrentDatabase(databaseName);
    try {
      const transaction = database.transaction("state", "readwrite");
      const store = transaction.objectStore("state");
      const key = `conversation:${historyId}`;
      const stored = await requestValue<Record<string, unknown>>(store.get(key));
      expect("selectedModelId" in stored).toBe(false);
      expect(
        await requestValue(
          store.get(`conversation-model:${historyId}`),
        ),
      ).toBe(modelA.id);
      // v307 knows only these fields and rewrites the whole record on load.
      store.put({
        messages: stored.messages,
        modelTurns: stored.modelTurns,
        pendingStateChangeJournal: stored.pendingStateChangeJournal,
      }, key);
      await transactionDone(transaction);
    } finally {
      database.close();
    }

    expect((await storage.loadConversation(historyId)).selectedModelId).toBe(
      modelA.id,
    );

    const resetDatabase = await openCurrentDatabase(databaseName);
    try {
      const transaction = resetDatabase.transaction("state", "readwrite");
      transaction.objectStore("state").delete(`conversation:${historyId}`);
      await transactionDone(transaction);
    } finally {
      resetDatabase.close();
    }
    const cleared = await storage.loadConversation(historyId);
    expect(cleared.selectedModelId).toBe(modelA.id);
    expect(cleared.messages).toEqual([]);
  });

  test("moves the v306 flat conversation once while preserving shared model state", async () => {
    const databaseName = uniqueDatabaseName("legacy");
    const legacyModel = model("provider/legacy");
    const pendingStateChangeJournal = {
      attempts: [
        { target: "app:records:background", name: "record.update" },
      ],
      overflow: false,
    } satisfies PendingStateChangeJournal;
    const legacyConversation = conversation(
      "legacy",
      pendingStateChangeJournal,
      legacyModel.id,
    );
    const legacy = {
      models: [legacyModel],
      modelsFetchedAt: 1_750_000_000_000,
      ...legacyConversation,
    } satisfies PersistedAgentState;
    await seedLegacyState(databaseName, legacy);

    const storage = await AgentStorage.open(databaseName);
    const tileA = tile("claimant");
    const tileB = tile("new-tile");

    // A status read during another tab's live turn may inspect the old record,
    // but must not choose which tile owns it.
    expect(await storage.peekConversation(tileA)).toEqual(legacyConversation);
    expect(await storage.peekConversation(tileB)).toEqual(legacyConversation);

    // Loading the conversation first must still preserve the global model
    // catalog before the legacy record is consumed.
    expect(await storage.loadConversation(tileA)).toEqual(legacyConversation);
    expect(await storage.loadShared()).toEqual({
      selectedModelId: legacyModel.id,
      models: [legacyModel],
      modelsFetchedAt: 1_750_000_000_000,
    });
    expect(await storage.loadConversation(tileB)).toEqual({
      selectedModelId: legacyModel.id,
      messages: [],
      modelTurns: [],
      pendingStateChangeJournal: null,
    });

    const reloaded = await AgentStorage.open(databaseName);
    expect(await reloaded.loadConversation(tileA)).toEqual(legacyConversation);
    expect(await reloaded.loadConversation(tileB)).toEqual({
      selectedModelId: legacyModel.id,
      messages: [],
      modelTurns: [],
      pendingStateChangeJournal: null,
    });
    expect(
      (await reloaded.loadConversation(tileA)).pendingStateChangeJournal,
    ).toEqual(pendingStateChangeJournal);

  });

  test("waits for a live v306 database before claiming its final state", async () => {
    const databaseName = uniqueDatabaseName("legacy-open-fence");
    const legacyDatabase = await openDatabase(databaseName);
    const legacy = {
      models: [],
      modelsFetchedAt: 0,
      ...conversation("legacy-final"),
    } satisfies PersistedAgentState;
    let upgraded = false;
    const pendingUpgrade = AgentStorage.open(databaseName).then((storage) => {
      upgraded = true;
      return storage;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upgraded).toBe(false);

    const transaction = legacyDatabase.transaction("state", "readwrite");
    transaction.objectStore("state").put(legacy, "current");
    await transactionDone(transaction);
    legacyDatabase.close();
    const storage = await pendingUpgrade;
    expect(await storage.loadConversation(tile("claim-final"))).toEqual(
      conversation("legacy-final"),
    );
  });

  test("atomically gives a legacy conversation to only one concurrent tile", async () => {
    const databaseName = uniqueDatabaseName("legacy-race");
    const legacyConversation = conversation("race");
    await seedLegacyState(databaseName, {
      models: [],
      modelsFetchedAt: 0,
      ...legacyConversation,
    });
    const storageA = await AgentStorage.open(databaseName);
    const storageB = await AgentStorage.open(databaseName);

    const results = await Promise.all([
      storageA.loadConversation(tile("race-a")),
      storageB.loadConversation(tile("race-b")),
    ]);

    expect(results.filter((state) => state.messages.length > 0)).toHaveLength(1);
    expect(results.find((state) => state.messages.length > 0)).toEqual(
      legacyConversation,
    );
    expect(results.filter((state) => state.messages.length === 0)).toHaveLength(1);
  });

});

function uniqueDatabaseName(label: string): string {
  return `agent-storage-test-${label}-${crypto.randomUUID()}`;
}

async function seedLegacyState(
  databaseName: string,
  state: PersistedAgentState,
): Promise<void> {
  const database = await openDatabase(databaseName);
  try {
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(state, "current");
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("state")) {
        request.result.createObjectStore("state");
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Test database open failed")),
    );
  });
}

function openCurrentDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Test database open failed")),
    );
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Test IndexedDB request failed")),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Test transaction aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Test transaction failed")),
    );
  });
}
