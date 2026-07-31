import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { readBoundedResponseBody } from "../src/transport/bounded_response.ts";
import {
  createBrowserImmutableResponseCache,
  createMemoryVerificationStore,
  likeHeadHighWaterKey,
  MAX_TRUSTED_RUNTIME_CONFIG_BYTES,
  profileHighWaterKey,
  readTrustedRuntimeConfigBytes,
  shareEdgeEvidenceKey,
} from "../src/worker/index.ts";

const NETWORK_A = "11".repeat(32);
const NETWORK_B = "22".repeat(32);
const NODE_A = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const NODE_B = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const POST_ID = "33".repeat(32);
const DIGEST = "44".repeat(32);

describe("Wagyu Worker persistence keys", () => {
  test("partition every high-water and result record by network, node, and object", () => {
    expect(profileHighWaterKey(NETWORK_A, NODE_A)).not.toBe(
      profileHighWaterKey(NETWORK_B, NODE_A),
    );
    expect(likeHeadHighWaterKey(NETWORK_A, NODE_A, POST_ID)).not.toBe(
      likeHeadHighWaterKey(NETWORK_A, NODE_B, POST_ID),
    );
    expect(
      shareEdgeEvidenceKey(
        NETWORK_A,
        NODE_A,
        NODE_B,
        POST_ID,
        DIGEST,
      ),
    ).not.toBe(
      shareEdgeEvidenceKey(
        NETWORK_A,
        NODE_A,
        NODE_B,
        POST_ID,
        "55".repeat(32),
      ),
    );
    expect(
      shareEdgeEvidenceKey(
        NETWORK_A,
        NODE_A,
        NODE_B,
        POST_ID,
        DIGEST,
      ),
    ).toContain(":share-edge:");
    expect(
      shareEdgeEvidenceKey(
        NETWORK_A,
        NODE_A,
        NODE_B,
        POST_ID,
        DIGEST,
      ),
    ).toContain("wagyu-verifier-v1");
  });

  test("never evicts rollback high-water when bounded storage is full", async () => {
    const storage = createMemoryVerificationStore({
      highWater: 1,
      results: 1,
    });
    const first = profileHighWaterKey(NETWORK_A, NODE_A);
    const second = profileHighWaterKey(NETWORK_A, NODE_B);
    await storage.putHighWater(first, {
      kind: "profile",
      profileGeneration: "1",
      revision: "1",
      bodyDigest: new Uint8Array(32).fill(1),
    });
    await expect(storage.putHighWater(second, {
      kind: "profile",
      profileGeneration: "1",
      revision: "2",
      bodyDigest: new Uint8Array(32).fill(2),
    })).rejects.toThrow("rollback protection cannot be weakened");
    expect(await storage.getHighWater(first)).toMatchObject({ revision: "1" });
    expect(await storage.getHighWater(second)).toBeNull();

    const firstResult = shareEdgeEvidenceKey(
      NETWORK_A,
      NODE_A,
      NODE_B,
      POST_ID,
      DIGEST,
    );
    const secondResult = shareEdgeEvidenceKey(
      NETWORK_A,
      NODE_B,
      NODE_A,
      POST_ID,
      DIGEST,
    );
    await storage.putVerifiedResult(firstResult, { marker: 1 });
    await storage.putVerifiedResult(secondResult, { marker: 2 });
    expect(await storage.getVerifiedResult(firstResult)).toBeNull();
    expect(
      await storage.getVerifiedResult<{ marker: number }>(secondResult),
    ).toEqual({ marker: 2 });
  });
});

test("CacheStorage reuses only committed immutable responses and every hit is rechecked", async () => {
  const storage = fakeCacheStorage();
  let networkReads = 0;
  let fullVerificationPasses = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    networkReads += 1;
    return new Response(Uint8Array.of(1, 2, 3), {
      status: 200,
      headers: { "content-length": "3" },
    });
  }) as typeof globalThis.fetch;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    fetcher,
    storage as unknown as CacheStorage,
  );
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${DIGEST}`;

  const rejected = await cache.fetch(immutableUrl, { method: "GET" });
  expect(await rejected.clone().arrayBuffer()).toHaveLength(3);
  cache.discard(immutableUrl);
  await cache.fetch(immutableUrl, { method: "GET" });
  cache.discard(immutableUrl);
  expect(networkReads).toBe(2);

  const verifyAndCommit = async (response: Response) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    fullVerificationPasses += 1;
    await cache.commit(immutableUrl);
  };
  await verifyAndCommit(await cache.fetch(immutableUrl, { method: "GET" }));
  const cached = await cache.fetch(immutableUrl, { method: "GET" });
  expect(cached.url).toBe(immutableUrl);
  expect(cached.type).toBe("default");
  expect(cached.redirected).toBe(false);
  await verifyAndCommit(cached);

  expect(networkReads).toBe(3);
  expect(fullVerificationPasses).toBe(2);

  const mutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/profile`;
  await cache.fetch(mutableUrl, { method: "GET" });
  await cache.commit(mutableUrl);
  await cache.fetch(mutableUrl, { method: "GET" });
  expect(networkReads).toBe(5);
});

