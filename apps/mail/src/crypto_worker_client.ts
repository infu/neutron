import { Principal } from "@dfinity/principal";
import {
  canisterIdFromUrl,
  isDedicatedAppOrigin,
} from "neutron-tools/src/runtime.js";
import type {
  MailCryptoWorkerRequest,
  MailCryptoWorkerResponse,
  MailCryptoWorkerResult,
  MailCryptoWorkerError,
  MailCryptoWorkerEvent,
  MailWorkerEncryptedHeader,
  MailWorkerEncryptedSettings,
  MailWorkerCachePublicInfo,
  MailWorkerCacheScope,
  MailWorkerKeyInfo,
  MailWorkerLiveGeneration,
  MailWorkerLocalWrap,
} from "./crypto_worker.ts";
import { MAIL_CRYPTO_WORKER_SOURCE } from "./crypto_worker_source.ts";

const MAX_PENDING_WORKER_CALLS = 32;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

type Pending = {
  resolve: (value: MailCryptoWorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WithoutWorkerFields<Request> = Request extends {
  id: number;
  type: "prepare_cache" | "configure";
}
  ? Omit<Request, "id" | "scope">
  : Request extends { id: number }
  ? Omit<Request, "id">
  : never;
type MailCryptoWorkerClientRequest =
  WithoutWorkerFields<MailCryptoWorkerRequest>;

export class MailCryptoWorkerClientError extends Error {
  constructor(public readonly code: MailCryptoWorkerError["code"]) {
    super(`Mail crypto worker: ${code}`);
    this.name = "MailCryptoWorkerClientError";
  }
}

export class MailCryptoWorkerClient {
  readonly #worker: Worker;
  readonly #cacheScope: MailWorkerCacheScope | null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #inactivityListeners = new Set<() => void>();
  #closed = false;

  constructor(
    worker = createMailCryptoWorker(),
    href: string | URL | null = currentLocationHref(),
  ) {
    this.#worker = worker;
    this.#cacheScope = href === null
      ? null
      : mailWorkerCacheScopeFromUrl(href);
    worker.addEventListener("message", (
      event: MessageEvent<MailCryptoWorkerResponse | MailCryptoWorkerEvent>,
    ) => {
      if (isInactivityEvent(event.data)) {
        for (const listener of this.#inactivityListeners) {
          try {
            listener();
          } catch {
            // Worker-side key erasure remains authoritative.
          }
        }
        return;
      }
      this.#handleResponse(event.data);
    });
    worker.addEventListener("error", () => this.close("Mail crypto worker stopped"));
    worker.addEventListener("messageerror", () => this.close("Mail crypto worker response was invalid"));
  }

  call(
    request: MailCryptoWorkerClientRequest,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  ): Promise<MailCryptoWorkerResult> {
    if (this.#closed) return Promise.reject(new Error("Mail crypto worker is closed"));
    if (this.#pending.size >= MAX_PENDING_WORKER_CALLS) {
      return Promise.reject(new Error("Mail crypto worker is busy"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      return Promise.reject(new Error("Mail crypto worker timeout is invalid"));
    }
    const id = this.#allocateId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutating operation may still own a transport secret or
        // IndexedDB transaction. Terminate the worker as the cancellation
        // fence instead of allowing retries to overlap unknown old work.
        this.close("Mail crypto worker timed out");
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      const message = request.type === "prepare_cache" ||
          request.type === "configure"
        ? { ...request, scope: this.#cacheScope, id }
        : { ...request, id };
      this.#worker.postMessage(message as MailCryptoWorkerRequest);
    });
  }

  prepareCache(input: {
    current: MailWorkerLiveGeneration;
    previous: MailWorkerLiveGeneration | null;
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "prepare_cache", ...input });
  }

  configure(input: {
    current: MailWorkerCachePublicInfo;
    previous: MailWorkerCachePublicInfo | null;
    inactivityMs?: number;
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "configure", ...input });
  }

  beginUnlock(epoch: string): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "begin_unlock", epoch });
  }

  completeUnlock(epoch: string, encryptedVetKey: Uint8Array): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "complete_unlock", epoch, encryptedVetKey }, 90_000);
  }

  cancelUnlock(): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "cancel_unlock" });
  }

  reset(): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "reset" });
  }

  lock(): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "lock" });
  }

  clearCache(): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "clear_cache" });
  }

  status(): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "status" });
  }

  encrypt(input: {
    senderPrincipal: string;
    recipientPrincipal: string;
    recipientKey: MailWorkerKeyInfo;
    header: Extract<MailCryptoWorkerRequest, { type: "encrypt" }>["header"];
    body: Extract<MailCryptoWorkerRequest, { type: "encrypt" }>["body"];
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "encrypt", ...input });
  }

  rewrap(localWrap: MailWorkerLocalWrap): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "rewrap", localWrap });
  }

  decryptHeader(input: {
    senderPrincipal: string;
    recipientPrincipal: string;
    encryptedHeader: MailWorkerEncryptedHeader;
    localWrap: MailWorkerLocalWrap;
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "decrypt_header", ...input });
  }

  decrypt(input: {
    senderPrincipal: string;
    recipientPrincipal: string;
    envelope: Uint8Array;
    localWrap: MailWorkerLocalWrap;
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "decrypt", ...input });
  }

  encryptSettings(input: {
    selfPrincipal: string;
    senderName: string;
    recordId: Uint8Array;
    revision: string;
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "settings_encrypt", ...input });
  }

  decryptSettings(input: {
    selfPrincipal: string;
    encrypted: MailWorkerEncryptedSettings;
  }): Promise<MailCryptoWorkerResult> {
    return this.call({ type: "settings_decrypt", ...input });
  }

  onInactivityLock(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#inactivityListeners.add(listener);
    return () => this.#inactivityListeners.delete(listener);
  }

  close(reason = "Mail crypto worker closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#inactivityListeners.clear();
  }

  #handleResponse(response: MailCryptoWorkerResponse): void {
    if (!response || !Number.isSafeInteger(response.id)) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if ("error" in response) {
      pending.reject(new MailCryptoWorkerClientError(response.error.code));
    } else {
      pending.resolve(response.ok);
    }
  }

  #allocateId(): number {
    for (let attempt = 0; attempt < 0x7fff_ffff; attempt += 1) {
      const id = this.#nextId;
      this.#nextId = id >= 0x7fff_ffff ? 1 : id + 1;
      if (!this.#pending.has(id)) return id;
    }
    throw new Error("Mail crypto worker request ids are exhausted");
  }
}

