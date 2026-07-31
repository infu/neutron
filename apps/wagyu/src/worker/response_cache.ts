import { readBoundedResponseBody } from "../transport/bounded_response.ts";

const IMMUTABLE_PATH =
  /^\/app\/wagyu\/_route\/protocol\/v1\/objects\/(post|share|tombstone|like|like-batch)\/sha256\/[0-9a-f]{64}$/u;
const MAX_CACHE_ENTRIES = 256;
const MAX_ACTIVE_RESPONSES = 32;
const MAX_REJECTED_PERSISTENT_RESPONSES = 32;
const IMMUTABLE_BODY_LIMITS = Object.freeze({
  post: 1_044_480,
  share: 1_048_576,
  tombstone: 1_048_576,
  like: 1_048_576,
  "like-batch": 983_040,
} as const);

export interface WagyuImmutableResponseCacheV1 {
  readonly fetch: typeof globalThis.fetch;
  commit(url: string): Promise<void>;
  discard(url: string): void;
}

interface CapturedResponse {
  readonly body: Uint8Array;
  readonly headers: Headers;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: ResponseType;
  readonly url: string;
}

interface ResponseLease {
  accepted: boolean;
  borrowers: number;
  loaded: LoadedResponse | null;
  loadSettled: boolean;
  persistPromise: Promise<void> | null;
  ready: Promise<LoadedResponse>;
}

interface LoadedResponse {
  readonly captured: CapturedResponse;
  readonly source: "network" | "persistent";
  readonly storable: boolean;
}

interface PersistentCachePolicy {
  disabled: boolean;
  readonly evictions: Map<string, Promise<void>>;
  readonly rejected: Set<string>;
}

/**
 * CacheStorage is transport reuse only. A hit is passed through the complete
 * verifier every time; neither a cached body nor a cached proof header is a
 * verification flag.
 */
export function createBrowserImmutableResponseCache(
  networkIdHex: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  cacheStorage: CacheStorage | null =
    typeof globalThis.caches === "undefined" ? null : globalThis.caches,
): WagyuImmutableResponseCacheV1 {
  if (!/^[0-9a-f]{64}$/u.test(networkIdHex)) {
    throw new Error("Immutable-cache network ID is invalid");
  }
  if (typeof fetcher !== "function") {
    throw new Error("Certified fetch is unavailable");
  }
  const storage = cacheStorage;
  const cacheName = `neutron-wagyu-certified-v1-${networkIdHex}`;
  const active = new Map<string, ResponseLease>();
  const persistentPolicy: PersistentCachePolicy = {
    disabled: false,
    evictions: new Map(),
    rejected: new Set(),
  };

  const cachedFetch = (async (input, init) => {
    const requestUrl = exactGetUrl(input, init);
    const cacheable = requestUrl !== null && isImmutableWagyuUrl(requestUrl);
    if (!cacheable || storage === null) return fetcher(input, init);

    const maximum = immutableBodyLimit(requestUrl)!;
    // commit/discard has a frozen URL-only API. Concurrent readers therefore
    // borrow one response generation for this URL; it remains active until
    // every borrower reports a terminal verification decision.
    const lease = borrowLease(
      active,
      requestUrl,
      () =>
        loadResponse(
          storage,
          cacheName,
          requestUrl,
          maximum,
          persistentPolicy,
          fetcher,
          input,
          init,
        ),
    );
    return rebuildResponse((await lease.ready).captured);
  }) as typeof globalThis.fetch;

  return {
    fetch: cachedFetch,
    async commit(url: string) {
      const lease = active.get(url);
      if (lease === undefined || storage === null) return;
      lease.accepted = true;
      // Persistence is only a transport optimization. Start it after the
      // verifier accepts the bytes, but release the active lease immediately
      // so slow CacheStorage cannot consume one of the 32 network slots.
      void ensureAcceptedResponsePersisted(
        lease,
        storage,
        cacheName,
        url,
        persistentPolicy,
      ).catch(() => {
        // A verified result remains valid when optional caching fails.
      });
      await releaseBorrower(
        active,
        url,
        lease,
        storage,
        cacheName,
        persistentPolicy,
      );
    },
    discard(url: string) {
      const lease = active.get(url);
      if (lease === undefined || storage === null) return;
      void releaseBorrower(
        active,
        url,
        lease,
        storage,
        cacheName,
        persistentPolicy,
      );
    },
  };
}

function borrowLease(
  active: Map<string, ResponseLease>,
  url: string,
  load: () => Promise<LoadedResponse>,
): ResponseLease {
  const current = active.get(url);
  if (current !== undefined) {
    current.borrowers += 1;
    return current;
  }
  if (active.size >= MAX_ACTIVE_RESPONSES) {
    throw new Error("Immutable response cache has too many active reads");
  }
  const pending = load();
  const lease: ResponseLease = {
    accepted: false,
    borrowers: 1,
    loaded: null,
    loadSettled: false,
    persistPromise: null,
    ready: pending,
  };
  lease.ready = pending.then(
    (loaded) => {
      lease.loaded = loaded;
      lease.loadSettled = true;
      return loaded;
    },
    (error: unknown) => {
      lease.loadSettled = true;
      throw error;
    },
  );
  active.set(url, lease);
  return lease;
}

