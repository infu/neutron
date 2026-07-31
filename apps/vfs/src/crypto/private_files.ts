import {
  assertBytes,
  assertContentBinding,
  assertContentBlockBinding,
  assertFixedBytes,
  assertMetadataBinding,
  contentBlockAad,
  contentBlockNonce,
  contentKeyAad,
  equalBytes,
  metadataAad,
  nameTagInput,
  rootCommitmentInput,
  vaultContext,
} from "./canonical.ts";
import {
  FILES_AES_GCM_TAG_BYTES,
  FILES_ENCRYPTED_METADATA_MAX_BYTES,
  FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES,
  FILES_PRIVATE_FILE_MAX_BLOCKS,
  FILES_PRIVATE_FILE_MAX_CIPHERTEXT_BYTES,
  FILES_PRIVATE_FILE_MAX_PLAINTEXT_BYTES,
  FILES_SHA256_BYTES,
  type FilesContentBinding,
  type FilesContentBlockBinding,
  type FilesMetadataBinding,
  type FilesPrivateBlockPlan,
  type FilesVaultContextInput,
} from "./types.ts";
import {
  decryptAesGcm,
  deriveContentRecordWrapKey,
  deriveMetadataRecordKey,
  encryptAesGcm,
  hmacSha256,
  importAesGcmKey,
  secureRandomBytes,
  sha256,
  zeroBytes,
  type FilesAesGcmKey,
  type FilesVaultKeys,
} from "./webcrypto.ts";

const ZERO_NONCE = new Uint8Array(12);

export function planPrivateBlocks(
  plaintextBytes: number,
): FilesPrivateBlockPlan {
  if (
    !Number.isSafeInteger(plaintextBytes) ||
    plaintextBytes < 0 ||
    plaintextBytes > FILES_PRIVATE_FILE_MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("Files plaintext length is outside its bound");
  }
  const plaintextBlockLengths: number[] = [];
  if (plaintextBytes === 0) {
    plaintextBlockLengths.push(0);
  } else {
    const count = Math.ceil(
      plaintextBytes / FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES,
    );
    plaintextBlockLengths.push(
      plaintextBytes -
        (count - 1) * FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES,
    );
    for (let index = 1; index < count; index += 1) {
      plaintextBlockLengths.push(FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES);
    }
  }
  const ciphertextBlockLengths = plaintextBlockLengths.map(
    (length) => length + FILES_AES_GCM_TAG_BYTES,
  );
  const ciphertextBytes = ciphertextBlockLengths.reduce(
    (sum, length) => sum + length,
    0,
  );
  const plan = {
    plaintextBytes,
    plaintextBlockLengths,
    ciphertextBlockLengths,
    ciphertextBytes,
  } as const;
  assertPrivateBlockPlan(plan);
  return plan;
}

export function assertPrivateBlockPlan(
  plan: FilesPrivateBlockPlan,
): void {
  if (
    !plan ||
    !Number.isSafeInteger(plan.plaintextBytes) ||
    plan.plaintextBytes < 0 ||
    plan.plaintextBytes > FILES_PRIVATE_FILE_MAX_PLAINTEXT_BYTES ||
    !Array.isArray(plan.plaintextBlockLengths) ||
    !Array.isArray(plan.ciphertextBlockLengths) ||
    plan.plaintextBlockLengths.length < 1 ||
    plan.plaintextBlockLengths.length > FILES_PRIVATE_FILE_MAX_BLOCKS ||
    plan.ciphertextBlockLengths.length !==
      plan.plaintextBlockLengths.length
  ) {
    throw new Error("Files private block plan is invalid");
  }
  const expected = planPrivateBlockLengthsUnchecked(plan.plaintextBytes);
  if (
    expected.length !== plan.plaintextBlockLengths.length ||
    expected.some(
      (length, index) => plan.plaintextBlockLengths[index] !== length,
    ) ||
    plan.ciphertextBlockLengths.some(
      (length, index) =>
        length !==
        (plan.plaintextBlockLengths[index] ?? -FILES_AES_GCM_TAG_BYTES) +
          FILES_AES_GCM_TAG_BYTES,
    )
  ) {
    throw new Error("Files private block geometry is noncanonical");
  }
  const ciphertextBytes = plan.ciphertextBlockLengths.reduce(
    (sum, length) => sum + length,
    0,
  );
  if (
    ciphertextBytes !== plan.ciphertextBytes ||
    ciphertextBytes > FILES_PRIVATE_FILE_MAX_CIPHERTEXT_BYTES
  ) {
    throw new Error("Files private ciphertext geometry is invalid");
  }
}

export async function computeRootCommitment(
  contextInput: FilesVaultContextInput,
  vaultRoot: Uint8Array,
  subtle?: SubtleCrypto,
): Promise<Uint8Array> {
  const context = vaultContext(contextInput);
  return sha256(rootCommitmentInput(context, vaultRoot), subtle);
}

export async function verifyRootCommitment(
  contextInput: FilesVaultContextInput,
  vaultRoot: Uint8Array,
  expected: Uint8Array,
  subtle?: SubtleCrypto,
): Promise<void> {
  assertFixedBytes(expected, FILES_SHA256_BYTES, "Files root commitment");
  const actual = await computeRootCommitment(contextInput, vaultRoot, subtle);
  try {
    if (!equalBytes(actual, expected)) {
      throw new Error("Files vault root commitment does not match");
    }
  } finally {
    zeroBytes(actual);
  }
}

export async function computeNameTag(
  keys: FilesVaultKeys,
  parentNodeId: FilesContentBinding["nodeId"],
  filename: string,
): Promise<Uint8Array> {
  return hmacSha256(keys.nameIndexKey, nameTagInput(parentNodeId, filename));
}

