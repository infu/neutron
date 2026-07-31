import {
  FILES_PRIVATE_FILE_MAX_BLOCKS,
  FILES_NAME_TAG_BYTES,
  FILES_SHA256_BYTES,
  FILES_VAULT_ID_BYTES,
  FILES_VAULT_SALT_BYTES,
  type FilesContentBinding,
  type FilesContentBlockBinding,
  type FilesId128,
  type FilesMetadataBinding,
  type FilesVaultContextInput,
  nodeKindByte,
} from "./types.ts";

const encoder = new TextEncoder();
const MAX_U8 = 0xff;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export function utf8(value: string): Uint8Array {
  if (typeof value !== "string") throw new Error("Files text is invalid");
  return encoder.encode(value);
}

export function nfcUtf8(value: string): Uint8Array {
  return utf8(value.normalize("NFC"));
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => {
    if (!(part instanceof Uint8Array)) throw new Error("Files bytes are invalid");
    const next = sum + part.byteLength;
    if (!Number.isSafeInteger(next)) throw new Error("Files byte string is too large");
    return next;
  }, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function lp(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? utf8(value) : copyBytes(value);
  return concatBytes(u32be(bytes.byteLength), bytes);
}

export function u8(value: number): Uint8Array {
  return Uint8Array.of(assertUnsignedNumber(value, MAX_U8, "u8"));
}

export function u16be(value: number): Uint8Array {
  const checked = assertUnsignedNumber(value, MAX_U16, "u16");
  return Uint8Array.of(checked >>> 8, checked);
}

export function u32be(value: number): Uint8Array {
  const checked = assertUnsignedNumber(value, MAX_U32, "u32");
  return Uint8Array.of(
    checked >>> 24,
    checked >>> 16,
    checked >>> 8,
    checked,
  );
}

export function u64be(value: bigint | string): Uint8Array {
  const checked = assertU64(value, "u64");
  const output = new Uint8Array(8);
  let remaining = checked;
  for (let index = output.byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

export function id128(value: FilesId128): Uint8Array {
  assertId128(value);
  return concatBytes(u64be(value.hi), u64be(value.lo));
}

export function isZeroId128(value: FilesId128): boolean {
  assertId128(value);
  return value.hi === "0" && value.lo === "0";
}

export function vaultContext(input: FilesVaultContextInput): Uint8Array {
  assertVaultContextInput(input);
  return concatBytes(
    lp("neutron.files.vault.v2"),
    lp(input.neutronCanisterPrincipalBytes),
    lp("files"),
    lp(input.vaultId),
    lp(input.vaultSalt),
  );
}

export function rootCommitmentInput(
  context: Uint8Array,
  vaultRoot: Uint8Array,
): Uint8Array {
  assertFixedBytes(vaultRoot, 32, "Files vault root");
  return concatBytes(
    lp("neutron.files.root-check.v2"),
    lp(context),
    vaultRoot,
  );
}

export function nameTagInput(
  parentNodeId: FilesId128,
  filename: string,
): Uint8Array {
  return concatBytes(
    lp("neutron.files.name.v2"),
    id128(parentNodeId),
    lp(nfcUtf8(filename)),
  );
}

export function metadataRecordKeyInput(
  nodeId: FilesId128,
  metadataRevision: string,
): Uint8Array {
  return concatBytes(
    lp("neutron.files.metadata-record-key.v2"),
    id128(nodeId),
    u64be(metadataRevision),
  );
}

export function contentRecordKeyInput(
  binding: FilesContentBinding,
): Uint8Array {
  assertContentBinding(binding);
  return concatBytes(
    lp("neutron.files.content-record-key.v2"),
    id128(binding.nodeId),
    id128(binding.contentId),
  );
}

export function metadataAad(
  context: Uint8Array,
  binding: FilesMetadataBinding,
): Uint8Array {
  assertMetadataBinding(binding);
  return concatBytes(
    lp("neutron.files.metadata.v2"),
    lp(context),
    id128(binding.nodeId),
    id128(binding.parentId),
    u8(nodeKindByte(binding.nodeKind)),
    u64be(binding.metadataRevision),
    u16be(binding.declaredNameScalars),
    binding.nameTag,
  );
}

export function contentKeyAad(
  context: Uint8Array,
  binding: FilesContentBinding,
): Uint8Array {
  assertContentBinding(binding);
  return concatBytes(
    lp("neutron.files.content-key.v2"),
    lp(context),
    id128(binding.nodeId),
    id128(binding.contentId),
  );
}

export function contentBlockAad(
  context: Uint8Array,
  binding: FilesContentBlockBinding,
): Uint8Array {
  assertContentBlockBinding(binding);
  return concatBytes(
    lp("neutron.files.content.v2"),
    lp(context),
    id128(binding.nodeId),
    id128(binding.contentId),
    u32be(binding.blockIndex),
    u32be(binding.totalBlockCount),
    u32be(binding.plaintextBlockLength),
  );
}

export function contentBlockNonce(blockIndex: number): Uint8Array {
  return concatBytes(u64be(0n), u32be(blockIndex));
}

export function assertVaultContextInput(
  input: FilesVaultContextInput,
): void {
  if (!input || typeof input !== "object") {
    throw new Error("Files vault context is invalid");
  }
  if (
    !(input.neutronCanisterPrincipalBytes instanceof Uint8Array) ||
    input.neutronCanisterPrincipalBytes.byteLength < 1 ||
    input.neutronCanisterPrincipalBytes.byteLength > 29
  ) {
    throw new Error("Files canister principal bytes are invalid");
  }
  assertFixedBytes(input.vaultId, FILES_VAULT_ID_BYTES, "Files vault id");
  assertFixedBytes(input.vaultSalt, FILES_VAULT_SALT_BYTES, "Files vault salt");
}

export function assertId128(value: FilesId128): void {
  if (!value || typeof value !== "object") throw new Error("Files id is invalid");
  assertU64(value.hi, "Files id high word");
  assertU64(value.lo, "Files id low word");
}

export function assertNonzeroId128(value: FilesId128, label = "Files id"): void {
  assertId128(value);
  if (value.hi === "0" && value.lo === "0") {
    throw new Error(`${label} must be nonzero`);
  }
}

export function assertMetadataBinding(binding: FilesMetadataBinding): void {
  if (!binding || typeof binding !== "object") {
    throw new Error("Files metadata binding is invalid");
  }
  assertId128(binding.nodeId);
  assertId128(binding.parentId);
  nodeKindByte(binding.nodeKind);
  assertU64(binding.metadataRevision, "Files metadata revision");
  if (binding.metadataRevision === "0") {
    throw new Error("Files metadata revision must be positive");
  }
  assertUnsignedNumber(
    binding.declaredNameScalars,
    100,
    "Files declared name scalars",
  );
  const root = isZeroId128(binding.nodeId);
  if (
    (root && binding.declaredNameScalars !== 0) ||
    (!root && binding.declaredNameScalars < 1)
  ) {
    throw new Error("Files declared name scalars do not match node identity");
  }
  assertFixedBytes(binding.nameTag, FILES_NAME_TAG_BYTES, "Files name tag");
  if (
    root &&
    (binding.nodeKind !== "folder" ||
      !isZeroId128(binding.parentId) ||
      binding.nameTag.some((byte) => byte !== 0))
  ) {
    throw new Error("Files root metadata binding is invalid");
  }
}

export function assertContentBinding(binding: FilesContentBinding): void {
  if (!binding || typeof binding !== "object") {
    throw new Error("Files content binding is invalid");
  }
  assertNonzeroId128(binding.nodeId, "Files content node id");
  assertNonzeroId128(binding.contentId, "Files content id");
}

export function assertContentBlockBinding(
  binding: FilesContentBlockBinding,
): void {
  assertContentBinding(binding);
  assertUnsignedNumber(
    binding.blockIndex,
    FILES_PRIVATE_FILE_MAX_BLOCKS - 1,
    "Files content block index",
  );
  if (
    !Number.isSafeInteger(binding.totalBlockCount) ||
    binding.totalBlockCount < 1 ||
    binding.totalBlockCount > FILES_PRIVATE_FILE_MAX_BLOCKS ||
    binding.blockIndex >= binding.totalBlockCount
  ) {
    throw new Error("Files content block count is invalid");
  }
  assertUnsignedNumber(
    binding.plaintextBlockLength,
    1_889_984,
    "Files plaintext block length",
  );
  if (binding.totalBlockCount > 1 && binding.plaintextBlockLength < 1) {
    throw new Error("Files nonempty content block is invalid");
  }
}

export function assertFixedBytes(
  value: Uint8Array,
  length: number,
  label: string,
): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
}

export function assertBytes(
  value: Uint8Array,
  label: string,
): void {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be bytes`);
}

export function copyBytes(value: Uint8Array): Uint8Array {
  assertBytes(value, "Files value");
  return value.slice();
}

export function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function assertSha256(value: Uint8Array, label: string): void {
  assertFixedBytes(value, FILES_SHA256_BYTES, label);
}

export function assertU64(
  value: bigint | string,
  label: string,
): bigint {
  if (
    typeof value !== "bigint" &&
    (typeof value !== "string" ||
      value.length < 1 ||
      value.length > 20 ||
      !/^(0|[1-9][0-9]*)$/u.test(value))
  ) {
    throw new Error(`${label} is outside Nat64`);
  }
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > MAX_U64) {
    throw new Error(`${label} is outside Nat64`);
  }
  return parsed;
}

function assertUnsignedNumber(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} is outside its bound`);
  }
  return value;
}
