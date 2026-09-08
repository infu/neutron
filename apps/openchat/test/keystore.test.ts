import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const originalPut = IDBObjectStore.prototype.put;
const originalDelete = IDBObjectStore.prototype.delete;
let nextModule = 0;

function setIndexedDb(value: IDBFactory | undefined) {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value });
}

async function freshStore() {
  return import(`../src/oc/keystore.ts?storage-test=${++nextModule}`);
}

beforeEach(() => { setIndexedDb(new IDBFactory()); });
afterEach(() => {
  IDBObjectStore.prototype.put = originalPut;
  IDBObjectStore.prototype.delete = originalDelete;
  if (originalIndexedDb) Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});

async function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open("neutron-openchat", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("kv"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saved(factory: IDBFactory, key: string): Promise<unknown> {
  const db = await open(factory);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const request = tx.objectStore("kv").get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

test("write acknowledgement waits for the IndexedDB transaction to commit", async () => {
  const module = await freshStore();
  const kv = await module.keystore();
  let committed = false;
  IDBObjectStore.prototype.put = function (value, key) {
    this.transaction.addEventListener("complete", () => { committed = true; });
    return originalPut.call(this, value, key);
  };
  await kv.set(module.KEYS.ocSession, { profile: "owner" });
  expect(committed).toBe(true);
  expect(await kv.get(module.KEYS.ocSession)).toEqual({ profile: "owner" });
});

test("a write that succeeds before an abort rejects and preserves the committed session", async () => {
  const module = await freshStore();
  const kv = await module.keystore();
  await kv.set(module.KEYS.ocSession, { profile: "original" });
  IDBObjectStore.prototype.put = function (value, key) {
    const request = originalPut.call(this, value, key);
    request.addEventListener("success", () => { this.transaction.abort(); });
    return request;
  };
  await expect(kv.set(module.KEYS.ocSession, { profile: "replacement" })).rejects.toThrow("aborted");
  expect(await kv.get(module.KEYS.ocSession)).toEqual({ profile: "original" });
  expect(module.keystoreIsDurable()).toBe(true);
});

test("an aborted deletion is not reported as a successful sign-out", async () => {
  const module = await freshStore();
  const kv = await module.keystore();
  await kv.set(module.KEYS.ocSession, { profile: "owner" });
  IDBObjectStore.prototype.delete = function (key) {
    const request = originalDelete.call(this, key);
    request.addEventListener("success", () => { this.transaction.abort(); });
    return request;
  };
  await expect(kv.del(module.KEYS.ocSession)).rejects.toThrow("aborted");
  expect(await kv.get(module.KEYS.ocSession)).toEqual({ profile: "owner" });
});

test("fallback keypair, session and pending email move together into the existing database", async () => {
  setIndexedDb(undefined);
  const module = await freshStore();
  const kv = await module.keystore();
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"],
  );
  const session = { profile: { ocPrincipal: "aaaaa-aa" }, expirationMs: 12345 };
  const email = { email: "owner@example.test", expiration: 12345n, userKey: new Uint8Array([1, 2]) };
  await kv.set(module.KEYS.sessionKeyPair, keyPair);
  await kv.set(module.KEYS.ocSession, session);
  await kv.set(module.KEYS.pendingEmail, email);
  expect(module.keystoreIsDurable()).toBe(false);

  const factory = new IDBFactory();
  setIndexedDb(factory);
  expect(await module.keystore()).toBe(kv);
  expect(module.keystoreIsDurable()).toBe(true);
  expect(await saved(factory, module.KEYS.ocSession)).toEqual(session);
  expect(await saved(factory, module.KEYS.pendingEmail)).toEqual(email);
  const storedPair = await saved(factory, module.KEYS.sessionKeyPair) as CryptoKeyPair;
  expect(storedPair.privateKey.extractable).toBe(false);
  expect(new Uint8Array(await crypto.subtle.exportKey("spki", storedPair.publicKey))).toEqual(
    new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey)),
  );
  await kv.set(module.KEYS.ocSession, { ...session, expirationMs: 56789 });
  expect(await saved(factory, module.KEYS.ocSession)).toEqual({ ...session, expirationMs: 56789 });
});

test("sign-out during fallback deletes the old durable session when storage returns", async () => {
  const factory = new IDBFactory();
  setIndexedDb(factory);
  const oldModule = await freshStore();
  const oldKv = await oldModule.keystore();
  await oldKv.set(oldModule.KEYS.ocSession, { profile: "old login" });
  await oldKv.set(oldModule.KEYS.pendingEmail, { code: "old challenge" });
  await oldKv.set("unrelated", "preserve");

  setIndexedDb(undefined);
  const module = await freshStore();
  const kv = await module.keystore();
  await kv.del(module.KEYS.ocSession);
  await kv.del(module.KEYS.pendingEmail);
  setIndexedDb(factory);
  expect(await kv.get(module.KEYS.ocSession)).toBeUndefined();
  expect(await saved(factory, module.KEYS.ocSession)).toBeUndefined();
  expect(await saved(factory, module.KEYS.pendingEmail)).toBeUndefined();
  expect(await saved(factory, "unrelated")).toBe("preserve");
});

test("failed promotion leaves all fallback values intact and never commits a mixed key/session", async () => {
  const factory = new IDBFactory();
  setIndexedDb(factory);
  const original = await freshStore();
  const originalKv = await original.keystore();
  await originalKv.set(original.KEYS.sessionKeyPair, "old key");
  await originalKv.set(original.KEYS.ocSession, "old session");

  setIndexedDb(undefined);
  const module = await freshStore();
  const kv = await module.keystore();
  await kv.set(module.KEYS.sessionKeyPair, "new key");
  await kv.set(module.KEYS.ocSession, "new session");
  IDBObjectStore.prototype.put = function (value, key) {
    const request = originalPut.call(this, value, key);
    if (key === module.KEYS.ocSession) {
      request.addEventListener("success", () => { this.transaction.abort(); });
    }
    return request;
  };
  setIndexedDb(factory);
  await module.keystore();
  expect(module.keystoreIsDurable()).toBe(false);
  expect(await saved(factory, module.KEYS.sessionKeyPair)).toBe("old key");
  expect(await saved(factory, module.KEYS.ocSession)).toBe("old session");
  expect(await kv.get(module.KEYS.sessionKeyPair)).toBe("new key");
  expect(await kv.get(module.KEYS.ocSession)).toBe("new session");

  IDBObjectStore.prototype.put = originalPut;
  expect(await kv.get(module.KEYS.ocSession)).toBe("new session");
  expect(module.keystoreIsDurable()).toBe(true);
  expect(await saved(factory, module.KEYS.sessionKeyPair)).toBe("new key");
  expect(await saved(factory, module.KEYS.ocSession)).toBe("new session");
});

test("overlapping operations retain ordering across fallback promotion", async () => {
  setIndexedDb(undefined);
  const module = await freshStore();
  const firstHandle = await module.keystore();
  await firstHandle.set(module.KEYS.ocSession, "initial");
  const factory = new IDBFactory();
  setIndexedDb(factory);
  const promotion = module.keystore();
  const updated = firstHandle.set(module.KEYS.ocSession, "updated");
  const removed = firstHandle.del(module.KEYS.ocSession);
  const observed = firstHandle.get(module.KEYS.ocSession);
  expect(await promotion).toBe(firstHandle);
  await Promise.all([updated, removed]);
  expect(await observed).toBeUndefined();
  expect(await saved(factory, module.KEYS.ocSession)).toBeUndefined();
});