export async function encryptMetadata(
  keys: FilesVaultKeys,
  binding: FilesMetadataBinding,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  assertMetadataBinding(binding);
  assertBytes(plaintext, "Files metadata plaintext");
  if (
    plaintext.byteLength + FILES_AES_GCM_TAG_BYTES >
    FILES_ENCRYPTED_METADATA_MAX_BYTES
  ) {
    throw new Error("Files encrypted metadata exceeds its bound");
  }
  const recordKey = await deriveMetadataRecordKey(
    keys,
    binding.nodeId,
    binding.metadataRevision,
  );
  const ciphertext = await encryptAesGcm(
    recordKey,
    ZERO_NONCE,
    metadataAad(keys.context, binding),
    plaintext,
  );
  if (ciphertext.byteLength > FILES_ENCRYPTED_METADATA_MAX_BYTES) {
    throw new Error("Files encrypted metadata exceeds its bound");
  }
  return ciphertext;
}

export async function decryptMetadata(
  keys: FilesVaultKeys,
  binding: FilesMetadataBinding,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  assertMetadataBinding(binding);
  assertBytes(ciphertext, "Files metadata ciphertext");
  if (
    ciphertext.byteLength < FILES_AES_GCM_TAG_BYTES ||
    ciphertext.byteLength > FILES_ENCRYPTED_METADATA_MAX_BYTES
  ) {
    throw new Error("Files encrypted metadata is outside its bound");
  }
  const recordKey = await deriveMetadataRecordKey(
    keys,
    binding.nodeId,
    binding.metadataRevision,
  );
  return decryptAesGcm(
    recordKey,
    ZERO_NONCE,
    metadataAad(keys.context, binding),
    ciphertext,
  );
}

export async function generateContentCipher(
  keys: FilesVaultKeys,
  binding: FilesContentBinding,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): Promise<{
  cipher: FilesAesGcmKey;
  wrappedKey: Uint8Array;
}> {
  assertContentBinding(binding);
  const raw = randomBytes(32);
  assertFixedBytes(raw, 32, "Files content key");
  try {
    const [cipher, wrappedKey] = await Promise.all([
      importAesGcmKey(raw, ["encrypt", "decrypt"], keys.subtle),
      wrapContentKey(keys, binding, raw),
    ]);
    return { cipher, wrappedKey };
  } finally {
    zeroBytes(raw);
  }
}

export async function wrapContentKey(
  keys: FilesVaultKeys,
  binding: FilesContentBinding,
  rawContentKey: Uint8Array,
): Promise<Uint8Array> {
  assertContentBinding(binding);
  assertFixedBytes(rawContentKey, 32, "Files content key");
  const recordKey = await deriveContentRecordWrapKey(keys, binding);
  return encryptAesGcm(
    recordKey,
    ZERO_NONCE,
    contentKeyAad(keys.context, binding),
    rawContentKey,
  );
}

export async function unwrapContentCipher(
  keys: FilesVaultKeys,
  binding: FilesContentBinding,
  wrappedKey: Uint8Array,
): Promise<FilesAesGcmKey> {
  assertContentBinding(binding);
  assertFixedBytes(wrappedKey, 48, "Files wrapped content key");
  const recordKey = await deriveContentRecordWrapKey(keys, binding);
  const raw = await decryptAesGcm(
    recordKey,
    ZERO_NONCE,
    contentKeyAad(keys.context, binding),
    wrappedKey,
  );
  try {
    assertFixedBytes(raw, 32, "Files unwrapped content key");
    return await importAesGcmKey(raw, ["encrypt", "decrypt"], keys.subtle);
  } finally {
    zeroBytes(raw);
  }
}

export async function encryptContentBlock(
  cipher: FilesAesGcmKey,
  context: Uint8Array,
  binding: FilesContentBlockBinding,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  assertContentBlockBinding(binding);
  assertBytes(plaintext, "Files content plaintext");
  if (
    plaintext.byteLength !== binding.plaintextBlockLength ||
    plaintext.byteLength > FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("Files content block length does not match its binding");
  }
  return encryptAesGcm(
    cipher,
    contentBlockNonce(binding.blockIndex),
    contentBlockAad(context, binding),
    plaintext,
  );
}

export async function decryptContentBlock(
  cipher: FilesAesGcmKey,
  context: Uint8Array,
  binding: FilesContentBlockBinding,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  assertContentBlockBinding(binding);
  assertBytes(ciphertext, "Files content ciphertext");
  if (
    ciphertext.byteLength !==
    binding.plaintextBlockLength + FILES_AES_GCM_TAG_BYTES
  ) {
    throw new Error("Files content ciphertext length does not match its binding");
  }
  const plaintext = await decryptAesGcm(
    cipher,
    contentBlockNonce(binding.blockIndex),
    contentBlockAad(context, binding),
    ciphertext,
  );
  if (plaintext.byteLength !== binding.plaintextBlockLength) {
    zeroBytes(plaintext);
    throw new Error("Files decrypted content length does not match");
  }
  return plaintext;
}

function planPrivateBlockLengthsUnchecked(
  plaintextBytes: number,
): number[] {
  if (plaintextBytes === 0) return [0];
  const count = Math.ceil(
    plaintextBytes / FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES,
  );
  return [
    plaintextBytes -
      (count - 1) * FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES,
    ...Array.from(
      { length: count - 1 },
      () => FILES_PRIVATE_BLOCK_MAX_PLAINTEXT_BYTES,
    ),
  ];
}