test("immutable transport staging consumes one bounded stream and never clones the network response", async () => {
  const storage = fakeCacheStorage();
  let cloneCalls = 0;
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/like/sha256/${DIGEST}`;
  const fetcher = (async () => {
    const response = new Response(Uint8Array.of(7, 8, 9), {
      status: 200,
      headers: { "content-length": "3" },
    });
    Object.defineProperty(response, "url", { value: immutableUrl });
    Object.defineProperty(response, "clone", {
      value() {
        cloneCalls += 1;
        throw new Error("network response must not be cloned");
      },
    });
    return response;
  }) as unknown as typeof globalThis.fetch;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    fetcher,
    storage as unknown as CacheStorage,
  );

  const response = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    Uint8Array.of(7, 8, 9),
  );
  expect(response.url).toBe(immutableUrl);
  expect(cloneCalls).toBe(0);
  cache.discard(immutableUrl);
});

test("immutable transport staging cancels a dishonest body at the route bound", async () => {
  const storage = fakeCacheStorage();
  const maximum = 983_040;
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(maximum));
      } else {
        controller.enqueue(Uint8Array.of(1));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = (async () =>
    new Response(stream, {
      status: 200,
      // Even the largest admissible declaration cannot bypass the route cap.
      headers: { "content-length": String(maximum) },
    })) as unknown as typeof globalThis.fetch;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    fetcher,
    storage as unknown as CacheStorage,
  );
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/like-batch/sha256/${DIGEST}`;

  await expect(cache.fetch(immutableUrl)).rejects.toThrow(
    `exceeds ${maximum} bytes`,
  );
  await Promise.resolve();
  expect(cancelled).toBe(true);
  cache.discard(immutableUrl);
});

test("immutable transport cancels without buffering a body declared over its route limit", async () => {
  const storage = fakeCacheStorage();
  let bodyCancels = 0;
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${DIGEST}`;
  const response = {
    body: {
      async cancel() {
        bodyCancels += 1;
      },
    },
    headers: new Headers({ "content-length": "1044481" }),
    redirected: false,
    status: 200,
    statusText: "",
    type: "cors",
    url: immutableUrl,
  } as unknown as Response;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    (async () => response) as unknown as typeof globalThis.fetch,
    storage as unknown as CacheStorage,
  );
  const rejected = await cache.fetch(immutableUrl);
  expect(rejected.headers.get("content-length")).toBe("1044481");
  expect(await rejected.arrayBuffer()).toHaveLength(0);
  expect(bodyCancels).toBe(1);
  cache.discard(immutableUrl);
});

test("same-URL readers share one request-bound generation", async () => {
  const storage = fakeCacheStorage();
  let networkReads = 0;
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/share/sha256/${DIGEST}`;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    (async () => {
      networkReads += 1;
      const response = new Response(Uint8Array.of(networkReads), {
        headers: { "content-length": "1" },
      });
      Object.defineProperty(response, "url", { value: immutableUrl });
      return response;
    }) as unknown as typeof globalThis.fetch,
    storage as unknown as CacheStorage,
  );

  const first = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(
    Uint8Array.of(1),
  );
  const second = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await second.arrayBuffer())).toEqual(
    Uint8Array.of(1),
  );
  expect(networkReads).toBe(1);

  await cache.commit(immutableUrl);
  await cache.commit(immutableUrl);
  expect(networkReads).toBe(1);
});

