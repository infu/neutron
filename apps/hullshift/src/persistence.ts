export const HULLSHIFT_SAVE_SCHEMA = 1 as const;
export const MAX_SAVED_RUNS = 12;
export const MAX_COMPLETION_SUMMARIES = 512;
export const MAX_COMMANDS_PER_RUN = 65_535;

const DATABASE_NAME = "neutron-hullshift-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "state";
const ACTIVE_KEY = "resident";

export type PersistedEnvelope<T> = {
  readonly schema: typeof HULLSHIFT_SAVE_SCHEMA;
  readonly savedAt: number;
  readonly payload: T;
};

export type PersistenceKind = "indexeddb" | "memory";

export interface HullshiftPersistence<T> {
  readonly kind: PersistenceKind;
  load(): Promise<PersistedEnvelope<T> | null>;
  save(envelope: PersistedEnvelope<T>): Promise<void>;
  clear(): Promise<void>;
}

/** Deterministic test/fallback store. Values cross the same clone boundary as IndexedDB. */
export function createMemoryPersistence<T>(): HullshiftPersistence<T> & {
  current(): PersistedEnvelope<T> | null;
} {
  let value: PersistedEnvelope<T> | null = null;
  return {
    kind: "memory",
    async load() {
      return value === null ? null : structuredClone(value);
    },
    async save(next) {
      value = structuredClone(next);
    },
    async clear() {
      value = null;
    },
    current() {
      return value === null ? null : structuredClone(value);
    },
  };
}

export function createIndexedDbPersistence<T>(): HullshiftPersistence<T> {
  if (typeof indexedDB === "undefined") return createMemoryPersistence<T>();
  let database: Promise<IDBDatabase> | null = null;
  const getDatabase = () => (database ??= openDatabase());
  return {
    kind: "indexeddb",
    async load() {
      const transaction = (await getDatabase()).transaction(STORE_NAME, "readonly");
      const value = await request<PersistedEnvelope<T> | undefined>(
        transaction.objectStore(STORE_NAME).get(ACTIVE_KEY),
      );
      await transactionDone(transaction);
      return value === undefined ? null : structuredClone(value);
    },
    async save(envelope) {
      const transaction = (await getDatabase()).transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(envelope, ACTIVE_KEY);
      await transactionDone(transaction);
    },
    async clear() {
      const transaction = (await getDatabase()).transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(ACTIVE_KEY);
      await transactionDone(transaction);
    },
  };
}

export function createEnvelope<T>(payload: T, savedAt = Date.now()): PersistedEnvelope<T> {
  return { schema: HULLSHIFT_SAVE_SCHEMA, savedAt, payload };
}

export function assertEnvelope<T>(value: unknown): PersistedEnvelope<T> {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schema?: unknown }).schema !== HULLSHIFT_SAVE_SCHEMA ||
    typeof (value as { savedAt?: unknown }).savedAt !== "number" ||
    !("payload" in value)
  ) {
    throw new Error("Hullshift local data uses an unsupported or corrupt save schema");
  }
  return value as PersistedEnvelope<T>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) {
        opening.result.createObjectStore(STORE_NAME);
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Unable to open Hullshift local data"));
    opening.onblocked = () => reject(new Error("Hullshift local data is blocked by another context"));
  });
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("Hullshift local data request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Hullshift local data transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Hullshift local data transaction aborted"));
  });
}
