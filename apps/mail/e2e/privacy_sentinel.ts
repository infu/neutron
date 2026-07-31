import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import type {
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "@playwright/test";

/** Deliberately absent from every production Mail source/bundle. */
export const MAIL_PRIVACY_SENDER_NAME_SENTINEL =
  "MAIL-PRIVATE-V1-SENDER-94A01B7C6D2E8F35-NO-BACKEND-COPY";
export const MAIL_PRIVACY_SUBJECT_SENTINEL =
  "MAIL-PRIVATE-V1-SUBJECT-C17E4A902B6D8F53-NO-BACKEND-COPY";
export const MAIL_PRIVACY_BODY_SENTINEL =
  "MAIL-PRIVATE-V1-SENTINEL-7F4C9A21D6E8B305-NO-BACKEND-COPY";
/** Compatibility name retained for the focused scanner unit tests. */
export const MAIL_PRIVACY_SENTINEL = MAIL_PRIVACY_BODY_SENTINEL;
export const MAIL_PRIVACY_SENTINELS = Object.freeze([
  MAIL_PRIVACY_SENDER_NAME_SENTINEL,
  MAIL_PRIVACY_SUBJECT_SENTINEL,
  MAIL_PRIVACY_BODY_SENTINEL,
] as const);

type Needle = { label: string; bytes: Uint8Array };
type PrivacySentinelInput = string | readonly string[];

export type PrivacyNetworkEvidence = {
  requests: number;
  requestBodies: number;
  responseBodies: number;
  scannedRequestBytes: number;
  scannedResponseBytes: number;
  icApiRequests: number;
  icApiRequestBodies: number;
  icApiCallRequestBodies: number;
  icApiResponses: number;
  icApiResponseBodies: number;
  icApiQueryResponseBodies: number;
  icApiReadStateResponseBodies: number;
  certifiedHttpResponses: number;
  consoleMessages: number;
  unreadableNonIcResponses: number;
};

export type PrivacyPersistenceEvidence = {
  frames: number;
  localStorageEntries: number;
  sessionStorageEntries: number;
  indexedDatabases: number;
  indexedRecords: number;
  nonExtractableCryptoKeys: number;
  cacheEntries: number;
  inaccessibleOpaqueSurfaces: number;
  storageStateBytes: number;
};

export type PrivacySnapshotEvidence = {
  files: number;
  rawBytes: number;
  decodedBytes: number;
  wasmMemoryBytes: number;
  stableMemoryBytes: number;
};

export function privacySentinelNeedles(sentinel = MAIL_PRIVACY_SENTINEL): Needle[] {
  if (!/^[A-Z0-9-]{48,128}$/u.test(sentinel)) {
    throw new Error("Mail privacy sentinel must be 48 to 128 uppercase ASCII characters");
  }
  const utf8 = Buffer.from(sentinel, "utf8");
  const utf16le = Buffer.from(sentinel, "utf16le");
  const utf16be = Buffer.from(utf16le);
  utf16be.swap16();
  const candidates: Needle[] = [
    { label: "utf8", bytes: utf8 },
    { label: "utf16le", bytes: utf16le },
    { label: "utf16be", bytes: utf16be },
    { label: "base64", bytes: Buffer.from(utf8.toString("base64"), "ascii") },
    { label: "hex-lower", bytes: Buffer.from(utf8.toString("hex"), "ascii") },
    { label: "hex-upper", bytes: Buffer.from(utf8.toString("hex").toUpperCase(), "ascii") },
  ];
  const unique = new Map<string, Needle>();
  for (const candidate of candidates) {
    unique.set(Buffer.from(candidate.bytes).toString("hex"), candidate);
  }
  return [...unique.values()];
}

export function assertNoPrivacySentinelBytes(
  value: Uint8Array,
  surface: string,
  sentinels: PrivacySentinelInput = MAIL_PRIVACY_SENTINELS,
): void {
  for (const needle of combinedPrivacySentinelNeedles(sentinels)) {
    if (Buffer.from(value.buffer, value.byteOffset, value.byteLength).indexOf(needle.bytes) !== -1) {
      throw new Error(`Mail privacy sentinel leaked into ${surface} (${needle.label})`);
    }
  }
}

/**
 * Observe raw browser traffic rather than decoded product models. IC ingress
 * request bodies contain the exact Candid argument and query/read-state
 * response bodies contain the raw replica response. Certified HTTP headers
 * and bodies are covered by the same observer.
 */
export function monitorPrivacySentinelNetwork(
  page: Page,
  sentinels: PrivacySentinelInput = MAIL_PRIVACY_SENTINELS,
): { finish: () => Promise<PrivacyNetworkEvidence> } {
  const findings: string[] = [];
  const captureErrors: string[] = [];
  const pending = new Set<Promise<void>>();
  const evidence: PrivacyNetworkEvidence = {
    requests: 0,
    requestBodies: 0,
    responseBodies: 0,
    scannedRequestBytes: 0,
    scannedResponseBytes: 0,
    icApiRequests: 0,
    icApiRequestBodies: 0,
    icApiCallRequestBodies: 0,
    icApiResponses: 0,
    icApiResponseBodies: 0,
    icApiQueryResponseBodies: 0,
    icApiReadStateResponseBodies: 0,
    certifiedHttpResponses: 0,
    consoleMessages: 0,
    unreadableNonIcResponses: 0,
  };

  const scan = (bytes: Uint8Array, surface: string, direction: "request" | "response") => {
    if (direction === "request") evidence.scannedRequestBytes += bytes.byteLength;
    else evidence.scannedResponseBytes += bytes.byteLength;
    try {
      assertNoPrivacySentinelBytes(bytes, surface, sentinels);
    } catch (error) {
      findings.push(error instanceof Error ? error.message : String(error));
    }
  };
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const onRequest = (request: Request) => {
    evidence.requests += 1;
    const icApi = icApiKind(request.url());
    if (icApi !== null) evidence.icApiRequests += 1;
    scan(
      Buffer.from(`${request.method()} ${request.url()}\n${JSON.stringify(request.headers())}`, "utf8"),
      `browser request metadata for ${redactedUrl(request.url())}`,
      "request",
    );
    const body = request.postDataBuffer();
    if (body) {
      evidence.requestBodies += 1;
      if (icApi !== null) evidence.icApiRequestBodies += 1;
      if (icApi === "call") evidence.icApiCallRequestBodies += 1;
      scan(body, `raw browser request body for ${redactedUrl(request.url())}`, "request");
    }
  };
  const onResponse = (response: Response) => {
    const task = (async () => {
      const icApi = icApiKind(response.url());
      if (icApi !== null) evidence.icApiResponses += 1;
      const headers = await response.allHeaders();
      if (Object.keys(headers).some((name) => name.toLowerCase() === "ic-certificate")) {
        evidence.certifiedHttpResponses += 1;
      }
      scan(
        Buffer.from(`${response.status()} ${response.url()}\n${JSON.stringify(headers)}`, "utf8"),
        `browser response metadata for ${redactedUrl(response.url())}`,
        "response",
      );
      try {
        const body = await response.body();
        evidence.responseBodies += 1;
        if (icApi !== null) evidence.icApiResponseBodies += 1;
        if (icApi === "query") evidence.icApiQueryResponseBodies += 1;
        if (icApi === "read_state") evidence.icApiReadStateResponseBodies += 1;
        scan(body, `raw browser response body for ${redactedUrl(response.url())}`, "response");
      } catch (error) {
        if (icApi !== null && response.status() !== 204 && response.status() < 300) {
          captureErrors.push(
            `Could not inspect successful IC response ${redactedUrl(response.url())}: ${errorMessage(error)}`,
          );
        } else {
          evidence.unreadableNonIcResponses += 1;
        }
      }
    })().catch((error) => {
      captureErrors.push(`Response observer failed: ${errorMessage(error)}`);
    });
    track(task);
  };
  const onConsole = (message: ConsoleMessage) => {
    evidence.consoleMessages += 1;
    scan(Buffer.from(message.text(), "utf8"), "browser console output", "response");
  };
  const onPageError = (error: Error) => {
    scan(Buffer.from(error.message, "utf8"), "browser page-error output", "response");
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return {
    async finish() {
      // Let response-body callbacks already queued by Playwright register
      // before detaching this bounded observer.
      await page.waitForTimeout(50);
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      await Promise.all([...pending]);
      if (captureErrors.length > 0 || findings.length > 0) {
        throw new Error([...captureErrors, ...findings].join("\n"));
      }
      return { ...evidence };
    },
  };
}

/** Scan every persistence API exposed by every current frame/origin. */
export async function assertPrivacySentinelAbsentFromBrowserPersistence(
  pages: readonly Page[],
  sentinels: PrivacySentinelInput = MAIL_PRIVACY_SENTINELS,
): Promise<PrivacyPersistenceEvidence> {
  if (pages.length === 0) throw new Error("Mail privacy scan needs at least one browser page");
  const needles = combinedPrivacySentinelNeedles(sentinels).map((needle) => ({
    label: needle.label,
    bytes: [...needle.bytes],
    text: Buffer.from(needle.bytes).toString("utf8"),
  }));
  const total: PrivacyPersistenceEvidence = {
    frames: 0,
    localStorageEntries: 0,
    sessionStorageEntries: 0,
    indexedDatabases: 0,
    indexedRecords: 0,
    nonExtractableCryptoKeys: 0,
    cacheEntries: 0,
    inaccessibleOpaqueSurfaces: 0,
    storageStateBytes: 0,
  };
  const errors: string[] = [];
  const matches: string[] = [];

  // Playwright collects IndexedDB through an isolated utility world. Reuse
  // that inventory for each visible frame instead of calling databases()
  // inside the page, which Chromium 150 incorrectly reports as an
  // `undefined` page error even when the returned promise resolves.
  const contexts = new Set(pages.map((page) => page.context()));
  const storageStates = await Promise.all([...contexts].map(async (context) => ({
    context,
    state: await context.storageState({ indexedDB: true }),
  })));
  const indexedDatabaseNames = new Map(storageStates.map(({ context, state }) => {
    const namesByOrigin = new Map<string, string[]>();
    for (const origin of state.origins as Array<{
      origin: string;
      indexedDB?: Array<{ name?: unknown }>;
    }>) {
      namesByOrigin.set(
        origin.origin,
        (origin.indexedDB ?? [])
          .map((database) => database.name)
          .filter((name): name is string => typeof name === "string" && name.length > 0),
      );
    }
    const bytes = Buffer.from(JSON.stringify(state), "utf8");
    total.storageStateBytes += bytes.byteLength;
    try {
      assertNoPrivacySentinelBytes(bytes, "Playwright browser storage-state export", sentinels);
    } catch (error) {
      matches.push(errorMessage(error));
    }
    return [context, namesByOrigin] as const;
  }));

  for (const page of pages) {
    for (const frame of page.frames()) {
      let frameOrigin = "null";
      try {
        frameOrigin = new URL(frame.url()).origin;
      } catch {
        // An opaque or transient frame has no enumerable persistent origin.
      }
      const result = await frame.evaluate(async (probe) => {
        const found: string[] = [];
        const failures: string[] = [];
        const inaccessible: string[] = [];
        const counts = {
          localStorageEntries: 0,
          sessionStorageEntries: 0,
          indexedDatabases: 0,
          indexedRecords: 0,
          nonExtractableCryptoKeys: 0,
          cacheEntries: 0,
        };
        const seen = new WeakSet<object>();
        const containsBytes = (haystack: Uint8Array, needle: number[]) => {
          outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
            for (let inner = 0; inner < needle.length; inner += 1) {
              if (haystack[index + inner] !== needle[inner]) continue outer;
            }
            return true;
          }
          return false;
        };
        const scanBytes = (bytes: Uint8Array, path: string) => {
          for (const needle of probe.needles) {
            if (containsBytes(bytes, needle.bytes)) found.push(`${path} (${needle.label})`);
          }
        };
        const scanString = (value: string, path: string) => {
          for (const needle of probe.needles) {
            if (needle.text.length > 0 && value.includes(needle.text)) {
              found.push(`${path} (${needle.label})`);
            }
          }
          scanBytes(new TextEncoder().encode(value), path);
        };
        const scanValue = async (value: unknown, path: string, depth = 0): Promise<void> => {
          if (depth > 64) {
            failures.push(`${path}: persisted value exceeds scan depth`);
            return;
          }
          if (typeof value === "string") {
            scanString(value, path);
            return;
          }
          if (value === null || value === undefined || typeof value !== "object") return;
          if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) {
            const algorithm = value.algorithm as { name?: unknown; length?: unknown };
            const usages = [...value.usages];
            if (
              value.type !== "secret" ||
              value.extractable ||
              algorithm.name !== "AES-GCM" ||
              algorithm.length !== 256 ||
              usages.length !== 2 ||
              !usages.includes("encrypt") ||
              !usages.includes("decrypt")
            ) {
              failures.push(`${path}: persisted CryptoKey is not a sealed AES-256-GCM wrapper`);
            } else {
              counts.nonExtractableCryptoKeys += 1;
            }
            return;
          }
          if (value instanceof ArrayBuffer) {
            scanBytes(new Uint8Array(value), path);
            return;
          }
          if (ArrayBuffer.isView(value)) {
            scanBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), path);
            return;
          }
          if (value instanceof Blob) {
            scanBytes(new Uint8Array(await value.arrayBuffer()), path);
            return;
          }
          if (seen.has(value)) return;
          seen.add(value);
          if (value instanceof Map) {
            let index = 0;
            for (const [key, entry] of value) {
              await scanValue(key, `${path}.map-key-${index}`, depth + 1);
              await scanValue(entry, `${path}.map-value-${index}`, depth + 1);
              index += 1;
            }
            return;
          }
          if (value instanceof Set) {
            let index = 0;
            for (const entry of value) {
              await scanValue(entry, `${path}.set-${index}`, depth + 1);
              index += 1;
            }
            return;
          }
          for (const [key, entry] of Object.entries(value)) {
            scanString(key, `${path}.property-name`);
            await scanValue(entry, `${path}.${key}`, depth + 1);
          }
        };
        const scanWebStorage = (storage: Storage, label: string) => {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key === null) continue;
            counts[label === "localStorage" ? "localStorageEntries" : "sessionStorageEntries"] += 1;
            scanString(key, `${label}.key`);
            scanString(storage.getItem(key) ?? "", `${label}[${key}]`);
          }
        };
        try {
          scanWebStorage(localStorage, "localStorage");
          scanWebStorage(sessionStorage, "sessionStorage");
        } catch (error) {
          if (location.origin === "null" || error instanceof DOMException && error.name === "SecurityError") {
            inaccessible.push("web-storage");
          } else {
            failures.push(`web-storage: ${String(error)}`);
          }
        }

        try {
          for (const databaseName of probe.indexedDatabaseNames) {
            counts.indexedDatabases += 1;
            scanString(databaseName, "indexedDB.database-name");
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(databaseName);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
              request.onupgradeneeded = () => {
                request.transaction?.abort();
                reject(new Error("IndexedDB changed during privacy scan"));
              };
            });
            try {
              const stores = [...database.objectStoreNames];
              if (stores.length === 0) continue;
              const transaction = database.transaction(stores, "readonly");
              for (const storeName of stores) {
                scanString(storeName, `indexedDB.${databaseName}.store-name`);
                const store = transaction.objectStore(storeName);
                for (const indexName of store.indexNames) {
                  scanString(indexName, `indexedDB.${databaseName}.${storeName}.index-name`);
                }
                const [keys, values] = await Promise.all([
                  new Promise<IDBValidKey[]>((resolve, reject) => {
                    const request = store.getAllKeys();
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error ?? new Error("IndexedDB key scan failed"));
                  }),
                  new Promise<unknown[]>((resolve, reject) => {
                    const request = store.getAll();
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error ?? new Error("IndexedDB value scan failed"));
                  }),
                ]);
                counts.indexedRecords += Math.max(keys.length, values.length);
                for (let index = 0; index < keys.length; index += 1) {
                  await scanValue(keys[index], `indexedDB.${databaseName}.${storeName}.key-${index}`);
                }
                for (let index = 0; index < values.length; index += 1) {
                  await scanValue(values[index], `indexedDB.${databaseName}.${storeName}.value-${index}`);
                }
              }
            } finally {
              database.close();
            }
          }
        } catch (error) {
          if (location.origin === "null" || error instanceof DOMException && error.name === "SecurityError") {
            inaccessible.push("indexed-db");
          } else {
            failures.push(`indexed-db: ${String(error)}`);
          }
        }

        try {
          for (const cacheName of await caches.keys()) {
            scanString(cacheName, "cache-storage.cache-name");
            const cache = await caches.open(cacheName);
            for (const request of await cache.keys()) {
              counts.cacheEntries += 1;
              scanString(request.url, `cache-storage.${cacheName}.request-url`);
              for (const [name, value] of request.headers) {
                scanString(name, `cache-storage.${cacheName}.request-header-name`);
                scanString(value, `cache-storage.${cacheName}.request-header-value`);
              }
              const response = await cache.match(request);
              if (!response) continue;
              for (const [name, value] of response.headers) {
                scanString(name, `cache-storage.${cacheName}.response-header-name`);
                scanString(value, `cache-storage.${cacheName}.response-header-value`);
              }
              scanBytes(
                new Uint8Array(await response.clone().arrayBuffer()),
                `cache-storage.${cacheName}.response-body`,
              );
            }
          }
        } catch (error) {
          if (location.origin === "null" || error instanceof DOMException && error.name === "SecurityError") {
            inaccessible.push("cache-storage");
          } else {
            failures.push(`cache-storage: ${String(error)}`);
          }
        }
        return { found, failures, inaccessible, counts };
      }, {
        needles,
        indexedDatabaseNames: indexedDatabaseNames.get(page.context())?.get(frameOrigin) ?? [],
      });
      total.frames += 1;
      total.localStorageEntries += result.counts.localStorageEntries;
      total.sessionStorageEntries += result.counts.sessionStorageEntries;
      total.indexedDatabases += result.counts.indexedDatabases;
      total.indexedRecords += result.counts.indexedRecords;
      total.nonExtractableCryptoKeys += result.counts.nonExtractableCryptoKeys;
      total.cacheEntries += result.counts.cacheEntries;
      total.inaccessibleOpaqueSurfaces += result.inaccessible.length;
      matches.push(...result.found.map((entry) => `${redactedUrl(frame.url())}: ${entry}`));
      errors.push(...result.failures.map((entry) => `${redactedUrl(frame.url())}: ${entry}`));
    }
  }

  if (errors.length > 0 || matches.length > 0) {
    throw new Error([...errors, ...matches].join("\n"));
  }
  return total;
}

