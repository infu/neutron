import { WAGYU_VERIFIER_VERSION } from "../verifier/index.ts";

const DATABASE_NAME = "neutron-wagyu-verification-v1";
const DATABASE_VERSION = 1;
const HIGH_WATER_STORE = "high_water";
const RESULT_STORE = "verified_results";
const SAVED_AT_INDEX = "saved_at_ms";
const MAX_HIGH_WATER_RECORDS = 8_192;
const MAX_RESULT_RECORDS = 4_096;
const MAX_STORAGE_KEY_LENGTH = 1_024;

export type StoredHighWaterV1 =
  | {
      readonly kind: "profile";
      readonly profileGeneration: string;
      readonly revision: string;
      readonly bodyDigest: Uint8Array;
    }
  | {
      readonly kind: "like-head";
      readonly storeGeneration: string;
      readonly revision: string;
      readonly bodyDigest: Uint8Array;
    }
  | {
      readonly kind: "reply-index";
      readonly storeGeneration: string;
      readonly revision: string;
      readonly bodyDigest: Uint8Array;
    };

export interface WagyuVerificationStoreV1 {
  getHighWater(key: string): Promise<StoredHighWaterV1 | null>;
  putHighWater(key: string, value: StoredHighWaterV1): Promise<void>;
  getVerifiedResult<T>(key: string): Promise<T | null>;
  putVerifiedResult<T>(key: string, value: T): Promise<void>;
}

type StoredEnvelope = {
  readonly key: string;
  readonly savedAtMs: number;
  readonly value: unknown;
};

export function profileHighWaterKey(
  networkIdHex: string,
  nodeId: string,
): string {
  return storageKey(networkIdHex, "high-water", nodeId, "profile", "current");
}

export function likeHeadHighWaterKey(
  networkIdHex: string,
  nodeId: string,
  postIdHex: string,
): string {
  return storageKey(
    networkIdHex,
    "high-water",
    nodeId,
    "like-head",
    postIdHex,
  );
}

export function replyIndexHighWaterKey(
  networkIdHex: string,
  nodeId: string,
  postIdHex: string,
): string {
  return storageKey(
    networkIdHex,
    "high-water",
    nodeId,
    "reply-index",
    postIdHex,
  );
}

export function shareEdgeEvidenceKey(
  networkIdHex: string,
  immediateSender: string,
  originalAuthor: string,
  postIdHex: string,
  bodyHashHex: string,
): string {
  return storageKey(
    networkIdHex,
    "result",
    immediateSender,
    "share-edge",
    [
      nodeIdKeySegment(originalAuthor),
      requiredHex32(postIdHex, "Share-edge post ID"),
      requiredHex32(bodyHashHex, "Share-edge body hash"),
      WAGYU_VERIFIER_VERSION,
    ].join("."),
  );
}

export function createBrowserVerificationStore(): WagyuVerificationStoreV1 {
  if (typeof globalThis.indexedDB === "undefined") {
    return createMemoryVerificationStore();
  }
  const memory = createMemoryVerificationStore();
  const database = openDatabase();
  return {
    async getHighWater(key) {
      const local = await memory.getHighWater(key);
      const stored = await readRecord<StoredHighWaterV1>(
        await database,
        HIGH_WATER_STORE,
        key,
      );
      const strongest = strongestHighWater(local, stored);
      if (strongest !== null) await memory.putHighWater(key, strongest);
      return strongest;
    },
    async putHighWater(key, value) {
      await writeHighWaterRecord(
        await database,
        key,
        value,
        MAX_HIGH_WATER_RECORDS,
      );
      await memory.putHighWater(key, value);
    },
    async getVerifiedResult<T>(key: string) {
      const local = await memory.getVerifiedResult<T>(key);
      if (local !== null) return local;
      try {
        const stored = await readRecord<T>(
          await database,
          RESULT_STORE,
          key,
        );
        if (stored !== null) {
          await memory.putVerifiedResult(key, stored);
        }
        return stored;
      } catch {
        return null;
      }
    },
    async putVerifiedResult<T>(key: string, value: T) {
      await memory.putVerifiedResult(key, value);
      try {
        await writeRecord(
          await database,
          RESULT_STORE,
          key,
          value,
          MAX_RESULT_RECORDS,
        );
      } catch {
        // Optional persistence failure does not erase the bounded memory copy.
      }
    },
  };
}

