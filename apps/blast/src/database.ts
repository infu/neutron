import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";
import type { JsonValue } from "neutron-tools/app";
import {
  assertBoundedBlastJson,
  assertBoundedBlastStoredV1Json,
  blastStoredV1JsonNodeCount,
  isUnicodeScalarText,
  jsonBytes,
  randomId as randomBlastId,
  requiredBlastMethodName,
  sha256Hex,
  unicodeScalarLength,
} from "./json.ts";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "./limits.ts";

export const BLAST_DATABASE_NAME = "neutron-blast-collections-v1";
export const BLAST_DATABASE_VERSION = 1;

const COLLECTIONS_STORE = "collections" as const;
const PAGES_STORE = "pages" as const;
const RUNS_STORE = "runs" as const;
const CHECKPOINTS_STORE = "checkpoints" as const;
const COLLECTION_STATE_INDEX = "by_state" as const;
const PAGE_IDEMPOTENCY_INDEX = "by_idempotency" as const;
const PAGE_COLLECTION_INDEX = "by_collection" as const;
const RUN_STATE_INDEX = "by_state" as const;
const RUN_COMPLETED_INDEX = "by_completed" as const;

const MAX_ID_CHARACTERS = 160;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 512;
const MAX_COLLECTION_LINKS = 32;
const MAX_DELETE_IDS = 64;
const MAX_RUN_COLLECTIONS = 64;
const MAX_CONCURRENT_RUNS = 8;
const MAX_RUNS_INTERRUPTED_PER_PASS = 100;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_NAT64 = 18_446_744_073_709_551_615n;

const COLLECTION_RECORD_FIELDS = Object.freeze([
  "schema",
  "id",
  "creationNonce",
  "name",
  "description",
  "state",
  "kind",
  "createdAt",
  "updatedAt",
  "nextSequence",
  "pageCount",
  "itemCount",
  "serializedBytes",
  "producer",
  "identity",
  "source",
  "sourceCollectionIds",
  "summary",
]);
const PAGE_RECORD_FIELDS = Object.freeze([
  "schema",
  "collectionId",
  "sequence",
  "digest",
  "value",
  "itemCount",
  "serializedBytes",
  "createdAt",
]);
const PAGE_RECORD_FIELDS_WITH_IDEMPOTENCY = Object.freeze([
  ...PAGE_RECORD_FIELDS,
  "idempotencyKey",
]);
const RUN_RECORD_FIELDS = Object.freeze([
  "schema",
  "id",
  "sessionId",
  "source",
  "state",
  "startedAt",
  "updatedAt",
  "completedAt",
  "deadlineAt",
  "inputCollectionIds",
  "outputCollectionIds",
  "identity",
  "counters",
  "pendingUpdates",
  "checkpointRevision",
  "summary",
]);
const PENDING_UPDATE_FIELDS = Object.freeze([
  "id",
  "canister",
  "method",
  "argumentsDigest",
  "identityMode",
  "startedAt",
  "status",
]);
const CHECKPOINT_RECORD_FIELDS = Object.freeze([
  "schema",
  "runId",
  "revision",
  "sourceDigest",
  "inputCollectionIds",
  "outputCollectionIds",
  "acknowledgedUpdateIds",
  "value",
  "serializedBytes",
  "updatedAt",
]);

export const BLAST_COLLECTION_LIMIT = 1_024;
export const BLAST_PENDING_UPDATE_LIMIT = 8;
export const BLAST_TERMINAL_RUN_RETENTION = 256;
export const BLAST_RUN_PRUNE_BATCH = 32;
export const BLAST_RUN_BUDGETS = Object.freeze({
  calls: 64,
  requestBytes: 2 * 1_024 * 1_024,
  responseBytes: 8 * 1_024 * 1_024,
  pageReads: 256,
  pageWrites: 256,
  readBytes: 16 * 1_024 * 1_024,
  writeBytes: 16 * 1_024 * 1_024,
});

export type CollectionState = "open" | "complete" | "failed" | "deleting";
export type CollectionKind = "raw" | "derived";
export type RunState =
  "running" | "complete" | "failed" | "cancelled" | "interrupted";

export type CollectionProducer = Readonly<{
  scriptId: string;
  revision: string;
  digest: string;
}>;

export type CollectionIdentity = Readonly<{
  mode: "local";
  principal: string;
}>;

export type CollectionSource = Readonly<{
  canister: string;
  method: string;
  argumentsDigest: string;
}>;

export type CollectionRecord = Readonly<{
  schema: 1;
  id: string;
  creationNonce: string;
  name: string;
  description: string | null;
  state: CollectionState;
  kind: CollectionKind;
  createdAt: number;
  updatedAt: number;
  nextSequence: number;
  pageCount: number;
  itemCount: number;
  serializedBytes: number;
  producer: CollectionProducer | null;
  identity: CollectionIdentity;
  source: CollectionSource | null;
  sourceCollectionIds: string[];
  summary: JsonValue | null;
}>;

type CollectionCleanupRecord = Readonly<
  Omit<CollectionRecord, "state" | "identity"> & {
    state: "deleting";
    identity: null;
  }
>;

type StoredCollectionRecord = CollectionRecord | CollectionCleanupRecord;

export type CollectionListEntry = Omit<
  CollectionRecord,
  "schema" | "creationNonce" | "nextSequence" | "description" | "summary"
>;

export type CollectionPageRecord = Readonly<{
  schema: 1;
  collectionId: string;
  sequence: number;
  idempotencyKey?: string;
  digest: string;
  value: JsonValue;
  itemCount: number;
  serializedBytes: number;
  createdAt: number;
}>;

export type RunSource =
  | Readonly<{ kind: "temporary"; digest: string }>
  | Readonly<{
      kind: "saved";
      scriptId: string;
      revision: string;
      digest: string;
    }>;

export type RunCounters = Readonly<{
  callCount: number;
  requestBytes: number;
  responseBytes: number;
  pageReadCount: number;
  pageWriteCount: number;
  readBytes: number;
  writeBytes: number;
}>;

export type PendingUpdateAttempt = Readonly<{
  id: string;
  canister: string;
  method: string;
  argumentsDigest: string;
  identityMode: "local";
  startedAt: number;
  status: "call_pending" | "dispatch_confirmed";
}>;

export type RunRecord = Readonly<{
  schema: 1;
  id: string;
  sessionId: string;
  source: RunSource;
  state: RunState;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  deadlineAt: number;
  inputCollectionIds: string[];
  outputCollectionIds: string[];
  identity: CollectionIdentity | null;
  counters: RunCounters;
  pendingUpdates: PendingUpdateAttempt[];
  checkpointRevision: number;
  summary: JsonValue | null;
}>;

export type RunHandle = Readonly<{
  runId: string;
  sessionId: string;
}>;

export type RunListEntry = Omit<
  RunRecord,
  | "schema"
  | "sessionId"
  | "inputCollectionIds"
  | "outputCollectionIds"
  | "pendingUpdates"
  | "summary"
> &
  Readonly<{
    inputCollectionCount: number;
    outputCollectionCount: number;
    pendingUpdateCount: number;
  }>;

export type ListRunsOptions = Readonly<{
  cursor?: string | null;
  limit?: number;
}>;

export type RunListPage = Readonly<{
  runs: RunListEntry[];
  cursor: string | null;
}>;

export type RunSnapshot = Readonly<{
  run: RunRecord;
  checkpoint: CheckpointRecord | null;
}>;

export type CheckpointRecord = Readonly<{
  schema: 1;
  runId: string;
  revision: number;
  sourceDigest: string;
  inputCollectionIds: string[];
  outputCollectionIds: string[];
  acknowledgedUpdateIds: string[];
  value: JsonValue;
  serializedBytes: number;
  updatedAt: number;
}>;

interface BlastCollectionsSchema extends DBSchema {
  collections: {
    key: string;
    value: StoredCollectionRecord;
    indexes: { by_state: CollectionState };
  };
  pages: {
    key: [string, number];
    value: CollectionPageRecord;
    indexes: {
      by_idempotency: [string, string];
      by_collection: string;
    };
  };
  runs: {
    key: string;
    value: RunRecord;
    indexes: {
      by_state: RunState;
      by_completed: [number, string];
    };
  };
  checkpoints: {
    key: string;
    value: CheckpointRecord;
  };
}

export type BlastDatabaseErrorCode =
  | "unavailable"
  | "blocked"
  | "terminated"
  | "quota_exceeded"
  | "not_found"
  | "invalid_state"
  | "conflict"
  | "idempotency_conflict"
  | "corrupt"
  | "storage_error";

export class BlastDatabaseError extends Error {
  constructor(
    public readonly code: BlastDatabaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BlastDatabaseError";
  }
}

/** A valid stored page that cannot fit a caller's smaller read envelope. */
export class BlastPageReadLimitError extends BlastDatabaseError {
  constructor(
    public readonly sequence: number,
    public readonly serializedBytes: number,
    public readonly maximumBytes: number,
  ) {
    super(
      "invalid_state",
      `Collection page ${sequence} is ${serializedBytes} bytes and exceeds the ${maximumBytes}-byte read limit`,
    );
    this.name = "BlastPageReadLimitError";
  }
}

/** A valid stored page that cannot fit a caller's JSON-node envelope. */
export class BlastPageReadNodeLimitError extends BlastDatabaseError {
  constructor(
    public readonly sequence: number,
    public readonly jsonNodes: number,
    public readonly maximumNodes: number,
  ) {
    super(
      "invalid_state",
      `Collection page ${sequence} has ${jsonNodes} JSON values and exceeds the ${maximumNodes}-value read limit`,
    );
    this.name = "BlastPageReadNodeLimitError";
  }
}

export type OpenBlastDatabaseOptions = Readonly<{
  databaseName?: string;
  now?: () => number;
  idFactory?: (prefix: string) => string;
  onBlocked?: (currentVersion: number, blockedVersion: number | null) => void;
  onTerminated?: () => void;
}>;

export type CreateCollectionInput = Readonly<{
  name: string;
  description?: string | null;
  kind: CollectionKind;
  producer?: CollectionProducer | null;
  identity: CollectionIdentity;
  source?: CollectionSource | null;
  sourceCollectionIds?: readonly string[];
  run?: RunHandle;
}>;

export type ListCollectionsOptions = Readonly<{
  cursor?: string | null;
  limit?: number;
}>;

export type CollectionListPage = Readonly<{
  collections: CollectionListEntry[];
  cursor: string | null;
}>;

export type ReadPagesOptions = Readonly<{
  cursor?: string | null;
  limit?: number;
  maxBytes?: number;
  maxNodes?: number;
  run?: RunHandle;
}>;

export type CollectionPageBatch = Readonly<{
  pages: CollectionPageRecord[];
  cursor: string | null;
  serializedBytes: number;
}>;

export type CollectionDescription = Readonly<{
  collection: CollectionRecord;
  pages: CollectionPageRecord[];
  cursor: string | null;
  serializedBytes: number;
  oversizedPage: Readonly<{
    sequence: number;
    serializedBytes: number;
    maximumBytes: number;
  }> | null;
}>;

export type PutPageInput = Readonly<{
  collectionId: string;
  idempotencyKey: string;
  value: JsonValue;
  run?: RunHandle;
}>;

export type AppendPageInput = Readonly<{
  collectionId: string;
  value: JsonValue;
  idempotencyKey?: string | null;
  run?: RunHandle;
}>;

export type PageWriteResult = Readonly<{
  status: "written" | "replayed";
  sequence: number;
  digest: string;
  itemCount: number;
  serializedBytes: number;
}>;

export type DeleteCollectionStatus = "missing" | "deleting" | "deleted";

export type DeleteCollectionsResult = Readonly<{
  results: Array<Readonly<{ id: string; status: DeleteCollectionStatus }>>;
  incompleteCleanup: boolean;
}>;

export type ResumeDeletionResult = Readonly<{
  processedCollectionIds: string[];
  deletedCollectionIds: string[];
  deletedPages: number;
  incompleteCleanup: boolean;
}>;

export type CreateRunInput = Readonly<{
  source: RunSource;
  deadlineAt: number;
  inputCollectionIds?: readonly string[];
  outputCollectionIds?: readonly string[];
  identity?: CollectionIdentity | null;
}>;

export type LogicalStorageStatus = Readonly<{
  collectionCount: number;
  deletingCollectionCount: number;
  pageCount: number;
  itemCount: number;
  serializedBytes: number;
  runningRunCount: number;
}>;

export type PruneTerminalRunsResult = Readonly<{
  deletedRunIds: string[];
  terminalRunCount: number;
  incomplete: boolean;
}>;

export type DeleteRunResult = Readonly<{
  id: string;
  status: "deleted" | "not_found";
  unresolvedUpdateCount: number;
}>;

/**
 * Opens Blast's browser-local collection database.
 *
 * This deliberately fails when IndexedDB is unavailable. Collection durability
 * must never silently degrade to an in-memory implementation.
 */
