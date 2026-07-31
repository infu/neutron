import { FILES_CRYPTO_WORKER_SOURCE } from "./worker_source.ts";
import {
  FILES_WORKER_MAX_PENDING_CALLS,
  type FilesCryptoWorkerError,
  type FilesCryptoWorkerEvent,
  type FilesCryptoWorkerRequest,
  type FilesCryptoWorkerRequestWithoutId,
  type FilesCryptoWorkerResponse,
  type FilesCryptoWorkerResult,
} from "./worker_protocol.ts";

const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const MAX_WORKER_TIMEOUT_MS = 120_000;

type Pending = {
  resolve: (value: FilesCryptoWorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerPort = Pick<
  Worker,
  "addEventListener" | "postMessage" | "terminate"
>;

export class FilesCryptoWorkerClientError extends Error {
  constructor(readonly code: FilesCryptoWorkerError["code"]) {
    super(`Files crypto worker: ${code}`);
    this.name = "FilesCryptoWorkerClientError";
  }
}

export class FilesCryptoWorkerClient {
  readonly #worker: WorkerPort;
  readonly #pending = new Map<number, Pending>();
  readonly #inactivityListeners = new Set<() => void>();
  #nextId = 1;
  #closed = false;
  #closedReason: string | null = null;

  constructor(worker: WorkerPort = createFilesCryptoWorker()) {
    this.#worker = worker;
    worker.addEventListener(
      "message",
      (event: MessageEvent<
        FilesCryptoWorkerResponse | FilesCryptoWorkerEvent
      >) => {
        if (isInactivityEvent(event.data)) {
          for (const listener of this.#inactivityListeners) {
            try {
              listener();
            } catch {
              // Worker key erasure remains authoritative.
            }
          }
          return;
        }
        this.#handleResponse(event.data);
      },
    );
    worker.addEventListener("error", () => {
      this.#stop("Files crypto worker stopped", true);
    });
    worker.addEventListener("messageerror", () => {
      this.#stop("Files crypto worker response was invalid", true);
    });
  }

  call(
    request: FilesCryptoWorkerRequestWithoutId,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  ): Promise<FilesCryptoWorkerResult> {
    if (this.#closed) {
      return Promise.reject(new Error("Files crypto worker is closed"));
    }
    if (this.#pending.size >= FILES_WORKER_MAX_PENDING_CALLS) {
      return Promise.reject(new Error("Files crypto worker is busy"));
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_WORKER_TIMEOUT_MS
    ) {
      return Promise.reject(new Error("Files crypto worker timeout is invalid"));
    }
    const id = this.#allocateId();
    const message = { ...request, id } as FilesCryptoWorkerRequest;
    let transfer: Transferable[];
    try {
      transfer = requestTransferables(message);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutating request may still complete inside the worker.
        // Termination is the only reliable fence: never accept a late unlock,
        // key creation, plaintext result, or lock acknowledgement.
        this.#stop("Files crypto worker timed out", true);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#worker.postMessage(message, transfer);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  configure(
    request: Extract<
      FilesCryptoWorkerRequestWithoutId,
      { type: "configure" }
    >,
  ): Promise<FilesCryptoWorkerResult> {
    return this.call(request);
  }

  initializeVault(
    neutronCanisterPrincipalBytes: Uint8Array,
  ): Promise<FilesCryptoWorkerResult> {
    return this.call({
      type: "initialize_vault",
      neutronCanisterPrincipalBytes,
    });
  }

  beginUnlock(generation: string): Promise<FilesCryptoWorkerResult> {
    return this.call({ type: "begin_unlock", generation });
  }

  completeUnlock(
    request: Extract<
      FilesCryptoWorkerRequestWithoutId,
      { type: "complete_unlock" }
    >,
  ): Promise<FilesCryptoWorkerResult> {
    return this.call(request, 90_000);
  }

  lock(): Promise<FilesCryptoWorkerResult> {
    return this.call({ type: "lock" });
  }

  reset(): Promise<FilesCryptoWorkerResult> {
    return this.call({ type: "reset" });
  }

  status(): Promise<FilesCryptoWorkerResult> {
    return this.call({ type: "status" });
  }

  onInactivityLock(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#inactivityListeners.add(listener);
    return () => this.#inactivityListeners.delete(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closedReason(): string | null {
    return this.#closedReason;
  }

  close(reason = "Files crypto worker closed"): void {
    this.#stop(reason, true);
  }

  #stop(reason: string, notifyLock: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedReason = reason;
    this.#worker.terminate();
    if (notifyLock) {
      for (const listener of this.#inactivityListeners) {
        try {
          listener();
        } catch {
          // Worker termination remains authoritative.
        }
      }
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#inactivityListeners.clear();
  }

  #handleResponse(response: FilesCryptoWorkerResponse): void {
    if (
      !response ||
      !Number.isSafeInteger(response.id) ||
      response.id < 1
    ) {
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if ("error" in response) {
      if (!isWorkerErrorCode(response.error.code)) {
        pending.reject(new Error("Files crypto worker returned an invalid error"));
      } else {
        pending.reject(new FilesCryptoWorkerClientError(response.error.code));
      }
      return;
    }
    pending.resolve(response.ok);
  }

  #allocateId(): number {
    for (let attempt = 0; attempt < 0x7fff_ffff; attempt += 1) {
      const id = this.#nextId;
      this.#nextId = id >= 0x7fff_ffff ? 1 : id + 1;
      if (!this.#pending.has(id)) return id;
    }
    throw new Error("Files crypto worker request ids are exhausted");
  }
}

export function assertFilesPersistentResident(
  candidate: { credentialless?: unknown },
): void {
  if (!candidate || candidate.credentialless === true) {
    throw new Error(
      "Files requires a persistent dedicated resident origin",
    );
  }
}

export function createFilesCryptoWorker(
  source = FILES_CRYPTO_WORKER_SOURCE,
): Worker {
  if (typeof window === "undefined") {
    throw new Error("Files crypto worker requires a browser resident");
  }
  assertFilesPersistentResident(
    window as Window & { credentialless?: boolean },
  );
  if (source.length < 1_000) {
    throw new Error("Files crypto worker bundle is unavailable");
  }
  const url = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );
  try {
    return new Worker(url, { name: "neutron-files-crypto" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function requestTransferables(
  request: FilesCryptoWorkerRequest,
): Transferable[] {
  switch (request.type) {
    case "complete_unlock":
      return [standaloneBuffer(
        request.encryptedVetKey,
        "Encrypted Files VetKey",
      )];
    case "encrypt_metadata":
      return [standaloneBuffer(
        request.plaintext,
        "Files metadata plaintext",
      )];
    case "decrypt_metadata":
      return [standaloneBuffer(
        request.ciphertext,
        "Files metadata ciphertext",
      )];
    case "encrypt_content_block":
      return [standaloneBuffer(
        request.plaintext,
        "Files content plaintext",
      )];
    case "decrypt_content_block":
      return [standaloneBuffer(
        request.ciphertext,
        "Files content ciphertext",
      )];
    case "retain_retry_frame":
      return [standaloneBuffer(request.frame, "Files retry frame")];
    default:
      return [];
  }
}

function standaloneBuffer(
  value: Uint8Array,
  label: string,
): ArrayBuffer {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== value.buffer.byteLength
  ) {
    throw new Error(`${label} must own one exact standalone ArrayBuffer`);
  }
  return value.buffer;
}

function isInactivityEvent(
  value: FilesCryptoWorkerResponse | FilesCryptoWorkerEvent,
): value is FilesCryptoWorkerEvent {
  return (
    "event" in value &&
    value.event === "inactivity_locked" &&
    Object.keys(value).length === 1
  );
}

function isWorkerErrorCode(
  value: string,
): value is FilesCryptoWorkerError["code"] {
  return (
    value === "invalid_request" ||
    value === "not_configured" ||
    value === "locked" ||
    value === "busy" ||
    value === "expired" ||
    value === "authentication_failed" ||
    value === "binding_changed" ||
    value === "not_found" ||
    value === "crypto_unavailable"
  );
}
