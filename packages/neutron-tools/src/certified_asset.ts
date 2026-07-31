import {
  Cbor,
  Certificate,
  LookupPathStatus,
  lookup_path,
  reconstruct,
  type HashTree,
} from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { Gunzip } from "fflate";
import { sha256 } from "js-sha256";

const MIB = 1024 * 1024;
const GZIP_INPUT_SLICE_BYTES = 1024;
const textEncoder = new TextEncoder();
const crc32Table = createCrc32Table();

export type CertifiedAssetBlob =
  | Uint8Array
  | ArrayBuffer
  | ArrayLike<number>;

export type KernelStaticReadInput = {
  key: string;
  index: bigint;
};

export type KernelStaticReadAsset = {
  content: CertifiedAssetBlob;
  chunks: bigint | number;
};

export type KernelStaticReadResponse = {
  certificate: CertifiedAssetBlob;
  witness: CertifiedAssetBlob;
  asset: readonly KernelStaticReadAsset[];
};

export type KernelStaticRead = (
  input: KernelStaticReadInput
) => Promise<KernelStaticReadResponse>;

export type CertifiedAssetLimits = {
  maxChunks: number;
  maxChunkBytes: number;
  maxEncodedBytes: number;
  maxCertificateBytes: number;
  maxWitnessBytes: number;
};

export type CertifiedAssetReaderOptions = {
  readChunk: KernelStaticRead;
  canisterId: string;
  rootKey: CertifiedAssetBlob;
  limits?: Partial<CertifiedAssetLimits>;
};

export type CertifiedAssetDecodeOptions = {
  maxDecodedBytes: number;
};

export type CertifiedAssetReader = {
  readRaw(key: string): Promise<Uint8Array | undefined>;
  readText(
    key: string,
    options: CertifiedAssetDecodeOptions
  ): Promise<string | undefined>;
  readJson<T = unknown>(
    key: string,
    options: CertifiedAssetDecodeOptions
  ): Promise<T | undefined>;
};

export type CertifiedAssetErrorCode =
  | "invalid_configuration"
  | "invalid_response"
  | "size_limit"
  | "invalid_certificate"
  | "invalid_witness"
  | "certified_data_mismatch"
  | "uncertified_path"
  | "presence_mismatch"
  | "hash_mismatch"
  | "decompression"
  | "text_decode"
  | "json_decode";

export class CertifiedAssetError extends Error {
  readonly code: CertifiedAssetErrorCode;

  constructor(
    code: CertifiedAssetErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CertifiedAssetError";
    this.code = code;
  }
}

export const CERTIFIED_ASSET_DEFAULT_LIMITS: Readonly<CertifiedAssetLimits> = {
  maxChunks: 64,
  maxChunkBytes: MIB,
  maxEncodedBytes: 32 * MIB,
  maxCertificateBytes: 64 * 1024,
  maxWitnessBytes: MIB,
};

type VerifiedProof =
  | { status: "absent" }
  | {
      status: "found";
      hash: Uint8Array;
      asset: KernelStaticReadAsset;
    };

type ProofContext = {
  canisterId: Principal;
  rootKey: Uint8Array;
  limits: CertifiedAssetLimits;
};