export function mailWorkerCacheScopeFromUrl(
  href: string | URL,
): MailWorkerCacheScope | null {
  try {
    const url = new URL(href);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.pathname !== "/app/mail/service.html" ||
      (url.protocol === "https:"
        ? !url.hostname.endsWith(".icp0.io")
        : url.protocol !== "http:" ||
          url.port !== "8000" ||
          !url.hostname.endsWith(".localhost"))
    ) return null;

    const expectedParameters = new Set([
      "app",
      "role",
      "installation-uid",
      "resident-frame-security",
      "browser-origin-nonce",
      "browser-origin-authority-epoch",
    ]);
    const parameters = [...url.searchParams.keys()];
    if (
      parameters.length !== expectedParameters.size ||
      new Set(parameters).size !== expectedParameters.size ||
      parameters.some((name) => !expectedParameters.has(name)) ||
      url.searchParams.get("app") !== "mail" ||
      url.searchParams.get("role") !== "background" ||
      url.searchParams.get("resident-frame-security") !==
        "persistent_dedicated_v1"
    ) return null;

    const installationUid = positiveNat64(
      url.searchParams.get("installation-uid"),
    );
    const browserOriginNonce =
      url.searchParams.get("browser-origin-nonce") ?? "";
    const browserOriginAuthorityEpoch = positiveNat64(
      url.searchParams.get("browser-origin-authority-epoch"),
    );
    const canisterPrincipal = canisterIdFromUrl(url);
    if (
      installationUid === null ||
      browserOriginAuthorityEpoch === null ||
      !/^[a-f0-9]{32}$/u.test(browserOriginNonce) ||
      typeof canisterPrincipal !== "string" ||
      !isCanonicalOpaqueCanisterPrincipal(canisterPrincipal) ||
      !isDedicatedAppOrigin(
        url,
        canisterPrincipal,
        "mail",
        browserOriginNonce,
      )
    ) return null;

    return {
      app: "mail",
      canisterPrincipal,
      installationUid,
      browserOriginNonce,
      browserOriginAuthorityEpoch,
    };
  } catch {
    return null;
  }
}

function currentLocationHref(): string | null {
  return typeof globalThis.location?.href === "string"
    ? globalThis.location.href
    : null;
}

const NAT64_MAX = 18_446_744_073_709_551_615n;

function positiveNat64(value: string | null): string | null {
  if (value === null || !/^[1-9][0-9]*$/u.test(value)) return null;
  try {
    return BigInt(value) <= NAT64_MAX ? value : null;
  } catch {
    return null;
  }
}

function isCanonicalOpaqueCanisterPrincipal(value: string): boolean {
  const principal = Principal.fromText(value);
  const bytes = principal.toUint8Array();
  return (
    principal.toText() === value &&
    bytes.byteLength >= 1 &&
    bytes.byteLength <= 29 &&
    bytes[bytes.byteLength - 1] === 1
  );
}

export function createMailCryptoWorker(
  source = MAIL_CRYPTO_WORKER_SOURCE,
): Worker {
  if (source.length < 1_000) {
    throw new Error("Mail crypto worker bundle is unavailable");
  }
  // Mail's install-approved persistent background runs on its dedicated app
  // origin, so this Blob inherits a secure, app-isolated origin and can use a
  // non-extractable WebCrypto key. Keeping the audited bundle inline also
  // avoids adding a second key-bearing asset entrypoint.
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return new Worker(url, { name: "neutron-mail-crypto" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isInactivityEvent(
  value: MailCryptoWorkerResponse | MailCryptoWorkerEvent,
): value is MailCryptoWorkerEvent {
  return "event" in value && value.event === "inactivity_locked" &&
    Object.keys(value).length === 1;
}