async function releaseBorrower(
  active: Map<string, ResponseLease>,
  url: string,
  lease: ResponseLease,
  storage: CacheStorage,
  cacheName: string,
  persistentPolicy: PersistentCachePolicy,
): Promise<void> {
  if (active.get(url) !== lease || lease.borrowers <= 0) return;
  lease.borrowers -= 1;
  if (lease.borrowers !== 0) return;

  // Detach before awaiting the response load. A cancelled request must free
  // active capacity even when the underlying Fetch/CacheStorage operation is
  // slow or cannot be cancelled.
  if (active.get(url) !== lease) return;
  active.delete(url);

  if (!lease.loadSettled) {
    try {
      await lease.ready;
    } catch {
      // A failed network load has no persistent response to retain.
    }
  }
  if (
    lease.loaded?.source === "persistent" &&
    !lease.accepted
  ) {
    await rejectPersistentResponse(
      persistentPolicy,
      storage,
      cacheName,
      url,
    );
  }
}

async function ensureAcceptedResponsePersisted(
  lease: ResponseLease,
  storage: CacheStorage,
  cacheName: string,
  url: string,
  persistentPolicy: PersistentCachePolicy,
): Promise<void> {
  if (lease.persistPromise === null) {
    lease.persistPromise = (async () => {
      const loaded = await lease.ready;
      if (
        loaded.source === "network" &&
        loaded.storable &&
        persistentResponseIsUsable(persistentPolicy, url)
      ) {
        await persistResponse(
          storage,
          cacheName,
          url,
          loaded.captured,
        );
      }
    })();
  }
  await lease.persistPromise;
}

async function loadResponse(
  storage: CacheStorage,
  cacheName: string,
  url: string,
  maximum: number,
  persistentPolicy: PersistentCachePolicy,
  fetcher: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<LoadedResponse> {
  const persistent = persistentResponseIsUsable(persistentPolicy, url)
    ? await readPersistentResponse(
      storage,
      cacheName,
      url,
      maximum,
      persistentPolicy,
    )
    : null;
  if (persistent !== null) {
    return {
      captured: persistent,
      source: "persistent",
      storable: true,
    };
  }

  const response = await fetcher(input, init);
  if (response.status < 200 || response.status > 599) {
    cancelUnusedBody(response);
    throw new Error("Immutable certified response has an unsupported status");
  }
  const canReadBody =
    response.status === 200 &&
    !response.redirected &&
    response.type !== "opaque" &&
    response.type !== "opaqueredirect";
  const declaredLength = canReadBody
    ? cacheableContentLength(response.headers, maximum)
    : null;
  if (declaredLength === null) {
    // The verifier rejects these metadata fields before consuming a body.
    // Cancel the unused network stream and share one bounded metadata-only
    // response with every concurrent verifier for this URL.
    cancelUnusedBody(response);
    return {
      captured: captureResponse(response, new Uint8Array(0)),
      source: "network",
      storable: false,
    };
  }
  const bytes = await readBoundedResponseBody(
    response,
    declaredLength,
    "Immutable certified response",
  );
  return {
    captured: captureResponse(response, bytes),
    source: "network",
    storable: bytes.byteLength === declaredLength,
  };
}

async function readPersistentResponse(
  storage: CacheStorage,
  cacheName: string,
  url: string,
  maximum: number,
  persistentPolicy: PersistentCachePolicy,
): Promise<CapturedResponse | null> {
  try {
    const cache = await storage.open(cacheName);
    const response = await cache.match(url);
    if (response === undefined) return null;
    const declaredLength =
      response.status === 200 &&
        !response.redirected &&
        response.type !== "opaque" &&
        response.type !== "opaqueredirect"
        ? cacheableContentLength(response.headers, maximum)
        : null;
    if (declaredLength === null) {
      void rejectPersistentResponse(
        persistentPolicy,
        storage,
        cacheName,
        url,
      );
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponseBody(
        response,
        declaredLength,
        "Cached immutable certified response",
      );
    } catch {
      void rejectPersistentResponse(
        persistentPolicy,
        storage,
        cacheName,
        url,
      );
      return null;
    }
    if (bytes.byteLength !== declaredLength) {
      void rejectPersistentResponse(
        persistentPolicy,
        storage,
        cacheName,
        url,
      );
      return null;
    }
    // CacheStorage does not preserve a script-reconstructed Response URL.
    // The exact cache key is trusted here; all headers/body/proof still pass
    // through the complete verifier before any bytes are released.
    return captureResponse(response, bytes, {
      redirected: false,
      type: "default",
      url,
    });
  } catch {
    // Optional, rebuildable storage never blocks a verified network read.
    void rejectPersistentResponse(
      persistentPolicy,
      storage,
      cacheName,
      url,
    );
    return null;
  }
}

async function persistResponse(
  storage: CacheStorage,
  cacheName: string,
  url: string,
  captured: CapturedResponse,
): Promise<void> {
  const cache = await storage.open(cacheName);
  await cache.put(url, cacheResponse(captured));
  const keys = await cache.keys();
  const excess = keys.length - MAX_CACHE_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    await cache.delete(keys[index]!);
  }
}

