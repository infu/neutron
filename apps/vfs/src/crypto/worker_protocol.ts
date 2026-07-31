import type {
  FilesCommittedVault,
  FilesContentBinding,
  FilesContentBlockBinding,
  FilesGeneratedVault,
  FilesMetadataBinding,
} from "./types.ts";
import type { FilesVetKeyPublicInfo } from "./vetkeys.ts";

export const FILES_WORKER_MAX_PENDING_CALLS = 32;
export const FILES_WORKER_MAX_CONTENT_CIPHERS = 8;
export const FILES_WORKER_MAX_RETRY_FRAMES = 2;
export const FILES_WORKER_MAX_FRAME_BYTES = 1_900_000;
export const FILES_WORKER_UNLOCK_CHALLENGE_MS = 60_000;
export const FILES_WORKER_DEFAULT_INACTIVITY_MS = 15 * 60_000;
export const FILES_WORKER_MIN_INACTIVITY_MS = 60_000;
export const FILES_WORKER_MAX_INACTIVITY_MS = 60 * 60_000;

export type FilesCryptoWorkerStatus = Readonly<{
  configured: boolean;
  currentGeneration: string | null;
  previousGeneration: string | null;
  unlocked: boolean;
  unlockedGeneration: string | null;
  pendingGeneration: string | null;
  inactivityExpiresAt: number | null;
  contentCipherCount: number;
  retryFrameCount: number;
}>;

export type FilesVaultPublicCacheDescriptor = Readonly<{
  generation: string;
  keyName: FilesVetKeyPublicInfo["keyName"];
  publicKeyFingerprint: Uint8Array;
  vaultId: Uint8Array;
  vaultSalt: Uint8Array;
  rootCommitment: Uint8Array;
  wrapperCiphertext: Uint8Array;
}>;

export type FilesVaultCacheDescriptor =
  FilesVaultPublicCacheDescriptor & Readonly<{
    neutronCanisterPrincipalBytes: Uint8Array;
  }>;

export type FilesCryptoWorkerRequest =
  | Readonly<{
      id: number;
      type: "configure";
      current: FilesVetKeyPublicInfo;
      previous: FilesVetKeyPublicInfo | null;
      inactivityMs?: number | null;
    }>
  | Readonly<{
      id: number;
      type: "initialize_vault";
      neutronCanisterPrincipalBytes: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "begin_unlock";
      generation: string;
      vault?: FilesCommittedVault;
      rewrapToGeneration?: string;
    }>
  | Readonly<{
      id: number;
      type: "complete_unlock";
      generation: string;
      encryptedVetKey: Uint8Array;
      vault: FilesCommittedVault;
      rewrapToGeneration?: string;
    }>
  | Readonly<{
      id: number;
      type: "load_cached_public_info";
      vault: FilesVaultPublicCacheDescriptor;
    }>
  | Readonly<{
      id: number;
      type: "commit_vault_cache";
      vault: FilesCommittedVault;
    }>
  | Readonly<{ id: number; type: "cancel_unlock" }>
  | Readonly<{ id: number; type: "lock" }>
  | Readonly<{ id: number; type: "reset" }>
  | Readonly<{ id: number; type: "status" }>
  | Readonly<{
      id: number;
      type: "name_tag";
      parentNodeId: FilesContentBinding["nodeId"];
      filename: string;
    }>
  | Readonly<{
      id: number;
      type: "encrypt_metadata";
      binding: FilesMetadataBinding;
      plaintext: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "decrypt_metadata";
      binding: FilesMetadataBinding;
      ciphertext: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "create_content_cipher";
      binding: FilesContentBinding;
    }>
  | Readonly<{
      id: number;
      type: "open_content_cipher";
      binding: FilesContentBinding;
      wrappedKey: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "release_content_cipher";
      handle: string;
    }>
  | Readonly<{
      id: number;
      type: "encrypt_content_block";
      handle: string;
      binding: FilesContentBlockBinding;
      plaintext: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "decrypt_content_block";
      handle: string;
      binding: FilesContentBlockBinding;
      ciphertext: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "retain_retry_frame";
      operationId: string;
      frameOrdinal: number;
      frame: Uint8Array;
    }>
  | Readonly<{
      id: number;
      type: "export_retry_frame";
      operationId: string;
      frameOrdinal: number;
    }>
  | Readonly<{
      id: number;
      type: "release_retry_frame";
      operationId: string;
      frameOrdinal: number;
    }>;

export type FilesCryptoWorkerResult =
  | Readonly<{ type: "status"; status: FilesCryptoWorkerStatus }>
  | Readonly<{
      type: "vault_initialized";
      vault: FilesGeneratedVault;
      status: FilesCryptoWorkerStatus;
    }>
  | Readonly<{
      type: "unlock_request";
      generation: string;
      transportPublicKey: Uint8Array;
      requestNonce: Uint8Array;
      expiresAt: number;
    }>
  | Readonly<{
      type: "vault_unlocked";
      status: FilesCryptoWorkerStatus;
      rewrapped: FilesGeneratedVault["wrapper"] | null;
    }>
  | Readonly<{
      type: "cached_public_info";
      publicInfo: FilesVetKeyPublicInfo | null;
    }>
  | Readonly<{
      type: "vault_cache_committed";
      stored: boolean;
      status: FilesCryptoWorkerStatus;
    }>
  | Readonly<{ type: "cancelled" }>
  | Readonly<{ type: "name_tag"; nameTag: Uint8Array }>
  | Readonly<{ type: "metadata_encrypted"; ciphertext: Uint8Array }>
  | Readonly<{ type: "metadata_decrypted"; plaintext: Uint8Array }>
  | Readonly<{
      type: "content_cipher_ready";
      handle: string;
      wrappedKey: Uint8Array | null;
    }>
  | Readonly<{ type: "content_cipher_released" }>
  | Readonly<{ type: "content_block_encrypted"; ciphertext: Uint8Array }>
  | Readonly<{ type: "content_block_decrypted"; plaintext: Uint8Array }>
  | Readonly<{
      type: "retry_frame_retained";
      fingerprint: Uint8Array;
    }>
  | Readonly<{
      type: "retry_frame_exported";
      frame: Uint8Array;
      fingerprint: Uint8Array;
    }>
  | Readonly<{ type: "retry_frame_released" }>;

export type FilesCryptoWorkerErrorCode =
  | "invalid_request"
  | "not_configured"
  | "locked"
  | "busy"
  | "expired"
  | "authentication_failed"
  | "binding_changed"
  | "not_found"
  | "crypto_unavailable";

export type FilesCryptoWorkerError = Readonly<{
  code: FilesCryptoWorkerErrorCode;
}>;

export type FilesCryptoWorkerResponse =
  | Readonly<{ id: number; ok: FilesCryptoWorkerResult }>
  | Readonly<{ id: number; error: FilesCryptoWorkerError }>;

export type FilesCryptoWorkerEvent = Readonly<{
  event: "inactivity_locked";
}>;

export type FilesCryptoWorkerRequestWithoutId =
  FilesCryptoWorkerRequest extends infer Request
    ? Request extends { id: number }
      ? Omit<Request, "id">
      : never
    : never;