export function createMemoryVerificationStore(
  limits: {
    readonly highWater?: number;
    readonly results?: number;
  } = {},
): WagyuVerificationStoreV1 {
  const highWater = new Map<string, StoredHighWaterV1>();
  const results = new Map<string, unknown>();
  const highWaterLimit = limits.highWater ?? MAX_HIGH_WATER_RECORDS;
  const resultLimit = limits.results ?? MAX_RESULT_RECORDS;
  return {
    async getHighWater(key) {
      const value = highWater.get(assertStorageKey(key));
      return value === undefined ? null : clone(value);
    },
    async putHighWater(key, value) {
      const exactKey = assertStorageKey(key);
      const current = highWater.get(exactKey) ?? null;
      const next = advancingHighWater(current, clone(value));
      if (current === null && highWater.size >= highWaterLimit) {
        throw new Error(
          "Verification high-water storage is full; rollback protection cannot be weakened",
        );
      }
      highWater.set(exactKey, next);
    },
    async getVerifiedResult<T>(key: string) {
      const value = results.get(assertStorageKey(key));
      return value === undefined ? null : clone(value as T);
    },
    async putVerifiedResult<T>(key: string, value: T) {
      boundedMapPut(
        results,
        assertStorageKey(key),
        clone(value),
        resultLimit,
      );
    },
  };
}

function storageKey(
  networkIdHex: string,
  bucket: "high-water" | "result",
  nodeId: string,
  objectKind:
    | "profile"
    | "like-head"
    | "reply-index"
    | "like-batch"
    | "share-edge",
  objectId: string,
): string {
  if (!/^[0-9a-f]{64}$/u.test(networkIdHex)) {
    throw new Error("Verification storage network ID is invalid");
  }
  if (
    typeof nodeId !== "string" ||
    nodeId.length < 5 ||
    nodeId.length > 128 ||
    !/^[a-z0-9-]+$/u.test(nodeId)
  ) {
    throw new Error("Verification storage node ID is invalid");
  }
  if (
    typeof objectId !== "string" ||
    objectId.length === 0 ||
    objectId.length > 384 ||
    !/^[a-zA-Z0-9._:-]+$/u.test(objectId)
  ) {
    throw new Error("Verification storage object ID is invalid");
  }
  return assertStorageKey(
    `wagyu:v1:${networkIdHex}:${bucket}:${nodeId}:${objectKind}:${objectId}`,
  );
}

function nodeIdKeySegment(nodeId: string): string {
  if (
    typeof nodeId !== "string" ||
    nodeId.length < 5 ||
    nodeId.length > 128 ||
    !/^[a-z0-9-]+$/u.test(nodeId)
  ) {
    throw new Error("Verification storage node ID is invalid");
  }
  return nodeId.replaceAll("-", "_");
}

function requiredHex32(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertStorageKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_STORAGE_KEY_LENGTH
  ) {
    throw new Error("Verification storage key is invalid");
  }
  return key;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [HIGH_WATER_STORE, RESULT_STORE]) {
        const store = database.objectStoreNames.contains(storeName)
          ? request.transaction!.objectStore(storeName)
          : database.createObjectStore(storeName, { keyPath: "key" });
        if (!store.indexNames.contains(SAVED_AT_INDEX)) {
          store.createIndex(SAVED_AT_INDEX, "savedAtMs");
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Wagyu IndexedDB open failed"));
    request.onblocked = () =>
      reject(new Error("Wagyu IndexedDB upgrade was blocked"));
  });
}

async function readRecord<T>(
  database: IDBDatabase,
  storeName: string,
  key: string,
): Promise<T | null> {
  assertStorageKey(key);
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).get(key);
  const result = await idbRequest<StoredEnvelope | undefined>(request);
  await idbTransaction(transaction);
  if (
    result === undefined ||
    result === null
  ) {
    return null;
  }
  if (result.key !== key || !Number.isSafeInteger(result.savedAtMs)) {
    throw new Error("Wagyu IndexedDB record is malformed");
  }
  return clone(result.value as T);
}