function persistentResponseIsUsable(
  policy: PersistentCachePolicy,
  url: string,
): boolean {
  return (
    !policy.disabled &&
    !policy.rejected.has(url) &&
    !policy.evictions.has(url)
  );
}

function rejectPersistentResponse(
  policy: PersistentCachePolicy,
  storage: CacheStorage,
  cacheName: string,
  url: string,
): Promise<void> {
  if (policy.disabled) return Promise.resolve();
  const existing = policy.evictions.get(url);
  if (existing !== undefined) return existing;

  policy.rejected.add(url);
  if (
    policy.rejected.size > MAX_REJECTED_PERSISTENT_RESPONSES ||
    policy.evictions.size >= MAX_REJECTED_PERSISTENT_RESPONSES
  ) {
    // CacheStorage is only an optimization. Disabling it bounds retained
    // failed-entry keys and pending deletion bookkeeping.
    policy.disabled = true;
    policy.rejected.clear();
    return Promise.resolve();
  }

  const deletion = deletePersistentResponse(storage, cacheName, url)
    .then((deleted) => {
      if (deleted) policy.rejected.delete(url);
    })
    .finally(() => {
      if (policy.evictions.get(url) === deletion) {
        policy.evictions.delete(url);
      }
    });
  policy.evictions.set(url, deletion);
  return deletion;
}

async function deletePersistentResponse(
  storage: CacheStorage,
  cacheName: string,
  url: string,
): Promise<boolean> {
  try {
    const cache = await storage.open(cacheName);
    await cache.delete(url);
    return true;
  } catch {
    // A failed deletion leaves the key rejected in memory.
    return false;
  }
}

function cancelUnusedBody(response: Response): void {
  if (response.body === null) return;
  try {
    void response.body.cancel("Immutable response metadata was rejected")
      .catch(() => undefined);
  } catch {
    // The response is already rejected and no bytes are retained.
  }
}

function exactGetUrl(
  input: RequestInfo | URL,
  init?: RequestInit,
): string | null {
  try {
    const method = (init?.method ??
      (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return null;
    const raw =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const url = new URL(raw);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function isImmutableWagyuUrl(value: string): boolean {
  return immutableBodyLimit(value) !== null;
}

function immutableBodyLimit(value: string): number | null {
  try {
    const url = new URL(value);
    if (url.search !== "" || url.hash !== "") return null;
    const match = IMMUTABLE_PATH.exec(url.pathname);
    if (match === null) return null;
    const kind = match[1] as keyof typeof IMMUTABLE_BODY_LIMITS;
    return IMMUTABLE_BODY_LIMITS[kind];
  } catch {
    return null;
  }
}

function cacheableContentLength(
  headers: Headers,
  maximum: number,
): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function captureResponse(
  response: Response,
  bytes: Uint8Array,
  metadata: Pick<CapturedResponse, "redirected" | "type" | "url"> = response,
): CapturedResponse {
  return {
    body: bytes,
    headers: new Headers(response.headers),
    redirected: metadata.redirected,
    status: response.status,
    statusText: response.statusText,
    type: metadata.type,
    url: metadata.url,
  };
}

function cacheResponse(captured: CapturedResponse): Response {
  return new Response(
    copiedArrayBuffer(captured.body),
    responseInit(captured),
  );
}

function rebuildResponse(captured: CapturedResponse): Response {
  const noBody =
    captured.status === 204 ||
    captured.status === 205 ||
    captured.status === 304;
  const rebuilt = new Response(
    noBody ? null : copiedArrayBuffer(captured.body),
    responseInit(captured),
  );
  // A newly constructed Response has an empty URL and "default" type. Those
  // values are part of the verifier's redirect/origin checks, so preserve the
  // network response metadata as immutable own properties.
  Object.defineProperties(rebuilt, {
    redirected: {
      configurable: false,
      enumerable: true,
      value: captured.redirected,
      writable: false,
    },
    type: {
      configurable: false,
      enumerable: true,
      value: captured.type,
      writable: false,
    },
    url: {
      configurable: false,
      enumerable: true,
      value: captured.url,
      writable: false,
    },
  });
  return rebuilt;
}

function responseInit(
  response: Pick<CapturedResponse, "headers" | "status" | "statusText">,
): ResponseInit {
  return {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  };
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