test("a canceled coalesced read cannot release another reader's generation", async () => {
  const storage = fakeCacheStorage();
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/share/sha256/${DIGEST}`;
  let releaseNetwork!: (response: Response) => void;
  const networkResponse = new Promise<Response>((resolve) => {
    releaseNetwork = resolve;
  });
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    (async () => networkResponse) as unknown as typeof globalThis.fetch,
    storage as unknown as CacheStorage,
  );

  const firstRead = cache.fetch(immutableUrl);
  const canceledRead = cache.fetch(immutableUrl);
  cache.discard(immutableUrl);
  releaseNetwork(
    new Response(Uint8Array.of(9), {
      headers: { "content-length": "1" },
    }),
  );
  const [first, canceled] = await Promise.all([firstRead, canceledRead]);
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(
    Uint8Array.of(9),
  );
  expect(new Uint8Array(await canceled.arrayBuffer())).toEqual(
    Uint8Array.of(9),
  );
  await cache.commit(immutableUrl);
  expect(storage.entries.has(immutableUrl)).toBe(true);
});

test("a rejected persistent response is evicted before the next URL lease", async () => {
  const storage = fakeCacheStorage();
  let networkReads = 0;
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/tombstone/sha256/${DIGEST}`;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    (async () => {
      networkReads += 1;
      return new Response(Uint8Array.of(networkReads), {
        headers: { "content-length": "1" },
      });
    }) as unknown as typeof globalThis.fetch,
    storage as unknown as CacheStorage,
  );

  await cache.fetch(immutableUrl);
  await cache.commit(immutableUrl);
  expect(storage.entries.has(immutableUrl)).toBe(true);

  await cache.fetch(immutableUrl);
  cache.discard(immutableUrl);
  await Promise.resolve();
  await Promise.resolve();
  expect(storage.entries.has(immutableUrl)).toBe(false);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const replacement = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await replacement.arrayBuffer())).toEqual(
    Uint8Array.of(2),
  );
  expect(networkReads).toBe(2);
  cache.discard(immutableUrl);
});

test("a new URL lease cannot accept a persistent entry while its old lease is being evicted", async () => {
  let releaseDeletion!: () => void;
  let reportDeletionStarted!: () => void;
  const deletionGate = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  const deletionStarted = new Promise<void>((resolve) => {
    reportDeletionStarted = resolve;
  });
  const storage = fakeCacheStorage({
    async deleteEntry(url, entries) {
      reportDeletionStarted();
      await deletionGate;
      return entries.delete(url);
    },
  });
  let networkReads = 0;
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/tombstone/sha256/${DIGEST}`;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    (async () => {
      networkReads += 1;
      return new Response(Uint8Array.of(networkReads), {
        headers: { "content-length": "1" },
      });
    }) as unknown as typeof globalThis.fetch,
    storage as unknown as CacheStorage,
  );

  await cache.fetch(immutableUrl);
  await cache.commit(immutableUrl);
  const persistent = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await persistent.arrayBuffer())).toEqual(
    Uint8Array.of(1),
  );
  cache.discard(immutableUrl);
  await deletionStarted;

  // The rejected persistent generation is already detached. A new reader
  // bypasses that key and receives a separately captured network generation.
  const replacement = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await replacement.arrayBuffer())).toEqual(
    Uint8Array.of(2),
  );
  expect(networkReads).toBe(2);
  await cache.commit(immutableUrl);

  releaseDeletion();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(storage.entries.has(immutableUrl)).toBe(false);

  const afterEviction = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await afterEviction.arrayBuffer())).toEqual(
    Uint8Array.of(3),
  );
  await cache.commit(immutableUrl);
  expect(storage.entries.has(immutableUrl)).toBe(true);
});

test("a failed persistent deletion is bypassed instead of being served repeatedly", async () => {
  let deleteAttempts = 0;
  const storage = fakeCacheStorage({
    async deleteEntry() {
      deleteAttempts += 1;
      throw new Error("CacheStorage deletion failed");
    },
  });
  let networkReads = 0;
  const immutableUrl =
    `https://${NODE_A}.icp0.io/app/wagyu/_route/protocol/v1/objects/tombstone/sha256/${DIGEST}`;
  const cache = createBrowserImmutableResponseCache(
    NETWORK_A,
    (async () => {
      networkReads += 1;
      return new Response(Uint8Array.of(networkReads), {
        headers: { "content-length": "1" },
      });
    }) as unknown as typeof globalThis.fetch,
    storage as unknown as CacheStorage,
  );

  await cache.fetch(immutableUrl);
  await cache.commit(immutableUrl);
  await cache.fetch(immutableUrl);
  cache.discard(immutableUrl);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const replacement = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await replacement.arrayBuffer())).toEqual(
    Uint8Array.of(2),
  );
  cache.discard(immutableUrl);
  const nextReplacement = await cache.fetch(immutableUrl);
  expect(new Uint8Array(await nextReplacement.arrayBuffer())).toEqual(
    Uint8Array.of(3),
  );
  cache.discard(immutableUrl);
  expect(deleteAttempts).toBe(1);
  expect(networkReads).toBe(3);
});

