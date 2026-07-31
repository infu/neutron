const DATABASE_NAME = "neutron-browser-secret-cache-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "sealed";
const KEK_KEY = "kek:v1";
const ENTRY_PREFIX = "secret:";
const AAD_DOMAIN = new TextEncoder().encode(
  "neutron.browser-secret-cache.v1",
);

export const BROWSER_SECRET_CACHE_MAX_RECORDS = 8;
export const BROWSER_SECRET_CACHE_MAX_TTL_MS =
  7 * 24 * 60 * 60 * 1_000;

const MAX_ID_BYTES = 160;
const MAX_BINDING_BYTES = 4_096;
const MAX_SECRET_BYTES = 4_096;
const AES_GCM_IV_BYTES = 12;

export type BrowserSecretCacheKey = Readonly<{
  id: string;
  binding: Uint8Array;
}>;

export type BrowserSecretCachePut = BrowserSecretCacheKey & Readonly<{
  secret: Uint8Array;
  /** Absolute Unix time in milliseconds, at most seven days from this write. */
  expiresAtMs: number;
}>;

export type BrowserSecretCacheOptions = Readonly<{
  crypto?: Crypto | null;
  indexedDB?: IDBFactory | null;
  now?: () => number;
}>;

export type BrowserSecretCache = Readonly<{
  get(key: BrowserSecretCacheKey): Promise<Uint8Array | null>;
  put(value: BrowserSecretCachePut): Promise<boolean>;
  /**
   * Remove corrupt and expired records. When `keep` is supplied, records not
   * present with the exact same id and binding are removed too.
   */
  prune(keep?: readonly BrowserSecretCacheKey[]): Promise<void>;
  close(): void;
}>;

type KekRecord = Readonly<{
  kind: "kek";
  schema: 1;
  key: CryptoKey;
}>;

type SecretRecord = Readonly<{
  kind: "secret";
  schema: 1;
  id: string;
  binding: ArrayBuffer;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  createdAtMs: number;
  expiresAtMs: number;
}>;

type NormalizedKey = Readonly<{
  id: string;
  binding: Uint8Array;
}>;

class IndexedDbBrowserSecretCache implements BrowserSecretCache {
  readonly #crypto: Crypto | null;
  readonly #factory: IDBFactory | null;
  readonly #now: () => number;
  #database: Promise<IDBDatabase | null> | null = null;
  #kek: Promise<CryptoKey | null> | null = null;
  #closed = false;

  constructor(options: BrowserSecretCacheOptions) {
    this.#crypto = options.crypto === undefined
      ? (globalThis.crypto ?? null)
      : options.crypto;
    this.#factory = options.indexedDB === undefined
      ? (globalThis.indexedDB ?? null)
      : options.indexedDB;
    this.#now = options.now ?? Date.now;
  }

