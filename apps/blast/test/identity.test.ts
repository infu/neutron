import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import {
  blastPublicIdentity,
  loadOrCreateBlastLocalIdentity,
} from "../src/identity.ts";

describe("Blast local identity", () => {
  test("persists a non-extractable P-256 signer without exposing it publicly", async () => {
    const databaseName = uniqueDatabaseName("persist");
    try {
      const first = await loadOrCreateBlastLocalIdentity({
        databaseName,
        now: () => 1_700_000_000_000,
      });
      const restored = await loadOrCreateBlastLocalIdentity({
        databaseName,
        now: () => 1_800_000_000_000,
      });

      expect(restored.principal).toBe(first.principal);
      expect(restored.publicKeyFingerprint).toBe(first.publicKeyFingerprint);
      expect(restored.createdAt).toBe(1_700_000_000_000);
      expect(first.identity.getKeyPair().privateKey.extractable).toBe(false);
      expect(first.identity.getKeyPair().privateKey.usages).toEqual(["sign"]);
      expect(first.identity.getKeyPair().publicKey.usages).toEqual(["verify"]);
      expect(blastPublicIdentity(first)).toEqual({
        slot: 0,
        principal: first.principal,
        createdAt: 1_700_000_000_000,
        publicKeyFingerprint: first.publicKeyFingerprint,
      });
      expect("identity" in blastPublicIdentity(first)).toBe(false);
    } finally {
      await deleteDatabase(databaseName);
    }
  });

  test("serializes concurrent cold starts onto one winning slot-zero key", async () => {
    const databaseName = uniqueDatabaseName("race");
    try {
      const [left, right] = await Promise.all([
        loadOrCreateBlastLocalIdentity({
          databaseName,
          now: () => 101,
        }),
        loadOrCreateBlastLocalIdentity({
          databaseName,
          now: () => 202,
        }),
      ]);
      expect(right.principal).toBe(left.principal);
      expect(right.publicKeyFingerprint).toBe(left.publicKeyFingerprint);
      expect([101, 202]).toContain(left.createdAt);
      expect(right.createdAt).toBe(left.createdAt);
    } finally {
      await deleteDatabase(databaseName);
    }
  });

  test("durably commits the winning key before returning the signer", async () => {
    const databaseName = uniqueDatabaseName("strict-durability");
    const observed: IDBTransactionDurability[] = [];
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
        const transaction = Reflect.apply(original, this, arguments) as IDBTransaction;
        if (transaction.mode === "readwrite") observed.push(transaction.durability);
        return transaction;
      },
    });
    try {
      await loadOrCreateBlastLocalIdentity({ databaseName, now: () => 404 });
    } finally {
      Object.defineProperty(IDBDatabase.prototype, "transaction", descriptor);
      await deleteDatabase(databaseName);
    }
    expect(observed).toEqual(["strict"]);
  });

  test("rederives and rejects tampered public identity evidence", async () => {
    const databaseName = uniqueDatabaseName("tamper");
    try {
      await loadOrCreateBlastLocalIdentity({ databaseName, now: () => 303 });
      const database = await openDatabase(databaseName);
      try {
        const transaction = database.transaction("keys", "readwrite");
        const store = transaction.objectStore("keys");
        const record = await requestResult<Record<string, unknown>>(
          store.get(0),
        );
        record.fingerprint = "ff".repeat(32);
        store.put(record);
        await transactionDone(transaction);
      } finally {
        database.close();
      }
      await expect(
        loadOrCreateBlastLocalIdentity({ databaseName }),
      ).rejects.toThrow("evidence does not match");
    } finally {
      await deleteDatabase(databaseName);
    }
  });

  test("rejects stored P-256 private and public keys that do not match", async () => {
    const databaseName = uniqueDatabaseName("mismatched-key-pair");
    const otherDatabaseName = uniqueDatabaseName("other-key-pair");
    try {
      const identity = await loadOrCreateBlastLocalIdentity({
        databaseName,
        now: () => 505,
      });
      const otherIdentity = await loadOrCreateBlastLocalIdentity({
        databaseName: otherDatabaseName,
        now: () => 606,
      });
      const database = await openDatabase(databaseName);
      try {
        const transaction = database.transaction("keys", "readwrite");
        const store = transaction.objectStore("keys");
        const record = await requestResult<Record<string, unknown>>(
          store.get(0),
        );
        record.keyPair = {
          privateKey: otherIdentity.identity.getKeyPair().privateKey,
          publicKey: identity.identity.getKeyPair().publicKey,
        } satisfies CryptoKeyPair;
        store.put(record);
        await transactionDone(transaction);
      } finally {
        database.close();
      }

      await expect(
        loadOrCreateBlastLocalIdentity({ databaseName }),
      ).rejects.toThrow("private/public keys do not match");
    } finally {
      await Promise.all([
        deleteDatabase(databaseName),
        deleteDatabase(otherDatabaseName),
      ]);
    }
  });
});

function uniqueDatabaseName(label: string): string {
  return `blast-test-${label}-${crypto.randomUUID()}`;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion blocked"));
  });
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
