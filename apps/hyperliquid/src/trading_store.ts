/** Device-local durable trading journal. It never contains a private signing key. */
export interface TradingBinding {
  walletAddress: string;
  installationId: string;
  environment: "mainnet" | "testnet";
}
export interface TradingCaller { appId: string; installationUid: string; role: string }
export interface JournalRecord {
  key: string;
  scope: string;
  operationId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  [field: string]: unknown;
}
export interface TradingStore {
  get(key: string): Promise<JournalRecord | undefined>;
  add(record: JournalRecord): Promise<void>;
  update(record: JournalRecord, expectedRevision: number): Promise<void>;
  list(scope: string): Promise<JournalRecord[]>;
  listBinding(binding: TradingBinding): Promise<JournalRecord[]>;
  nextNonce(signerScope: string, now: number): Promise<number>;
}

function validateBinding(binding: TradingBinding): void {
  if (!/^0x[0-9a-f]{40}$/i.test(binding.walletAddress)) throw new Error("Invalid wallet address");
  if (!binding.installationId) throw new Error("Authenticated installation is required");
  if (binding.environment !== "mainnet" && binding.environment !== "testnet") throw new Error("Invalid Hyperliquid environment");
}

type ScopeParts = [TradingBinding["environment"], string, string, string, string, string];
function parseScope(scope: string): ScopeParts | undefined {
  try {
    const parts: unknown = JSON.parse(scope);
    if (!Array.isArray(parts) || parts.length !== 6 || !parts.every(part => typeof part === "string" && part.length > 0)) return undefined;
    if ((parts[0] !== "mainnet" && parts[0] !== "testnet") || !/^0x[0-9a-f]{40}$/i.test(parts[1])) return undefined;
    return parts as ScopeParts;
  } catch { return undefined; }
}

export function tradingCallerFromScope(scope: string): TradingCaller {
  const parts = parseScope(scope);
  if (!parts) throw new Error("Invalid trading journal scope");
  return { appId: parts[3], installationUid: parts[4], role: parts[5] };
}

function belongsToBinding(record: JournalRecord, binding: TradingBinding): boolean {
  const parts = parseScope(record.scope);
  return parts !== undefined && parts[0] === binding.environment && parts[1].toLowerCase() === binding.walletAddress.toLowerCase() && parts[2] === binding.installationId;
}

export function tradingScope(binding: TradingBinding, caller: TradingCaller): string {
  validateBinding(binding);
  if (!caller.appId || !caller.installationUid || !caller.role) throw new Error("Authenticated installation and caller are required");
  return JSON.stringify([binding.environment, binding.walletAddress.toLowerCase(), binding.installationId, caller.appId, caller.installationUid, caller.role]);
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("Persistent browser storage is required for trading"));
    const request = indexedDB.open("neutron-hyperliquid-trading-v1", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("operations", { keyPath: "key" }).createIndex("scope", "scope");
      db.createObjectStore("nonces");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Close another outdated Hyperliquid window to open trading storage")); };
  });
  return database;
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Trading storage transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Trading storage transaction failed"));
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedTradingStore implements TradingStore {
  async get(key: string): Promise<JournalRecord | undefined> {
    const db = await openDatabase();
    return result(db.transaction("operations").objectStore("operations").get(key));
  }
  async add(record: JournalRecord): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction("operations", "readwrite");
    const done = complete(tx);
    tx.objectStore("operations").add(structuredClone(record));
    await done;
  }
  async update(record: JournalRecord, expectedRevision: number): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction("operations", "readwrite");
    const done = complete(tx);
    let conflict = false;
    const store = tx.objectStore("operations");
    const request = store.get(record.key);
    request.onsuccess = () => {
      const existing = request.result as JournalRecord | undefined;
      if (!existing || existing.revision !== expectedRevision) { conflict = true; tx.abort(); return; }
      if (record.revision !== expectedRevision + 1 || record.scope !== existing.scope || record.operationId !== existing.operationId) { conflict = true; tx.abort(); return; }
      store.put(structuredClone(record));
    };
    try { await done; } catch (error) { if (conflict) throw new Error("Trading operation changed in another window; reload its status"); throw error; }
  }
  async list(scope: string): Promise<JournalRecord[]> {
    const db = await openDatabase();
    return result(db.transaction("operations").objectStore("operations").index("scope").getAll(scope));
  }
  async listBinding(binding: TradingBinding): Promise<JournalRecord[]> {
    validateBinding(binding);
    const db = await openDatabase();
    const records = await result<JournalRecord[]>(db.transaction("operations").objectStore("operations").getAll());
    return records.filter(record => belongsToBinding(record, binding));
  }
  async nextNonce(signerScope: string, now: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid signing time");
    const db = await openDatabase();
    const tx = db.transaction("nonces", "readwrite");
    const done = complete(tx);
    let nonce = 0;
    const store = tx.objectStore("nonces");
    const request = store.get(signerScope);
    request.onsuccess = () => {
      nonce = Math.max(now, Number(request.result ?? 0) + 1);
      if (!Number.isSafeInteger(nonce)) { tx.abort(); return; }
      store.put(nonce, signerScope);
    };
    await done;
    return nonce;
  }
}

/** Master-signed funding and API-key lifecycle actions share this atomic nonce sequence. */
export function nextTradingMasterNonce(binding: Pick<TradingBinding, "walletAddress" | "environment">): Promise<number> {
  if (!/^0x[0-9a-f]{40}$/i.test(binding.walletAddress)) throw new Error("Invalid master wallet address");
  return new IndexedTradingStore().nextNonce(JSON.stringify(["master", binding.environment, binding.walletAddress.toLowerCase()]), Date.now());
}

const locks = new Map<string, Promise<unknown>>();
/** Web Locks spans resident tabs. CAS + atomic nonce allocation also defend fallback callers. */
export async function withTradingLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request(`hyperliquid:${key}`, run);
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}

/** Deterministic injectable store for recovery tests and non-browser protocol verification. */
export class MemoryTradingStore implements TradingStore {
  private records = new Map<string, JournalRecord>();
  private nonces = new Map<string, number>();
  async get(key: string) { const value = this.records.get(key); return value ? structuredClone(value) : undefined; }
  async add(record: JournalRecord) { if (this.records.has(record.key)) throw new Error("Operation already exists"); this.records.set(record.key, structuredClone(record)); }
  async update(record: JournalRecord, expectedRevision: number) {
    const previous = this.records.get(record.key);
    if (!previous || previous.revision !== expectedRevision || record.revision !== expectedRevision + 1 || previous.scope !== record.scope) throw new Error("Trading operation revision conflict");
    this.records.set(record.key, structuredClone(record));
  }
  async list(scope: string) { return [...this.records.values()].filter(value => value.scope === scope).map(value => structuredClone(value)); }
  async listBinding(binding: TradingBinding) {
    validateBinding(binding);
    return [...this.records.values()].filter(value => belongsToBinding(value, binding)).map(value => structuredClone(value));
  }
  async nextNonce(scope: string, now: number) { const next = Math.max(now, (this.nonces.get(scope) ?? 0) + 1); this.nonces.set(scope, next); return next; }
}
