import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import type { JsonValue } from "neutron-tools/app";
import {
  BLAST_COLLECTION_LIMIT,
  BLAST_RUN_BUDGETS,
  BLAST_TERMINAL_RUN_RETENTION,
  BlastDatabaseError,
  canonicalJson,
  classifyBlastDatabaseError,
  openBlastDatabase,
  type BlastDatabase,
  type CollectionIdentity,
  type CreateCollectionInput,
  type RunHandle,
} from "../src/database.ts";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "../src/limits.ts";

let databaseSequence = 0;

type TestDatabase = Readonly<{
  database: BlastDatabase;
  name: string;
  clock: { now: number };
}>;

async function openTestDatabase(
  name = `neutron-blast-test-${(databaseSequence += 1)}`,
  clock = { now: 1_000 },
): Promise<TestDatabase> {
  let id = 0;
  const database = await openBlastDatabase({
    databaseName: name,
    now: () => clock.now,
    idFactory: (prefix) => `${prefix}_${(id += 1)}`,
  });
  return { database, name, clock };
}

async function editRawRecord(
  databaseName: string,
  storeName: "collections" | "pages" | "runs" | "checkpoints",
  key: IDBValidKey,
  edit: (value: unknown) => unknown,
): Promise<void> {
  const raw = await openDB(databaseName);
  try {
    const transaction = raw.transaction(storeName, "readwrite");
    const value = await transaction.store.get(key);
    await transaction.store.put(edit(value));
    await transaction.done;
  } finally {
    raw.close();
  }
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const LOCAL_IDENTITY: CollectionIdentity = Object.freeze({
  mode: "local",
  principal: "aaaaa-aa",
});

function createTestCollection(
  database: BlastDatabase,
  input: Omit<CreateCollectionInput, "identity"> & {
    identity?: CollectionIdentity;
  },
) {
  return database.createCollection({ identity: LOCAL_IDENTITY, ...input });
}

function handle(run: { id: string; sessionId: string }): RunHandle {
  return { runId: run.id, sessionId: run.sessionId };
}

describe("Blast collection database", () => {
  test("preserves nested JSON and paginates bounded catalogue and page reads", async () => {
    const { database } = await openTestDatabase();
    try {
      const first = await createTestCollection(database, {
        name: "Governance pages",
        description: "Raw nested responses",
        kind: "raw",
        source: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "list_proposals",
          argumentsDigest: DIGEST_A,
        },
      });
      const second = await createTestCollection(database, {
        name: "Derived summaries",
        kind: "derived",
        sourceCollectionIds: [first.id],
      });
      const nested = {
        records: [
          { id: "7", flags: [true, false], detail: { title: "hello" } },
        ],
        cursor: null,
      };
      await database.putPage({
        collectionId: first.id,
        idempotencyKey: "page-1",
        value: nested,
      });
      await database.putPage({
        collectionId: first.id,
        idempotencyKey: "page-2",
        value: ["a", "b"],
      });
      await database.putPage({
        collectionId: first.id,
        idempotencyKey: "page-3",
        value: { done: true },
      });

      const listOne = await database.listCollections({ limit: 1 });
      expect(listOne.collections).toHaveLength(1);
      expect(listOne.cursor).not.toBeNull();
      const listTwo = await database.listCollections({
        cursor: listOne.cursor,
        limit: 1,
      });
      expect(listTwo.collections).toHaveLength(1);
      expect(
        new Set([listOne.collections[0]!.id, listTwo.collections[0]!.id]),
      ).toEqual(new Set([first.id, second.id]));
      expect((await database.getCollection(second.id))?.identity).toEqual(
        LOCAL_IDENTITY,
      );
      await expect(
        createTestCollection(database, {
          name: "Fabricated Kernel identity",
          kind: "raw",
          identity: {
            mode: "kernel",
            principal: null,
          } as unknown as CollectionIdentity,
        }),
      ).rejects.toThrow("identity mode is invalid");
      await expect(
        database.createCollection({
          name: "Missing identity",
          kind: "raw",
        } as CreateCollectionInput),
      ).rejects.toThrow("identity metadata is invalid");

      const firstBatch = await database.readPages(first.id, { limit: 2 });
      expect(firstBatch.pages.map((page) => page.value)).toEqual([
        nested,
        ["a", "b"],
      ]);
      expect(firstBatch.cursor).toBe("1");
      const secondBatch = await database.readPages(first.id, {
        cursor: firstBatch.cursor,
        limit: 2,
      });
      expect(secondBatch.pages.map((page) => page.value)).toEqual([
        { done: true },
      ]);
      expect(secondBatch.cursor).toBeNull();

      const description = await database.describeCollection(first.id, {
        limit: 1,
      });
      expect(description.collection).toMatchObject({
        id: first.id,
        state: "open",
        pageCount: 3,
        itemCount: 4,
      });
      expect(description.pages[0]!.value).toEqual(nested);
    } finally {
      database.close();
    }
  });

  test("a fresh catalogue pass sees inserts behind an earlier cursor", async () => {
    const ids = ["collection_m", "collection_z", "collection_a"];
    let fallbackId = 0;
    const database = await openBlastDatabase({
      databaseName: `neutron-blast-test-${(databaseSequence += 1)}`,
      now: () => 1_000,
      idFactory: (prefix) =>
        prefix === "collection"
          ? (ids.shift() ?? `collection_${(fallbackId += 1)}`)
          : `${prefix}_${(fallbackId += 1)}`,
    });
    try {
      await createTestCollection(database, { name: "Middle", kind: "raw" });
      await createTestCollection(database, { name: "Last", kind: "raw" });
      const first = await database.listCollections({ limit: 1 });
      expect(first.collections.map(({ id }) => id)).toEqual(["collection_m"]);

      await createTestCollection(database, { name: "Earlier", kind: "raw" });
      const continued = await database.listCollections({
        cursor: first.cursor,
        limit: 10,
      });
      expect(continued.collections.map(({ id }) => id)).toEqual([
        "collection_z",
      ]);
      expect(continued.cursor).toBeNull();

      const fresh = await database.listCollections({ limit: 10 });
      expect(fresh.collections.map(({ id }) => id)).toEqual([
        "collection_a",
        "collection_m",
        "collection_z",
      ]);
    } finally {
      database.close();
    }
  });

  test("paginates page batches before their aggregate JSON-node budget is exceeded", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Wide pages",
        kind: "raw",
      });
      const page = Array.from({ length: 50_000 }, () => 0);
      for (const key of ["wide-1", "wide-2"]) {
        await database.putPage({
          collectionId: collection.id,
          idempotencyKey: key,
          value: page,
        });
      }

      const first = await database.readPages(collection.id, {
        maxNodes: BLAST_LIMITS.jsonNodes,
      });
      expect(first.pages).toHaveLength(1);
      expect(first.cursor).toBe("0");
      const second = await database.readPages(collection.id, {
        cursor: first.cursor,
        maxNodes: BLAST_LIMITS.jsonNodes,
      });
      expect(second.pages).toHaveLength(1);
      expect(second.cursor).toBeNull();

      await expect(
        database.readPages(collection.id, {
          maxNodes: 50_000,
        }),
      ).rejects.toMatchObject({
        code: "invalid_state",
        sequence: 0,
        jsonNodes: 50_001,
        maximumNodes: 50_000,
      });
    } finally {
      database.close();
    }
  });

  test("omits an oversized describe sample and advances past it", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Oversized sample",
        kind: "raw",
      });
      const page = await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "large",
        value: { body: "x".repeat(128) },
      });
      const description = await database.describeCollection(collection.id, {
        maxBytes: page.serializedBytes - 1,
      });
      expect(description).toMatchObject({
        collection: { id: collection.id },
        pages: [],
        cursor: "0",
        serializedBytes: 0,
        oversizedPage: {
          sequence: 0,
          serializedBytes: page.serializedBytes,
          maximumBytes: page.serializedBytes - 1,
        },
      });

      const afterSkipped = await database.describeCollection(collection.id, {
        cursor: description.cursor,
        maxBytes: page.serializedBytes - 1,
      });
      expect(afterSkipped).toMatchObject({
        pages: [],
        cursor: null,
        oversizedPage: null,
      });
    } finally {
      database.close();
    }
  });

  test("applies text limits to Unicode scalars and rejects malformed text", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "😀".repeat(BLAST_LIMITS.collectionNameCharacters),
        description: "🧪".repeat(BLAST_LIMITS.collectionDescriptionCharacters),
        kind: "raw",
        source: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "🔎".repeat(BLAST_LIMITS.canisterMethodCharacters),
          argumentsDigest: DIGEST_A,
        },
      });
      await expect(
        database.putPage({
          collectionId: collection.id,
          idempotencyKey: "🔑".repeat(512),
          value: { ok: true },
        }),
      ).resolves.toMatchObject({ status: "written" });

      await expect(
        createTestCollection(database, {
          name: "😀".repeat(BLAST_LIMITS.collectionNameCharacters + 1),
          kind: "raw",
        }),
      ).rejects.toThrow("Collection name is invalid");
      await expect(
        createTestCollection(database, {
          name: "bad\ud800text",
          kind: "raw",
        }),
      ).rejects.toThrow("Collection name is invalid");
      await expect(
        createTestCollection(database, {
          name: "Invalid source",
          kind: "raw",
          source: {
            canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            method: "bad\nmethod",
            argumentsDigest: DIGEST_A,
          },
        }),
      ).rejects.toThrow("Source method is invalid");

      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 11_000,
      });
      await expect(
        database.beginRunCall(handle(run), {
          requestBytes: 1,
          responseReservationBytes: 1,
          update: {
            canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            method: "bad\u007fmethod",
            argumentsDigest: DIGEST_A,
            identityMode: "local",
          },
        }),
      ).rejects.toThrow("Pending update method is invalid");
      expect(await database.getRun(run.id)).toMatchObject({
        counters: { callCount: 0, requestBytes: 0, responseBytes: 0 },
        pendingUpdates: [],
      });
    } finally {
      database.close();
    }
  });

  test("restores the wider JSON and method provenance accepted by v0.1.0", async () => {
    const { database, name, clock } = await openTestDatabase();
    let retainedValue: unknown = null;
    for (let index = 0; index < BLAST_STORED_V1_JSON_LIMITS.depth; index += 1) {
      retainedValue = [retainedValue];
    }
    const retainedJson = retainedValue as JsonValue;
    const retainedBytes = new TextEncoder().encode(
      JSON.stringify(retainedJson),
    ).byteLength;

    try {
      const collection = await createTestCollection(database, {
        name: "Retained v0.1.0 collection",
        kind: "raw",
        source: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "read",
          argumentsDigest: DIGEST_A,
        },
      });
      await expect(
        database.putPage({
          collectionId: collection.id,
          idempotencyKey: "new-boundary",
          value: retainedJson,
        }),
      ).rejects.toThrow("nested too deeply");
      await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "retained-page",
        value: { retained: true },
      });
      await expect(
        database.completeCollection(collection.id, retainedJson),
      ).rejects.toThrow("nested too deeply");
      await database.completeCollection(collection.id, { retained: true });

      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      await expect(
        database.checkpointRun(handle(run), retainedJson),
      ).rejects.toThrow("nested too deeply");
      await database.checkpointRun(handle(run), { retained: true });
      clock.now += 1;
      await expect(
        database.transitionRun(handle(run), "complete", retainedJson),
      ).rejects.toThrow("nested too deeply");
      await database.transitionRun(handle(run), "complete", { retained: true });

      await editRawRecord(name, "collections", collection.id, (value) => ({
        ...(value as object),
        source: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "legacy\nmethod",
          argumentsDigest: DIGEST_A,
        },
        summary: retainedJson,
      }));
      await editRawRecord(name, "pages", [collection.id, 0], (value) => ({
        ...(value as object),
        value: retainedJson,
        itemCount: 1,
        serializedBytes: retainedBytes,
      }));
      await editRawRecord(name, "runs", run.id, (value) => ({
        ...(value as object),
        summary: retainedJson,
      }));
      await editRawRecord(name, "checkpoints", run.id, (value) => ({
        ...(value as object),
        value: retainedJson,
        serializedBytes: retainedBytes,
      }));

      expect(
        (await database.getCollection(collection.id))?.source?.method,
      ).toBe("legacy\nmethod");
      expect((await database.readPages(collection.id)).pages[0]?.value).toEqual(
        retainedJson,
      );
      const snapshot = await database.getRunSnapshot(run.id);
      expect(snapshot?.run.summary).toEqual(retainedJson);
      expect(snapshot?.checkpoint?.value).toEqual(retainedJson);

      const pendingRun = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: clock.now + 10_000,
      });
      await editRawRecord(name, "runs", pendingRun.id, (value) => {
        const record = value as Record<string, unknown>;
        return {
          ...record,
          counters: {
            ...(record.counters as object),
            callCount: 1,
          },
          pendingUpdates: [
            {
              id: "update_legacy",
              canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
              method: "legacy\u007fmethod",
              argumentsDigest: DIGEST_B,
              identityMode: "local",
              startedAt: pendingRun.startedAt,
              status: "call_pending",
            },
          ],
        };
      });
      expect(
        (await database.getRun(pendingRun.id))?.pendingUpdates[0]?.method,
      ).toBe("legacy\u007fmethod");

      expect(await database.deleteCollections([collection.id])).toMatchObject({
        results: [{ id: collection.id, status: "deleted" }],
        incompleteCleanup: false,
      });
      expect(await database.getCollection(collection.id)).toBeNull();
      expect(await database.deleteRun(run.id)).toEqual({
        id: run.id,
        status: "deleted",
        unresolvedUpdateCount: 0,
      });
      expect(await database.getRunSnapshot(run.id)).toBeNull();
    } finally {
      database.close();
    }
  });

  test("enforces the bounded collection catalogue atomically across tabs", async () => {
    const first = await openTestDatabase();
    let otherId = 0;
    const second = await openBlastDatabase({
      databaseName: first.name,
      now: () => first.clock.now,
      idFactory: (prefix) => `${prefix}_other_${(otherId += 1)}`,
    });
    try {
      for (let index = 0; index < BLAST_COLLECTION_LIMIT - 1; index += 1) {
        await createTestCollection(first.database, {
          name: `Bounded ${index}`,
          kind: "raw",
        });
      }
      const contenders = await Promise.allSettled([
        createTestCollection(first.database, { name: "Final A", kind: "raw" }),
        createTestCollection(second, { name: "Final B", kind: "raw" }),
      ]);
      expect(
        contenders.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        contenders.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(await first.database.logicalStorageStatus()).toMatchObject({
        collectionCount: BLAST_COLLECTION_LIMIT,
        pageCount: 0,
        itemCount: 0,
        serializedBytes: 0,
      });
      await expect(
        createTestCollection(second, { name: "Overflow", kind: "raw" }),
      ).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      second.close();
      first.database.close();
    }
  });

  test("commits page, collection counters, and run counters atomically", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const collection = await createTestCollection(database, {
        name: "Run output",
        kind: "raw",
        run: runHandle,
      });
      const first = await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "stable-page",
        value: { alpha: 1, beta: { value: true } },
        run: runHandle,
      });
      expect(first.status).toBe("written");

      // Object member order is not semantically significant for idempotency.
      const replay = await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "stable-page",
        value: { beta: { value: true }, alpha: 1 },
        run: runHandle,
      });
      expect(replay).toEqual({ ...first, status: "replayed" });

      await expect(
        database.putPage({
          collectionId: collection.id,
          idempotencyKey: "stable-page",
          value: { alpha: 2 },
          run: runHandle,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      const storedCollection = await database.getCollection(collection.id);
      expect(storedCollection).toMatchObject({
        pageCount: 1,
        itemCount: 1,
        nextSequence: 1,
        serializedBytes: first.serializedBytes,
      });
      expect(await database.getRun(run.id)).toMatchObject({
        outputCollectionIds: [collection.id],
        counters: {
          pageWriteCount: 1,
          writeBytes: first.serializedBytes,
        },
      });

      await expect(
        database.putPage({
          collectionId: collection.id,
          idempotencyKey: "must-abort",
          value: [1, 2, 3],
          run: { runId: run.id, sessionId: "session_wrong" },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await database.getCollection(collection.id))?.pageCount).toBe(1);
      expect((await database.readPages(collection.id)).pages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("serializes concurrent tabs and allocates unique monotonic sequences", async () => {
    const firstConnection = await openTestDatabase();
    const secondConnection = await openTestDatabase(
      firstConnection.name,
      firstConnection.clock,
    );
    try {
      const collection = await createTestCollection(firstConnection.database, {
        name: "Concurrent raw pages",
        kind: "raw",
      });
      const writes = await Promise.all([
        firstConnection.database.putPage({
          collectionId: collection.id,
          idempotencyKey: "tab-a",
          value: { tab: "a" },
        }),
        secondConnection.database.putPage({
          collectionId: collection.id,
          idempotencyKey: "tab-b",
          value: { tab: "b" },
        }),
      ]);
      expect(writes.map((write) => write.sequence).sort()).toEqual([0, 1]);
      expect(
        await secondConnection.database.getCollection(collection.id),
      ).toMatchObject({
        pageCount: 2,
        nextSequence: 2,
      });
      const pages = await firstConnection.database.readPages(collection.id);
      expect(pages.pages.map((page) => page.sequence)).toEqual([0, 1]);
    } finally {
      secondConnection.database.close();
      firstConnection.database.close();
    }
  });

  test("supports idempotent derived appends without pretending unkeyed appends are exactly once", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Derived",
        kind: "derived",
      });
      const written = await database.append({
        collectionId: collection.id,
        idempotencyKey: "derived-1",
        value: [1, 2],
      });
      const replayed = await database.append({
        collectionId: collection.id,
        idempotencyKey: "derived-1",
        value: [1, 2],
      });
      const unkeyedOne = await database.append({
        collectionId: collection.id,
        value: "again",
      });
      const unkeyedTwo = await database.append({
        collectionId: collection.id,
        value: "again",
      });
      expect(written.status).toBe("written");
      expect(replayed.status).toBe("replayed");
      expect([unkeyedOne.sequence, unkeyedTwo.sequence]).toEqual([1, 2]);
      expect(await database.getCollection(collection.id)).toMatchObject({
        pageCount: 3,
        itemCount: 4,
      });
    } finally {
      database.close();
    }
  });

  test("snapshots mutable page input before validating and storing it", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Snapshot input",
        kind: "raw",
      });
      let reads = 0;
      const changing: Record<string, unknown> = {};
      Object.defineProperty(changing, "value", {
        enumerable: true,
        get() {
          reads += 1;
          return reads;
        },
      });
      await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "snapshot-once",
        value: changing as never,
      });
      expect(reads).toBe(1);
      expect((await database.readPages(collection.id)).pages[0]!.value).toEqual(
        {
          value: 1,
        },
      );
    } finally {
      database.close();
    }
  });

  test("returns an empty page at the maximum safe cursor", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Cursor edge",
        kind: "raw",
      });
      await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "first",
        value: { present: true },
      });
      expect(
        await database.readPages(collection.id, {
          cursor: String(Number.MAX_SAFE_INTEGER),
        }),
      ).toEqual({ pages: [], cursor: null, serializedBytes: 0 });
    } finally {
      database.close();
    }
  });

  test("does not expose an idempotency key when its data conflicts", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Private idempotency",
        kind: "raw",
      });
      const secretKey = "agent-private-retry-key";
      await database.putPage({
        collectionId: collection.id,
        idempotencyKey: secretKey,
        value: { version: 1 },
      });
      let failure: unknown;
      try {
        await database.putPage({
          collectionId: collection.id,
          idempotencyKey: secretKey,
          value: { version: 2 },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "idempotency_conflict" });
      expect((failure as Error).message).not.toContain(secretKey);
    } finally {
      database.close();
    }
  });

  test("persists checkpoints with exact source binding and CAS revision", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const input = await createTestCollection(database, {
        name: "Input",
        kind: "raw",
      });
      const output = await createTestCollection(database, {
        name: "Output",
        kind: "derived",
      });
      const run = await database.createRun({
        source: {
          kind: "saved",
          scriptId: "1",
          revision: "7",
          digest: DIGEST_B,
        },
        deadlineAt: clock.now + 10_000,
        inputCollectionIds: [input.id],
        outputCollectionIds: [output.id],
      });
      const runHandle = handle(run);
      await database.append({
        collectionId: output.id,
        idempotencyKey: "output-1",
        value: { ok: true },
        run: runHandle,
      });
      await database.readPages(input.id, { run: runHandle });
      await database.beginRunCall(runHandle, {
        requestBytes: 11,
        responseReservationBytes: 1_024,
      });
      await database.settleRunCall(runHandle, {
        responseReservationBytes: 1_024,
        responseBytes: 29,
      });
      const checkpoint = await database.checkpointRun(
        runHandle,
        { cursor: "next", nested: { page: 1 } },
        0,
      );
      expect(checkpoint).toMatchObject({
        revision: 1,
        sourceDigest: DIGEST_B,
        inputCollectionIds: [input.id],
        outputCollectionIds: [output.id],
        acknowledgedUpdateIds: [],
      });
      await expect(
        database.checkpointRun(runHandle, { cursor: "stale" }, 0),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await database.getCheckpoint(run.id)).toEqual(checkpoint);
      expect(await database.getRun(run.id)).toMatchObject({
        checkpointRevision: 1,
        counters: {
          callCount: 1,
          requestBytes: 11,
          responseBytes: 29,
          pageReadCount: 0,
          pageWriteCount: 1,
        },
      });
      const listed = await database.listRuns({ limit: 1 });
      expect(listed).toMatchObject({
        runs: [
          {
            id: run.id,
            inputCollectionCount: 1,
            outputCollectionCount: 1,
            checkpointRevision: 1,
          },
        ],
        cursor: null,
      });
      expect(listed.runs[0]).not.toHaveProperty("sessionId");
      expect(listed.runs[0]).not.toHaveProperty("summary");

      const completed = await database.transitionRun(runHandle, "complete", {
        result: output.id,
      });
      expect(completed.state).toBe("complete");
      expect(
        await database.transitionRun(runHandle, "complete", {
          result: output.id,
        }),
      ).toEqual(completed);
      await expect(
        database.transitionRun(runHandle, "failed", "different terminal state"),
      ).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      database.close();
    }
  });

  test("reads each run and checkpoint revision from one transaction snapshot", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const writer = async () => {
        for (let revision = 0; revision < 20; revision += 1) {
          await database.checkpointRun(
            runHandle,
            { revision: revision + 1 },
            revision,
          );
        }
      };
      const reader = async () => {
        for (let index = 0; index < 40; index += 1) {
          const snapshot = await database.getRunSnapshot(run.id);
          expect(snapshot).not.toBeNull();
          expect(snapshot!.checkpoint?.revision ?? 0).toBe(
            snapshot!.run.checkpointRevision,
          );
        }
      };
      await Promise.all([writer(), reader()]);
      expect(await database.getRunSnapshot(run.id)).toMatchObject({
        run: { checkpointRevision: 20 },
        checkpoint: { revision: 20, value: { revision: 20 } },
      });
    } finally {
      database.close();
    }
  });

  test("rejects checkpoint writes after the durable revision limit", async () => {
    const { database, name, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const checkpoint = await database.checkpointRun(
        runHandle,
        { revision: 1 },
        0,
      );
      await editRawRecord(name, "runs", run.id, (value) => ({
        ...(value as object),
        checkpointRevision: BLAST_LIMITS.scriptHostCalls,
      }));
      await editRawRecord(name, "checkpoints", run.id, () => ({
        ...checkpoint,
        revision: BLAST_LIMITS.scriptHostCalls,
      }));

      await expect(
        database.checkpointRun(
          runHandle,
          { revision: BLAST_LIMITS.scriptHostCalls + 1 },
          BLAST_LIMITS.scriptHostCalls,
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });
      expect(await database.getRunSnapshot(run.id)).toMatchObject({
        run: { checkpointRevision: BLAST_LIMITS.scriptHostCalls },
        checkpoint: { revision: BLAST_LIMITS.scriptHostCalls },
      });
    } finally {
      database.close();
    }
  });

  test("keeps a checkpoint valid when the run creates a later output", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const checkpoint = await database.checkpointRun(
        runHandle,
        { cursor: "before-output" },
        0,
      );
      const output = await createTestCollection(database, {
        name: "Created after checkpoint",
        kind: "derived",
        run: runHandle,
      });
      await database.completeCollection(output.id, null, runHandle);
      await database.transitionRun(runHandle, "complete");

      const snapshot = await database.getRunSnapshot(run.id);
      expect(snapshot).toMatchObject({
        run: {
          state: "complete",
          outputCollectionIds: [output.id],
        },
        checkpoint: {
          revision: checkpoint.revision,
          outputCollectionIds: [],
          value: { cursor: "before-output" },
        },
      });
    } finally {
      database.close();
    }
  });

  test("rejects a script finalizer after its run becomes terminal", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const output = await createTestCollection(database, {
        name: "Late output",
        kind: "raw",
        run: runHandle,
      });
      await database.transitionRun(runHandle, "cancelled", {
        error: "caller cancelled",
      });

      await expect(
        database.completeCollection(output.id, { tooLate: true }, runHandle),
      ).rejects.toMatchObject({ code: "invalid_state" });
      expect(await database.getCollection(output.id)).toMatchObject({
        state: "open",
        summary: null,
      });
    } finally {
      database.close();
    }
  });

  test("admits at most eight concurrent sandbox runs across transactions", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 9 }, (_, index) =>
          database.createRun({
            source: {
              kind: "temporary",
              digest: index % 2 === 0 ? DIGEST_A : DIGEST_B,
            },
            deadlineAt: clock.now + 10_000,
          }),
        ),
      );
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(8);
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "invalid_state" });
      expect((await database.logicalStorageStatus()).runningRunCount).toBe(8);
    } finally {
      database.close();
    }
  });

  test("prevents two running scripts from claiming the same output collection", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const output = await createTestCollection(database, {
        name: "Exclusive output",
        kind: "derived",
      });
      const first = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
        outputCollectionIds: [output.id],
      });
      await expect(
        database.createRun({
          source: { kind: "temporary", digest: DIGEST_B },
          deadlineAt: clock.now + 10_000,
          outputCollectionIds: [output.id],
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await database.getRun(first.id))?.state).toBe("running");
    } finally {
      database.close();
    }
  });

  test("reserves aggregate IC byte budgets atomically before dispatch", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      await database.beginRunCall(handle(run), {
        requestBytes: BLAST_RUN_BUDGETS.requestBytes,
        responseReservationBytes: BLAST_RUN_BUDGETS.responseBytes,
      });
      await expect(
        database.beginRunCall(handle(run), {
          requestBytes: 1,
          responseReservationBytes: 0,
        }),
      ).rejects.toThrow("request bytes budget is exhausted");
      await expect(
        database.beginRunCall(handle(run), {
          requestBytes: 0,
          responseReservationBytes: 1,
        }),
      ).rejects.toThrow("response bytes budget is exhausted");

      const settled = await database.settleRunCall(handle(run), {
        responseReservationBytes: BLAST_RUN_BUDGETS.responseBytes,
        responseBytes: 29,
      });
      expect(settled.counters).toMatchObject({
        callCount: 1,
        requestBytes: BLAST_RUN_BUDGETS.requestBytes,
        responseBytes: 29,
      });
    } finally {
      database.close();
    }
  });

  test("rejects replay or downgrade of settled update evidence", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const pendingUpdateId = await database.beginRunCall(runHandle, {
        requestBytes: 10,
        responseReservationBytes: 1_024,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit",
          argumentsDigest: DIGEST_B,
          identityMode: "local",
        },
      });
      if (pendingUpdateId === null)
        throw new Error("Expected update evidence ID");
      const settled = await database.settleRunCall(runHandle, {
        responseReservationBytes: 1_024,
        responseBytes: 20,
        pendingUpdateId,
        updateResolution: "confirmed",
      });
      for (const updateResolution of ["confirmed", "not_dispatched"] as const) {
        await expect(
          database.settleRunCall(runHandle, {
            responseReservationBytes: 1_024,
            responseBytes: 20,
            pendingUpdateId,
            updateResolution,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }
      expect(await database.getRun(run.id)).toEqual(settled);

      const secondId = await database.beginRunCall(runHandle, {
        requestBytes: 1,
        responseReservationBytes: 1,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit",
          argumentsDigest: DIGEST_A,
          identityMode: "local",
        },
      });
      if (secondId === null)
        throw new Error("Expected second update evidence ID");
      await database.settleRunCall(runHandle, {
        responseReservationBytes: 1,
        responseBytes: 0,
        pendingUpdateId: secondId,
        updateResolution: "not_dispatched",
      });
      await expect(
        database.settleRunCall(runHandle, {
          responseReservationBytes: 1,
          responseBytes: 0,
          pendingUpdateId: secondId,
          updateResolution: "not_dispatched",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      database.close();
    }
  });

  test("uses strict durability for update evidence and checkpoints, not bulk pages", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const collection = await createTestCollection(database, {
        name: "Durability boundary",
        kind: "raw",
        run: runHandle,
      });
      const observed = await captureTransactions(async () => {
        await database.putPage({
          collectionId: collection.id,
          idempotencyKey: "bulk-page",
          value: { retained: true },
          run: runHandle,
        });
        const pendingUpdateId = await database.beginRunCall(runHandle, {
          requestBytes: 10,
          responseReservationBytes: 1_024,
          update: {
            canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            method: "commit",
            argumentsDigest: DIGEST_B,
            identityMode: "local",
          },
        });
        if (pendingUpdateId === null)
          throw new Error("Expected update evidence ID");
        await database.settleRunCall(runHandle, {
          responseReservationBytes: 1_024,
          responseBytes: 20,
          pendingUpdateId,
          updateResolution: "confirmed",
        });
        await database.checkpointRun(runHandle, { afterUpdate: true }, 0, [
          pendingUpdateId,
        ]);
      });

      expect(observed).toEqual([
        {
          stores: ["collections", "pages", "runs"],
          mode: "readwrite",
          durability: "default",
        },
        { stores: ["runs"], mode: "readwrite", durability: "strict" },
        { stores: ["runs"], mode: "readwrite", durability: "strict" },
        {
          stores: ["runs", "checkpoints"],
          mode: "readwrite",
          durability: "strict",
        },
      ]);
    } finally {
      database.close();
    }
  });

  test("journals update evidence across crash expiry until a checkpoint", async () => {
    const clock = { now: 1_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 1_100,
      });
      const evidence = {
        canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        method: "commit",
        argumentsDigest: DIGEST_B,
        identityMode: "local" as const,
      };
      const pendingUpdateId = await database.beginRunCall(handle(run), {
        requestBytes: 10,
        responseReservationBytes: 1_024,
        update: evidence,
      });
      expect(await database.getRun(run.id)).toMatchObject({
        pendingUpdates: [
          {
            id: pendingUpdateId,
            ...evidence,
            status: "call_pending",
          },
        ],
      });

      clock.now = 1_101;
      expect(await database.interruptExpiredRuns()).toEqual([run.id]);
      expect(await database.getRunSnapshot(run.id)).toMatchObject({
        run: {
          state: "interrupted",
          pendingUpdates: [],
          summary: {
            retrySafe: false,
            updateEvidence: {
              protocol: 1,
              uncheckpointedUpdateCount: 1,
              callPendingCount: 1,
              dispatchConfirmedCount: 0,
              attempts: [
                {
                  id: pendingUpdateId,
                  ...evidence,
                  status: "call_pending",
                },
              ],
            },
          },
        },
      });

      const next = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 2_000,
      });
      const confirmedId = await database.beginRunCall(handle(next), {
        requestBytes: 10,
        responseReservationBytes: 1_024,
        update: evidence,
      });
      if (confirmedId === null) throw new Error("Expected update evidence ID");
      await database.settleRunCall(handle(next), {
        responseReservationBytes: 1_024,
        responseBytes: 20,
        pendingUpdateId: confirmedId,
        updateResolution: "confirmed",
      });
      expect(await database.getRun(next.id)).toMatchObject({
        pendingUpdates: [{ id: confirmedId, status: "dispatch_confirmed" }],
      });
      const checkpoint = await database.checkpointRun(
        handle(next),
        { afterUpdate: true },
        0,
        [confirmedId],
      );
      expect(checkpoint.acknowledgedUpdateIds).toEqual([confirmedId]);
      expect(await database.getRun(next.id)).toMatchObject({
        pendingUpdates: [],
      });
    } finally {
      database.close();
    }
  });

  test("keeps update evidence until the exact attempt is checkpoint-acknowledged", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const pendingUpdateId = await database.beginRunCall(runHandle, {
        requestBytes: 10,
        responseReservationBytes: 1_024,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit",
          argumentsDigest: DIGEST_B,
          identityMode: "local",
        },
      });
      if (pendingUpdateId === null)
        throw new Error("Expected update evidence ID");

      const [, unrelatedCheckpoint] = await Promise.all([
        database.settleRunCall(runHandle, {
          responseReservationBytes: 1_024,
          responseBytes: 20,
          pendingUpdateId,
          updateResolution: "confirmed",
        }),
        database.checkpointRun(runHandle, { cursor: "unrelated" }, 0),
      ]);
      expect(unrelatedCheckpoint.acknowledgedUpdateIds).toEqual([]);
      expect(await database.getRun(run.id)).toMatchObject({
        pendingUpdates: [{ id: pendingUpdateId, status: "dispatch_confirmed" }],
      });

      await expect(
        database.checkpointRun(runHandle, { cursor: "invalid" }, 1, [
          "update_missing",
        ]),
      ).rejects.toMatchObject({ code: "conflict" });

      const acknowledged = await database.checkpointRun(
        runHandle,
        { cursor: "after-update" },
        1,
        [pendingUpdateId],
      );
      expect(acknowledged.acknowledgedUpdateIds).toEqual([pendingUpdateId]);
      expect((await database.getRun(run.id))?.pendingUpdates).toEqual([]);

      const later = await database.checkpointRun(
        runHandle,
        { cursor: "later" },
        2,
      );
      expect(later.acknowledgedUpdateIds).toEqual([pendingUpdateId]);
    } finally {
      database.close();
    }
  });

  test("folds exact uncheckpointed update evidence into a bounded terminal summary", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const confirmedId = await database.beginRunCall(runHandle, {
        requestBytes: 1,
        responseReservationBytes: 1,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "confirmed_update",
          argumentsDigest: DIGEST_A,
          identityMode: "local",
        },
      });
      const unknownId = await database.beginRunCall(runHandle, {
        requestBytes: 1,
        responseReservationBytes: 1,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "unknown_update",
          argumentsDigest: DIGEST_B,
          identityMode: "local",
        },
      });
      if (confirmedId === null || unknownId === null) {
        throw new Error("Expected update evidence IDs");
      }
      await database.settleRunCall(runHandle, {
        responseReservationBytes: 1,
        responseBytes: 0,
        pendingUpdateId: confirmedId,
        updateResolution: "confirmed",
      });
      const terminal = await database.transitionRun(runHandle, "failed", {
        detail: "x".repeat(16_300),
      });
      expect(terminal.pendingUpdates).toEqual([]);
      expect(terminal.summary).toMatchObject({
        retrySafe: false,
        summaryOmitted: true,
        updateEvidence: {
          protocol: 1,
          uncheckpointedUpdateCount: 2,
          callPendingCount: 1,
          dispatchConfirmedCount: 1,
          attempts: [
            {
              id: confirmedId,
              method: "confirmed_update",
              status: "dispatch_confirmed",
            },
            { id: unknownId, method: "unknown_update", status: "call_pending" },
          ],
        },
      });
      expect(
        new TextEncoder().encode(JSON.stringify(terminal.summary)).byteLength,
      ).toBeLessThanOrEqual(16 * 1_024);
      expect((await database.listRuns()).runs[0]).toMatchObject({
        id: run.id,
        pendingUpdateCount: 2,
      });

      const safe = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: clock.now + 10_000,
      });
      await database.transitionRun(handle(safe), "complete", { safe: true });
      expect(await database.pruneTerminalRuns({ retain: 1 })).toMatchObject({
        deletedRunIds: [safe.id],
        terminalRunCount: 1,
        incomplete: false,
      });
      expect(await database.getRun(run.id)).not.toBeNull();
      await expect(database.deleteRun(run.id)).rejects.toThrow(
        "set acknowledgeUnresolvedUpdates to true",
      );
      expect(await database.deleteRun(run.id, true)).toEqual({
        id: run.id,
        status: "deleted",
        unresolvedUpdateCount: 2,
      });
      expect(await database.getRun(run.id)).toBeNull();
    } finally {
      database.close();
    }
  });

  test("keeps completion digests when update evidence displaces a stored result", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const runHandle = handle(run);
      const pendingId = await database.beginRunCall(runHandle, {
        requestBytes: 1,
        responseReservationBytes: 1,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "write",
          argumentsDigest: DIGEST_A,
          identityMode: "local",
        },
      });
      if (pendingId === null) throw new Error("Expected update evidence ID");

      const terminal = await database.transitionRun(runHandle, "complete", {
        completionEvidence: {
          protocol: 1,
          argumentsDigest: DIGEST_A,
          resultDigest: DIGEST_B,
          resultBytes: 16_000,
          resultStatus: "stored",
          result: "x".repeat(16_000),
        },
      });

      expect(terminal.summary).toMatchObject({
        retrySafe: false,
        summaryOmitted: true,
        completionEvidence: {
          protocol: 1,
          argumentsDigest: DIGEST_A,
          resultDigest: DIGEST_B,
          resultBytes: 16_000,
          resultStatus: "digest_only",
        },
        updateEvidence: {
          uncheckpointedUpdateCount: 1,
          attempts: [{ id: pendingId, status: "call_pending" }],
        },
      });
      expect(
        (terminal.summary as Record<string, unknown>).completionEvidence,
      ).not.toHaveProperty("result");
    } finally {
      database.close();
    }
  });

  test("requires explicit evidence cleanup at bounded run-history capacity", async () => {
    const { database, clock } = await openTestDatabase();
    let oldestRunId = "";
    try {
      for (let index = 0; index < BLAST_TERMINAL_RUN_RETENTION; index += 1) {
        const run = await database.createRun({
          source: { kind: "temporary", digest: DIGEST_A },
          deadlineAt: clock.now + 10_000,
        });
        const pendingUpdateId = await database.beginRunCall(handle(run), {
          requestBytes: 0,
          responseReservationBytes: 0,
          update: {
            canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            method: "commit",
            argumentsDigest: DIGEST_B,
            identityMode: "local",
          },
        });
        if (pendingUpdateId === null)
          throw new Error("Expected update evidence ID");
        if (index === 0) oldestRunId = run.id;
        await database.settleRunCall(handle(run), {
          responseReservationBytes: 0,
          responseBytes: 0,
          pendingUpdateId,
          updateResolution: "confirmed",
        });
        await database.transitionRun(handle(run), "complete", { index });
        clock.now += 1;
      }
      expect((await database.listRuns({ limit: 50 })).runs).toHaveLength(50);
      await expect(
        database.createRun({
          source: { kind: "temporary", digest: DIGEST_B },
          deadlineAt: clock.now + 10_000,
        }),
      ).rejects.toThrow(
        "run history is full of uncheckpointed update evidence",
      );
      await expect(database.deleteRun(oldestRunId)).rejects.toThrow(
        "set acknowledgeUnresolvedUpdates to true",
      );
      expect(await database.deleteRun(oldestRunId, true)).toMatchObject({
        id: oldestRunId,
        status: "deleted",
        unresolvedUpdateCount: 1,
      });
      const admitted = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: clock.now + 10_000,
      });
      expect(admitted.state).toBe("running");
    } finally {
      database.close();
    }
  });

  test("rolls back automatic history pruning when run admission fails", async () => {
    const { database, clock } = await openTestDatabase();
    let oldestRunId = "";
    try {
      for (let index = 0; index < BLAST_TERMINAL_RUN_RETENTION; index += 1) {
        const run = await database.createRun({
          source: { kind: "temporary", digest: DIGEST_A },
          deadlineAt: clock.now + 10_000,
        });
        if (index === 0) oldestRunId = run.id;
        await database.transitionRun(handle(run), "complete", { index });
        clock.now += 1;
      }

      await expect(
        database.createRun({
          source: { kind: "temporary", digest: DIGEST_B },
          deadlineAt: clock.now + 10_000,
          inputCollectionIds: ["collection_missing"],
        }),
      ).rejects.toThrow("was not found");

      expect(await database.getRun(oldestRunId)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  test("deletes only terminal run/checkpoint pairs and is idempotent", async () => {
    const { database, clock } = await openTestDatabase();
    try {
      const running = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      await expect(database.deleteRun(running.id, true)).rejects.toThrow(
        "still running",
      );
      await database.checkpointRun(handle(running), { cursor: 1 });
      const terminal = await database.transitionRun(
        handle(running),
        "complete",
        { done: true },
      );
      expect(await database.deleteRun(terminal.id)).toEqual({
        id: terminal.id,
        status: "deleted",
        unresolvedUpdateCount: 0,
      });
      expect(await database.getRun(terminal.id)).toBeNull();
      expect(await database.getCheckpoint(terminal.id)).toBeNull();
      expect(await database.deleteRun(terminal.id)).toEqual({
        id: terminal.id,
        status: "not_found",
        unresolvedUpdateCount: 0,
      });
    } finally {
      database.close();
    }
  });

  test("interrupts only expired running records", async () => {
    const clock = { now: 1_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const expired = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 1_100,
      });
      const live = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: 2_000,
      });
      clock.now = 1_100;
      expect(await database.interruptExpiredRuns()).toEqual([expired.id]);
      expect((await database.getRun(expired.id))?.state).toBe("interrupted");
      expect((await database.getRun(live.id))?.state).toBe("running");
    } finally {
      database.close();
    }
  });

  test("expires runs and outputs atomically without interrupting another tab's live run", async () => {
    const clock = { now: 1_000 };
    const firstConnection = await openTestDatabase(undefined, clock);
    const firstRun = await firstConnection.database.createRun({
      source: { kind: "temporary", digest: DIGEST_A },
      deadlineAt: 1_100,
    });
    const firstOutput = await createTestCollection(firstConnection.database, {
      name: "Orphaned output one",
      kind: "raw",
      run: handle(firstRun),
    });
    const secondRun = await firstConnection.database.createRun({
      source: { kind: "temporary", digest: DIGEST_B },
      deadlineAt: 2_000,
    });
    const secondOutput = await createTestCollection(firstConnection.database, {
      name: "Orphaned output two",
      kind: "derived",
      run: handle(secondRun),
    });
    const secondConnection = await openTestDatabase(
      firstConnection.name,
      firstConnection.clock,
    );
    try {
      clock.now = 1_100;
      expect(await secondConnection.database.interruptExpiredRuns(1)).toEqual([
        firstRun.id,
      ]);
      expect(await firstConnection.database.getRun(firstRun.id)).toMatchObject({
        state: "interrupted",
        completedAt: expect.any(Number),
        summary: { outputCleanupIncomplete: false },
      });
      expect(
        await firstConnection.database.getCollection(firstOutput.id),
      ).toMatchObject({
        state: "failed",
        summary: { error: expect.stringContaining("deadline elapsed") },
      });
      expect((await firstConnection.database.getRun(secondRun.id))?.state).toBe(
        "running",
      );
      expect(
        (await firstConnection.database.getCollection(secondOutput.id))?.state,
      ).toBe("open");
    } finally {
      secondConnection.database.close();
      firstConnection.database.close();
    }
  });

  test("expires runs after their outputs were deleted or entered deletion", async () => {
    const clock = { now: 1_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const missingRun = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 1_100,
      });
      const missingOutput = await createTestCollection(database, {
        name: "Removed output",
        kind: "raw",
        run: handle(missingRun),
      });
      await database.deleteCollections([missingOutput.id]);
      expect(await database.getCollection(missingOutput.id)).toBeNull();

      const deletingRun = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: 1_100,
      });
      const deletingOutput = await createTestCollection(database, {
        name: "Deleting output",
        kind: "raw",
        run: handle(deletingRun),
      });
      for (let page = 0; page < 2; page += 1) {
        await database.putPage({
          collectionId: deletingOutput.id,
          idempotencyKey: `delete-${page}`,
          value: page,
          run: handle(deletingRun),
        });
      }
      await database.deleteCollections([deletingOutput.id], { pageBudget: 1 });
      expect((await database.getCollection(deletingOutput.id))?.state).toBe(
        "deleting",
      );

      clock.now = 1_100;
      expect(new Set(await database.interruptExpiredRuns())).toEqual(
        new Set([missingRun.id, deletingRun.id]),
      );
      expect((await database.getRun(missingRun.id))?.state).toBe("interrupted");
      expect((await database.getRun(deletingRun.id))?.state).toBe(
        "interrupted",
      );
      expect((await database.getCollection(deletingOutput.id))?.state).toBe(
        "deleting",
      );
    } finally {
      database.close();
    }
  });

  test("recovers run slots stranded by a large backward clock correction", async () => {
    const clock = { now: 1_000_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const stranded = [];
      for (let index = 0; index < 8; index += 1) {
        stranded.push(
          await database.createRun({
            source: { kind: "temporary", digest: DIGEST_A },
            deadlineAt: clock.now + 10_000,
          }),
        );
      }
      clock.now = 1;
      expect(new Set(await database.interruptExpiredRuns())).toEqual(
        new Set(stranded.map((run) => run.id)),
      );
      const admitted = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: 1_001,
      });
      expect(admitted.state).toBe("running");
    } finally {
      database.close();
    }
  });

  test("tolerates a small backward clock correction for a live run", async () => {
    const clock = { now: 10_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 20_000,
      });
      clock.now = 9_000;
      expect(await database.interruptExpiredRuns()).toEqual([]);
      expect((await database.getRun(run.id))?.state).toBe("running");
    } finally {
      database.close();
    }
  });

  test("rechecks a run deadline after its IndexedDB read", async () => {
    const clock = { now: 1_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: 1_100,
      });
      const admission = database.beginRunCall(handle(run), {
        requestBytes: 1,
        responseReservationBytes: 1,
      });
      clock.now = 1_100;
      await expect(admission).rejects.toMatchObject({ code: "invalid_state" });
      expect((await database.getRun(run.id))?.counters.callCount).toBe(0);
    } finally {
      database.close();
    }
  });

  test("prunes terminal runs and checkpoints oldest-first in bounded transactions", async () => {
    const clock = { now: 1_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      const terminal: Array<{
        id: string;
        sessionId: string;
      }> = [];
      for (let index = 0; index < 4; index += 1) {
        const run = await database.createRun({
          source: {
            kind: "temporary",
            digest: index % 2 === 0 ? DIGEST_A : DIGEST_B,
          },
          deadlineAt: clock.now + 10_000,
        });
        await database.checkpointRun(handle(run), { resume: index }, 0);
        await database.transitionRun(
          handle(run),
          index === 2 ? "interrupted" : "complete",
          { index },
        );
        terminal.push(run);
        clock.now += 10;
      }
      const live = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });

      const firstPass = await database.pruneTerminalRuns({
        retain: 2,
        deletionLimit: 1,
      });
      expect(firstPass).toEqual({
        deletedRunIds: [terminal[0]!.id],
        terminalRunCount: 3,
        incomplete: true,
      });
      expect(await database.getRun(terminal[0]!.id)).toBeNull();
      expect(await database.getCheckpoint(terminal[0]!.id)).toBeNull();

      const secondPass = await database.pruneTerminalRuns({
        retain: 2,
        deletionLimit: 1,
      });
      expect(secondPass).toEqual({
        deletedRunIds: [terminal[1]!.id],
        terminalRunCount: 2,
        incomplete: false,
      });
      expect((await database.getRun(terminal[2]!.id))?.state).toBe(
        "interrupted",
      );
      expect(await database.getCheckpoint(terminal[2]!.id)).toMatchObject({
        value: { resume: 2 },
      });
      expect((await database.getRun(terminal[3]!.id))?.state).toBe("complete");
      expect((await database.getRun(live.id))?.state).toBe("running");
    } finally {
      database.close();
    }
  });

  test("keeps completion order monotonic after a backward clock correction", async () => {
    const clock = { now: 100_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      for (let index = 0; index < BLAST_TERMINAL_RUN_RETENTION; index += 1) {
        const run = await database.createRun({
          source: { kind: "temporary", digest: DIGEST_A },
          deadlineAt: clock.now + 10_000,
        });
        await database.transitionRun(handle(run), "complete", { index });
        clock.now += 1;
      }
      clock.now = 1_000;
      const firstAfterRollback = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: 11_000,
      });
      const firstFinalized = await database.transitionRun(
        handle(firstAfterRollback),
        "complete",
        { afterClockCorrection: true },
      );

      clock.now += 1;
      const secondAfterRollback = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: 11_001,
      });
      const secondFinalized = await database.transitionRun(
        handle(secondAfterRollback),
        "complete",
        { afterClockCorrection: 2 },
      );

      expect(await database.getRun(firstAfterRollback.id)).toEqual(
        firstFinalized,
      );
      expect(await database.getRun(secondAfterRollback.id)).toEqual(
        secondFinalized,
      );
      expect(secondFinalized.completedAt).toBeGreaterThan(
        firstFinalized.completedAt!,
      );
    } finally {
      database.close();
    }
  });

  test("deletes a malformed oldest terminal row instead of wedging retention", async () => {
    const { database, name, clock } = await openTestDatabase();
    try {
      const terminal: Array<{ id: string; sessionId: string }> = [];
      for (let index = 0; index < 2; index += 1) {
        const run = await database.createRun({
          source: { kind: "temporary", digest: DIGEST_A },
          deadlineAt: clock.now + 10_000,
        });
        await database.checkpointRun(handle(run), { index }, 0);
        await database.transitionRun(handle(run), "complete", { index });
        terminal.push(run);
        clock.now += 1;
      }

      await editRawRecord(name, "runs", terminal[0]!.id, (value) => ({
        ...(value as object),
        unexpected: "corrupt terminal history",
      }));

      expect(
        await database.pruneTerminalRuns({ retain: 1, deletionLimit: 1 }),
      ).toEqual({
        deletedRunIds: [terminal[0]!.id],
        terminalRunCount: 1,
        incomplete: false,
      });
      expect(await database.getRun(terminal[0]!.id)).toBeNull();
      expect(await database.getCheckpoint(terminal[0]!.id)).toBeNull();
      expect(await database.getRun(terminal[1]!.id)).toMatchObject({
        state: "complete",
      });
    } finally {
      database.close();
    }
  });

  test("quarantines a malformed newest terminal timestamp before finalizing a run", async () => {
    const { database, name, clock } = await openTestDatabase();
    try {
      const malformed = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      await database.checkpointRun(handle(malformed), { cursor: 1 }, 0);
      await database.transitionRun(handle(malformed), "complete", {
        first: true,
      });
      await editRawRecord(name, "runs", malformed.id, (value) => ({
        ...(value as object),
        completedAt: "malformed-newest-index-key",
      }));

      // Ordinary retention has no reason to scan a history below its cap. The
      // next finalization must still quarantine this unusable index row before
      // it derives the new monotonic completion timestamp.
      expect(await database.pruneTerminalRuns()).toEqual({
        deletedRunIds: [],
        terminalRunCount: 1,
        incomplete: false,
      });

      clock.now += 1;
      const current = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: clock.now + 10_000,
      });
      const finalized = await database.transitionRun(
        handle(current),
        "complete",
        { current: true },
      );

      expect(finalized).toMatchObject({
        state: "complete",
        completedAt: clock.now,
      });
      expect(await database.getRun(malformed.id)).toBeNull();
      expect(await database.getCheckpoint(malformed.id)).toBeNull();
      expect(await database.getRun(current.id)).toEqual(finalized);
    } finally {
      database.close();
    }
  });

  test("reserves retention before interrupting a run after clock rollback", async () => {
    const clock = { now: 100_000 };
    const { database } = await openTestDatabase(undefined, clock);
    try {
      for (let index = 0; index < BLAST_TERMINAL_RUN_RETENTION; index += 1) {
        const run = await database.createRun({
          source: { kind: "temporary", digest: DIGEST_A },
          deadlineAt: clock.now + 10_000,
        });
        await database.transitionRun(handle(run), "complete", { index });
        clock.now += 1;
      }

      clock.now = 1_000;
      const interrupted = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_B },
        deadlineAt: 1_100,
      });
      const pendingUpdateId = await database.beginRunCall(handle(interrupted), {
        requestBytes: 1,
        responseReservationBytes: 1,
        update: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit_after_clock_rollback",
          argumentsDigest: DIGEST_A,
          identityMode: "local",
        },
      });
      if (pendingUpdateId === null)
        throw new Error("Expected update evidence ID");

      clock.now = 1_101;
      expect(await database.interruptExpiredRuns()).toEqual([interrupted.id]);
      expect(await database.getRun(interrupted.id)).toMatchObject({
        state: "interrupted",
        summary: {
          retrySafe: false,
          updateEvidence: {
            uncheckpointedUpdateCount: 1,
            attempts: [{ id: pendingUpdateId, status: "call_pending" }],
          },
        },
      });

      expect(await database.pruneTerminalRuns()).toMatchObject({
        deletedRunIds: [],
        terminalRunCount: BLAST_TERMINAL_RUN_RETENTION,
        incomplete: false,
      });
      expect(await database.getRun(interrupted.id)).toMatchObject({
        state: "interrupted",
        summary: { retrySafe: false },
      });
    } finally {
      database.close();
    }
  });

  test("marks deletion first and resumes bounded page cleanup after reopen", async () => {
    const firstConnection = await openTestDatabase();
    const collection = await createTestCollection(firstConnection.database, {
      name: "Delete me",
      kind: "raw",
    });
    for (let index = 0; index < 5; index += 1) {
      await firstConnection.database.putPage({
        collectionId: collection.id,
        idempotencyKey: `page-${index}`,
        value: [index, index + 1],
      });
    }
    const firstPass = await firstConnection.database.deleteCollections(
      [collection.id],
      { pageBudget: 2 },
    );
    expect(firstPass).toEqual({
      results: [{ id: collection.id, status: "deleting" }],
      incompleteCleanup: true,
    });
    expect(
      await firstConnection.database.getCollection(collection.id),
    ).toMatchObject({
      state: "deleting",
      pageCount: 3,
      itemCount: 6,
    });
    await expect(
      firstConnection.database.readPages(collection.id),
    ).rejects.toMatchObject({
      code: "invalid_state",
    });
    firstConnection.database.close();

    const reopened = await openTestDatabase(
      firstConnection.name,
      firstConnection.clock,
    );
    try {
      const secondPass = await reopened.database.resumeDeletingCollections({
        pageBudget: 2,
      });
      expect(secondPass).toMatchObject({
        processedCollectionIds: [collection.id],
        deletedPages: 2,
        incompleteCleanup: true,
      });
      expect(
        await reopened.database.getCollection(collection.id),
      ).toMatchObject({
        state: "deleting",
        pageCount: 1,
        itemCount: 2,
      });
      const finalPass = await reopened.database.resumeDeletingCollections({
        pageBudget: 2,
      });
      expect(finalPass).toMatchObject({
        deletedCollectionIds: [collection.id],
        deletedPages: 1,
        incompleteCleanup: false,
      });
      expect(await reopened.database.getCollection(collection.id)).toBeNull();
    } finally {
      reopened.database.close();
    }
  });

  test("rejects malformed restored collection, run, and checkpoint rows as corrupt", async () => {
    const { database, name, clock } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Restore validation",
        kind: "raw",
        producer: { scriptId: "1", revision: "1", digest: DIGEST_A },
        source: {
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "read",
          argumentsDigest: DIGEST_B,
        },
      });
      const originalCollection = await database.getCollection(collection.id);
      if (originalCollection === null)
        throw new Error("Missing collection fixture");
      const collectionCases = [
        { ...originalCollection, creationNonce: "" },
        { ...originalCollection, name: "x".repeat(121) },
        {
          ...originalCollection,
          identity: { mode: "kernel", principal: null },
        },
        {
          ...originalCollection,
          producer: { ...originalCollection.producer!, extra: "not-v1" },
        },
        {
          ...originalCollection,
          sourceCollectionIds: Array.from(
            { length: 33 },
            (_, index) => `c_${index}`,
          ),
        },
        { ...originalCollection, updatedAt: originalCollection.createdAt - 1 },
        { ...originalCollection, summary: "x".repeat(16 * 1_024 + 1) },
      ];
      for (const candidate of collectionCases) {
        await editRawRecord(
          name,
          "collections",
          collection.id,
          () => candidate,
        );
        await expect(
          database.getCollection(collection.id),
        ).rejects.toMatchObject({
          code: "corrupt",
        });
      }
      await editRawRecord(
        name,
        "collections",
        collection.id,
        () => originalCollection,
      );

      const run = await database.createRun({
        source: { kind: "temporary", digest: DIGEST_A },
        deadlineAt: clock.now + 10_000,
      });
      const originalRun = await database.getRun(run.id);
      if (originalRun === null) throw new Error("Missing run fixture");
      const runCases = [
        { ...originalRun, sessionId: "" },
        { ...originalRun, identity: { mode: "kernel", principal: null } },
        {
          ...originalRun,
          source: {
            kind: "saved",
            scriptId: "0",
            revision: "1",
            digest: DIGEST_A,
          },
        },
        { ...originalRun, inputCollectionIds: [collection.id, collection.id] },
        { ...originalRun, summary: { impossible: true } },
        { ...originalRun, completedAt: originalRun.startedAt },
        {
          ...originalRun,
          deadlineAt: originalRun.startedAt + 5_000 + 240_000 + 1,
        },
        { ...originalRun, counters: { ...originalRun.counters, extra: 1 } },
        {
          ...originalRun,
          counters: { ...originalRun.counters, callCount: 1 },
          pendingUpdates: [
            {
              id: "update_1",
              canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
              method: "write",
              argumentsDigest: DIGEST_A,
              identityMode: "kernel",
              startedAt: originalRun.startedAt,
              status: "call_pending",
            },
          ],
        },
      ];
      for (const candidate of runCases) {
        await editRawRecord(name, "runs", run.id, () => candidate);
        await expect(database.getRun(run.id)).rejects.toMatchObject({
          code: "corrupt",
        });
      }
      await editRawRecord(name, "runs", run.id, () => originalRun);

      const checkpoint = await database.checkpointRun(
        handle(run),
        { cursor: 1 },
        0,
      );
      await editRawRecord(name, "checkpoints", run.id, (value) => ({
        ...(value as object),
        serializedBytes: checkpoint.serializedBytes + 1,
      }));
      await expect(database.getCheckpoint(run.id)).rejects.toMatchObject({
        code: "corrupt",
      });
      await editRawRecord(name, "checkpoints", run.id, () => ({
        ...checkpoint,
        revision: 0,
      }));
      await expect(database.getCheckpoint(run.id)).rejects.toMatchObject({
        code: "corrupt",
      });
      await editRawRecord(name, "checkpoints", run.id, () => ({
        ...checkpoint,
        updatedAt: run.startedAt - 1,
      }));
      await expect(database.getRunSnapshot(run.id)).rejects.toMatchObject({
        code: "corrupt",
      });
    } finally {
      database.close();
    }
  });

  test("deletes corrupt rows and pages in bounded reclaiming transactions", async () => {
    const { database, name } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Corrupt cleanup",
        kind: "raw",
      });
      for (let index = 0; index < 3; index += 1) {
        await database.putPage({
          collectionId: collection.id,
          idempotencyKey: `corrupt-${index}`,
          value: { index },
        });
      }
      await editRawRecord(name, "collections", collection.id, (value) => ({
        ...(value as object),
        name: "x".repeat(121),
      }));
      await editRawRecord(name, "pages", [collection.id, 0], (value) => ({
        ...(value as object),
        value: undefined,
        itemCount: "invalid",
        serializedBytes: "invalid",
      }));
      await editRawRecord(
        name,
        "pages",
        [collection.id, "invalid-sequence"],
        () => ({
          schema: 1,
          collectionId: collection.id,
          sequence: "invalid-sequence",
          digest: DIGEST_A,
          value: { corrupt: true },
          itemCount: 1,
          serializedBytes: 16,
          createdAt: 1_000,
        }),
      );

      let firstPass: unknown;
      const observed = await captureTransactions(async () => {
        firstPass = await database.deleteCollections([collection.id], {
          pageBudget: 1,
        });
      });
      expect(firstPass).toEqual({
        results: [{ id: collection.id, status: "deleting" }],
        incompleteCleanup: true,
      });
      expect(observed[0]).toEqual({
        stores: ["collections", "pages"],
        mode: "readwrite",
        durability: "default",
      });
      expect(
        observed.some(
          (transaction) =>
            transaction.mode === "readwrite" &&
            transaction.stores.length === 1 &&
            transaction.stores[0] === "collections",
        ),
      ).toBe(false);
      // The internal cleanup tombstone is not a reachable collection and does
      // not invent local-identity metadata for a corrupt row.
      expect(await database.getCollection(collection.id)).toBeNull();
      expect(
        await database.resumeDeletingCollections({ pageBudget: 3 }),
      ).toMatchObject({
        deletedCollectionIds: [collection.id],
        deletedPages: 3,
        incompleteCleanup: false,
      });
      expect(await database.getCollection(collection.id)).toBeNull();

      const invalidId = "invalid collection id";
      await editRawRecord(name, "collections", invalidId, () => ({
        id: invalidId,
        state: "deleting",
      }));
      expect(await database.resumeDeletingCollections()).toMatchObject({
        processedCollectionIds: [invalidId],
        deletedCollectionIds: [invalidId],
        incompleteCleanup: false,
      });
    } finally {
      database.close();
    }
  });

  test("stops multi-collection deletion between recoverable transactions", async () => {
    const { database } = await openTestDatabase();
    const controller = new AbortController();
    const collections = [];
    for (const name of ["First deletion", "Second deletion"]) {
      const collection = await createTestCollection(database, {
        name,
        kind: "raw",
      });
      await database.putPage({
        collectionId: collection.id,
        idempotencyKey: name,
        value: { name },
      });
      collections.push(collection);
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      IDBDatabase.prototype,
      "transaction",
    );
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error("IndexedDB transaction method is unavailable");
    }
    const original = descriptor.value as IDBDatabase["transaction"];
    let watched = false;
    Object.defineProperty(IDBDatabase.prototype, "transaction", {
      ...descriptor,
      value: function (this: IDBDatabase): IDBTransaction {
        const transaction = Reflect.apply(
          original,
          this,
          arguments,
        ) as IDBTransaction;
        const rawStores = arguments[0] as string | readonly string[];
        const stores =
          typeof rawStores === "string" ? [rawStores] : [...rawStores];
        if (
          !watched &&
          transaction.mode === "readwrite" &&
          stores.includes("collections") &&
          stores.includes("pages")
        ) {
          watched = true;
          transaction.addEventListener(
            "complete",
            () => {
              controller.abort(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        }
        return transaction;
      },
    });
    try {
      await expect(
        database.deleteCollections(
          collections.map((collection) => collection.id),
          { pageBudget: 2, signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await database.getCollection(collections[0]!.id)).toBeNull();
      expect(await database.getCollection(collections[1]!.id)).toMatchObject({
        state: "open",
        pageCount: 1,
      });
    } finally {
      Object.defineProperty(IDBDatabase.prototype, "transaction", descriptor);
      database.close();
    }
  });

  test("closes collections and reports internally consistent logical totals", async () => {
    const { database } = await openTestDatabase();
    try {
      const collection = await createTestCollection(database, {
        name: "Finished",
        kind: "raw",
      });
      const page = await database.putPage({
        collectionId: collection.id,
        idempotencyKey: "only-page",
        value: [1, 2, 3],
      });
      const completed = await database.completeCollection(collection.id, {
        total: 3,
      });
      expect(completed).toMatchObject({
        state: "complete",
        summary: { total: 3 },
      });
      expect(
        await database.completeCollection(collection.id, { total: 3 }),
      ).toEqual(completed);
      await expect(
        database.putPage({
          collectionId: collection.id,
          idempotencyKey: "too-late",
          value: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
      const status = await database.logicalStorageStatus();
      expect(status).toMatchObject({
        collectionCount: 1,
        pageCount: 1,
        itemCount: 3,
        serializedBytes: page.serializedBytes,
      });
    } finally {
      database.close();
    }
  });
});

describe("Blast storage boundary", () => {
  test("canonical JSON is stable across object insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: false } })).toBe(
      canonicalJson({ a: { x: false, y: true }, z: 1 }),
    );
  });

  test("classifies quota exhaustion without exposing raw browser errors", () => {
    const error = classifyBlastDatabaseError({ name: "QuotaExceededError" });
    expect(error).toBeInstanceOf(BlastDatabaseError);
    expect(error).toMatchObject({ code: "quota_exceeded" });
    expect(error.message).toContain("delete exact local collections");
  });

  test("does not fall back to memory when IndexedDB is unavailable", async () => {
    const previous = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    try {
      await expect(
        openBlastDatabase({
          databaseName: "must-not-open",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        writable: true,
        value: previous,
      });
    }
  });

  test("notifies once when another tab invalidates the database connection", async () => {
    const databaseName = `neutron-blast-versionchange-${(databaseSequence += 1)}`;
    let notifications = 0;
    const database = await openBlastDatabase({
      databaseName,
      onTerminated: () => {
        notifications += 1;
      },
    });
    let upgraded: IDBDatabase | null = null;
    try {
      upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 2);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Upgrade remained blocked"));
        request.onsuccess = () => resolve(request.result);
      });
      expect(notifications).toBe(1);
      await expect(database.listCollections()).rejects.toMatchObject({
        code: "terminated",
      });
      expect(notifications).toBe(1);
    } finally {
      upgraded?.close();
      database.close();
    }
  });
});

type ObservedTransaction = Readonly<{
  stores: string[];
  mode: IDBTransactionMode;
  durability: IDBTransactionDurability;
}>;

async function captureTransactions(
  operation: () => Promise<void>,
): Promise<ObservedTransaction[]> {
  const observed: ObservedTransaction[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(
    IDBDatabase.prototype,
    "transaction",
  );
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error("IndexedDB transaction method is unavailable");
  }
  const original = descriptor.value as IDBDatabase["transaction"];
  Object.defineProperty(IDBDatabase.prototype, "transaction", {
    ...descriptor,
    value: function (this: IDBDatabase): IDBTransaction {
      const transaction = Reflect.apply(
        original,
        this,
        arguments,
      ) as IDBTransaction;
      const rawStores = arguments[0] as string | readonly string[];
      observed.push({
        stores: typeof rawStores === "string" ? [rawStores] : [...rawStores],
        mode: transaction.mode,
        durability: transaction.durability,
      });
      return transaction;
    },
  });
  try {
    await operation();
    return observed;
  } finally {
    Object.defineProperty(IDBDatabase.prototype, "transaction", descriptor);
  }
}
