import { parseCanonicalNat64 } from "../protocol/ids.ts";
import type { CanonicalNat64 } from "../protocol/types.ts";

const HEX_32_PATTERN = /^[a-f0-9]{32}$/u;

export type FilesResidentBinding = Readonly<{
  installationUid: CanonicalNat64;
  frameSecurity: "persistent_dedicated_v1";
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: CanonicalNat64;
  authorizedPrincipal: string | null;
}>;

export type FilesAuthorityResetReason =
  | "initial_binding"
  | "installation_changed"
  | "origin_authority_changed"
  | "principal_changed"
  | "lock_epoch_changed"
  | "worker_failure"
  | "shutdown";

export type FilesAuthorityResetPort = Readonly<{
  clearMetadata(reason: FilesAuthorityResetReason): void;
  clearContinuations(reason: FilesAuthorityResetReason): void;
  cancelTransfers(reason: FilesAuthorityResetReason): void;
  revokeBlobUrls(reason: FilesAuthorityResetReason): void;
  dropDirtyBuffers(reason: FilesAuthorityResetReason): void;
  lockWorker(reason: FilesAuthorityResetReason): void | Promise<void>;
}>;

export class FilesResidentEnvironmentError extends Error {
  constructor(
    public readonly code:
      | "persistent_resident_required"
      | "resident_binding_missing"
      | "resident_binding_invalid",
    message: string,
  ) {
    super(message);
    this.name = "FilesResidentEnvironmentError";
  }
}

export function assertFilesPersistentEnvironment(
  environment: { credentialless?: boolean },
): void {
  if (environment.credentialless === true) {
    throw new FilesResidentEnvironmentError(
      "persistent_resident_required",
      "Files private state requires its persistent dedicated resident",
    );
  }
}

export function parseFilesResidentBinding(
  href: string,
  authorizedPrincipal: string | null = null,
): FilesResidentBinding {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new FilesResidentEnvironmentError(
      "resident_binding_invalid",
      "Files resident URL is invalid",
    );
  }
  const required = (name: string): string => {
    const values = url.searchParams.getAll(name);
    if (values.length === 0 || !values[0]) {
      throw new FilesResidentEnvironmentError(
        "resident_binding_missing",
        `Files resident binding is missing ${name}`,
      );
    }
    if (values.length !== 1) {
      throw new FilesResidentEnvironmentError(
        "resident_binding_invalid",
        `Files resident binding has an ambiguous ${name}`,
      );
    }
    return values[0];
  };
  const installationUid = parsePositiveNat64(
    required("installation-uid"),
    "installation UID",
  );
  const frameSecurity = required("resident-frame-security");
  const browserOriginNonce = required("browser-origin-nonce");
  const browserOriginAuthorityEpoch = parsePositiveNat64(
    required("browser-origin-authority-epoch"),
    "browser-origin authority epoch",
  );
  if (
    frameSecurity !== "persistent_dedicated_v1" ||
    !HEX_32_PATTERN.test(browserOriginNonce) ||
    (authorizedPrincipal !== null &&
      (authorizedPrincipal.length < 3 ||
        authorizedPrincipal.length > 80 ||
        !/^[a-z0-9-]+$/u.test(authorizedPrincipal)))
  ) {
    throw new FilesResidentEnvironmentError(
      "resident_binding_invalid",
      "Files resident authority binding is invalid",
    );
  }
  return Object.freeze({
    installationUid,
    frameSecurity,
    browserOriginNonce,
    browserOriginAuthorityEpoch,
    authorizedPrincipal,
  });
}

export function filesResidentBindingKey(binding: FilesResidentBinding): string {
  return [
    binding.installationUid,
    binding.frameSecurity,
    binding.browserOriginNonce,
    binding.browserOriginAuthorityEpoch,
    binding.authorizedPrincipal ?? "",
  ].join(":");
}

/**
 * Owns the volatile authority boundary. Nothing here persists: authority
 * changes synchronously make plaintext, continuations, transfers, and public
 * Blob URLs unreachable before the worker is asked to discard its keys.
 */
export class FilesAuthorityManager {
  #binding: FilesResidentBinding | null = null;
  #lockEpoch: CanonicalNat64 = parseCanonicalNat64("0");
  #closed = false;

  constructor(private readonly reset: FilesAuthorityResetPort) {}

  get binding(): FilesResidentBinding | null {
    return this.#binding;
  }

  get lockEpoch(): CanonicalNat64 {
    return this.#lockEpoch;
  }

  adopt(binding: FilesResidentBinding): FilesAuthorityResetReason | null {
    if (this.#closed) {
      throw new Error("Files resident authority manager is closed");
    }
    const previous = this.#binding;
    if (previous && filesResidentBindingKey(previous) === filesResidentBindingKey(binding)) {
      return null;
    }
    const reason = previous === null
      ? "initial_binding"
      : binding.installationUid !== previous.installationUid
        ? "installation_changed"
        : binding.browserOriginAuthorityEpoch !==
              previous.browserOriginAuthorityEpoch ||
            binding.browserOriginNonce !== previous.browserOriginNonce
          ? "origin_authority_changed"
          : "principal_changed";
    this.#binding = binding;
    this.#lockEpoch = incrementNat64(this.#lockEpoch);
    this.#resetPrivateAuthority(reason, true);
    return reason;
  }

  relock(reason: "lock_epoch_changed" | "worker_failure"): CanonicalNat64 {
    if (this.#closed) {
      throw new Error("Files resident authority manager is closed");
    }
    this.#lockEpoch = incrementNat64(this.#lockEpoch);
    // An idle/explicit relock may retain a same-authority dirty editor buffer.
    // Worker failure does not: the buffer cannot be trusted to match a live
    // crypto session after that boundary.
    this.#resetPrivateAuthority(reason, reason === "worker_failure");
    return this.#lockEpoch;
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lockEpoch = incrementNat64(this.#lockEpoch);
    this.#resetPrivateAuthority("shutdown", true);
    this.#binding = null;
  }

  #resetPrivateAuthority(
    reason: FilesAuthorityResetReason,
    dropDirtyBuffers: boolean,
  ): void {
    this.reset.clearMetadata(reason);
    this.reset.clearContinuations(reason);
    this.reset.cancelTransfers(reason);
    this.reset.revokeBlobUrls(reason);
    if (dropDirtyBuffers) this.reset.dropDirtyBuffers(reason);
    void Promise.resolve(this.reset.lockWorker(reason)).catch(() => {
      // Reset is fail-closed even if an already-failed worker cannot answer.
    });
  }
}

function parsePositiveNat64(value: string, label: string): CanonicalNat64 {
  const parsed = parseCanonicalNat64(value, label);
  if (parsed === "0") {
    throw new FilesResidentEnvironmentError(
      "resident_binding_invalid",
      `${label} must be positive`,
    );
  }
  return parsed;
}

function incrementNat64(value: CanonicalNat64): CanonicalNat64 {
  const next = BigInt(value) + 1n;
  if (next > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Files lock epoch exhausted");
  }
  return parseCanonicalNat64(next, "lock epoch");
}
