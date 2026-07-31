import { parseCanonicalNat64 } from "../protocol/ids.ts";
import type { CanonicalNat64 } from "../protocol/types.ts";

const TOKEN_BYTES = 32;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_TTL_MS = 5 * 60_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export type FilesContinuationBinding = Readonly<{
  callerEndpoint: string;
  callerSession: string;
  installationGeneration: CanonicalNat64;
  lockEpoch: CanonicalNat64;
  folderRevision: CanonicalNat64;
}>;

export type FilesContinuationScope = Omit<
  FilesContinuationBinding,
  "folderRevision"
>;

export type FilesContinuationRegistryOptions = Readonly<{
  maxEntries?: number;
  maxTtlMs?: number;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>;

type ContinuationEntry<Value> = {
  binding: FilesContinuationBinding;
  expiresAtMs: number;
  sequence: number;
  value: Value;
};

export class FilesContinuationError extends Error {
  constructor(
    public readonly code:
      | "cursor_expired"
      | "cursor_unknown"
      | "cursor_scope_mismatch"
      | "cursor_capacity"
      | "cursor_invalid",
    message: string,
  ) {
    super(message);
    this.name = "FilesContinuationError";
  }
}

/**
 * Holds backend cursors inside the resident and exposes only random handles.
 * No handle serializes a parent ID, blind tag, or backend Candid cursor.
 */
export class FilesContinuationRegistry<Value> {
  readonly #entries = new Map<string, ContinuationEntry<Value>>();
  readonly #maxEntries: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  #sequence = 0;

  constructor(options: FilesContinuationRegistryOptions = {}) {
    this.#maxEntries = boundedInteger(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      1,
      4_096,
      "continuation capacity",
    );
    this.#maxTtlMs = boundedInteger(
      options.maxTtlMs ?? DEFAULT_MAX_TTL_MS,
      1_000,
      60 * 60_000,
      "continuation TTL cap",
    );
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes =
      options.randomBytes ??
      ((length) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  }

  issue(
    binding: FilesContinuationBinding,
    value: Value,
    ttlMs = this.#maxTtlMs,
  ): string {
    const normalizedBinding = normalizeBinding(binding);
    const now = validNow(this.#now());
    this.purgeExpired(now);
    const ttl = boundedInteger(ttlMs, 1, this.#maxTtlMs, "continuation TTL");
    if (this.#entries.size >= this.#maxEntries) {
      this.#evictOldest();
    }
    if (this.#entries.size >= this.#maxEntries) {
      throw new FilesContinuationError(
        "cursor_capacity",
        "The resident continuation registry is full",
      );
    }
    const token = this.#allocateToken();
    this.#entries.set(token, {
      binding: normalizedBinding,
      expiresAtMs: now + ttl,
      sequence: ++this.#sequence,
      value,
    });
    return token;
  }

  redeem(token: string, binding: FilesContinuationBinding): Value {
    const entry = this.#redeemEntry(token);
    if (!sameBinding(entry.binding, normalizeBinding(binding))) {
      throw new FilesContinuationError(
        "cursor_scope_mismatch",
        "The continuation handle belongs to another caller or authority epoch",
      );
    }
    return entry.value;
  }

  redeemScope(
    token: string,
    scope: FilesContinuationScope,
  ): Readonly<{ binding: FilesContinuationBinding; value: Value }> {
    const entry = this.#redeemEntry(token);
    if (!sameScope(entry.binding, normalizeScope(scope))) {
      throw new FilesContinuationError(
        "cursor_scope_mismatch",
        "The continuation handle belongs to another caller or authority epoch",
      );
    }
    return Object.freeze({ binding: entry.binding, value: entry.value });
  }

  #redeemEntry(token: string): ContinuationEntry<Value> {
    if (!TOKEN_PATTERN.test(token)) {
      throw new FilesContinuationError(
        "cursor_invalid",
        "The continuation handle is malformed",
      );
    }
    const now = validNow(this.#now());
    const entry = this.#entries.get(token);
    if (!entry) {
      this.purgeExpired(now);
      throw new FilesContinuationError(
        "cursor_unknown",
        "The continuation handle is unknown",
      );
    }
    if (entry.expiresAtMs <= now) {
      this.#entries.delete(token);
      throw new FilesContinuationError(
        "cursor_expired",
        "The continuation handle expired",
      );
    }
    return entry;
  }

  revoke(token: string): boolean {
    return this.#entries.delete(token);
  }

  revokeWhere(
    predicate: (binding: FilesContinuationBinding) => boolean,
  ): number {
    let removed = 0;
    for (const [token, entry] of this.#entries) {
      if (!predicate(entry.binding)) continue;
      this.#entries.delete(token);
      removed += 1;
    }
    return removed;
  }

  purgeExpired(now = this.#now()): number {
    const normalizedNow = validNow(now);
    let removed = 0;
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAtMs > normalizedNow) continue;
      this.#entries.delete(token);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #allocateToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const random = this.#randomBytes(TOKEN_BYTES);
      if (!(random instanceof Uint8Array) || random.byteLength !== TOKEN_BYTES) {
        throw new FilesContinuationError(
          "cursor_invalid",
          "The continuation random source returned the wrong byte length",
        );
      }
      const token = Array.from(
        random,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (!this.#entries.has(token)) return token;
    }
    throw new FilesContinuationError(
      "cursor_capacity",
      "Unable to allocate a unique continuation handle",
    );
  }

  #evictOldest(): void {
    let selected: [string, ContinuationEntry<Value>] | null = null;
    for (const candidate of this.#entries) {
      if (
        selected === null ||
        candidate[1].expiresAtMs < selected[1].expiresAtMs ||
        (candidate[1].expiresAtMs === selected[1].expiresAtMs &&
          candidate[1].sequence < selected[1].sequence)
      ) {
        selected = candidate;
      }
    }
    if (selected) this.#entries.delete(selected[0]);
  }
}

