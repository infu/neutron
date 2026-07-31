import { expect, test } from "bun:test";
import {
  BROWSER_SECRET_CACHE_MAX_RECORDS,
  BROWSER_SECRET_CACHE_MAX_TTL_MS,
  createBrowserSecretCache,
} from "../src/browser_secret_cache.ts";

const NOW = 1_800_000_000_000;

test("browser secret cache is bounded and fails soft without browser storage", async () => {
  expect(BROWSER_SECRET_CACHE_MAX_RECORDS).toBe(8);
  expect(BROWSER_SECRET_CACHE_MAX_TTL_MS).toBe(7 * 24 * 60 * 60 * 1_000);

  const cache = createBrowserSecretCache({
    crypto: null,
    indexedDB: null,
    now: () => NOW,
  });
  const key = {
    id: "mailbox:1",
    binding: Uint8Array.of(1, 2, 3),
  };
  const secret = new Uint8Array(48).fill(7);
  await expect(cache.get(key)).resolves.toBeNull();
  await expect(cache.put({
    ...key,
    secret,
    expiresAtMs: NOW + BROWSER_SECRET_CACHE_MAX_TTL_MS,
  })).resolves.toBe(false);
  expect(secret).toEqual(new Uint8Array(48).fill(7));
  await expect(cache.prune([key])).resolves.toBeUndefined();
  cache.close();
  await expect(cache.get(key)).resolves.toBeNull();
});

test("browser secret cache rejects ambiguous keys and overlong absolute TTLs before storage", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens += 1;
      throw new Error("must not open");
    },
  } as unknown as IDBFactory;
  const cache = createBrowserSecretCache({
    indexedDB: factory,
    now: () => NOW,
  });

  await expect(cache.get({
    id: "contains whitespace",
    binding: Uint8Array.of(1),
  })).resolves.toBeNull();
  await expect(cache.get({
    id: "a".repeat(161),
    binding: Uint8Array.of(1),
  })).resolves.toBeNull();
  await expect(cache.put({
    id: "files-vault:1",
    binding: Uint8Array.of(1),
    secret: Uint8Array.of(2),
    expiresAtMs: NOW + BROWSER_SECRET_CACHE_MAX_TTL_MS + 1,
  })).resolves.toBe(false);
  await expect(cache.put({
    id: "files-vault:1",
    binding: new Uint8Array(),
    secret: Uint8Array.of(2),
    expiresAtMs: NOW + 1,
  })).resolves.toBe(false);
  expect(opens).toBe(0);
  cache.close();
});

test("browser secret cache has a dedicated package subpath", async () => {
  const manifest = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  expect(manifest.exports).toMatchObject({
    "./browser_secret_cache": "./src/browser_secret_cache.ts",
    "./browser_secret_cache.js": "./src/browser_secret_cache.ts",
  });
});

test("transient IndexedDB open failures are retried without losing single-flight state", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens += 1;
      throw new Error("temporarily unavailable");
    },
  } as unknown as IDBFactory;
  const cache = createBrowserSecretCache({
    indexedDB: factory,
    now: () => NOW,
  });
  const key = {
    id: "retryable:1",
    binding: Uint8Array.of(1),
  };

  await expect(cache.get(key)).resolves.toBeNull();
  await expect(cache.get(key)).resolves.toBeNull();
  expect(opens).toBe(2);
  cache.close();
});