async function writeHighWaterRecord(
  database: IDBDatabase,
  key: string,
  value: StoredHighWaterV1,
  maximumRecords: number,
): Promise<void> {
  assertStorageKey(key);
  const transaction = database.transaction(HIGH_WATER_STORE, "readwrite");
  const store = transaction.objectStore(HIGH_WATER_STORE);
  try {
    const envelope = await idbRequest<StoredEnvelope | undefined>(
      store.get(key),
    );
    const current =
      envelope === undefined || envelope === null
        ? null
        : (
            envelope.key === key &&
              Number.isSafeInteger(envelope.savedAtMs)
            ? clone(envelope.value as StoredHighWaterV1)
            : (() => {
                throw new Error("Wagyu high-water record is malformed");
              })()
          );
    const next = advancingHighWater(current, clone(value));
    if (current === null) {
      const count = await idbRequest<number>(store.count());
      if (count >= maximumRecords) {
        throw new Error(
          "Verification high-water storage is full; rollback protection cannot be weakened",
        );
      }
    }
    store.put({
      key,
      savedAtMs: Date.now(),
      value: next,
    } satisfies StoredEnvelope);
  } catch (error) {
    transaction.abort();
    throw error;
  }
  await idbTransaction(transaction);
}

async function writeRecord<T>(
  database: IDBDatabase,
  storeName: string,
  key: string,
  value: T,
  maximumRecords: number,
): Promise<void> {
  assertStorageKey(key);
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put({
    key,
    savedAtMs: Date.now(),
    value: clone(value),
  } satisfies StoredEnvelope);
  await idbTransaction(transaction);
  await pruneStore(database, storeName, maximumRecords, key);
}

async function pruneStore(
  database: IDBDatabase,
  storeName: string,
  maximumRecords: number,
  protectedKey: string,
): Promise<void> {
  const countTransaction = database.transaction(storeName, "readonly");
  const count = await idbRequest<number>(
    countTransaction.objectStore(storeName).count(),
  );
  await idbTransaction(countTransaction);
  let remaining = count - maximumRecords;
  if (remaining <= 0) return;

  const transaction = database.transaction(storeName, "readwrite");
  const index = transaction.objectStore(storeName).index(SAVED_AT_INDEX);
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor();
    request.onerror = () =>
      reject(request.error ?? new Error("Wagyu IndexedDB prune failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || remaining <= 0) {
        resolve();
        return;
      }
      const record = cursor.value as StoredEnvelope;
      if (record.key !== protectedKey) {
        cursor.delete();
        remaining -= 1;
      }
      cursor.continue();
    };
  });
  await idbTransaction(transaction);
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Wagyu IndexedDB request failed"));
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Wagyu IndexedDB failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Wagyu IndexedDB aborted"));
  });
}

function boundedMapPut<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maximum: number,
): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Verification memory-store bound is invalid");
  }
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function strongestHighWater(
  left: StoredHighWaterV1 | null,
  right: StoredHighWaterV1 | null,
): StoredHighWaterV1 | null {
  if (left === null) return right === null ? null : clone(right);
  if (right === null) return clone(left);
  const order = compareHighWater(left, right);
  return clone(order >= 0 ? left : right);
}

function advancingHighWater(
  current: StoredHighWaterV1 | null,
  next: StoredHighWaterV1,
): StoredHighWaterV1 {
  validateHighWater(next);
  if (current === null) return clone(next);
  const order = compareHighWater(current, next);
  if (order > 0) {
    throw new Error("Verification high-water state cannot move backwards");
  }
  return clone(next);
}

function compareHighWater(
  left: StoredHighWaterV1,
  right: StoredHighWaterV1,
): number {
  validateHighWater(left);
  validateHighWater(right);
  if (left.kind !== right.kind) {
    throw new Error("Verification high-water kind changed for one key");
  }
  const leftGeneration = highWaterGeneration(left);
  const rightGeneration = highWaterGeneration(right);
  const generationOrder =
    leftGeneration < rightGeneration ? -1 : leftGeneration > rightGeneration ? 1 : 0;
  if (generationOrder !== 0) return generationOrder;
  const leftRevision = canonicalNat(left.revision);
  const rightRevision = canonicalNat(right.revision);
  const revisionOrder =
    leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0;
  if (revisionOrder !== 0) return revisionOrder;
  if (!equalBytes(left.bodyDigest, right.bodyDigest)) {
    throw new Error(
      "Verification high-water digest conflicts at the same revision",
    );
  }
  return 0;
}

function highWaterGeneration(value: StoredHighWaterV1): bigint {
  return canonicalNat(
    value.kind === "profile"
      ? value.profileGeneration
      : value.storeGeneration,
  );
}

function validateHighWater(value: StoredHighWaterV1): void {
  highWaterGeneration(value);
  canonicalNat(value.revision);
  if (!(value.bodyDigest instanceof Uint8Array) || value.bodyDigest.byteLength !== 32) {
    throw new Error("Verification high-water digest is invalid");
  }
}

function canonicalNat(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Verification high-water revision is invalid");
  }
  return BigInt(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
