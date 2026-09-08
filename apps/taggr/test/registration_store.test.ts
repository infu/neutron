import { describe, expect, test } from "bun:test";
import {
  loadRegistrationFunding,
  removeRegistrationFunding,
  saveRegistrationFunding,
  RegistrationFundingStorageError,
  type RegistrationFundingRecord,
  type RegistrationFundingScope,
} from "../src/registration_store.ts";
import { createFundingRequest, invoiceAccountText } from "../src/wallet.ts";

const scope: RegistrationFundingScope = {
  taggrCanister: "6qfxa-ryaaa-aaaai-qbhsq-cai",
  principal: "jjrmb-teli6-dar7d-kr2rx-zm5ax-hh35n-u2ybm-tfjsa-v5rk4-l7gjh-eae",
};

const record = (idByte = 0xab): RegistrationFundingRecord => ({
  version: 1,
  request: createFundingRequest({
    to: invoiceAccountText(scope),
    amountAtoms: "1234567",
    // An expired request must survive reload: its outcome may already exist.
    nowMs: 1_700_000_000_000,
    fillRandomValues: (bytes) => bytes.fill(idByte),
  }),
  status: "requested",
  blockIndex: null,
});

class MemoryStorage {
  constructor(readonly data = new Map<string, string>()) {}
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

describe("registration funding journal", () => {
  test("a fresh installation has no pending payment", () => {
    const storage = new MemoryStorage();
    expect(loadRegistrationFunding(scope, storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  test("restores the exact expired request after reconstructing the storage client", () => {
    const firstStorage = new MemoryStorage();
    const requested = record();
    requested.request.route.memoHex = "00ab";
    const exactRequest = JSON.stringify(requested.request);
    saveRegistrationFunding(scope, requested, firstStorage);
    // A fresh API call with a new storage facade reads the persisted bytes;
    // there is no process-local cache that could hide a dropped write.
    const reloadedStorage = new MemoryStorage(firstStorage.data);
    const restored = loadRegistrationFunding(scope, reloadedStorage);
    expect(restored).toEqual(requested);
    expect(JSON.stringify(restored?.request)).toBe(exactRequest);
    expect(BigInt(restored!.request.validUntilNs)).toBeLessThan(BigInt(Date.now()) * 1_000_000n);
  });

  test("keeps independent deployment and identity journals", () => {
    const storage = new MemoryStorage();
    const otherDeployment = { ...scope, taggrCanister: "ryjl3-tyaaa-aaaaa-aaaba-cai" };
    const otherIdentity = { ...scope, principal: "2vxsx-fae" };
    saveRegistrationFunding(scope, record(), storage);
    expect(loadRegistrationFunding(otherDeployment, storage)).toBeNull();
    expect(loadRegistrationFunding(otherIdentity, storage)).toBeNull();
    const secondRecord = record(0xcd);
    secondRecord.request.route.to = invoiceAccountText(otherIdentity);
    saveRegistrationFunding(otherIdentity, secondRecord, storage);
    expect(loadRegistrationFunding(scope, storage)?.request.requestId).toBe("ab".repeat(16));
    expect(loadRegistrationFunding(otherIdentity, storage)?.request.requestId).toBe("cd".repeat(16));
    removeRegistrationFunding(otherIdentity, storage);
    expect(loadRegistrationFunding(scope, storage)).toEqual(record());
  });

  test("refuses to replace an unresolved request even after its deadline", () => {
    const storage = new MemoryStorage();
    const first = record();
    saveRegistrationFunding(scope, first, storage);
    expect(() => saveRegistrationFunding(scope, record(0xcd), storage)).toThrow(/original registration payment must be reconciled/);
    expect(() => saveRegistrationFunding(scope, {
      ...first,
      request: { ...first.request, amountAtoms: "7654321" },
    }, storage)).toThrow(/original registration payment must be reconciled/);
    expect(loadRegistrationFunding(scope, storage)).toEqual(first);
  });

  test("known rejection permits a fresh request", () => {
    const storage = new MemoryStorage();
    const rejected = { ...record(), status: "rejected" as const };
    saveRegistrationFunding(scope, record(), storage);
    saveRegistrationFunding(scope, rejected, storage);
    expect(loadRegistrationFunding(scope, storage)).toEqual(rejected);
    const next = record(0xcd);
    saveRegistrationFunding(scope, next, storage);
    expect(loadRegistrationFunding(scope, storage)).toEqual(next);
  });

  test("preserves confirmed transfer evidence and refuses a pending or different replacement", () => {
    const storage = new MemoryStorage();
    const first = record();
    const transferred = { ...first, status: "transferred" as const, blockIndex: "900719925474099312345" };
    saveRegistrationFunding(scope, first, storage);
    saveRegistrationFunding(scope, transferred, storage);
    saveRegistrationFunding(scope, transferred, storage);
    expect(loadRegistrationFunding(scope, new MemoryStorage(storage.data))).toEqual(transferred);
    expect(() => saveRegistrationFunding(scope, first, storage)).toThrow(/confirmed registration payment cannot be replaced/);
    expect(() => saveRegistrationFunding(scope, { ...transferred, blockIndex: "1" }, storage)).toThrow(/confirmed registration payment cannot be replaced/);
    expect(() => saveRegistrationFunding(scope, record(0xcd), storage)).toThrow(/original registration payment must be reconciled/);
    expect(loadRegistrationFunding(scope, storage)).toEqual(transferred);
  });

  test("checks transferred block indices, including zero, without losing large integer precision", () => {
    const storage = new MemoryStorage();
    for (const blockIndex of [null, undefined, 1, "", "01", "-1", "1.5", "1e3"]) {
      expect(() => saveRegistrationFunding(scope, {
        ...record(), status: "transferred", blockIndex,
      } as RegistrationFundingRecord, storage)).toThrow(RegistrationFundingStorageError);
    }
    expect(storage.data.size).toBe(0);
    saveRegistrationFunding(scope, { ...record(), status: "transferred", blockIndex: "0" }, storage);
    expect(loadRegistrationFunding(scope, storage)?.blockIndex).toBe("0");
  });

  test("malformed stored data is retained and never treated as an empty journal", () => {
    const storage = new MemoryStorage();
    saveRegistrationFunding(scope, record(), storage);
    const key = [...storage.data.keys()][0]!;
    for (const raw of ["", "{bad", "null", "[]", "{}", JSON.stringify({ ...record(), version: 2 })]) {
      storage.data.set(key, raw);
      expect(() => loadRegistrationFunding(scope, storage)).toThrow(/saved registration payment is not readable/);
      expect(() => saveRegistrationFunding(scope, record(0xcd), storage)).toThrow(/saved registration payment is not readable/);
      expect(storage.data.get(key)).toBe(raw);
    }
  });

  test("validates every saved payment field against the Wallet request and invoice scope", () => {
    const original = record();
    const invalidRequests = [
      { ...original.request, requestId: "AB".repeat(16) },
      { ...original.request, requestId: "ab" },
      { ...original.request, ledger: "2vxsx-fae" },
      { ...original.request, amountAtoms: "0" },
      { ...original.request, amountAtoms: "01" },
      { ...original.request, amountAtoms: 42 },
      { ...original.request, validUntilNs: "-1" },
      { ...original.request, validUntilNs: "18446744073709551616" },
      { ...original.request, route: { kind: "allowance", to: original.request.route.to } },
      { ...original.request, route: { kind: "direct", to: invoiceAccountText({ ...scope, principal: "2vxsx-fae" }) } },
      { ...original.request, route: { ...original.request.route, memoHex: "zz" } },
      { ...original.request, route: { ...original.request.route, extra: true } },
      { ...original.request, secretKey: "unexpected identity material" },
    ];
    const storage = new MemoryStorage();
    saveRegistrationFunding(scope, original, storage);
    const key = [...storage.data.keys()][0]!;
    for (const request of invalidRequests) {
      const raw = JSON.stringify({ ...original, request });
      storage.data.set(key, raw);
      expect(() => loadRegistrationFunding(scope, storage)).toThrow(RegistrationFundingStorageError);
      expect(storage.data.get(key)).toBe(raw);
    }
  });

  test("does not modify identity, settings, or another application's browser records", () => {
    const storage = new MemoryStorage(new Map([
      ["taggr.identity.v1", "private identity bytes"],
      ["taggr.settings.v1", "deployment settings"],
      ["wallet.state", "wallet data"],
    ]));
    const original = [...storage.data];
    saveRegistrationFunding(scope, record(), storage);
    const paymentEntry = [...storage.data].find(([key]) => !original.some(([other]) => key === other))!;
    expect(paymentEntry[0]).toBe(`taggr.registration-funding.v1:${scope.taggrCanister}:${scope.principal}`);
    expect(paymentEntry[1]).not.toContain("private identity bytes");
    removeRegistrationFunding(scope, storage);
    expect([...storage.data]).toEqual(original);
  });

  test("a write failure stops saving before a caller may request a transfer", () => {
    const storage = new MemoryStorage();
    storage.setItem = () => { throw new Error("quota exhausted"); };
    expect(() => saveRegistrationFunding(scope, record(), storage)).toThrow(/payment could not be saved/);
    expect(storage.data.size).toBe(0);
  });

  test("readback detects storage that silently drops writes", () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {};
    expect(() => saveRegistrationFunding(scope, record(), storage)).toThrow(/payment could not be saved/);
    expect(storage.data.size).toBe(0);
  });

  test("storage read failures never masquerade as no previous request", () => {
    const storage = new MemoryStorage();
    storage.getItem = () => { throw new Error("storage blocked"); };
    expect(() => loadRegistrationFunding(scope, storage)).toThrow(/payment could not be read/);
    expect(() => saveRegistrationFunding(scope, record(), storage)).toThrow(/payment could not be read/);
    expect(storage.data.size).toBe(0);
  });

  test("a failed confirmation write leaves the original requested payment recoverable", () => {
    const storage = new MemoryStorage();
    const original = record();
    saveRegistrationFunding(scope, original, storage);
    storage.setItem = () => { throw new Error("quota exhausted"); };
    expect(() => saveRegistrationFunding(scope, {
      ...original, status: "transferred", blockIndex: "42",
    }, storage)).toThrow(/payment could not be saved/);
    expect(loadRegistrationFunding(scope, new MemoryStorage(storage.data))).toEqual(original);
  });

  test("a failed explicit removal keeps the evidence and reports the failure", () => {
    const storage = new MemoryStorage();
    saveRegistrationFunding(scope, record(), storage);
    storage.removeItem = () => {};
    expect(() => removeRegistrationFunding(scope, storage)).toThrow(/record could not be cleared/);
    expect(loadRegistrationFunding(scope, storage)).toEqual(record());
  });
});