/** Scan raw snapshot files and transparently decode the gzip Wasm module. */
export async function scanPrivacySnapshotDirectory(
  directory: string,
  sentinels: PrivacySentinelInput = MAIL_PRIVACY_SENTINELS,
): Promise<PrivacySnapshotEvidence> {
  const root = resolve(directory);
  const files = await listRegularFiles(root);
  const names = new Set(files.map((file) => relative(root, file)));
  for (const required of ["metadata.json", "stable_memory.bin", "wasm_memory.bin", "wasm_module.bin"]) {
    if (!names.has(required)) throw new Error(`Canister snapshot is missing ${required}`);
  }
  const evidence: PrivacySnapshotEvidence = {
    files: files.length,
    rawBytes: 0,
    decodedBytes: 0,
    wasmMemoryBytes: 0,
    stableMemoryBytes: 0,
  };
  for (const file of files) {
    const name = relative(root, file);
    const stat = await lstat(file);
    const first = new Uint8Array(4);
    const handle = await open(file, "r");
    let firstBytes = 0;
    try {
      firstBytes = (await handle.read(first, 0, first.byteLength, 0)).bytesRead;
    } finally {
      await handle.close();
    }
    evidence.rawBytes += await scanChunks(createReadStream(file), `${name} raw`, sentinels);
    if (name === "wasm_memory.bin") evidence.wasmMemoryBytes = stat.size;
    if (name === "stable_memory.bin") evidence.stableMemoryBytes = stat.size;
    if (firstBytes >= 2 && first[0] === 0x1f && first[1] === 0x8b) {
      evidence.decodedBytes += await scanChunks(
        createReadStream(file).pipe(createGunzip()),
        `${name} gzip-decoded`,
        sentinels,
      );
    } else if (
      firstBytes >= 4 &&
      ((first[0] === 0x28 && first[1] === 0xb5 && first[2] === 0x2f && first[3] === 0xfd) ||
        (first[0] === 0x50 && first[1] === 0x4b && first[2] === 0x03 && first[3] === 0x04))
    ) {
      throw new Error(`Canister snapshot contains unsupported compressed file ${name}`);
    }
  }
  if (evidence.wasmMemoryBytes === 0) {
    throw new Error("Canister snapshot has no Wasm memory to inspect");
  }
  if (evidence.rawBytes < evidence.wasmMemoryBytes || evidence.decodedBytes === 0) {
    throw new Error("Canister snapshot scan did not cover its complete raw and decoded state");
  }
  return evidence;
}