export function createCertifiedAssetReader(
  options: CertifiedAssetReaderOptions
): CertifiedAssetReader {
  if (typeof options.readChunk !== "function") {
    throw new CertifiedAssetError(
      "invalid_configuration",
      "Certified asset reader requires a readChunk callback"
    );
  }
  if (typeof options.canisterId !== "string" || options.canisterId === "") {
    throw new CertifiedAssetError(
      "invalid_configuration",
      "Certified asset reader requires a canister id"
    );
  }

  let canisterId: Principal;
  try {
    canisterId = Principal.fromText(options.canisterId);
  } catch (cause) {
    throw new CertifiedAssetError(
      "invalid_configuration",
      "Certified asset reader received an invalid canister id",
      { cause }
    );
  }

  const rootKey = toBytes(options.rootKey, "root key");
  if (rootKey.byteLength === 0) {
    throw new CertifiedAssetError(
      "invalid_configuration",
      "Certified asset reader requires a non-empty root key"
    );
  }

  const limits = resolveLimits(options.limits);
  const context: ProofContext = { canisterId, rootKey, limits };

  async function readRaw(key: string): Promise<Uint8Array | undefined> {
    assertCanonicalKey(key);

    // Transport errors intentionally propagate unchanged and stay closed.
    const firstResponse = await options.readChunk({ key, index: 0n });
    const firstProof = await verifyResponseProof(firstResponse, key, context);
    if (firstProof.status === "absent") return undefined;

    const chunkCount = parseChunkCount(
      firstProof.asset.chunks,
      limits.maxChunks,
      key
    );
    const chunks: Uint8Array[] = [];
    let encodedBytes = 0;

    const appendChunk = (content: CertifiedAssetBlob, index: number): void => {
      const chunk = toBytes(content, `asset chunk ${index}`);
      if (chunk.byteLength > limits.maxChunkBytes) {
        throw new CertifiedAssetError(
          "size_limit",
          `Certified asset '${key}' chunk ${index} exceeds ${limits.maxChunkBytes} bytes`
        );
      }
      if (encodedBytes > limits.maxEncodedBytes - chunk.byteLength) {
        throw new CertifiedAssetError(
          "size_limit",
          `Certified asset '${key}' exceeds ${limits.maxEncodedBytes} encoded bytes`
        );
      }
      chunks.push(chunk);
      encodedBytes += chunk.byteLength;
    };

    appendChunk(firstProof.asset.content, 0);

    for (let index = 1; index < chunkCount; index += 1) {
      const response = await options.readChunk({ key, index: BigInt(index) });
      const proof = await verifyResponseProof(response, key, context);
      if (proof.status !== "found") {
        throw new CertifiedAssetError(
          "presence_mismatch",
          `Certified asset '${key}' disappeared while reading chunk ${index}`
        );
      }
      if (!bytesEqual(proof.hash, firstProof.hash)) {
        throw new CertifiedAssetError(
          "hash_mismatch",
          `Certified asset '${key}' changed while reading chunks`
        );
      }
      const responseChunkCount = parseChunkCount(
        proof.asset.chunks,
        limits.maxChunks,
        key
      );
      if (responseChunkCount !== chunkCount) {
        throw new CertifiedAssetError(
          "invalid_response",
          `Certified asset '${key}' changed its declared chunk count`
        );
      }
      appendChunk(proof.asset.content, index);
    }

    const hash = sha256.create();
    for (const chunk of chunks) hash.update(chunk);
    if (hash.hex() !== bytesToHex(firstProof.hash)) {
      throw new CertifiedAssetError(
        "hash_mismatch",
        `Certified asset '${key}' content does not match its certified hash`
      );
    }

    const result = new Uint8Array(encodedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  return {
    readRaw,
    async readText(key, decodeOptions) {
      const bytes = await readRaw(key);
      return bytes === undefined
        ? undefined
        : decodeCertifiedAssetText(bytes, decodeOptions);
    },
    async readJson<T>(key: string, decodeOptions: CertifiedAssetDecodeOptions) {
      const bytes = await readRaw(key);
      return bytes === undefined
        ? undefined
        : decodeCertifiedAssetJson<T>(bytes, decodeOptions);
    },
  };
}

export function decodeCertifiedAssetBytes(
  verifiedBytes: Uint8Array,
  options: CertifiedAssetDecodeOptions
): Uint8Array {
  const maxDecodedBytes = parseDecodedLimit(options?.maxDecodedBytes);
  if (!hasGzipMagic(verifiedBytes)) {
    if (verifiedBytes.byteLength > maxDecodedBytes) {
      throw new CertifiedAssetError(
        "size_limit",
        `Certified asset exceeds ${maxDecodedBytes} decoded bytes`
      );
    }
    return verifiedBytes.slice();
  }
  if (
    verifiedBytes.byteLength < 18 ||
    verifiedBytes[2] !== 8 ||
    (verifiedBytes[3]! & 0xe0) !== 0
  ) {
    throw new CertifiedAssetError(
      "decompression",
      "Certified gzip asset has an invalid envelope"
    );
  }

  const chunks: Uint8Array[] = [];
  let decodedBytes = 0;
  let finished = false;
  let members = 1;

  try {
    const gunzip = new Gunzip((chunk, final) => {
      if (decodedBytes > maxDecodedBytes - chunk.byteLength) {
        throw new CertifiedAssetError(
          "size_limit",
          `Certified gzip asset exceeds ${maxDecodedBytes} decoded bytes`
        );
      }
      if (chunk.byteLength > 0) chunks.push(chunk.slice());
      decodedBytes += chunk.byteLength;
      finished = final;
    });
    gunzip.onmember = () => {
      members += 1;
      throw new CertifiedAssetError(
        "decompression",
        "Concatenated gzip members are not supported"
      );
    };

    for (
      let offset = 0;
      offset < verifiedBytes.byteLength;
      offset += GZIP_INPUT_SLICE_BYTES
    ) {
      const end = Math.min(
        offset + GZIP_INPUT_SLICE_BYTES,
        verifiedBytes.byteLength
      );
      gunzip.push(
        verifiedBytes.subarray(offset, end),
        end === verifiedBytes.byteLength
      );
    }
  } catch (cause) {
    if (cause instanceof CertifiedAssetError) throw cause;
    throw new CertifiedAssetError(
      "decompression",
      "Certified gzip asset could not be decompressed",
      { cause }
    );
  }

  if (!finished || members !== 1) {
    throw new CertifiedAssetError(
      "decompression",
      "Certified gzip asset ended before decompression completed"
    );
  }

  const result = new Uint8Array(decodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const expectedCrc32 = readUint32Le(
    verifiedBytes,
    verifiedBytes.byteLength - 8
  );
  const expectedSize = readUint32Le(
    verifiedBytes,
    verifiedBytes.byteLength - 4
  );
  if (
    crc32(result) !== expectedCrc32 ||
    decodedBytes % 0x1_0000_0000 !== expectedSize
  ) {
    throw new CertifiedAssetError(
      "decompression",
      "Certified gzip asset has an invalid checksum or size footer"
    );
  }
  return result;
}

export function decodeCertifiedAssetText(
  verifiedBytes: Uint8Array,
  options: CertifiedAssetDecodeOptions
): string {
  const decoded = decodeCertifiedAssetBytes(verifiedBytes, options);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch (cause) {
    throw new CertifiedAssetError(
      "text_decode",
      "Certified asset is not valid UTF-8 text",
      { cause }
    );
  }
}

export function decodeCertifiedAssetJson<T = unknown>(
  verifiedBytes: Uint8Array,
  options: CertifiedAssetDecodeOptions
): T {
  const text = decodeCertifiedAssetText(verifiedBytes, options);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new CertifiedAssetError(
      "json_decode",
      "Certified asset is not valid JSON",
      { cause }
    );
  }
}

async function verifyResponseProof(
  response: KernelStaticReadResponse,
  key: string,
  context: ProofContext
): Promise<VerifiedProof> {
  if (!response || typeof response !== "object") {
    throw new CertifiedAssetError(
      "invalid_response",
      `Certified asset '${key}' returned a malformed response`
    );
  }

  const certificateBytes = toBytes(response.certificate, "certificate");
  const witnessBytes = toBytes(response.witness, "witness");
  if (certificateBytes.byteLength > context.limits.maxCertificateBytes) {
    throw new CertifiedAssetError(
      "size_limit",
      `Certified asset certificate exceeds ${context.limits.maxCertificateBytes} bytes`
    );
  }
  if (witnessBytes.byteLength > context.limits.maxWitnessBytes) {
    throw new CertifiedAssetError(
      "size_limit",
      `Certified asset witness exceeds ${context.limits.maxWitnessBytes} bytes`
    );
  }

  let certificate: Certificate;
  try {
    certificate = await Certificate.create({
      certificate: certificateBytes,
      rootKey: context.rootKey,
      principal: { canisterId: context.canisterId },
    });
  } catch (cause) {
    throw new CertifiedAssetError(
      "invalid_certificate",
      `Certified asset '${key}' returned an invalid or stale certificate`,
      { cause }
    );
  }

  let witness: HashTree;
  let witnessRoot: Uint8Array;
  try {
    witness = Cbor.decode<HashTree>(witnessBytes);
    witnessRoot = await reconstruct(witness);
  } catch (cause) {
    throw new CertifiedAssetError(
      "invalid_witness",
      `Certified asset '${key}' returned an invalid witness`,
      { cause }
    );
  }

  const certifiedData = certificate.lookup_path([
    "canister",
    context.canisterId.toUint8Array(),
    "certified_data",
  ]);
  if (
    certifiedData.status !== LookupPathStatus.Found ||
    !bytesEqual(certifiedData.value, witnessRoot)
  ) {
    throw new CertifiedAssetError(
      "certified_data_mismatch",
      `Certified asset '${key}' witness does not match canister certified data`
    );
  }

  const assetLookup = lookup_path(
    [textEncoder.encode("http_assets"), textEncoder.encode(key)],
    witness
  );
  if (
    assetLookup.status === LookupPathStatus.Unknown ||
    assetLookup.status === LookupPathStatus.Error
  ) {
    throw new CertifiedAssetError(
      "uncertified_path",
      `Certified asset '${key}' witness does not prove the exact path`
    );
  }

  if (!Array.isArray(response.asset) || response.asset.length > 1) {
    throw new CertifiedAssetError(
      "invalid_response",
      `Certified asset '${key}' returned a malformed optional asset`
    );
  }

  if (assetLookup.status === LookupPathStatus.Absent) {
    if (response.asset.length !== 0) {
      throw new CertifiedAssetError(
        "presence_mismatch",
        `Certified asset '${key}' returned bytes with a proof of absence`
      );
    }
    return { status: "absent" };
  }

  const asset = response.asset[0];
  if (!asset) {
    throw new CertifiedAssetError(
      "presence_mismatch",
      `Certified asset '${key}' returned no bytes with a proof of presence`
    );
  }
  if (assetLookup.value.byteLength !== 32) {
    throw new CertifiedAssetError(
      "invalid_witness",
      `Certified asset '${key}' leaf is not a SHA-256 hash`
    );
  }
  return { status: "found", hash: assetLookup.value.slice(), asset };
}

function resolveLimits(
  overrides: Partial<CertifiedAssetLimits> | undefined
): CertifiedAssetLimits {
  const limits: CertifiedAssetLimits = {
    ...CERTIFIED_ASSET_DEFAULT_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CertifiedAssetError(
        "invalid_configuration",
        `Certified asset ${name} must be a positive safe integer`
      );
    }
  }
  return limits;
}

function parseChunkCount(
  value: bigint | number,
  maxChunks: number,
  key: string
): number {
  if (typeof value === "bigint") {
    if (value < 1n || value > BigInt(maxChunks)) {
      throw new CertifiedAssetError(
        "size_limit",
        `Certified asset '${key}' has an invalid or excessive chunk count`
      );
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maxChunks) {
    throw new CertifiedAssetError(
      "size_limit",
      `Certified asset '${key}' has an invalid or excessive chunk count`
    );
  }
  return value;
}

function parseDecodedLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
    throw new CertifiedAssetError(
      "invalid_configuration",
      "maxDecodedBytes must be a non-negative safe integer"
    );
  }
  return value;
}

function assertCanonicalKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    !key.startsWith("/") ||
    key.includes("?") ||
    key.includes("#") ||
    key.includes("\0")
  ) {
    throw new CertifiedAssetError(
      "invalid_configuration",
      "Certified asset key must be a canonical absolute path"
    );
  }
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function toBytes(value: CertifiedAssetBlob, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.length) ||
    value.length < 0
  ) {
    throw new CertifiedAssetError(
      "invalid_response",
      `Certified asset ${label} is not a byte array`
    );
  }

  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte === undefined || byte < 0 || byte > 255) {
      throw new CertifiedAssetError(
        "invalid_response",
        `Certified asset ${label} contains a non-byte value`
      );
    }
    bytes[index] = byte;
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crc32Table[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}