describe("trusted runtime response bounds", () => {
  test("rejects an oversized declaration before touching the body", async () => {
    let bodyReads = 0;
    const response = {
      headers: new Headers({ "content-length": "4097" }),
      get body() {
        bodyReads += 1;
        throw new Error("body must not be read");
      },
    } as unknown as Response;

    await expect(readTrustedRuntimeConfigBytes(response)).rejects.toThrow(
      "invalid size",
    );
    expect(bodyReads).toBe(0);
  });

  test("bounds a missing or dishonest Content-Length while streaming", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4_096));
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": "1" } },
    );

    await expect(readTrustedRuntimeConfigBytes(response)).rejects.toThrow(
      "invalid size",
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("returns a non-empty bounded runtime file", async () => {
    const response = new Response(Uint8Array.of(1, 2, 3, 4), {
      headers: { "content-length": "4" },
    });
    expect(await readTrustedRuntimeConfigBytes(response)).toEqual(
      Uint8Array.of(1, 2, 3, 4),
    );
  });

  test("bounds the decoded body without trusting a shorter wire Content-Length", async () => {
    const response = new Response(Uint8Array.of(1, 2, 3, 4), {
      headers: { "content-length": "2" },
    });
    expect(await readTrustedRuntimeConfigBytes(response)).toEqual(
      Uint8Array.of(1, 2, 3, 4),
    );

    const oversized = new Response(
      new Uint8Array(MAX_TRUSTED_RUNTIME_CONFIG_BYTES + 1),
      {
        headers: { "content-length": "2" },
      },
    );
    await expect(readTrustedRuntimeConfigBytes(oversized)).rejects.toThrow(
      "invalid size",
    );
  });
});

test("bounded stream reads cap zero-length and tiny-chunk amplification", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(0));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(
    readBoundedResponseBody(response, 4, "Amplified response"),
  ).rejects.toThrow("too many stream chunks");
  await Promise.resolve();
  expect(cancelled).toBe(true);
});

test("browser storage implementation uses isolated IndexedDB stores and CacheStorage is transport-only", async () => {
  const [storageSource, cacheSource] = await Promise.all([
    readFile(new URL("../src/worker/storage.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/worker/response_cache.ts", import.meta.url),
      "utf8",
    ),
  ]);
  expect(storageSource).toContain(
    'const DATABASE_NAME = "neutron-wagyu-verification-v1"',
  );
  expect(storageSource).toContain('const HIGH_WATER_STORE = "high_water"');
  expect(storageSource).toContain(
    'const RESULT_STORE = "verified_results"',
  );
  expect(cacheSource).toContain(
    "A hit is passed through the complete",
  );
  expect(cacheSource).not.toContain("response.clone()");
  expect(cacheSource).not.toContain("state: \"verified\"");
});

test("both trusted runtime loaders apply the stream bound before decoding", async () => {
  const [workerSource, tileSource] = await Promise.all([
    readFile(new URL("../src/worker/trust.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/service_adapter.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of [workerSource, tileSource]) {
    expect(source).toContain(
      "await readTrustedRuntimeConfigBytes(response)",
    );
    expect(source).not.toContain(
      "new Uint8Array(await response.arrayBuffer())",
    );
    expect(source).toContain("response.url !== configUrl.href");
  }
});

interface FakeCacheStorageOptions {
  deleteEntry?(
    url: string,
    entries: Map<string, Response>,
  ): Promise<boolean>;
}

function fakeCacheStorage(options: FakeCacheStorageOptions = {}) {
  const entries = new Map<string, Response>();
  const cache = {
    async match(request: RequestInfo | URL) {
      const value = entries.get(urlText(request));
      return value?.clone();
    },
    async put(request: RequestInfo | URL, response: Response) {
      entries.set(urlText(request), response.clone());
    },
    async keys() {
      return [...entries.keys()].map((url) => new Request(url));
    },
    async delete(request: RequestInfo | URL) {
      const url = urlText(request);
      return options.deleteEntry === undefined
        ? entries.delete(url)
        : options.deleteEntry(url, entries);
    },
  };
  return {
    entries,
    async open() {
      return cache;
    },
  };
}

function urlText(value: RequestInfo | URL): string {
  if (value instanceof Request) return value.url;
  return value instanceof URL ? value.href : value;
}
