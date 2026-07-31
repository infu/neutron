export const FILES_VAULT_ROOT_BYTES = 32;
export const FILES_VAULT_ID_BYTES = 16;
export const FILES_VAULT_SALT_BYTES = 32;
export const FILES_SHA256_BYTES = 32;
export const FILES_NAME_TAG_BYTES = 32;
export const FILES_AES_GCM_NONCE_BYTES = 12;
export const FILES_AES_GCM_TAG_BYTES = 16;
export const FILES_ENCRYPTED_METADATA_MAX_BYTES = 2_048;
export const FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES = 1_889_984;
export const FILES_PRIVATE_FILE_MAX_PLAINTEXT_BYTES = 67_108_864;
export const FILES_PRIVATE_FILE_MAX_CIPHERTEXT_BYTES = 67_109_440;
export const FILES_PRIVATE_FILE_MAX_BLOCKS = 36;

export type FilesId128 = Readonly<{
  hi: string;
  lo: string;
}>;

export type FilesNodeKind = "folder" | "file";

export type FilesVaultContextInput = Readonly<{
  neutronCanisterPrincipalBytes: Uint8Array;
  vaultId: Uint8Array;
  vaultSalt: Uint8Array;
}>;

export type FilesMetadataBinding = Readonly<{
  nodeId: FilesId128;
  parentId: FilesId128;
  nodeKind: FilesNodeKind;
  metadataRevision: string;
  declaredNameScalars: number;
  nameTag: Uint8Array;
}>;

export type FilesContentBinding = Readonly<{
  nodeId: FilesId128;
  contentId: FilesId128;
}>;

export type FilesContentBlockBinding = FilesContentBinding &
  Readonly<{
    blockIndex: number;
    totalBlockCount: number;
    plaintextBlockLength: number;
  }>;

export type FilesPrivateBlockPlan = Readonly<{
  plaintextBytes: number;
  plaintextBlockLengths: readonly number[];
  ciphertextBlockLengths: readonly number[];
  ciphertextBytes: number;
}>;

export type FilesVaultWrapper = Readonly<{
  generation: string;
  publicKeyFingerprint: Uint8Array;
  ciphertext: Uint8Array;
}>;

export type FilesCommittedVault = Readonly<{
  context: FilesVaultContextInput;
  rootCommitment: Uint8Array;
  wrapper: FilesVaultWrapper;
}>;

export type FilesGeneratedVault = Readonly<{
  context: FilesVaultContextInput;
  rootCommitment: Uint8Array;
  wrapper: FilesVaultWrapper;
}>;

export function nodeKindByte(kind: FilesNodeKind): number {
  if (kind === "folder") return 0;
  if (kind === "file") return 1;
  throw new Error("Files node kind is invalid");
}
