/**
 * The cache that turns a 30-second start into an instant one.
 *
 * Two things make it easy to get wrong. Token supplies are `bigint` and JSON
 * has no representation for them, so an unguarded round trip either throws or
 * silently degrades to a string. And `localStorage` is shared with every other
 * app on the Neutron origin, so an unbounded cache is not merely wasteful — it
 * can push other apps over quota.
 */

import { beforeEach, expect, test } from "bun:test";
import { readCachedRegistry, writeCachedRegistry } from "../src/data/registry_cache";
import type { Registry, RegistryEntry } from "../src/data/registry";

const KEY = "snsgov.registry.v1";

class MemoryStorage {
  store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

function entry(root: string, logoBytes = 0): RegistryEntry {
  return {
    canisters: { root, governance: `${root}-gov`, ledger: `${root}-led`, swap: null, index: null },
    liveness: { governance: true, ledger: true },
    // Past Number.MAX_SAFE_INTEGER: 40 of 54 real supplies are.
    token: { name: "T", symbol: "T", decimals: 8, totalSupply: 9_007_199_254_740_993n },
    metadata: {
      name: root,
      ...(logoBytes > 0 ? { logo: `data:image/png;base64,${"A".repeat(logoBytes)}` } : {}),
    },
    lifecycle: {},
    fetchedAt: 0,
  } as unknown as RegistryEntry;
}

function registry(entries: RegistryEntry[], fetchedAt = Date.now()): Registry {
  return {
    entries,
    byRoot: new Map(entries.map((row) => [row.canisters.root, row])),
    fetchedAt,
  };
}

test("a bigint supply survives the round trip exactly", () => {
  const written = registry([entry("a")]);
  writeCachedRegistry(written);
  const read = readCachedRegistry();
  const supply = read!.entries[0]!.token!.totalSupply;
  expect(typeof supply).toBe("bigint");
  expect(supply).toBe(9_007_199_254_740_993n);
  // The `Map` is rebuilt, not stored — it has no JSON form either.
  expect(read!.byRoot.get("a")).toBeDefined();
});

// Names, symbols and canister ids do not change, and an SNS winding down is a
// once-a-year event, so a month-old list is still the right thing to paint
// while the real one loads. A one-day limit meant anyone opening the app less
// often than daily paid the twenty-second build every time.
test("a month-old cache is still offered; an older one is not", () => {
  const day = 24 * 60 * 60 * 1000;
  writeCachedRegistry(registry([entry("a")], Date.now() - 20 * day));
  expect(readCachedRegistry()?.entries.length).toBe(1);

  writeCachedRegistry(registry([entry("a")], Date.now() - 31 * day));
  expect(readCachedRegistry()).toBeUndefined();
});

// A provisional list has placeholder liveness; storing it would show sixteen
// wound-down DAOs as active on the next open with nothing to correct them.
test("a provisional registry is never stored", () => {
  writeCachedRegistry({ ...registry([entry("a")]), livenessKnown: false });
  expect(readCachedRegistry()).toBeUndefined();
});

test("corrupt or foreign content is discarded, not retried forever", () => {
  storage.setItem(KEY, "{not json");
  expect(readCachedRegistry()).toBeUndefined();
  expect(storage.getItem(KEY)).toBeNull();

  storage.setItem(KEY, JSON.stringify({ version: 99, fetchedAt: Date.now(), entries: [{}] }));
  expect(readCachedRegistry()).toBeUndefined();
});

// A stored row whose shape drifted between builds would break the whole list.
test("entries missing the key everything is keyed on are rejected", () => {
  storage.setItem(
    KEY,
    JSON.stringify({ version: 1, fetchedAt: Date.now(), entries: [{ canisters: {} }] }),
  );
  expect(readCachedRegistry()).toBeUndefined();
});

// Logos are ~99% of the payload: 3 MB with them, 33 KB without.
test("the cache stays within budget by dropping the most expensive logos", () => {
  const entries = [
    entry("small-1", 4_000),
    entry("small-2", 4_000),
    entry("huge-1", 900_000),
    entry("huge-2", 900_000),
  ];
  writeCachedRegistry(registry(entries));

  const stored = storage.getItem(KEY)!;
  expect(stored.length).toBeLessThan(600_000);

  const read = readCachedRegistry()!;
  const kept = read.entries.filter((row) => row.metadata?.logo !== undefined);
  // The cheap ones are kept so most rows still show a real logo instantly.
  expect(kept.map((row) => row.canisters.root).sort()).toEqual(["small-1", "small-2"]);
  // Every row is still present — only the logo is dropped.
  expect(read.entries.length).toBe(4);
});

test("a registry small enough to fit keeps every logo", () => {
  writeCachedRegistry(registry([entry("a", 4_000), entry("b", 4_000)]));
  const read = readCachedRegistry()!;
  expect(read.entries.every((row) => row.metadata?.logo !== undefined)).toBe(true);
});

// A private window, a blocked-cookies setting, or a full quota all throw on
// access. None of them is a reason for the app to fail.
test("storage that throws is survivable in both directions", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  expect(() => writeCachedRegistry(registry([entry("a")]))).not.toThrow();
  expect(readCachedRegistry()).toBeUndefined();
});