export async function openBlastDatabase(
  options: OpenBlastDatabaseOptions = {},
): Promise<BlastDatabase> {
  if (typeof globalThis.indexedDB === "undefined") {
    throw new BlastDatabaseError(
      "unavailable",
      "Blast browser storage is unavailable in this context",
    );
  }
  const databaseName = options.databaseName ?? BLAST_DATABASE_NAME;
  if (
    typeof databaseName !== "string" ||
    databaseName.length < 1 ||
    databaseName.length > 256
  ) {
    throw new Error("Blast database name is invalid");
  }

  let opened: IDBPDatabase<BlastCollectionsSchema> | null = null;
  let invalidated: BlastDatabaseError | null = null;
  let terminationNotified = false;
  const notifyTermination = () => {
    if (terminationNotified) return;
    terminationNotified = true;
    options.onTerminated?.();
  };
  let rejectBlocked!: (error: BlastDatabaseError) => void;
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject;
  });
  const opening = openDB<BlastCollectionsSchema>(
    databaseName,
    BLAST_DATABASE_VERSION,
    {
      upgrade(database, oldVersion) {
        if (oldVersion !== 0) {
          throw new BlastDatabaseError(
            "corrupt",
            `Blast browser storage cannot upgrade unexpected schema ${oldVersion}`,
          );
        }
        const collections = database.createObjectStore(COLLECTIONS_STORE, {
          keyPath: "id",
        });
        collections.createIndex(COLLECTION_STATE_INDEX, "state");
        const pages = database.createObjectStore(PAGES_STORE, {
          keyPath: ["collectionId", "sequence"],
        });
        pages.createIndex(
          PAGE_IDEMPOTENCY_INDEX,
          ["collectionId", "idempotencyKey"],
          { unique: true },
        );
        pages.createIndex(PAGE_COLLECTION_INDEX, "collectionId");
        const runs = database.createObjectStore(RUNS_STORE, { keyPath: "id" });
        runs.createIndex(RUN_STATE_INDEX, "state");
        // `completedAt: null` is not an IndexedDB key, so running records are
        // structurally absent from this terminal-only retention index.
        runs.createIndex(RUN_COMPLETED_INDEX, ["completedAt", "id"]);
        database.createObjectStore(CHECKPOINTS_STORE, { keyPath: "runId" });
      },
      blocked(currentVersion, blockedVersion) {
        options.onBlocked?.(currentVersion, blockedVersion);
        rejectBlocked(
          new BlastDatabaseError(
            "blocked",
            "Blast browser storage is blocked by another open tab; reload that tab and retry",
          ),
        );
      },
      blocking() {
        invalidated = new BlastDatabaseError(
          "terminated",
          "Blast browser storage was closed for a schema change in another tab",
        );
        opened?.close();
        notifyTermination();
      },
      terminated() {
        invalidated = new BlastDatabaseError(
          "terminated",
          "Blast browser storage connection terminated unexpectedly",
        );
        notifyTermination();
      },
    },
  );

  try {
    opened = await Promise.race([opening, blocked]);
  } catch (error) {
    // If the blocked race wins and the old tab closes later, do not leak the
    // now-unwanted connection.
    void opening.then(
      (database) => database.close(),
      () => undefined,
    );
    throw classifyBlastDatabaseError(error);
  }
  return new BlastDatabase(
    opened,
    options.now ?? Date.now,
    options.idFactory ?? randomBlastId,
    () => invalidated,
  );
}

export class BlastDatabase {
  readonly #database: IDBPDatabase<BlastCollectionsSchema>;
  readonly #now: () => number;
  readonly #idFactory: (prefix: string) => string;
  readonly #invalidation: () => BlastDatabaseError | null;
  #closed = false;