function normalizeBinding(
  binding: FilesContinuationBinding,
): FilesContinuationBinding {
  const scope = normalizeScope(binding);
  return Object.freeze({
    ...scope,
    folderRevision: parseCanonicalNat64(
      binding.folderRevision,
      "folder revision",
    ),
  });
}

function normalizeScope(
  binding: FilesContinuationScope,
): FilesContinuationScope {
  if (
    !binding ||
    typeof binding.callerEndpoint !== "string" ||
    binding.callerEndpoint.length < 1 ||
    binding.callerEndpoint.length > 256 ||
    typeof binding.callerSession !== "string" ||
    binding.callerSession.length < 1 ||
    binding.callerSession.length > 256
  ) {
    throw new FilesContinuationError(
      "cursor_invalid",
      "Continuation caller binding is invalid",
    );
  }
  return Object.freeze({
    callerEndpoint: binding.callerEndpoint,
    callerSession: binding.callerSession,
    installationGeneration: parseCanonicalNat64(
      binding.installationGeneration,
      "installation generation",
    ),
    lockEpoch: parseCanonicalNat64(binding.lockEpoch, "lock epoch"),
  });
}

function sameBinding(
  left: FilesContinuationBinding,
  right: FilesContinuationBinding,
): boolean {
  return (
    left.callerEndpoint === right.callerEndpoint &&
    left.callerSession === right.callerSession &&
    left.installationGeneration === right.installationGeneration &&
    left.lockEpoch === right.lockEpoch &&
    left.folderRevision === right.folderRevision
  );
}

function sameScope(
  left: FilesContinuationScope,
  right: FilesContinuationScope,
): boolean {
  return (
    left.callerEndpoint === right.callerEndpoint &&
    left.callerSession === right.callerSession &&
    left.installationGeneration === right.installationGeneration &&
    left.lockEpoch === right.lockEpoch
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FilesContinuationError(
      "cursor_invalid",
      `${label} must be within ${minimum}..${maximum}`,
    );
  }
  return value;
}

function validNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new FilesContinuationError(
      "cursor_invalid",
      "Continuation clock returned an invalid time",
    );
  }
  return value;
}
