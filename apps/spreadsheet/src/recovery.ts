import type { SpreadsheetWorkbook } from "./model.ts";

const DATABASE_NAME = "neutron-spreadsheet-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "recovery";
const ACTIVE_KEY = "active";

export type RecoveryRecord = {
  version: 1;
  savedAt: number;
  revision: number;
  workbook: SpreadsheetWorkbook;
  nativeSource: { path: string; etag: string } | null;
};

export interface RecoveryPersistence {
  load(): Promise<RecoveryRecord | null>;
  save(record: RecoveryRecord): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryRecoveryPersistence(): RecoveryPersistence & { current(): RecoveryRecord | null } {
  let record: RecoveryRecord | null = null;
  return {
    async load() { return record ? structuredClone(record) : null; },
    async save(next) { record = structuredClone(next); },
    async clear() { record = null; },
    current() { return record ? structuredClone(record) : null; },
  };
}

export function createIndexedDbRecoveryPersistence(): RecoveryPersistence {
  if (typeof indexedDB === "undefined") return createMemoryRecoveryPersistence();
  const database = openDatabase();
  return {
    async load() {
      return request<RecoveryRecord | undefined>((await database).transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ACTIVE_KEY))
        .then((value) => value ? structuredClone(value) : null);
    },
    async save(record) {
      const transaction = (await database).transaction(STORE_NAME, "readwrite");
      // IndexedDB's structured-clone step happens synchronously when `put` is
      // called. Cloning first only doubles the main-thread copy cost for large
      // workbooks and does not add isolation or durability.
      transaction.objectStore(STORE_NAME).put(record, ACTIVE_KEY);
      await transactionDone(transaction);
    },
    async clear() {
      const transaction = (await database).transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(ACTIVE_KEY);
      await transactionDone(transaction);
    },
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME);
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Failed to open spreadsheet recovery database"));
    opening.onblocked = () => reject(new Error("Spreadsheet recovery database is blocked"));
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("Spreadsheet recovery request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Spreadsheet recovery transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Spreadsheet recovery transaction aborted"));
  });
}