  constructor(
    database: IDBPDatabase<BlastCollectionsSchema>,
    now: () => number,
    idFactory: (prefix: string) => string,
    invalidation: () => BlastDatabaseError | null,
  ) {
    this.#database = database;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#invalidation = invalidation;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  async createCollection(
    input: CreateCollectionInput,
  ): Promise<CollectionRecord> {
    this.#requireOpen();
    const now = this.#timestamp();
    const name = requiredScalarString(
      input.name,
      "Collection name",
      BLAST_LIMITS.collectionNameCharacters,
    );
    const description = optionalScalarString(
      input.description,
      "Collection description",
      BLAST_LIMITS.collectionDescriptionCharacters,
    );
    const kind = assertCollectionKind(input.kind);
    const producer = normalizeProducer(input.producer);
    const identity = normalizeCollectionIdentity(input.identity);
    const source = normalizeSource(input.source);
    const sourceCollectionIds = normalizeCollectionIds(
      input.sourceCollectionIds ?? [],
      MAX_COLLECTION_LINKS,
      "Source collection IDs",
    );
    const run = input.run === undefined ? null : normalizeRunHandle(input.run);
    const id = assertGeneratedId(
      this.#idFactory("collection"),
      "Collection ID",
    );
    const creationNonce = assertGeneratedId(
      this.#idFactory("nonce"),
      "Collection creation nonce",
    );
    const record: CollectionRecord = {
      schema: 1,
      id,
      creationNonce,
      name,
      description,
      state: "open",
      kind,
      createdAt: now,
      updatedAt: now,
      nextSequence: 0,
      pageCount: 0,
      itemCount: 0,
      serializedBytes: 0,
      producer,
      identity,
      source,
      sourceCollectionIds,
      summary: null,
    };

    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, RUNS_STORE],
        "readwrite",
      );
      try {
        const collections = transaction.objectStore(COLLECTIONS_STORE);
        if ((await collections.count()) >= BLAST_COLLECTION_LIMIT) {
          throw new BlastDatabaseError(
            "invalid_state",
            `Blast collection capacity of ${BLAST_COLLECTION_LIMIT} is exhausted`,
          );
        }
        for (const sourceId of sourceCollectionIds) {
          const sourceRecord = await collections.get(sourceId);
          requireReadableCollection(sourceRecord, sourceId);
        }
        let runRecord: RunRecord | null = null;
        let runUpdatedAt = now;
        if (run !== null) {
          const storedRun = await transaction
            .objectStore(RUNS_STORE)
            .get(run.runId);
          runUpdatedAt = this.#timestamp();
          runRecord = requireWritableRun(storedRun, run, runUpdatedAt);
          if (runRecord.outputCollectionIds.length >= MAX_RUN_COLLECTIONS) {
            throw new BlastDatabaseError(
              "invalid_state",
              "Blast run has too many output collections",
            );
          }
        }
        await collections.add(record);
        if (runRecord !== null && !runRecord.outputCollectionIds.includes(id)) {
          await transaction.objectStore(RUNS_STORE).put({
            ...runRecord,
            outputCollectionIds: [...runRecord.outputCollectionIds, id],
            updatedAt: monotonicNow(runRecord.updatedAt, runUpdatedAt),
          });
        }
        await transaction.done;
        return record;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async getCollection(id: string): Promise<CollectionRecord | null> {
    this.#requireOpen();
    const collectionId = assertId(id, "Collection ID");
    try {
      const transaction = this.#database.transaction(
        COLLECTIONS_STORE,
        "readonly",
      );
      const value = await transaction.store.get(collectionId);
      await transaction.done;
      if (value === undefined) return null;
      const collection = validateStoredCollectionRecord(value, collectionId);
      return collection.identity === null ? null : collection;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async listCollections(
    options: ListCollectionsOptions = {},
  ): Promise<CollectionListPage> {
    this.#requireOpen();
    const limit = boundedPositiveInteger(
      options.limit ?? BLAST_LIMITS.collectionListPage,
      "Collection list limit",
      BLAST_LIMITS.collectionListPage,
    );
    const cursor =
      options.cursor === undefined || options.cursor === null
        ? null
        : assertId(options.cursor, "Collection list cursor");
    try {
      const transaction = this.#database.transaction(
        COLLECTIONS_STORE,
        "readonly",
      );
      const range =
        cursor === null ? undefined : IDBKeyRange.lowerBound(cursor, true);
      let databaseCursor = await transaction.store.openCursor(range);
      const collections: CollectionListEntry[] = [];
      let hasMore = false;
      while (databaseCursor !== null) {
        if (collections.length >= limit) {
          hasMore = true;
          break;
        }
        const collection = validateStoredCollectionRecord(
          databaseCursor.value,
          databaseCursor.key,
        );
        if (collection.identity !== null) {
          collections.push(toCollectionListEntry(collection));
        }
        databaseCursor = await databaseCursor.continue();
      }
      await transaction.done;
      return {
        collections,
        cursor: hasMore ? collections.at(-1)!.id : null,
      };
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async describeCollection(
    id: string,
    options: ReadPagesOptions = {},
  ): Promise<CollectionDescription> {
    this.#requireOpen();
    const collectionId = assertId(id, "Collection ID");
    if (options.run !== undefined) {
      throw new Error("Collection descriptions cannot carry a run capability");
    }
    const afterSequence = decodePageCursor(options.cursor);
    const limit = boundedPositiveInteger(
      options.limit ?? BLAST_LIMITS.collectionBatchPages,
      "Collection page limit",
      BLAST_LIMITS.collectionBatchPages,
    );
    const maxBytes = boundedPositiveInteger(
      options.maxBytes ?? BLAST_LIMITS.collectionBatchBytes,
      "Collection page byte limit",
      BLAST_LIMITS.collectionBatchBytes,
    );
    const maxNodes = boundedPositiveInteger(
      options.maxNodes ?? BLAST_STORED_V1_JSON_LIMITS.nodes,
      "Collection page JSON-value limit",
      BLAST_STORED_V1_JSON_LIMITS.nodes,
    );
    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, PAGES_STORE],
        "readonly",
      );
      const collection = requireReadableCollection(
        await transaction.objectStore(COLLECTIONS_STORE).get(collectionId),
        collectionId,
      );
      try {
        const batch = await readPageBatch(
          transaction,
          collectionId,
          afterSequence,
          limit,
          maxBytes,
          maxNodes,
        );
        await transaction.done;
        return { collection, ...batch, oversizedPage: null };
      } catch (error) {
        if (!(error instanceof BlastPageReadLimitError)) throw error;
        await transaction.done;
        // A compact describe response may intentionally sample below the full
        // stored-page bound. Report and advance past an oversized sample so a
        // caller never receives a cursor that is stuck on the same page.
        return {
          collection,
          pages: [],
          cursor: encodePageCursor(error.sequence),
          serializedBytes: 0,
          oversizedPage: {
            sequence: error.sequence,
            serializedBytes: error.serializedBytes,
            maximumBytes: error.maximumBytes,
          },
        };
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async putPage(input: PutPageInput): Promise<PageWriteResult> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    return await this.#writePage(
      input.collectionId,
      input.value,
      "raw",
      idempotencyKey,
      input.run,
    );
  }

  async append(input: AppendPageInput): Promise<PageWriteResult> {
    const idempotencyKey =
      input.idempotencyKey === undefined || input.idempotencyKey === null
        ? null
        : assertIdempotencyKey(input.idempotencyKey);
    return await this.#writePage(
      input.collectionId,
      input.value,
      "derived",
      idempotencyKey,
      input.run,
    );
  }

  async readPages(
    id: string,
    options: ReadPagesOptions = {},
  ): Promise<CollectionPageBatch> {
    this.#requireOpen();
    const collectionId = assertId(id, "Collection ID");
    const afterSequence = decodePageCursor(options.cursor);
    const limit = boundedPositiveInteger(
      options.limit ?? BLAST_LIMITS.collectionBatchPages,
      "Collection page limit",
      BLAST_LIMITS.collectionBatchPages,
    );
    const maxBytes = boundedPositiveInteger(
      options.maxBytes ?? BLAST_LIMITS.collectionBatchBytes,
      "Collection page byte limit",
      BLAST_LIMITS.collectionBatchBytes,
    );
    const maxNodes = boundedPositiveInteger(
      options.maxNodes ?? BLAST_STORED_V1_JSON_LIMITS.nodes,
      "Collection page JSON-value limit",
      BLAST_STORED_V1_JSON_LIMITS.nodes,
    );
    const run =
      options.run === undefined ? null : normalizeRunHandle(options.run);
    try {
      if (run === null) {
        const transaction = this.#database.transaction(
          [COLLECTIONS_STORE, PAGES_STORE],
          "readonly",
        );
        requireReadableCollection(
          await transaction.objectStore(COLLECTIONS_STORE).get(collectionId),
          collectionId,
        );
        const batch = await readPageBatch(
          transaction,
          collectionId,
          afterSequence,
          limit,
          maxBytes,
          maxNodes,
        );
        await transaction.done;
        return batch;
      }

      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, PAGES_STORE, RUNS_STORE],
        "readwrite",
      );
      const collection = requireReadableCollection(
        await transaction.objectStore(COLLECTIONS_STORE).get(collectionId),
        collectionId,
      );
      const runStore = transaction.objectStore(RUNS_STORE);
      const storedRun = await runStore.get(run.runId);
      const activeNow = this.#timestamp();
      const runRecord = requireWritableRun(storedRun, run, activeNow);
      requireRunCollectionAccess(runRecord, collection.id, "read");
      const batch = await readPageBatch(
        transaction,
        collectionId,
        afterSequence,
        limit,
        maxBytes,
        maxNodes,
      );
      await runStore.put({
        ...runRecord,
        updatedAt: monotonicNow(runRecord.updatedAt, activeNow),
        counters: {
          ...runRecord.counters,
          pageReadCount: addWithinRunBudget(
            runRecord.counters.pageReadCount,
            batch.pages.length,
            BLAST_RUN_BUDGETS.pageReads,
            "page read count",
          ),
          readBytes: addWithinRunBudget(
            runRecord.counters.readBytes,
            batch.serializedBytes,
            BLAST_RUN_BUDGETS.readBytes,
            "page read bytes",
          ),
        },
      });
      await transaction.done;
      return batch;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async completeCollection(
    id: string,
    summary: JsonValue = null,
    run?: RunHandle,
  ): Promise<CollectionRecord> {
    return await this.#finishCollection(id, "complete", summary, run);
  }

  async failCollection(
    id: string,
    summary: JsonValue,
    run?: RunHandle,
  ): Promise<CollectionRecord> {
    return await this.#finishCollection(id, "failed", summary, run);
  }

  async deleteCollections(
    ids: readonly string[],
    options: Readonly<{
      pageBudget?: number;
      signal?: AbortSignal;
    }> = {},
  ): Promise<DeleteCollectionsResult> {
    this.#requireOpen();
    const collectionIds = normalizeCollectionIds(
      ids,
      MAX_DELETE_IDS,
      "Collection delete IDs",
    );
    const pageBudget = boundedPositiveInteger(
      options.pageBudget ?? BLAST_LIMITS.collectionDeleteBatch,
      "Collection deletion page budget",
      BLAST_LIMITS.collectionDeleteBatch,
    );
    let remainingBudget = pageBudget;
    const statuses = new Map<string, DeleteCollectionStatus>();
    for (const id of collectionIds) {
      options.signal?.throwIfAborted();
      // Marking and the first reclaim happen in one transaction. This keeps
      // deletion recoverable without requiring a growth-only catalogue write
      // to succeed while the origin is already at quota.
      const result = await this.#deleteCollectionBatch(
        id,
        remainingBudget,
        true,
      );
      remainingBudget -= result.deletedPages;
      statuses.set(
        id,
        !result.found ? "missing" : result.deleted ? "deleted" : "deleting",
      );
    }
    return {
      results: collectionIds.map((id) => ({ id, status: statuses.get(id)! })),
      incompleteCleanup: await this.hasIncompleteDeletion(),
    };
  }

  async resumeDeletingCollections(
    options: Readonly<{ pageBudget?: number; collectionLimit?: number }> = {},
  ): Promise<ResumeDeletionResult> {
    this.#requireOpen();
    const pageBudget = boundedPositiveInteger(
      options.pageBudget ?? BLAST_LIMITS.collectionDeleteBatch,
      "Collection deletion page budget",
      BLAST_LIMITS.collectionDeleteBatch,
    );
    const collectionLimit = boundedPositiveInteger(
      options.collectionLimit ?? BLAST_LIMITS.collectionListPage,
      "Collection cleanup limit",
      BLAST_LIMITS.collectionListPage,
    );
    const ids = await this.#deletingCollectionIds(collectionLimit);
    const processedCollectionIds: string[] = [];
    const deletedCollectionIds: string[] = [];
    let deletedPages = 0;
    for (const id of ids) {
      if (deletedPages >= pageBudget) break;
      const result = await this.#deleteCollectionBatch(
        id,
        pageBudget - deletedPages,
      );
      processedCollectionIds.push(id);
      deletedPages += result.deletedPages;
      if (result.deleted) deletedCollectionIds.push(id);
    }
    return {
      processedCollectionIds,
      deletedCollectionIds,
      deletedPages,
      incompleteCleanup: await this.hasIncompleteDeletion(),
    };
  }

  async hasIncompleteDeletion(): Promise<boolean> {
    this.#requireOpen();
    try {
      const transaction = this.#database.transaction(
        COLLECTIONS_STORE,
        "readonly",
      );
      const key = await transaction.store
        .index(COLLECTION_STATE_INDEX)
        .getKey("deleting");
      await transaction.done;
      return key !== undefined;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    this.#requireOpen();
    // Expire abandoned work before applying the origin-wide running cap, then
    // reserve one terminal-history slot for every admitted running script.
    await this.interruptExpiredRuns(MAX_RUNS_INTERRUPTED_PER_PASS);
    const now = this.#timestamp();
    const source = normalizeRunSource(input.source);
    const deadlineAt = boundedTimestamp(input.deadlineAt, "Run deadline");
    if (deadlineAt <= now)
      throw new Error("Run deadline must be in the future");
    if (deadlineAt - now > BLAST_LIMITS.scriptMaximumTimeoutMs + 5_000) {
      throw new Error("Run deadline exceeds the supported execution window");
    }
    const inputCollectionIds = normalizeCollectionIds(
      input.inputCollectionIds ?? [],
      MAX_RUN_COLLECTIONS,
      "Run input collection IDs",
    );
    const outputCollectionIds = normalizeCollectionIds(
      input.outputCollectionIds ?? [],
      MAX_RUN_COLLECTIONS,
      "Run output collection IDs",
    );
    const identity = normalizeOptionalIdentity(input.identity);
    const id = assertGeneratedId(this.#idFactory("run"), "Run ID");
    const sessionId = assertGeneratedId(
      this.#idFactory("session"),
      "Run session ID",
    );
    const record: RunRecord = {
      schema: 1,
      id,
      sessionId,
      source,
      state: "running",
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      deadlineAt,
      inputCollectionIds,
      outputCollectionIds,
      identity,
      counters: emptyRunCounters(),
      pendingUpdates: [],
      checkpointRevision: 0,
      summary: null,
    };
    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, RUNS_STORE, CHECKPOINTS_STORE],
        "readwrite",
      );
      try {
        const runStore = transaction.objectStore(RUNS_STORE);
        const runningIndex = runStore.index(RUN_STATE_INDEX);
        let runningCursor = await runningIndex.openCursor("running");
        let runningRunCount = 0;
        const requestedOutputs = new Set(outputCollectionIds);
        while (runningCursor !== null) {
          const running = validateRunRecord(
            runningCursor.value,
            runningCursor.primaryKey,
          );
          runningRunCount += 1;
          if (
            requestedOutputs.size > 0 &&
            running.outputCollectionIds.some((id) => requestedOutputs.has(id))
          ) {
            throw new BlastDatabaseError(
              "conflict",
              "An output collection is already owned by another running script",
            );
          }
          runningCursor = await runningCursor.continue();
        }
        if (runningRunCount >= MAX_CONCURRENT_RUNS) {
          throw new BlastDatabaseError(
            "invalid_state",
            `Blast already has ${MAX_CONCURRENT_RUNS} running scripts in this browser origin`,
          );
        }
        const retained = await pruneTerminalRunsInTransaction(
          transaction,
          Math.max(0, BLAST_TERMINAL_RUN_RETENTION - runningRunCount - 1),
          BLAST_RUN_PRUNE_BATCH,
        );
        if (retained.incomplete) throw runHistoryCapacityError();
        const collectionStore = transaction.objectStore(COLLECTIONS_STORE);
        for (const collectionId of inputCollectionIds) {
          requireReadableCollection(
            await collectionStore.get(collectionId),
            collectionId,
          );
        }
        for (const collectionId of outputCollectionIds) {
          const collection = requireReadableCollection(
            await collectionStore.get(collectionId),
            collectionId,
          );
          if (collection.state !== "open") {
            throw new BlastDatabaseError(
              "invalid_state",
              `Output collection ${collectionId} is not open`,
            );
          }
        }
        const admittedAt = this.#timestamp();
        if (
          deadlineAt <= admittedAt ||
          deadlineAt - admittedAt > BLAST_LIMITS.scriptMaximumTimeoutMs + 5_000
        ) {
          throw new BlastDatabaseError(
            "invalid_state",
            "Run deadline elapsed while browser storage admission was pending",
          );
        }
        const admittedRecord: RunRecord = {
          ...record,
          startedAt: admittedAt,
          updatedAt: admittedAt,
        };
        await runStore.add(admittedRecord);
        await transaction.done;
        return admittedRecord;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async getRun(id: string): Promise<RunRecord | null> {
    this.#requireOpen();
    const runId = assertId(id, "Run ID");
    try {
      const transaction = this.#database.transaction(RUNS_STORE, "readonly");
      const value = await transaction.store.get(runId);
      await transaction.done;
      return value === undefined ? null : validateRunRecord(value, runId);
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  /** Read a run and its latest checkpoint from one IndexedDB snapshot. */
  async getRunSnapshot(id: string): Promise<RunSnapshot | null> {
    this.#requireOpen();
    const runId = assertId(id, "Run ID");
    try {
      const transaction = this.#database.transaction(
        [RUNS_STORE, CHECKPOINTS_STORE],
        "readonly",
      );
      const [runValue, checkpointValue] = await Promise.all([
        transaction.objectStore(RUNS_STORE).get(runId),
        transaction.objectStore(CHECKPOINTS_STORE).get(runId),
      ]);
      await transaction.done;
      if (runValue === undefined) {
        if (checkpointValue !== undefined) {
          throw corrupt(`Checkpoint exists without run ${runId}`);
        }
        return null;
      }
      const run = validateRunRecord(runValue, runId);
      const checkpoint =
        checkpointValue === undefined
          ? null
          : validateCheckpointRecord(checkpointValue, runId);
      if (
        (checkpoint === null && run.checkpointRevision !== 0) ||
        (checkpoint !== null && !checkpointMatchesRun(checkpoint, run))
      ) {
        throw corrupt(`Run ${runId} checkpoint revision is inconsistent`);
      }
      return { run, checkpoint };
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async deleteRun(
    id: string,
    acknowledgeUnresolvedUpdates = false,
  ): Promise<DeleteRunResult> {
    this.#requireOpen();
    const runId = assertId(id, "Run ID");
    if (typeof acknowledgeUnresolvedUpdates !== "boolean") {
      throw new Error("Run evidence acknowledgement must be boolean");
    }
    try {
      const transaction = this.#database.transaction(
        [RUNS_STORE, CHECKPOINTS_STORE],
        "readwrite",
      );
      try {
        const runs = transaction.objectStore(RUNS_STORE);
        const value = await runs.get(runId);
        if (value === undefined) {
          // Keep exact-id deletion idempotent and repair an otherwise unusable
          // orphan checkpoint under the same key.
          await transaction.objectStore(CHECKPOINTS_STORE).delete(runId);
          await transaction.done;
          return { id: runId, status: "not_found", unresolvedUpdateCount: 0 };
        }
        const run = validateRunRecord(value, runId);
        if (run.state === "running") {
          throw new BlastDatabaseError(
            "invalid_state",
            `Run ${runId} is still running and cannot be deleted`,
          );
        }
        const unresolvedUpdateCount = runPendingUpdateCount(run);
        if (unresolvedUpdateCount > 0 && !acknowledgeUnresolvedUpdates) {
          throw new BlastDatabaseError(
            "invalid_state",
            `Run ${runId} retains ${unresolvedUpdateCount} uncheckpointed update ${
              unresolvedUpdateCount === 1 ? "attempt" : "attempts"
            }; inspect it and set acknowledgeUnresolvedUpdates to true to delete it`,
          );
        }
        await runs.delete(runId);
        await transaction.objectStore(CHECKPOINTS_STORE).delete(runId);
        await transaction.done;
        return { id: runId, status: "deleted", unresolvedUpdateCount };
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunListPage> {
    this.#requireOpen();
    const limit = boundedPositiveInteger(
      options.limit ?? 50,
      "Run list limit",
      50,
    );
    const cursor =
      options.cursor === undefined || options.cursor === null
        ? null
        : assertId(options.cursor, "Run list cursor");
    try {
      const transaction = this.#database.transaction(RUNS_STORE, "readonly");
      const range =
        cursor === null ? undefined : IDBKeyRange.lowerBound(cursor, true);
      let databaseCursor = await transaction.store.openCursor(range);
      const runs: RunListEntry[] = [];
      let hasMore = false;
      while (databaseCursor !== null) {
        if (runs.length >= limit) {
          hasMore = true;
          break;
        }
        runs.push(
          toRunListEntry(
            validateRunRecord(databaseCursor.value, databaseCursor.primaryKey),
          ),
        );
        databaseCursor = await databaseCursor.continue();
      }
      await transaction.done;
      return {
        runs,
        cursor: hasMore ? runs.at(-1)!.id : null,
      };
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  /** Reserve aggregate IC-call budget before any external dispatch. */
  async beginRunCall(
    handle: RunHandle,
    input: Readonly<{
      requestBytes: number;
      responseReservationBytes: number;
      update?: Readonly<{
        canister: string;
        method: string;
        argumentsDigest: string;
        identityMode: "local";
      }>;
    }>,
  ): Promise<string | null> {
    this.#requireOpen();
    const run = normalizeRunHandle(handle);
    const requestBytes = boundedCounterDelta(
      input.requestBytes,
      "Run request bytes",
    );
    const responseReservationBytes = boundedCounterDelta(
      input.responseReservationBytes,
      "Run response reservation bytes",
    );
    const update =
      input.update === undefined
        ? null
        : normalizePendingUpdateInput(input.update);
    const pendingUpdateId =
      update === null
        ? null
        : assertGeneratedId(this.#idFactory("update"), "Pending update ID");
    try {
      const transaction = this.#database.transaction(
        RUNS_STORE,
        "readwrite",
        update === null ? undefined : { durability: "strict" },
      );
      const stored = await transaction.store.get(run.runId);
      const activeNow = this.#timestamp();
      const record = requireWritableRun(stored, run, activeNow);
      const counters = {
        ...record.counters,
        callCount: addWithinRunBudget(
          record.counters.callCount,
          1,
          BLAST_RUN_BUDGETS.calls,
          "IC call count",
        ),
        requestBytes: addWithinRunBudget(
          record.counters.requestBytes,
          requestBytes,
          BLAST_RUN_BUDGETS.requestBytes,
          "IC request bytes",
        ),
        responseBytes: addWithinRunBudget(
          record.counters.responseBytes,
          responseReservationBytes,
          BLAST_RUN_BUDGETS.responseBytes,
          "IC response bytes",
        ),
      };
      if (
        update !== null &&
        record.pendingUpdates.length >= BLAST_PENDING_UPDATE_LIMIT
      ) {
        throw new BlastDatabaseError(
          "invalid_state",
          `Run already has ${BLAST_PENDING_UPDATE_LIMIT} uncheckpointed update attempts`,
        );
      }
      if (
        pendingUpdateId !== null &&
        record.pendingUpdates.some((attempt) => attempt.id === pendingUpdateId)
      ) {
        throw new BlastDatabaseError(
          "conflict",
          `Pending update ${pendingUpdateId} already exists`,
        );
      }
      const updatedAt = monotonicNow(record.updatedAt, activeNow);
      await transaction.store.put({
        ...record,
        updatedAt,
        counters,
        pendingUpdates:
          update === null
            ? record.pendingUpdates
            : [
                ...record.pendingUpdates,
                {
                  id: pendingUpdateId!,
                  ...update,
                  startedAt: updatedAt,
                  status: "call_pending" as const,
                },
              ],
      });
      await transaction.done;
      return pendingUpdateId;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  /** Replace one prior response reservation with its exact settled byte size. */
  async settleRunCall(
    handle: RunHandle,
    bytes: Readonly<{
      responseReservationBytes: number;
      responseBytes: number;
      pendingUpdateId?: string | null;
      updateResolution?: "confirmed" | "not_dispatched";
    }>,
  ): Promise<RunRecord> {
    this.#requireOpen();
    const run = normalizeRunHandle(handle);
    const responseReservationBytes = boundedCounterDelta(
      bytes.responseReservationBytes,
      "Run response reservation bytes",
    );
    const responseBytes = boundedCounterDelta(
      bytes.responseBytes,
      "Run response bytes",
    );
    const pendingUpdateId =
      bytes.pendingUpdateId === undefined || bytes.pendingUpdateId === null
        ? null
        : assertId(bytes.pendingUpdateId, "Pending update ID");
    const updateResolution = bytes.updateResolution;
    if (
      (pendingUpdateId === null && updateResolution !== undefined) ||
      (pendingUpdateId !== null &&
        updateResolution !== "confirmed" &&
        updateResolution !== "not_dispatched")
    ) {
      throw new Error("Run update settlement evidence is invalid");
    }
    if (responseBytes > responseReservationBytes) {
      throw new Error("Run response exceeded its admitted reservation");
    }
    try {
      const transaction = this.#database.transaction(
        RUNS_STORE,
        "readwrite",
        pendingUpdateId === null ? undefined : { durability: "strict" },
      );
      const stored = await transaction.store.get(run.runId);
      const activeNow = this.#timestamp();
      const record = requireWritableRun(stored, run, activeNow);
      const pendingUpdateIndex =
        pendingUpdateId === null
          ? -1
          : record.pendingUpdates.findIndex(
              (attempt) => attempt.id === pendingUpdateId,
            );
      if (pendingUpdateId !== null && pendingUpdateIndex < 0) {
        throw new BlastDatabaseError(
          "conflict",
          `Run ${record.id} update attempt was already settled or is unavailable`,
        );
      }
      if (
        pendingUpdateIndex >= 0 &&
        record.pendingUpdates[pendingUpdateIndex]!.status !== "call_pending"
      ) {
        throw new BlastDatabaseError(
          "conflict",
          `Run ${record.id} update attempt was already settled`,
        );
      }
      if (record.counters.responseBytes < responseReservationBytes) {
        throw corrupt(`Run ${record.id} has an invalid response reservation`);
      }
      const updated: RunRecord = {
        ...record,
        updatedAt: monotonicNow(record.updatedAt, activeNow),
        counters: {
          ...record.counters,
          responseBytes:
            record.counters.responseBytes -
            responseReservationBytes +
            responseBytes,
        },
        pendingUpdates:
          pendingUpdateIndex < 0
            ? record.pendingUpdates
            : updateResolution === "not_dispatched"
              ? record.pendingUpdates.filter(
                  (_, index) => index !== pendingUpdateIndex,
                )
              : record.pendingUpdates.map((attempt, index) =>
                  index === pendingUpdateIndex
                    ? { ...attempt, status: "dispatch_confirmed" as const }
                    : attempt,
                ),
      };
      await transaction.store.put(updated);
      await transaction.done;
      return updated;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async checkpointRun(
    handle: RunHandle,
    value: JsonValue,
    expectedRevision?: number,
    acknowledgedUpdateIds: readonly string[] = [],
  ): Promise<CheckpointRecord> {
    this.#requireOpen();
    const checkpointValue = snapshotBoundedJson(
      value,
      "Run checkpoint",
      BLAST_LIMITS.collectionSummaryBytes,
    );
    const serializedBytes = jsonBytes(checkpointValue);
    const run = normalizeRunHandle(handle);
    if (expectedRevision !== undefined) {
      boundedCounterDelta(expectedRevision, "Expected checkpoint revision");
    }
    const requestedAcknowledgements = normalizeCollectionIds(
      acknowledgedUpdateIds,
      BLAST_RUN_BUDGETS.calls,
      "Acknowledged update IDs",
    );
    try {
      const transaction = this.#database.transaction(
        [RUNS_STORE, CHECKPOINTS_STORE],
        "readwrite",
        { durability: "strict" },
      );
      const runs = transaction.objectStore(RUNS_STORE);
      const storedRun = await runs.get(run.runId);
      const activeNow = this.#timestamp();
      const runRecord = requireWritableRun(storedRun, run, activeNow);
      if (
        expectedRevision !== undefined &&
        runRecord.checkpointRevision !== expectedRevision
      ) {
        throw new BlastDatabaseError(
          "conflict",
          `Run checkpoint revision is ${runRecord.checkpointRevision}, not ${expectedRevision}`,
        );
      }
      const checkpoints = transaction.objectStore(CHECKPOINTS_STORE);
      const priorValue = await checkpoints.get(runRecord.id);
      const priorCheckpoint =
        priorValue === undefined
          ? null
          : validateCheckpointRecord(priorValue, runRecord.id);
      if (
        (priorCheckpoint === null && runRecord.checkpointRevision !== 0) ||
        (priorCheckpoint !== null &&
          !checkpointMatchesRun(priorCheckpoint, runRecord))
      ) {
        throw corrupt(
          `Run ${runRecord.id} checkpoint revision is inconsistent`,
        );
      }
      const priorAcknowledgements =
        priorCheckpoint?.acknowledgedUpdateIds ?? [];
      const acknowledged = new Set(priorAcknowledgements);
      const pendingById = new Map(
        runRecord.pendingUpdates.map((attempt) => [attempt.id, attempt]),
      );
      for (const id of requestedAcknowledgements) {
        if (acknowledged.has(id)) continue;
        const attempt = pendingById.get(id);
        if (attempt === undefined) {
          throw new BlastDatabaseError(
            "conflict",
            `Run ${runRecord.id} has no update attempt ${id} to acknowledge`,
          );
        }
        if (attempt.status !== "dispatch_confirmed") {
          throw new BlastDatabaseError(
            "invalid_state",
            `Run update attempt ${id} is not dispatch-confirmed`,
          );
        }
        acknowledged.add(id);
      }
      if (acknowledged.size > BLAST_RUN_BUDGETS.calls) {
        throw new BlastDatabaseError(
          "invalid_state",
          "Run has too many acknowledged update attempts",
        );
      }
      if (runRecord.checkpointRevision >= BLAST_LIMITS.scriptHostCalls) {
        throw new BlastDatabaseError(
          "invalid_state",
          "Run checkpoint revision capacity is exhausted",
        );
      }
      const revision = checkedAdd(
        runRecord.checkpointRevision,
        1,
        "Checkpoint revision",
      );
      const checkpoint: CheckpointRecord = {
        schema: 1,
        runId: runRecord.id,
        revision,
        sourceDigest: runSourceDigest(runRecord.source),
        inputCollectionIds: [...runRecord.inputCollectionIds],
        outputCollectionIds: [...runRecord.outputCollectionIds],
        acknowledgedUpdateIds: [...acknowledged],
        value: checkpointValue,
        serializedBytes,
        updatedAt: monotonicNow(runRecord.updatedAt, activeNow),
      };
      await checkpoints.put(checkpoint);
      await runs.put({
        ...runRecord,
        checkpointRevision: revision,
        updatedAt: checkpoint.updatedAt,
        // Only update attempts explicitly correlated with this checkpoint may
        // leave the retry-safety journal. Concurrent and unrelated attempts
        // remain visible to crash recovery.
        pendingUpdates: runRecord.pendingUpdates.filter(
          (attempt) => !acknowledged.has(attempt.id),
        ),
      });
      await transaction.done;
      return checkpoint;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async getCheckpoint(runId: string): Promise<CheckpointRecord | null> {
    this.#requireOpen();
    const id = assertId(runId, "Run ID");
    try {
      const transaction = this.#database.transaction(
        CHECKPOINTS_STORE,
        "readonly",
      );
      const value = await transaction.store.get(id);
      await transaction.done;
      return value === undefined ? null : validateCheckpointRecord(value, id);
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async transitionRun(
    handle: RunHandle,
    state: Exclude<RunState, "running">,
    summary: JsonValue = null,
  ): Promise<RunRecord> {
    this.#requireOpen();
    if (!isTerminalRunState(state))
      throw new Error("Run terminal state is invalid");
    const summaryValue = snapshotBoundedJson(
      summary,
      "Run summary",
      BLAST_LIMITS.collectionSummaryBytes,
    );
    const run = normalizeRunHandle(handle);
    try {
      const transaction = this.#database.transaction(
        [RUNS_STORE, CHECKPOINTS_STORE],
        "readwrite",
      );
      try {
        const runs = transaction.objectStore(RUNS_STORE);
        const stored = await runs.get(run.runId);
        const activeNow = this.#timestamp();
        const record = requireRun(stored, run.runId);
        requireRunSession(record, run);
        if (record.state !== "running") {
          if (
            record.state === state &&
            (canonicalJson(record.summary) === canonicalJson(summaryValue) ||
              hasTerminalUpdateEvidence(record.summary))
          ) {
            await transaction.done;
            return record;
          }
          throw new BlastDatabaseError(
            "invalid_state",
            `Run ${run.runId} is already ${record.state}`,
          );
        }
        // Make room before this running row enters the terminal index. If the
        // wall clock moved backward, pruning afterward could otherwise select
        // and delete the run that this call just finalized.
        const retained = await pruneTerminalRunsInTransaction(
          transaction,
          Math.max(0, BLAST_TERMINAL_RUN_RETENTION - 1),
          BLAST_RUN_PRUNE_BATCH,
        );
        if (retained.incomplete) throw runHistoryCapacityError();
        const updatedAt = await nextTerminalTimestampInTransaction(
          transaction,
          record.updatedAt,
          activeNow,
        );
        const terminalSummary = withTerminalUpdateEvidence(
          summaryValue,
          record.pendingUpdates,
        );
        const updated: RunRecord = {
          ...record,
          state,
          updatedAt,
          completedAt: updatedAt,
          pendingUpdates: [],
          summary: terminalSummary,
        };
        await runs.put(updated);
        await transaction.done;
        return updated;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async interruptExpiredRuns(
    limit = MAX_RUNS_INTERRUPTED_PER_PASS,
  ): Promise<string[]> {
    this.#requireOpen();
    const maximum = boundedPositiveInteger(
      limit,
      "Interrupted run limit",
      MAX_RUNS_INTERRUPTED_PER_PASS,
    );
    const maximumLifetime = BLAST_LIMITS.scriptMaximumTimeoutMs + 5_000;
    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, RUNS_STORE, CHECKPOINTS_STORE],
        "readwrite",
      );
      try {
        const collections = transaction.objectStore(COLLECTIONS_STORE);
        const runs = transaction.objectStore(RUNS_STORE);
        const index = runs.index(RUN_STATE_INDEX);
        let cursor = await index.openCursor("running");
        const now = this.#timestamp();
        const expired: Readonly<{
          record: RunRecord;
          interruption: string;
        }>[] = [];
        let examined = 0;
        while (
          cursor !== null &&
          expired.length < maximum &&
          examined < MAX_RUNS_INTERRUPTED_PER_PASS
        ) {
          const record = validateRunRecord(cursor.value, cursor.primaryKey);
          examined += 1;
          // Tolerate ordinary wall-clock corrections while bounding how long
          // a crash-created future row can occupy one of the eight run slots.
          const clockInconsistent =
            record.startedAt - now > maximumLifetime ||
            record.deadlineAt - now > maximumLifetime * 2;
          if (record.deadlineAt > now && !clockInconsistent) {
            cursor = await cursor.continue();
            continue;
          }
          expired.push({
            record,
            interruption: clockInconsistent
              ? "Run timing became invalid after the browser clock changed"
              : "Run deadline elapsed before the resident completed it",
          });
          cursor = await cursor.continue();
        }

        // Reserve all terminal-history slots before assigning rollbackable wall
        // clock timestamps to the interrupted rows. Otherwise a later prune in
        // this recovery pass can mistake a newly interrupted run for the oldest
        // retained row and erase its exact update-dispatch evidence.
        if (expired.length > 0) {
          const retained = await pruneTerminalRunsInTransaction(
            transaction,
            Math.max(0, BLAST_TERMINAL_RUN_RETENTION - expired.length),
            expired.length,
          );
          if (retained.incomplete) throw runHistoryCapacityError();
        }

        const interrupted: string[] = [];
        let latestCompletedAt =
          await latestTerminalTimestampInTransaction(transaction);
        for (const { record, interruption } of expired) {
          for (const collectionId of record.outputCollectionIds) {
            const stored = await collections.get(collectionId);
            // Exact collection deletion is allowed while a run is live. A
            // missing, deleting, or already-terminal output is unavailable to
            // late guest writes and therefore needs no recovery mutation.
            if (stored === undefined) continue;
            const collection = validateStoredCollectionRecord(
              stored,
              collectionId,
            );
            if (collection.state !== "open") continue;
            await collections.put({
              ...collection,
              state: "failed",
              updatedAt: monotonicNow(collection.updatedAt, now),
              summary: { error: interruption },
            });
          }
          const updatedAt = nextTerminalTimestamp(
            record.updatedAt,
            now,
            latestCompletedAt,
          );
          latestCompletedAt = updatedAt;
          const terminalSummary = withTerminalUpdateEvidence(
            {
              error: interruption,
              outputCleanupIncomplete: false,
            },
            record.pendingUpdates,
          );
          await runs.put({
            ...record,
            state: "interrupted",
            updatedAt,
            completedAt: updatedAt,
            pendingUpdates: [],
            summary: terminalSummary,
          });
          interrupted.push(record.id);
        }
        await transaction.done;
        return interrupted;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  /**
   * Deletes the oldest terminal run rows and their latest checkpoints in one
   * bounded transaction. Running rows cannot appear in the completed index.
   */
  async pruneTerminalRuns(
    options: Readonly<{ retain?: number; deletionLimit?: number }> = {},
  ): Promise<PruneTerminalRunsResult> {
    this.#requireOpen();
    const retain = boundedNonNegativeInteger(
      options.retain ?? BLAST_TERMINAL_RUN_RETENTION,
      "Terminal run retention",
      BLAST_TERMINAL_RUN_RETENTION,
    );
    const deletionLimit = boundedPositiveInteger(
      options.deletionLimit ?? BLAST_RUN_PRUNE_BATCH,
      "Run prune deletion limit",
      BLAST_RUN_PRUNE_BATCH,
    );
    try {
      const transaction = this.#database.transaction(
        [RUNS_STORE, CHECKPOINTS_STORE],
        "readwrite",
      );
      try {
        const result = await pruneTerminalRunsInTransaction(
          transaction,
          retain,
          deletionLimit,
        );
        await transaction.done;
        return result;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async logicalStorageStatus(): Promise<LogicalStorageStatus> {
    this.#requireOpen();
    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, RUNS_STORE],
        "readonly",
      );
      const collections = transaction.objectStore(COLLECTIONS_STORE);
      const runs = transaction.objectStore(RUNS_STORE);
      const runningRunCountPromise = runs
        .index(RUN_STATE_INDEX)
        .count("running");
      const deletingCountPromise = collections
        .index(COLLECTION_STATE_INDEX)
        .count("deleting");
      let collectionCount = 0;
      let pageCount = 0;
      let itemCount = 0;
      let serializedBytes = 0;
      let cursor = await collections.openCursor();
      while (cursor !== null) {
        if (collectionCount >= BLAST_COLLECTION_LIMIT) {
          throw corrupt(
            `Collection count exceeds the fixed ${BLAST_COLLECTION_LIMIT}-record bound`,
          );
        }
        const collection = validateStoredCollectionRecord(
          cursor.value,
          cursor.key,
        );
        collectionCount = checkedAdd(collectionCount, 1, "Collection count");
        pageCount = checkedAdd(pageCount, collection.pageCount, "Page count");
        itemCount = checkedAdd(itemCount, collection.itemCount, "Item count");
        serializedBytes = checkedAdd(
          serializedBytes,
          collection.serializedBytes,
          "Serialized byte count",
        );
        cursor = await cursor.continue();
      }
      const [runningRunCount, deletingCollectionCount] = await Promise.all([
        runningRunCountPromise,
        deletingCountPromise,
      ]);
      await transaction.done;
      return {
        collectionCount,
        deletingCollectionCount,
        pageCount,
        itemCount,
        serializedBytes,
        runningRunCount,
      };
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async #writePage(
    id: string,
    value: JsonValue,
    expectedKind: CollectionKind,
    idempotencyKey: string | null,
    runHandle: RunHandle | undefined,
  ): Promise<PageWriteResult> {
    this.#requireOpen();
    const collectionId = assertId(id, "Collection ID");
    // Snapshot first so validation, hashing, counters, and the eventual IDB
    // write all describe the same value even when the caller supplied mutable
    // data or accessor-backed properties.
    const storedValue = snapshotBoundedJson(
      value,
      "Collection page",
      BLAST_LIMITS.collectionPageBytes,
    );
    const serializedBytes = jsonBytes(storedValue);
    const itemCount = Array.isArray(storedValue) ? storedValue.length : 1;
    const digest = await sha256Hex(canonicalJson(storedValue));
    const run = runHandle === undefined ? null : normalizeRunHandle(runHandle);
    const now = this.#timestamp();
    try {
      // Every await below is an IndexedDB request from this transaction. No IC,
      // Worker, hashing, or other external promise is allowed in this block.
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, PAGES_STORE, RUNS_STORE],
        "readwrite",
      );
      try {
        const collections = transaction.objectStore(COLLECTIONS_STORE);
        const pages = transaction.objectStore(PAGES_STORE);
        const collection = requireWritableCollection(
          await collections.get(collectionId),
          collectionId,
          expectedKind,
        );
        let runRecord: RunRecord | null = null;
        let runUpdatedAt = now;
        if (run !== null) {
          const storedRun = await transaction
            .objectStore(RUNS_STORE)
            .get(run.runId);
          runUpdatedAt = this.#timestamp();
          runRecord = requireWritableRun(storedRun, run, runUpdatedAt);
          requireRunCollectionAccess(runRecord, collectionId, "write");
        }
        if (idempotencyKey !== null) {
          const existing = await pages
            .index(PAGE_IDEMPOTENCY_INDEX)
            .get([collectionId, idempotencyKey]);
          if (existing !== undefined) {
            const page = validatePageRecord(
              existing,
              collectionId,
              undefined,
              idempotencyKey,
            );
            if (page.digest !== digest) {
              throw new BlastDatabaseError(
                "idempotency_conflict",
                "Collection page idempotency key was already committed with different data",
              );
            }
            await transaction.done;
            return pageWriteResult("replayed", page);
          }
        }
        const runCounters =
          runRecord === null
            ? null
            : {
                ...runRecord.counters,
                pageWriteCount: addWithinRunBudget(
                  runRecord.counters.pageWriteCount,
                  1,
                  BLAST_RUN_BUDGETS.pageWrites,
                  "page write count",
                ),
                writeBytes: addWithinRunBudget(
                  runRecord.counters.writeBytes,
                  serializedBytes,
                  BLAST_RUN_BUDGETS.writeBytes,
                  "page write bytes",
                ),
              };
        const sequence = collection.nextSequence;
        const page: CollectionPageRecord = {
          schema: 1,
          collectionId,
          sequence,
          ...(idempotencyKey === null ? {} : { idempotencyKey }),
          digest,
          value: storedValue,
          itemCount,
          serializedBytes,
          createdAt: now,
        };
        await pages.add(page);
        await collections.put({
          ...collection,
          updatedAt: monotonicNow(collection.updatedAt, now),
          nextSequence: checkedAdd(sequence, 1, "Collection page sequence"),
          pageCount: checkedAdd(
            collection.pageCount,
            1,
            "Collection page count",
          ),
          itemCount: checkedAdd(
            collection.itemCount,
            itemCount,
            "Collection item count",
          ),
          serializedBytes: checkedAdd(
            collection.serializedBytes,
            serializedBytes,
            "Collection byte count",
          ),
        });
        if (runRecord !== null) {
          await transaction.objectStore(RUNS_STORE).put({
            ...runRecord,
            updatedAt: monotonicNow(runRecord.updatedAt, runUpdatedAt),
            counters: runCounters!,
          });
        }
        await transaction.done;
        return pageWriteResult("written", page);
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async #finishCollection(
    id: string,
    state: "complete" | "failed",
    summary: JsonValue,
    rawRun?: RunHandle,
  ): Promise<CollectionRecord> {
    this.#requireOpen();
    const collectionId = assertId(id, "Collection ID");
    const summaryValue = snapshotBoundedJson(
      summary,
      "Collection summary",
      BLAST_LIMITS.collectionSummaryBytes,
    );
    const run = rawRun === undefined ? null : normalizeRunHandle(rawRun);
    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, RUNS_STORE],
        "readwrite",
      );
      let activeNow = this.#timestamp();
      if (run !== null) {
        const storedRun = await transaction
          .objectStore(RUNS_STORE)
          .get(run.runId);
        activeNow = this.#timestamp();
        const runRecord = requireWritableRun(storedRun, run, activeNow);
        requireRunCollectionAccess(runRecord, collectionId, "write");
      }
      const collections = transaction.objectStore(COLLECTIONS_STORE);
      const collection = requireCollection(
        await collections.get(collectionId),
        collectionId,
      );
      if (collection.state !== "open") {
        if (
          collection.state === state &&
          canonicalJson(collection.summary) === canonicalJson(summaryValue)
        ) {
          await transaction.done;
          return collection;
        }
        throw new BlastDatabaseError(
          "invalid_state",
          `Collection ${collectionId} is ${collection.state}`,
        );
      }
      const updated: CollectionRecord = {
        ...collection,
        state,
        updatedAt: monotonicNow(collection.updatedAt, activeNow),
        summary: summaryValue,
      };
      await collections.put(updated);
      await transaction.done;
      return updated;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async #deletingCollectionIds(limit: number): Promise<string[]> {
    try {
      const transaction = this.#database.transaction(
        COLLECTIONS_STORE,
        "readonly",
      );
      const index = transaction.store.index(COLLECTION_STATE_INDEX);
      let cursor = await index.openKeyCursor("deleting");
      const ids: string[] = [];
      while (cursor !== null && ids.length < limit) {
        if (typeof cursor.primaryKey !== "string") {
          throw corrupt("Deleting collection key is malformed");
        }
        // Cleanup is intentionally more tolerant than the public tool input:
        // a damaged key must not make every startup recovery pass fail.
        ids.push(cursor.primaryKey);
        cursor = await cursor.continue();
      }
      await transaction.done;
      return ids;
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  async #deleteCollectionBatch(
    id: string,
    maximumPages: number,
    allowMark = false,
  ): Promise<
    Readonly<{
      found: boolean;
      deleted: boolean;
      deletedPages: number;
    }>
  > {
    try {
      const transaction = this.#database.transaction(
        [COLLECTIONS_STORE, PAGES_STORE],
        "readwrite",
      );
      try {
        const collections = transaction.objectStore(COLLECTIONS_STORE);
        const stored = await collections.get(id);
        if (
          !allowMark &&
          stored !== undefined &&
          storedCollectionState(stored) !== "deleting"
        ) {
          throw new BlastDatabaseError(
            "invalid_state",
            `Collection ${id} is not marked for deletion`,
          );
        }
        const now = this.#timestamp();
        const pages = transaction.objectStore(PAGES_STORE);
        let cursor = await pages.index(PAGE_COLLECTION_INDEX).openCursor(id);
        const found = stored !== undefined || cursor !== null;
        if (!found) {
          await transaction.done;
          return { found: false, deleted: true, deletedPages: 0 };
        }
        const collection = deletionRecord(stored, id, now, this.#idFactory);
        let deletedPages = 0;
        let deletedItems = 0;
        let deletedBytes = 0;
        let itemCountersKnown = true;
        let byteCountersKnown = true;
        while (cursor !== null && deletedPages < maximumPages) {
          const pageCounters = recoverablePageCounters(cursor.value);
          if (pageCounters === null) {
            itemCountersKnown = false;
            byteCountersKnown = false;
          } else {
            if (itemCountersKnown) {
              const nextItems = deletedItems + pageCounters.itemCount;
              if (Number.isSafeInteger(nextItems)) deletedItems = nextItems;
              else itemCountersKnown = false;
            }
            if (byteCountersKnown) {
              const nextBytes = deletedBytes + pageCounters.serializedBytes;
              if (Number.isSafeInteger(nextBytes)) deletedBytes = nextBytes;
              else byteCountersKnown = false;
            }
          }
          await cursor.delete();
          deletedPages += 1;
          cursor = await cursor.continue();
        }
        if (cursor === null) {
          await collections.delete(id);
          await transaction.done;
          return { found: true, deleted: true, deletedPages };
        }
        await collections.put({
          ...collection,
          updatedAt: monotonicNow(collection.updatedAt, now),
          pageCount: subtractKnownCounter(collection.pageCount, deletedPages),
          itemCount: itemCountersKnown
            ? subtractKnownCounter(collection.itemCount, deletedItems)
            : collection.itemCount,
          serializedBytes: byteCountersKnown
            ? subtractKnownCounter(collection.serializedBytes, deletedBytes)
            : collection.serializedBytes,
        });
        await transaction.done;
        return { found: true, deleted: false, deletedPages };
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    } catch (error) {
      throw classifyBlastDatabaseError(error);
    }
  }

  #requireOpen(): void {
    const invalidated = this.#invalidation();
    if (invalidated !== null) throw invalidated;
    if (this.#closed) {
      throw new BlastDatabaseError(
        "terminated",
        "Blast browser storage is closed",
      );
    }
  }

  #timestamp(): number {
    return boundedTimestamp(this.#now(), "Blast storage timestamp");
  }
}

async function readPageBatch<
  Mode extends IDBTransactionMode,
  Stores extends ArrayLike<StoreNames<BlastCollectionsSchema>>,
>(
  transaction: IDBPTransaction<BlastCollectionsSchema, Stores, Mode>,
  collectionId: string,
  afterSequence: number,
  limit: number,
  maxBytes: number,
  maxNodes: number,
): Promise<CollectionPageBatch> {
  if (afterSequence === Number.MAX_SAFE_INTEGER) {
    return { pages: [], cursor: null, serializedBytes: 0 };
  }
  const store = transaction.objectStore(PAGES_STORE);
  let cursor = await store.openCursor(
    collectionPageRange(collectionId, afterSequence + 1),
  );
  const pages: CollectionPageRecord[] = [];
  let serializedBytes = 0;
  let jsonNodes = 0;
  let hasMore = false;
  while (cursor !== null) {
    const page = validatePageRecord(
      cursor.value,
      collectionId,
      cursor.primaryKey[1],
    );
    const pageNodes = blastStoredV1JsonNodeCount(
      page.value,
      `Collection ${collectionId} page ${page.sequence}`,
    );
    if (
      pages.length >= limit ||
      serializedBytes + page.serializedBytes > maxBytes ||
      jsonNodes + pageNodes > maxNodes
    ) {
      if (pages.length === 0) {
        if (pageNodes > maxNodes) {
          throw new BlastPageReadNodeLimitError(
            page.sequence,
            pageNodes,
            maxNodes,
          );
        }
        throw new BlastPageReadLimitError(
          page.sequence,
          page.serializedBytes,
          maxBytes,
        );
      }
      hasMore = true;
      break;
    }
    pages.push(page);
    serializedBytes = checkedAdd(
      serializedBytes,
      page.serializedBytes,
      "Page batch byte count",
    );
    jsonNodes = checkedAdd(jsonNodes, pageNodes, "Page batch JSON-value count");
    cursor = await cursor.continue();
  }
  return {
    pages,
    cursor: hasMore
      ? encodePageCursor(pages.at(-1)?.sequence ?? afterSequence)
      : null,
    serializedBytes,
  };
}

async function pruneTerminalRunsInTransaction<
  Stores extends ArrayLike<StoreNames<BlastCollectionsSchema>>,
>(
  transaction: IDBPTransaction<BlastCollectionsSchema, Stores, "readwrite">,
  retain: number,
  deletionLimit: number,
): Promise<PruneTerminalRunsResult> {
  const runs = transaction.objectStore(RUNS_STORE);
  const checkpoints = transaction.objectStore(CHECKPOINTS_STORE);
  const index = runs.index(RUN_COMPLETED_INDEX);
  const before = await index.count();
  let remainingToDelete = Math.min(Math.max(0, before - retain), deletionLimit);
  let cursor = remainingToDelete > 0 ? await index.openCursor() : null;
  const deletedRunIds: string[] = [];
  while (cursor !== null && remainingToDelete > 0) {
    const runId = cursor.primaryKey;
    let unresolved = false;
    try {
      const run = validateRunRecord(cursor.value, runId);
      if (run.state === "running" || run.completedAt === null) {
        throw corrupt(
          `Running run ${run.id} appeared in the terminal retention index`,
        );
      }
      unresolved = runPendingUpdateCount(run) > 0;
    } catch (error) {
      if (!(error instanceof BlastDatabaseError) || error.code !== "corrupt") {
        throw error;
      }
      // A corrupt terminal-history row cannot be read or repaired safely. It
      // must not permanently block the bounded cleanup that keeps new runs
      // available, so retire it together with any checkpoint under its key.
    }
    if (unresolved) {
      cursor = await cursor.continue();
      continue;
    }
    // Deleting through the primary store and deleting the latest checkpoint
    // share this transaction, so a crash cannot orphan either side.
    await cursor.delete();
    await checkpoints.delete(runId);
    deletedRunIds.push(runId);
    remainingToDelete -= 1;
    cursor = await cursor.continue();
  }
  const terminalRunCount = before - deletedRunIds.length;
  return {
    deletedRunIds,
    terminalRunCount,
    incomplete: terminalRunCount > retain,
  };
}

function runHistoryCapacityError(): BlastDatabaseError {
  return new BlastDatabaseError(
    "invalid_state",
    "Blast run history is full of uncheckpointed update evidence; inspect run.list and run.get, then delete an acknowledged terminal run with run.delete",
  );
}

async function latestTerminalTimestampInTransaction<
  Stores extends ArrayLike<StoreNames<BlastCollectionsSchema>>,
>(
  transaction: IDBPTransaction<BlastCollectionsSchema, Stores, "readwrite">,
): Promise<number | null> {
  const runs = transaction.objectStore(RUNS_STORE);
  const checkpoints = transaction.objectStore(CHECKPOINTS_STORE);
  let cursor = await runs.index(RUN_COMPLETED_INDEX).openCursor(null, "prev");
  while (cursor !== null) {
    const runId = cursor.primaryKey;
    try {
      const run = validateRunRecord(cursor.value, runId);
      if (run.state === "running" || run.completedAt === null) {
        throw corrupt(
          `Running run ${run.id} appeared in the terminal retention index`,
        );
      }
      return run.completedAt;
    } catch (error) {
      if (!(error instanceof BlastDatabaseError) || error.code !== "corrupt") {
        throw error;
      }
      // Timestamp allocation must not trust a malformed newest index key. Retire
      // the unusable history and its checkpoint in this same transaction, then
      // continue to the next valid terminal row. Normal Blast writes keep this
      // scan within the terminal-history cap.
      await cursor.delete();
      await checkpoints.delete(runId);
      cursor = await cursor.continue();
    }
  }
  return null;
}

async function nextTerminalTimestampInTransaction<
  Stores extends ArrayLike<StoreNames<BlastCollectionsSchema>>,
>(
  transaction: IDBPTransaction<BlastCollectionsSchema, Stores, "readwrite">,
  previous: number,
  now: number,
): Promise<number> {
  return nextTerminalTimestamp(
    previous,
    now,
    await latestTerminalTimestampInTransaction(transaction),
  );
}

function nextTerminalTimestamp(
  previous: number,
  now: number,
  latestCompletedAt: number | null,
): number {
  const timestamp = monotonicNow(previous, now);
  return latestCompletedAt === null || latestCompletedAt < timestamp
    ? timestamp
    : checkedAdd(latestCompletedAt, 1, "Run completion timestamp");
}

function collectionPageRange(
  collectionId: string,
  firstSequence: number,
): IDBKeyRange {
  return IDBKeyRange.bound(
    [collectionId, firstSequence],
    [collectionId, Number.MAX_SAFE_INTEGER],
  );
}

function storedCollectionState(value: unknown): unknown {
  return value && typeof value === "object"
    ? (value as { state?: unknown }).state
    : undefined;
}

function deletionRecord(
  value: unknown,
  id: string,
  now: number,
  idFactory: (prefix: string) => string,
): StoredCollectionRecord {
  if (value !== undefined) {
    try {
      const collection = validateStoredCollectionRecord(value, id);
      return collection.state === "deleting"
        ? collection
        : {
            ...collection,
            state: "deleting",
            updatedAt: monotonicNow(collection.updatedAt, now),
          };
    } catch (error) {
      if (!(error instanceof BlastDatabaseError) || error.code !== "corrupt") {
        throw error;
      }
    }
  }

  const partial =
    value && typeof value === "object"
      ? (value as Partial<CollectionRecord>)
      : {};
  const createdAt = validCounter(partial.createdAt) ? partial.createdAt : now;
  const updatedAt = validCounter(partial.updatedAt)
    ? Math.max(createdAt, partial.updatedAt, now)
    : Math.max(createdAt, now);
  const pageCount = validCounter(partial.pageCount) ? partial.pageCount : 0;
  const nextSequence = validCounter(partial.nextSequence)
    ? Math.max(partial.nextSequence, pageCount)
    : pageCount;
  const itemCount =
    pageCount > 0 && validCounter(partial.itemCount) ? partial.itemCount : 0;
  const serializedBytes =
    pageCount > 0 && validCounter(partial.serializedBytes)
      ? partial.serializedBytes
      : 0;
  let creationNonce: string;
  try {
    creationNonce = assertGeneratedId(
      partial.creationNonce as string,
      "Collection creation nonce",
    );
  } catch {
    creationNonce = assertGeneratedId(
      idFactory("cleanup"),
      "Collection cleanup nonce",
    );
  }
  return {
    schema: 1,
    id,
    creationNonce,
    name: "Collection pending cleanup",
    description: null,
    state: "deleting",
    kind: isCollectionKind(partial.kind) ? partial.kind : "raw",
    createdAt,
    updatedAt,
    nextSequence,
    pageCount,
    itemCount,
    serializedBytes,
    producer: null,
    identity: null,
    source: null,
    sourceCollectionIds: [],
    summary: null,
  };
}

function recoverablePageCounters(value: unknown): Readonly<{
  itemCount: number;
  serializedBytes: number;
}> | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<CollectionPageRecord>;
  return validCounter(page.itemCount) && validCounter(page.serializedBytes)
    ? { itemCount: page.itemCount, serializedBytes: page.serializedBytes }
    : null;
}

function subtractKnownCounter(current: number, removed: number): number {
  return current >= removed ? current - removed : current;
}

function storedObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function requireExactStoredFields(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  if (!hasExactObjectFields(record, fields)) {
    throw corrupt(`${label} is malformed`);
  }
}

function hasExactObjectFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === fields.length && keys.every((key) => fields.includes(key))
  );
}

function requireCanonicalStoredIds(
  value: unknown,
  maximum: number,
  label: string,
): string[] {
  if (!Array.isArray(value)) throw corrupt(`${label} are malformed`);
  let normalized: string[];
  try {
    normalized = normalizeCollectionIds(value as string[], maximum, label);
  } catch {
    throw corrupt(`${label} are malformed`);
  }
  if (normalized.length !== value.length || !sameStrings(normalized, value)) {
    throw corrupt(`${label} are malformed`);
  }
  return normalized;
}

function requireCollection(
  value: StoredCollectionRecord | undefined,
  id: string,
): CollectionRecord {
  if (value === undefined) {
    throw new BlastDatabaseError("not_found", `Collection ${id} was not found`);
  }
  const collection = validateStoredCollectionRecord(value, id);
  if (collection.identity === null) {
    throw new BlastDatabaseError(
      "invalid_state",
      `Collection ${id} is being deleted`,
    );
  }
  return collection;
}

function requireReadableCollection(
  value: StoredCollectionRecord | undefined,
  id: string,
): CollectionRecord {
  const collection = requireCollection(value, id);
  if (collection.state === "deleting") {
    throw new BlastDatabaseError(
      "invalid_state",
      `Collection ${id} is being deleted`,
    );
  }
  return collection;
}

function requireWritableCollection(
  value: StoredCollectionRecord | undefined,
  id: string,
  kind: CollectionKind,
): CollectionRecord {
  const collection = requireCollection(value, id);
  if (collection.state !== "open") {
    throw new BlastDatabaseError(
      "invalid_state",
      `Collection ${id} is ${collection.state}`,
    );
  }
  if (collection.kind !== kind) {
    throw new BlastDatabaseError(
      "invalid_state",
      `Collection ${id} is ${collection.kind}, not ${kind}`,
    );
  }
  return collection;
}

function requireRun(value: RunRecord | undefined, id: string): RunRecord {
  if (value === undefined) {
    throw new BlastDatabaseError("not_found", `Run ${id} was not found`);
  }
  return validateRunRecord(value, id);
}

function requireRunSession(record: RunRecord, handle: RunHandle): void {
  if (record.sessionId !== handle.sessionId) {
    throw new BlastDatabaseError(
      "conflict",
      `Run ${handle.runId} belongs to another resident session`,
    );
  }
}

function requireWritableRun(
  value: RunRecord | undefined,
  handle: RunHandle,
  now: number,
): RunRecord {
  const run = requireRun(value, handle.runId);
  requireRunSession(run, handle);
  if (run.state !== "running") {
    throw new BlastDatabaseError(
      "invalid_state",
      `Run ${handle.runId} is ${run.state}`,
    );
  }
  if (run.deadlineAt <= now) {
    throw new BlastDatabaseError(
      "invalid_state",
      `Run ${handle.runId} reached its deadline`,
    );
  }
  return run;
}

function requireRunCollectionAccess(
  run: RunRecord,
  collectionId: string,
  mode: "read" | "write",
): void {
  const admitted =
    mode === "write"
      ? run.outputCollectionIds.includes(collectionId)
      : run.inputCollectionIds.includes(collectionId) ||
        run.outputCollectionIds.includes(collectionId);
  if (!admitted) {
    throw new BlastDatabaseError(
      "conflict",
      `Run ${run.id} does not own ${mode} access to collection ${collectionId}`,
    );
  }
}

function validateStoredCollectionRecord(
  value: unknown,
  id: string,
): StoredCollectionRecord {
  const label = `Collection ${id} record`;
  const record = storedObject(value, label);
  requireExactStoredFields(record, COLLECTION_RECORD_FIELDS, label);
  try {
    if (
      record.schema !== 1 ||
      assertId(record.id, "Stored collection ID") !== id ||
      assertGeneratedId(
        record.creationNonce as string,
        "Collection creation nonce",
      ) !== record.creationNonce ||
      requiredScalarString(
        record.name,
        "Collection name",
        BLAST_LIMITS.collectionNameCharacters,
      ) !== record.name ||
      optionalScalarString(
        record.description,
        "Collection description",
        BLAST_LIMITS.collectionDescriptionCharacters,
      ) !== record.description ||
      !isCollectionState(record.state) ||
      !isCollectionKind(record.kind) ||
      !validCounter(record.createdAt) ||
      !validCounter(record.updatedAt) ||
      record.updatedAt < record.createdAt ||
      !validCounter(record.nextSequence) ||
      !validCounter(record.pageCount) ||
      !validCounter(record.itemCount) ||
      !validCounter(record.serializedBytes) ||
      record.pageCount > record.nextSequence ||
      (record.state !== "deleting" &&
        record.pageCount !== record.nextSequence) ||
      (record.pageCount === 0 &&
        (record.itemCount !== 0 || record.serializedBytes !== 0))
    ) {
      throw new Error("invalid collection fields");
    }
    if (
      record.producer === undefined ||
      record.identity === undefined ||
      record.source === undefined
    ) {
      throw new Error("missing nullable collection metadata");
    }
    const producer = normalizeProducer(
      record.producer as CollectionProducer | null,
    );
    const identity =
      record.identity === null
        ? null
        : normalizeCollectionIdentity(record.identity);
    const source = normalizeStoredV1Source(
      record.source as CollectionSource | null,
    );
    const sourceCollectionIds = requireCanonicalStoredIds(
      record.sourceCollectionIds,
      MAX_COLLECTION_LINKS,
      "Source collection IDs",
    );
    assertBoundedBlastStoredV1Json(
      record.summary,
      `Collection ${id} summary`,
      BLAST_LIMITS.collectionSummaryBytes,
    );
    if (record.state === "open" && record.summary !== null) {
      throw new Error("open collection has a summary");
    }
    if (
      identity === null &&
      (record.state !== "deleting" ||
        record.name !== "Collection pending cleanup" ||
        record.description !== null ||
        producer !== null ||
        source !== null ||
        sourceCollectionIds.length !== 0 ||
        record.summary !== null)
    ) {
      throw new Error("invalid collection cleanup record");
    }
  } catch (error) {
    if (error instanceof BlastDatabaseError && error.code === "corrupt") {
      throw error;
    }
    throw corrupt(`${label} is malformed`);
  }
  return value as StoredCollectionRecord;
}

function validatePageRecord(
  value: unknown,
  collectionId: string,
  expectedSequence?: number,
  expectedIdempotencyKey?: string,
): CollectionPageRecord {
  const label = `Collection ${collectionId} page`;
  const page = storedObject(value, label);
  requireExactStoredFields(
    page,
    Object.hasOwn(page, "idempotencyKey")
      ? PAGE_RECORD_FIELDS_WITH_IDEMPOTENCY
      : PAGE_RECORD_FIELDS,
    label,
  );
  try {
    if (
      page.schema !== 1 ||
      assertId(page.collectionId, "Stored page collection ID") !==
        collectionId ||
      !validCounter(page.sequence) ||
      (expectedSequence !== undefined && page.sequence !== expectedSequence) ||
      typeof page.digest !== "string" ||
      !DIGEST_PATTERN.test(page.digest) ||
      !validCounter(page.itemCount) ||
      !validCounter(page.serializedBytes) ||
      !validCounter(page.createdAt)
    ) {
      throw new Error("invalid page fields");
    }
    if (Object.hasOwn(page, "idempotencyKey")) {
      if (
        assertIdempotencyKey(page.idempotencyKey) !== page.idempotencyKey ||
        (expectedIdempotencyKey !== undefined &&
          page.idempotencyKey !== expectedIdempotencyKey)
      ) {
        throw new Error("invalid page idempotency key");
      }
    } else if (expectedIdempotencyKey !== undefined) {
      throw new Error("missing page idempotency key");
    }
    assertBoundedBlastStoredV1Json(
      page.value,
      label,
      BLAST_LIMITS.collectionPageBytes,
    );
    const actualBytes = jsonBytes(page.value as JsonValue);
    const actualItems = Array.isArray(page.value) ? page.value.length : 1;
    if (
      page.serializedBytes !== actualBytes ||
      page.itemCount !== actualItems
    ) {
      throw new Error("inconsistent page counters");
    }
  } catch (error) {
    if (error instanceof BlastDatabaseError && error.code === "corrupt") {
      throw error;
    }
    throw corrupt(`${label} is malformed`);
  }
  return value as CollectionPageRecord;
}

function validateRunRecord(value: unknown, id: string): RunRecord {
  const label = `Run ${id}`;
  const run = storedObject(value, label);
  requireExactStoredFields(run, RUN_RECORD_FIELDS, label);
  try {
    if (
      run.schema !== 1 ||
      assertId(run.id, "Stored run ID") !== id ||
      assertId(run.sessionId, "Stored run session ID") !== run.sessionId ||
      !isRunState(run.state) ||
      !validCounter(run.startedAt) ||
      !validCounter(run.updatedAt) ||
      run.updatedAt < run.startedAt ||
      !validCounter(run.deadlineAt) ||
      run.deadlineAt <= run.startedAt ||
      run.deadlineAt - run.startedAt >
        BLAST_LIMITS.scriptMaximumTimeoutMs + 5_000 ||
      (run.completedAt !== null && !validCounter(run.completedAt)) ||
      !validCounter(run.checkpointRevision) ||
      run.checkpointRevision > BLAST_LIMITS.scriptHostCalls ||
      !validRunCounters(run.counters) ||
      !Array.isArray(run.pendingUpdates) ||
      run.pendingUpdates.length > BLAST_PENDING_UPDATE_LIMIT
    ) {
      throw new Error("invalid run fields");
    }
    normalizeRunSource(run.source as RunSource);
    if (run.identity === undefined) {
      throw new Error("missing nullable run identity");
    }
    normalizeOptionalIdentity(run.identity as CollectionIdentity | null);
    requireCanonicalStoredIds(
      run.inputCollectionIds,
      MAX_RUN_COLLECTIONS,
      "Run input collection IDs",
    );
    requireCanonicalStoredIds(
      run.outputCollectionIds,
      MAX_RUN_COLLECTIONS,
      "Run output collection IDs",
    );
    assertBoundedBlastStoredV1Json(
      run.summary,
      `Run ${id} summary`,
      BLAST_LIMITS.collectionSummaryBytes,
    );
    if (
      (run.state === "running" &&
        (run.completedAt !== null ||
          run.summary !== null ||
          run.updatedAt >= run.deadlineAt)) ||
      (run.state !== "running" &&
        (run.completedAt === null ||
          run.completedAt !== run.updatedAt ||
          run.pendingUpdates.length !== 0))
    ) {
      throw new Error("inconsistent run state timestamps");
    }
    if (run.pendingUpdates.length > (run.counters as RunCounters).callCount) {
      throw new Error("too many pending updates");
    }
    const pendingIds = new Set<string>();
    for (const attempt of run.pendingUpdates) {
      validatePendingUpdateAttempt(
        attempt,
        id,
        run.startedAt as number,
        run.updatedAt as number,
      );
      if (pendingIds.has((attempt as PendingUpdateAttempt).id)) {
        throw new Error("duplicate pending update evidence");
      }
      pendingIds.add((attempt as PendingUpdateAttempt).id);
    }
  } catch (error) {
    if (error instanceof BlastDatabaseError && error.code === "corrupt") {
      throw error;
    }
    throw corrupt(`${label} is malformed`);
  }
  return value as RunRecord;
}

function validatePendingUpdateAttempt(
  value: unknown,
  runId: string,
  runStartedAt: number,
  runUpdatedAt: number,
): asserts value is PendingUpdateAttempt {
  const label = `Run ${runId} pending update evidence`;
  const attempt = storedObject(value, label);
  requireExactStoredFields(attempt, PENDING_UPDATE_FIELDS, label);
  if (
    assertId(attempt.id, "Pending update ID") !== attempt.id ||
    requiredStringRange(attempt.canister, "Pending update canister", 5, 63) !==
      attempt.canister ||
    requiredStoredV1MethodName(attempt.method, "Pending update method") !==
      attempt.method ||
    typeof attempt.argumentsDigest !== "string" ||
    !DIGEST_PATTERN.test(attempt.argumentsDigest) ||
    attempt.identityMode !== "local" ||
    !validCounter(attempt.startedAt) ||
    attempt.startedAt < runStartedAt ||
    attempt.startedAt > runUpdatedAt ||
    (attempt.status !== "call_pending" &&
      attempt.status !== "dispatch_confirmed")
  ) {
    throw corrupt(`${label} is malformed`);
  }
}

function validateCheckpointRecord(
  value: unknown,
  runId: string,
): CheckpointRecord {
  const label = `Run ${runId} checkpoint`;
  const checkpoint = storedObject(value, label);
  requireExactStoredFields(checkpoint, CHECKPOINT_RECORD_FIELDS, label);
  try {
    if (
      checkpoint.schema !== 1 ||
      assertId(checkpoint.runId, "Checkpoint run ID") !== runId ||
      !validCounter(checkpoint.revision) ||
      checkpoint.revision < 1 ||
      checkpoint.revision > BLAST_LIMITS.scriptHostCalls ||
      typeof checkpoint.sourceDigest !== "string" ||
      !DIGEST_PATTERN.test(checkpoint.sourceDigest) ||
      !validCounter(checkpoint.serializedBytes) ||
      !validCounter(checkpoint.updatedAt)
    ) {
      throw new Error("invalid checkpoint fields");
    }
    requireCanonicalStoredIds(
      checkpoint.inputCollectionIds,
      MAX_RUN_COLLECTIONS,
      "Checkpoint input collection IDs",
    );
    requireCanonicalStoredIds(
      checkpoint.outputCollectionIds,
      MAX_RUN_COLLECTIONS,
      "Checkpoint output collection IDs",
    );
    requireCanonicalStoredIds(
      checkpoint.acknowledgedUpdateIds,
      BLAST_RUN_BUDGETS.calls,
      "Checkpoint acknowledged update IDs",
    );
    assertBoundedBlastStoredV1Json(
      checkpoint.value,
      label,
      BLAST_LIMITS.collectionSummaryBytes,
    );
    if (
      checkpoint.serializedBytes !== jsonBytes(checkpoint.value as JsonValue)
    ) {
      throw new Error("inconsistent checkpoint byte count");
    }
  } catch (error) {
    if (error instanceof BlastDatabaseError && error.code === "corrupt") {
      throw error;
    }
    throw corrupt(`${label} is malformed`);
  }
  return value as CheckpointRecord;
}

function toCollectionListEntry(record: CollectionRecord): CollectionListEntry {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    kind: record.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pageCount: record.pageCount,
    itemCount: record.itemCount,
    serializedBytes: record.serializedBytes,
    producer: record.producer,
    identity: record.identity,
    source: record.source,
    sourceCollectionIds: [...record.sourceCollectionIds],
  };
}

function toRunListEntry(record: RunRecord): RunListEntry {
  return {
    id: record.id,
    source: record.source,
    state: record.state,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    deadlineAt: record.deadlineAt,
    identity: record.identity,
    counters: record.counters,
    pendingUpdateCount: runPendingUpdateCount(record),
    checkpointRevision: record.checkpointRevision,
    inputCollectionCount: record.inputCollectionIds.length,
    outputCollectionCount: record.outputCollectionIds.length,
  };
}

function pageWriteResult(
  status: PageWriteResult["status"],
  page: CollectionPageRecord,
): PageWriteResult {
  return {
    status,
    sequence: page.sequence,
    digest: page.digest,
    itemCount: page.itemCount,
    serializedBytes: page.serializedBytes,
  };
}

function normalizeProducer(value: unknown): CollectionProducer | null {
  if (value === undefined || value === null) return null;
  if (!hasExactObjectFields(value, ["scriptId", "revision", "digest"])) {
    throw new Error("Collection producer is invalid");
  }
  return {
    scriptId: positiveNat64Text(value.scriptId, "Producer script ID"),
    revision: positiveNat64Text(value.revision, "Producer script revision"),
    digest: assertDigest(value.digest, "Producer script digest"),
  };
}

function normalizeCollectionIdentity(value: unknown): CollectionIdentity {
  if (!hasExactObjectFields(value, ["mode", "principal"])) {
    throw new Error("Collection identity metadata is invalid");
  }
  if (value.mode === "local") {
    return {
      mode: "local",
      principal: requiredStringRange(
        value.principal,
        "Collection identity principal",
        5,
        63,
      ),
    };
  }
  throw new Error("Collection identity mode is invalid");
}

function normalizeOptionalIdentity(value: unknown): CollectionIdentity | null {
  return value === undefined || value === null
    ? null
    : normalizeCollectionIdentity(value);
}

function normalizePendingUpdateInput(
  value: unknown,
): Omit<PendingUpdateAttempt, "id" | "startedAt" | "status"> {
  if (
    !hasExactObjectFields(value, [
      "canister",
      "method",
      "argumentsDigest",
      "identityMode",
    ])
  ) {
    throw new Error("Pending update evidence is invalid");
  }
  if (value.identityMode !== "local") {
    throw new Error("Pending update identity mode is invalid");
  }
  return {
    canister: requiredStringRange(
      value.canister,
      "Pending update canister",
      5,
      63,
    ),
    method: requiredBlastMethodName(value.method, "Pending update method"),
    argumentsDigest: assertDigest(
      value.argumentsDigest,
      "Pending update arguments digest",
    ),
    identityMode: value.identityMode,
  };
}

function normalizeSource(value: unknown): CollectionSource | null {
  if (value === undefined || value === null) return null;
  if (!hasExactObjectFields(value, ["canister", "method", "argumentsDigest"])) {
    throw new Error("Collection source is invalid");
  }
  return {
    canister: requiredStringRange(value.canister, "Source canister", 5, 63),
    method: requiredBlastMethodName(value.method, "Source method"),
    argumentsDigest: assertDigest(
      value.argumentsDigest,
      "Source argument digest",
    ),
  };
}

function normalizeStoredV1Source(value: unknown): CollectionSource | null {
  if (value === undefined || value === null) return null;
  if (!hasExactObjectFields(value, ["canister", "method", "argumentsDigest"])) {
    throw new Error("Collection source is invalid");
  }
  return {
    canister: requiredStringRange(value.canister, "Source canister", 5, 63),
    method: requiredStoredV1MethodName(value.method, "Source method"),
    argumentsDigest: assertDigest(
      value.argumentsDigest,
      "Source argument digest",
    ),
  };
}

function requiredStoredV1MethodName(value: unknown, label: string): string {
  return requiredScalarString(
    value,
    label,
    BLAST_LIMITS.canisterMethodCharacters,
  );
}

function normalizeRunSource(value: unknown): RunSource {
  if (!value || typeof value !== "object")
    throw new Error("Run source is invalid");
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "temporary") {
    if (!hasExactObjectFields(value, ["kind", "digest"])) {
      throw new Error("Run source is invalid");
    }
    return {
      kind: "temporary",
      digest: assertDigest(value.digest, "Run source digest"),
    };
  }
  if (kind === "saved") {
    if (
      !hasExactObjectFields(value, ["kind", "scriptId", "revision", "digest"])
    ) {
      throw new Error("Run source is invalid");
    }
    return {
      kind: "saved",
      scriptId: positiveNat64Text(value.scriptId, "Run script ID"),
      revision: positiveNat64Text(value.revision, "Run script revision"),
      digest: assertDigest(value.digest, "Run source digest"),
    };
  }
  throw new Error("Run source is invalid");
}

function normalizeRunHandle(value: RunHandle): RunHandle {
  if (!hasExactObjectFields(value, ["runId", "sessionId"])) {
    throw new Error("Run handle is invalid");
  }
  return {
    runId: assertId(value.runId, "Run ID"),
    sessionId: assertId(value.sessionId, "Run session ID"),
  };
}

function normalizeCollectionIds(
  values: readonly string[],
  maximum: number,
  label: string,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new Error(`${label} are invalid`);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = assertId(value, label);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isStringPrefix(
  prefix: readonly string[],
  values: readonly string[],
): boolean {
  return (
    prefix.length <= values.length &&
    prefix.every((value, index) => value === values[index])
  );
}

function checkpointMatchesRun(
  checkpoint: CheckpointRecord,
  run: RunRecord,
): boolean {
  return (
    checkpoint.revision === run.checkpointRevision &&
    checkpoint.sourceDigest === runSourceDigest(run.source) &&
    checkpoint.updatedAt >= run.startedAt &&
    checkpoint.updatedAt <= run.updatedAt &&
    sameStrings(checkpoint.inputCollectionIds, run.inputCollectionIds) &&
    // Output collections are append-only while a run is live. A checkpoint is
    // a historical boundary, so outputs created after it must not invalidate it.
    isStringPrefix(checkpoint.outputCollectionIds, run.outputCollectionIds)
  );
}

function assertCollectionKind(value: unknown): CollectionKind {
  if (!isCollectionKind(value)) throw new Error("Collection kind is invalid");
  return value;
}

function isCollectionKind(value: unknown): value is CollectionKind {
  return value === "raw" || value === "derived";
}

function isCollectionState(value: unknown): value is CollectionState {
  return (
    value === "open" ||
    value === "complete" ||
    value === "failed" ||
    value === "deleting"
  );
}

function isRunState(value: unknown): value is RunState {
  return value === "running" || isTerminalRunState(value);
}

function isTerminalRunState(
  value: unknown,
): value is Exclude<RunState, "running"> {
  return (
    value === "complete" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isValidId(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isValidId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= MAX_ID_CHARACTERS &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function assertGeneratedId(value: unknown, label: string): string {
  return assertId(value, label);
}

function assertIdempotencyKey(value: unknown): string {
  return requiredScalarString(
    value,
    "Collection idempotency key",
    MAX_IDEMPOTENCY_KEY_CHARACTERS,
  );
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredStringRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const text = requiredScalarString(value, label, maximum);
  if (unicodeScalarLength(text) < minimum)
    throw new Error(`${label} is invalid`);
  return text;
}

function requiredScalarString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarText(value) ||
    unicodeScalarLength(value) > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalScalarString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requiredScalarString(value, label, maximum);
}

function positiveNat64Text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value) ||
    BigInt(value) > MAX_NAT64
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function decodePageCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return -1;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new Error("Collection page cursor is invalid");
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Collection page cursor is invalid");
  }
  return sequence;
}

export function encodePageCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Collection page cursor is invalid");
  }
  return String(sequence);
}

function boundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedNonNegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedCounterDelta(value: unknown, label: string): number {
  if (!validCounter(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedTimestamp(value: unknown, label: string): number {
  if (!validCounter(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BlastDatabaseError(
      "invalid_state",
      `${label} exceeds its safe bound`,
    );
  }
  return value;
}

function addWithinRunBudget(
  current: number,
  increment: number,
  maximum: number,
  label: string,
): number {
  const value = checkedAdd(current, increment, `Run ${label}`);
  if (value > maximum) {
    throw new BlastDatabaseError(
      "invalid_state",
      `Run ${label} budget is exhausted`,
    );
  }
  return value;
}

function monotonicNow(previous: number, now: number): number {
  return Math.max(previous, now);
}

function emptyRunCounters(): RunCounters {
  return {
    callCount: 0,
    requestBytes: 0,
    responseBytes: 0,
    pageReadCount: 0,
    pageWriteCount: 0,
    readBytes: 0,
    writeBytes: 0,
  };
}

function validRunCounters(value: unknown): value is RunCounters {
  if (
    !hasExactObjectFields(value, [
      "callCount",
      "requestBytes",
      "responseBytes",
      "pageReadCount",
      "pageWriteCount",
      "readBytes",
      "writeBytes",
    ])
  ) {
    return false;
  }
  return (
    validCounter(value.callCount) &&
    value.callCount <= BLAST_RUN_BUDGETS.calls &&
    validCounter(value.requestBytes) &&
    value.requestBytes <= BLAST_RUN_BUDGETS.requestBytes &&
    validCounter(value.responseBytes) &&
    value.responseBytes <= BLAST_RUN_BUDGETS.responseBytes &&
    validCounter(value.pageReadCount) &&
    value.pageReadCount <= BLAST_RUN_BUDGETS.pageReads &&
    validCounter(value.pageWriteCount) &&
    value.pageWriteCount <= BLAST_RUN_BUDGETS.pageWrites &&
    validCounter(value.readBytes) &&
    value.readBytes <= BLAST_RUN_BUDGETS.readBytes &&
    validCounter(value.writeBytes) &&
    value.writeBytes <= BLAST_RUN_BUDGETS.writeBytes
  );
}

function runSourceDigest(source: RunSource): string {
  return source.digest;
}

function snapshotBoundedJson(
  value: unknown,
  label: string,
  maximumBytes: number,
): JsonValue {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new Error(`${label} must be structured-cloneable JSON`);
  }
  assertBoundedBlastJson(snapshot, label, maximumBytes);
  return snapshot;
}

function withTerminalUpdateEvidence(
  summary: JsonValue,
  attempts: readonly PendingUpdateAttempt[],
): JsonValue {
  if (attempts.length === 0) {
    if (!hasTerminalUpdateEvidence(summary)) return summary;
    const escaped = { summary };
    try {
      assertBoundedBlastJson(
        escaped,
        "Run terminal summary",
        BLAST_LIMITS.collectionSummaryBytes,
      );
      return escaped;
    } catch {
      return { summaryOmitted: true };
    }
  }
  const updateEvidence = {
    protocol: 1,
    uncheckpointedUpdateCount: attempts.length,
    callPendingCount: attempts.filter(
      (attempt) => attempt.status === "call_pending",
    ).length,
    dispatchConfirmedCount: attempts.filter(
      (attempt) => attempt.status === "dispatch_confirmed",
    ).length,
    attempts: attempts.map((attempt) => ({ ...attempt })),
  };
  const retained =
    summary !== null && typeof summary === "object" && !Array.isArray(summary)
      ? {
          ...summary,
          retrySafe: false,
          updateEvidence,
        }
      : {
          summary,
          retrySafe: false,
          updateEvidence,
        };
  try {
    assertBoundedBlastJson(
      retained,
      "Run terminal summary",
      BLAST_LIMITS.collectionSummaryBytes,
    );
    return retained;
  } catch {
    const fallback = {
      retrySafe: false,
      summaryOmitted: true,
      ...completionEvidenceDigestOnly(summary),
      updateEvidence,
    };
    assertBoundedBlastJson(
      fallback,
      "Run terminal update evidence",
      BLAST_LIMITS.collectionSummaryBytes,
    );
    return fallback;
  }
}

function completionEvidenceDigestOnly(
  summary: JsonValue,
): Readonly<{ completionEvidence: JsonValue }> | Record<string, never> {
  if (
    summary === null ||
    typeof summary !== "object" ||
    Array.isArray(summary)
  ) {
    return {};
  }
  const evidence = summary.completionEvidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  ) {
    return {};
  }
  if (
    evidence.protocol !== 1 ||
    typeof evidence.argumentsDigest !== "string" ||
    !DIGEST_PATTERN.test(evidence.argumentsDigest) ||
    typeof evidence.resultDigest !== "string" ||
    !DIGEST_PATTERN.test(evidence.resultDigest) ||
    !validCounter(evidence.resultBytes) ||
    evidence.resultBytes > BLAST_LIMITS.scriptResultBytes ||
    (evidence.resultStatus !== "stored" &&
      evidence.resultStatus !== "digest_only")
  ) {
    return {};
  }
  return {
    completionEvidence: {
      protocol: 1,
      argumentsDigest: evidence.argumentsDigest,
      resultDigest: evidence.resultDigest,
      resultBytes: evidence.resultBytes,
      resultStatus: "digest_only",
    },
  };
}

function hasTerminalUpdateEvidence(value: JsonValue | null): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evidence = value.updateEvidence;
  return (
    value.retrySafe === false &&
    evidence !== null &&
    typeof evidence === "object" &&
    !Array.isArray(evidence) &&
    evidence.protocol === 1
  );
}

function terminalUpdateEvidenceCount(value: JsonValue | null): number {
  if (!hasTerminalUpdateEvidence(value)) return 0;
  const evidence = (value as Record<string, JsonValue>)
    .updateEvidence as Record<string, JsonValue>;
  const count = evidence.uncheckpointedUpdateCount;
  return typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= BLAST_PENDING_UPDATE_LIMIT
    ? count
    : 0;
}

export function runPendingUpdateCount(
  run: Pick<RunRecord, "pendingUpdates" | "summary">,
): number {
  return run.pendingUpdates.length > 0
    ? run.pendingUpdates.length
    : terminalUpdateEvidenceCount(run.summary);
}

/** Stable object-key ordering for idempotency comparisons. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function corrupt(message: string): BlastDatabaseError {
  return new BlastDatabaseError("corrupt", message);
}

export function classifyBlastDatabaseError(error: unknown): BlastDatabaseError {
  if (error instanceof BlastDatabaseError) return error;
  const name = errorName(error);
  if (name === "QuotaExceededError") {
    return new BlastDatabaseError(
      "quota_exceeded",
      "Blast browser storage quota is exhausted; delete exact local collections or export data before retrying",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (name === "VersionError") {
    return new BlastDatabaseError(
      "unavailable",
      "Blast browser storage was created by a newer incompatible app version",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return new BlastDatabaseError(
    "storage_error",
    "Blast browser storage operation failed",
    error instanceof Error ? { cause: error } : undefined,
  );
}

function errorName(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function abortTransaction<
  Stores extends ArrayLike<StoreNames<BlastCollectionsSchema>>,
  Mode extends IDBTransactionMode,
>(transaction: IDBPTransaction<BlastCollectionsSchema, Stores, Mode>): void {
  // Observe the rejection produced by an explicit abort; callers receive the
  // original bounded domain error rather than an unhandled AbortError.
  void transaction.done.catch(() => undefined);
  try {
    transaction.abort();
  } catch {
    // A request error may already have aborted or completed the transaction.
  }
}