async function scanChunks(
  chunks: AsyncIterable<Uint8Array | string>,
  surface: string,
  sentinels: PrivacySentinelInput,
): Promise<number> {
  const needles = combinedPrivacySentinelNeedles(sentinels);
  const overlap = Math.max(...needles.map((needle) => needle.bytes.byteLength)) - 1;
  let tail = Buffer.alloc(0);
  let total = 0;
  for await (const value of chunks) {
    const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    total += chunk.byteLength;
    const combined = tail.byteLength === 0 ? chunk : Buffer.concat([tail, chunk]);
    for (const needle of needles) {
      if (combined.indexOf(needle.bytes) !== -1) {
        throw new Error(`Mail privacy sentinel leaked into ${surface} (${needle.label})`);
      }
    }
    tail = combined.subarray(Math.max(0, combined.byteLength - overlap));
  }
  return total;
}

function combinedPrivacySentinelNeedles(input: PrivacySentinelInput): Needle[] {
  const sentinels = typeof input === "string" ? [input] : [...input];
  if (sentinels.length < 1 || sentinels.length > 8) {
    throw new Error("Mail privacy scan needs one to eight deterministic sentinels");
  }
  const unique = new Map<string, Needle>();
  for (const sentinel of sentinels) {
    for (const needle of privacySentinelNeedles(sentinel)) {
      unique.set(Buffer.from(needle.bytes).toString("hex"), needle);
    }
  }
  return [...unique.values()];
}

async function listRegularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(path));
    else if (entry.isFile()) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`Snapshot contains symbolic link ${path}`);
  }
  return files.sort();
}

function icApiKind(url: string): "call" | "query" | "read_state" | null {
  const match = /\/api\/v(?:2|3)\/canister\/[^/]+\/(call|query|read_state)(?:[/?#]|$)/u.exec(url);
  return match?.[1] as "call" | "query" | "read_state" | undefined ?? null;
}

function redactedUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<non-url>";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
