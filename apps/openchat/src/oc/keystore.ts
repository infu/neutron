// Durable browser storage for the resident engine.
//
// The database, object store and keys are part of the existing browser session
// format. CryptoKeyPair values stay non-extractable and are structured-cloned
// directly into IndexedDB. Opaque origins can use a resident-lifetime fallback;
// when IndexedDB becomes available, its pending writes and deletions are moved
// together before the durable store takes over.

const DB_NAME = "neutron-openchat";
const STORE = "kv";

type Kv = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
};

type PendingValue = { deleted: true } | { deleted: false; value: unknown };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

/** A successful request is not a committed transaction: quota errors and
 * aborts can still roll it back afterwards. Resolve reads and writes only once
 * the transaction completes, including every write in a fallback promotion. */
function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    try {
      run(tx.objectStore(STORE), (value) => { result = value; });
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
      reject(error);
    }
  });
}

function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return transaction<T | undefined>(db, "readonly", (store, result) => {
    const request = store.get(key);
    request.onsuccess = () => result(request.result as T | undefined);
  });
}

let database: IDBDatabase | null = null;
const pending = new Map<string, PendingValue>();
let warned = false;
let tail: Promise<unknown> = Promise.resolve();

// Promotion must not race another operation or an older, retained Kv handle.
// Keep one facade and sequence its operations in their original call order.
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const operation = tail.then(run);
  tail = operation.catch(() => undefined);
  return operation;
}

async function ensureBackend(): Promise<void> {
  if (database) return;
  if (typeof indexedDB !== "undefined") {
    let candidate: IDBDatabase | undefined;
    try {
      candidate = await openDb();
      await read(candidate, "__probe__");
      if (pending.size > 0) {
        await transaction<void>(candidate, "readwrite", (store) => {
          for (const [key, entry] of pending) {
            if (entry.deleted) store.delete(key);
            else store.put(entry.value, key);
          }
        });
      }
      database = candidate;
      pending.clear();
      if (warned) console.log("[openchat] keystore: IndexedDB now available (durable)");
      return;
    } catch (error) {
      candidate?.close();
      if (!warned) {
        console.warn(
          "[openchat] keystore: IndexedDB unavailable — using in-memory fallback; " +
            "the session will not survive a resident restart until IDB works.",
          error,
        );
        warned = true;
      }
    }
  } else if (!warned) {
    console.warn("[openchat] keystore: no IndexedDB in this context; using in-memory fallback.");
    warned = true;
  }
}

const kv: Kv = {
  get<T>(key: string): Promise<T | undefined> {
    return serialized(async () => {
      await ensureBackend();
      if (database) return read<T>(database, key);
      const entry = pending.get(key);
      return entry && !entry.deleted ? entry.value as T : undefined;
    });
  },
  set(key, value): Promise<void> {
    return serialized(async () => {
      await ensureBackend();
      if (database) {
        await transaction<void>(database, "readwrite", (store) => { store.put(value, key); });
      } else {
        pending.set(key, { deleted: false, value });
      }
    });
  },
  del(key): Promise<void> {
    return serialized(async () => {
      await ensureBackend();
      if (database) {
        await transaction<void>(database, "readwrite", (store) => { store.delete(key); });
      } else {
        // Retain a tombstone so a sign-out during fallback cannot resurrect an
        // older durable session when access to IndexedDB returns.
        pending.set(key, { deleted: true });
      }
    });
  },
};

export async function keystore(): Promise<Kv> {
  await serialized(ensureBackend);
  return kv;
}

/** Whether the durable IndexedDB store is in use (diagnostics). */
export function keystoreIsDurable(): boolean {
  return database !== null;
}

export const KEYS = {
  sessionKeyPair: "session.keypair.v1",
  ocSession: "session.oc.v1",
  pendingEmail: "session.pending-email.v1",
} as const;