  async get(input: BrowserSecretCacheKey): Promise<Uint8Array | null> {
    const key = normalizeKey(input);
    if (key === null || this.#closed) return null;
    try {
      const now = safeNow(this.#now);
      const [database, kek] = await Promise.all([
        this.#open(),
        this.#getOrCreateKek(),
      ]);
      if (database === null || kek === null) return null;
      const value = await requestValue<unknown>(
        database,
        "readonly",
        (store) => store.get(entryKey(key.id)),
      );
      const record = parseSecretRecord(value);
      if (
        record === null ||
        record.id !== key.id ||
        !equalBytes(new Uint8Array(record.binding), key.binding) ||
        record.createdAtMs > now ||
        record.expiresAtMs <= now ||
        record.expiresAtMs - record.createdAtMs >
          BROWSER_SECRET_CACHE_MAX_TTL_MS
      ) {
        if (
          record === null ||
          record.createdAtMs > now ||
          record.expiresAtMs <= now
        ) {
          void this.#delete(key.id);
        }
        return null;
      }
      const plaintext = await this.#crypto!.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(record.iv),
          additionalData: exactBuffer(encodeAad(
            record.id,
            new Uint8Array(record.binding),
            record.createdAtMs,
            record.expiresAtMs,
          )),
          tagLength: 128,
        },
        kek,
        record.ciphertext,
      );
      const bytes = new Uint8Array(plaintext);
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_SECRET_BYTES
      ) {
        bytes.fill(0);
        return null;
      }
      return bytes;
    } catch {
      return null;
    }
  }

  async put(input: BrowserSecretCachePut): Promise<boolean> {
    const key = normalizeKey(input);
    if (key === null || this.#closed) return false;
    const secret = copyBytes(input?.secret, MAX_SECRET_BYTES);
    if (secret === null) return false;
    try {
      const now = safeNow(this.#now);
      if (
        !Number.isSafeInteger(input.expiresAtMs) ||
        input.expiresAtMs <= now ||
        input.expiresAtMs - now > BROWSER_SECRET_CACHE_MAX_TTL_MS
      ) return false;
      const [database, kek] = await Promise.all([
        this.#open(),
        this.#getOrCreateKek(),
      ]);
      if (database === null || kek === null || this.#crypto === null) {
        return false;
      }
      const iv = new Uint8Array(AES_GCM_IV_BYTES);
      this.#crypto.getRandomValues(iv);
      const plaintext = secret.slice();
      let ciphertext: ArrayBuffer;
      try {
        ciphertext = await this.#crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: exactBuffer(encodeAad(
              key.id,
              key.binding,
              now,
              input.expiresAtMs,
            )),
            tagLength: 128,
          },
          kek,
          plaintext,
        );
      } finally {
        plaintext.fill(0);
      }
      const record: SecretRecord = {
        kind: "secret",
        schema: 1,
        id: key.id,
        binding: exactBuffer(key.binding),
        iv: exactBuffer(iv),
        ciphertext,
        createdAtMs: now,
        expiresAtMs: input.expiresAtMs,
      };
      return await storeBoundedRecord(database, record, now);
    } catch {
      return false;
    } finally {
      secret.fill(0);
    }
  }

  async prune(keep?: readonly BrowserSecretCacheKey[]): Promise<void> {
    if (this.#closed) return;
    const normalizedKeep = normalizeKeep(keep);
    if (keep !== undefined && normalizedKeep === null) return;
    try {
      const database = await this.#open();
      if (database === null) return;
      await pruneRecords(
        database,
        safeNow(this.#now),
        normalizedKeep,
      );
    } catch {
      // This cache is an optimization. Storage cleanup cannot block recovery.
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#kek = null;
    void this.#database?.then((database) => database?.close());
    this.#database = null;
  }

  #open(): Promise<IDBDatabase | null> {
    if (this.#closed || this.#factory === null) {
      return Promise.resolve(null);
    }
    if (this.#database !== null) return this.#database;
    const opening = openDatabase(this.#factory);
    this.#database = opening;
    void opening.then((database) => {
      if (database === null && this.#database === opening) {
        this.#database = null;
      }
    });
    return opening;
  }

  #getOrCreateKek(): Promise<CryptoKey | null> {
    if (
      this.#closed ||
      this.#crypto === null ||
      typeof this.#crypto.subtle?.generateKey !== "function"
    ) return Promise.resolve(null);
    if (this.#kek !== null) return this.#kek;
    const operation = this.#initializeKek();
    this.#kek = operation;
    void operation.then((kek) => {
      if (kek === null && this.#kek === operation) {
        this.#kek = null;
      }
    });
    return operation;
  }

  async #initializeKek(): Promise<CryptoKey | null> {
    try {
      const database = await this.#open();
      if (database === null || this.#crypto === null) return null;
      const existing = await requestValue<unknown>(
        database,
        "readonly",
        (store) => store.get(KEK_KEY),
      );
      const parsed = parseKekRecord(existing);
      if (parsed !== null) return parsed.key;

      const candidate = await this.#crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      if (!isCacheKek(candidate)) return null;
      // A read/write transaction is serialized against other tabs. It checks
      // again before installing, so concurrent cold starts converge on the
      // first committed non-extractable key instead of orphaning ciphertext.
      return await installKek(database, candidate);
    } catch {
      return null;
    }
  }

  async #delete(id: string): Promise<void> {
    try {
      const database = await this.#open();
      if (database === null) return;
      await requestValue(
        database,
        "readwrite",
        (store) => store.delete(entryKey(id)),
      );
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export function createBrowserSecretCache(
  options: BrowserSecretCacheOptions = {},
): BrowserSecretCache {
  return new IndexedDbBrowserSecretCache(options);
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: IDBDatabase | null): void => {
      if (settled) {
        value?.close();
        return;
      }
      settled = true;
      resolve(value);
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      finish(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      finish(database);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

function requestValue<Result>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<Result>,
): Promise<Result | undefined> {
  return new Promise((resolve, reject) => {
    let request: IDBRequest<Result>;
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (error) {
      reject(error);
      return;
    }
    let result: Result | undefined;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => {
      // The transaction handlers below own rejection.
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Browser secret cache transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Browser secret cache transaction aborted"),
    );
  });
}

function installKek(
  database: IDBDatabase,
  candidate: CryptoKey,
): Promise<CryptoKey | null> {
  return new Promise((resolve) => {
    let selected: CryptoKey | null = null;
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(KEK_KEY);
      request.onsuccess = () => {
        const existing = parseKekRecord(request.result);
        if (existing !== null) {
          selected = existing.key;
          return;
        }
        selected = candidate;
        store.clear();
        const record: KekRecord = { kind: "kek", schema: 1, key: candidate };
        store.put(record, KEK_KEY);
      };
    } catch {
      resolve(null);
      return;
    }
    transaction.oncomplete = () => resolve(selected);
    transaction.onerror = () => resolve(null);
    transaction.onabort = () => resolve(null);
  });
}

function storeBoundedRecord(
  database: IDBDatabase,
  record: SecretRecord,
  now: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      const live: SecretRecord[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor !== null) {
          if (cursor.key !== KEK_KEY) {
            const parsed = parseSecretRecord(cursor.value);
            if (
              parsed === null ||
              cursor.key !== entryKey(parsed.id) ||
              parsed.createdAtMs > now ||
              parsed.expiresAtMs <= now
            ) {
              cursor.delete();
            } else if (parsed.id !== record.id) {
              live.push(parsed);
            }
          }
          cursor.continue();
          return;
        }
        live.sort(
          (left, right) =>
            left.expiresAtMs - right.expiresAtMs ||
            left.createdAtMs - right.createdAtMs ||
            left.id.localeCompare(right.id),
        );
        const excess =
          live.length - (BROWSER_SECRET_CACHE_MAX_RECORDS - 1);
        for (let index = 0; index < excess; index += 1) {
          store.delete(entryKey(live[index]!.id));
        }
        store.put(record, entryKey(record.id));
      };
    } catch {
      resolve(false);
      return;
    }
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

function pruneRecords(
  database: IDBDatabase,
  now: number,
  keep: ReadonlyMap<string, Uint8Array> | null,
): Promise<void> {
  return new Promise((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) return;
        if (cursor.key !== KEK_KEY) {
          const record = parseSecretRecord(cursor.value);
          const expected = record === null ? undefined : keep?.get(record.id);
          if (
            record === null ||
            cursor.key !== entryKey(record.id) ||
            record.createdAtMs > now ||
            record.expiresAtMs <= now ||
            (keep !== null &&
              (expected === undefined ||
                !equalBytes(new Uint8Array(record.binding), expected)))
          ) {
            cursor.delete();
          }
        }
        cursor.continue();
      };
    } catch {
      resolve();
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

function normalizeKeep(
  keep: readonly BrowserSecretCacheKey[] | undefined,
): ReadonlyMap<string, Uint8Array> | null {
  if (keep === undefined) return null;
  const result = new Map<string, Uint8Array>();
  for (const value of keep) {
    const normalized = normalizeKey(value);
    if (normalized === null) return null;
    const previous = result.get(normalized.id);
    if (previous !== undefined && !equalBytes(previous, normalized.binding)) {
      return null;
    }
    result.set(normalized.id, normalized.binding);
  }
  return result;
}

function normalizeKey(value: unknown): NormalizedKey | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<BrowserSecretCacheKey>;
  if (
    typeof candidate.id !== "string" ||
    !/^[A-Za-z0-9._:/-]+$/u.test(candidate.id)
  ) return null;
  const encodedId = new TextEncoder().encode(candidate.id);
  if (encodedId.byteLength < 1 || encodedId.byteLength > MAX_ID_BYTES) {
    return null;
  }
  const binding = copyBytes(candidate.binding, MAX_BINDING_BYTES);
  return binding === null ? null : { id: candidate.id, binding };
}

function copyBytes(value: unknown, maximum: number): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  if (value.byteLength < 1 || value.byteLength > maximum) return null;
  return value.slice();
}

function parseKekRecord(value: unknown): KekRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<KekRecord>;
  return candidate.kind === "kek" &&
      candidate.schema === 1 &&
      isCacheKek(candidate.key)
    ? { kind: "kek", schema: 1, key: candidate.key }
    : null;
}

function isCacheKek(value: unknown): value is CryptoKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CryptoKey>;
  const algorithm = candidate.algorithm as
    | { name?: unknown; length?: unknown }
    | undefined;
  const usages = Array.from(candidate.usages ?? []);
  return candidate.type === "secret" &&
    candidate.extractable === false &&
    algorithm?.name === "AES-GCM" &&
    algorithm.length === 256 &&
    usages.length === 2 &&
    usages.includes("encrypt") &&
    usages.includes("decrypt");
}

function parseSecretRecord(value: unknown): SecretRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SecretRecord>;
  if (
    candidate.kind !== "secret" ||
    candidate.schema !== 1 ||
    typeof candidate.id !== "string" ||
    !/^[A-Za-z0-9._:/-]+$/u.test(candidate.id) ||
    new TextEncoder().encode(candidate.id).byteLength > MAX_ID_BYTES ||
    !(candidate.binding instanceof ArrayBuffer) ||
    candidate.binding.byteLength < 1 ||
    candidate.binding.byteLength > MAX_BINDING_BYTES ||
    !(candidate.iv instanceof ArrayBuffer) ||
    candidate.iv.byteLength !== AES_GCM_IV_BYTES ||
    !(candidate.ciphertext instanceof ArrayBuffer) ||
    candidate.ciphertext.byteLength < 17 ||
    candidate.ciphertext.byteLength > MAX_SECRET_BYTES + 16 ||
    !Number.isSafeInteger(candidate.createdAtMs) ||
    !Number.isSafeInteger(candidate.expiresAtMs) ||
    candidate.createdAtMs! < 0 ||
    candidate.expiresAtMs! <= candidate.createdAtMs! ||
    candidate.expiresAtMs! - candidate.createdAtMs! >
      BROWSER_SECRET_CACHE_MAX_TTL_MS
  ) return null;
  return candidate as SecretRecord;
}

function encodeAad(
  id: string,
  binding: Uint8Array,
  createdAtMs: number,
  expiresAtMs: number,
): Uint8Array {
  const encodedId = new TextEncoder().encode(id);
  const output = new Uint8Array(
    4 + AAD_DOMAIN.byteLength +
      4 + encodedId.byteLength +
      4 + binding.byteLength +
      8 + 8,
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  offset = writeField(output, view, offset, AAD_DOMAIN);
  offset = writeField(output, view, offset, encodedId);
  offset = writeField(output, view, offset, binding);
  view.setBigUint64(offset, BigInt(createdAtMs), false);
  offset += 8;
  view.setBigUint64(offset, BigInt(expiresAtMs), false);
  return output;
}

function writeField(
  output: Uint8Array,
  view: DataView,
  offset: number,
  value: Uint8Array,
): number {
  view.setUint32(offset, value.byteLength, false);
  output.set(value, offset + 4);
  return offset + 4 + value.byteLength;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Browser secret cache clock is invalid");
  }
  return value;
}

function entryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}`;
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}
