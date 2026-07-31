import type { JsonObject, JsonValue, MsgBusEndpointId } from "neutron-tools/app";
import { callToolWithAttachments } from "./attachment_transport.ts";
import {
  type BinaryFileMetadata,
  type BinaryFileRead,
  FilePortError,
  type WorkbookFilesPort,
} from "./file_ports.ts";

const FILES_TARGET = "app:files:background" as MsgBusEndpointId;
const SHA_256_ETAG = /^[a-f0-9]{64}$/u;
const GENERIC_BINARY_MEDIA_TYPE = "application/octet-stream";
// This is the Files attachment protocol allowlist. Persisted media types that
// are not representable by the protocol travel as application/octet-stream.
const FILES_ATTACHMENT_MEDIA_TYPES = new Set([
  GENERIC_BINARY_MEDIA_TYPE,
  "application/vnd.neutron.spreadsheet+json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/json",
  "application/zip",
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export class NeutronFilesPort implements WorkbookFilesPort {
  constructor(
    private readonly callAttachments: typeof callToolWithAttachments = callToolWithAttachments,
  ) {}

  async readBinary(path: string, options: { ifMatch?: string; delegationToken?: string } = {}): Promise<BinaryFileRead> {
    const result = await this.callAttachments({
      target: FILES_TARGET,
      name: "readBinary",
      arguments: {
        path,
        ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
      },
    }, [], { ...(options.delegationToken ? { delegationToken: options.delegationToken } : {}) });
    const metadata = parseMetadata(result.value);
    if (metadata.path !== path) {
      throw invalidResponse("path does not match the requested file");
    }
    if (options.ifMatch !== undefined && metadata.etag !== options.ifMatch) {
      throw invalidResponse("etag does not match the requested version");
    }
    const attachment = result.attachments[0];
    if (
      result.attachments.length !== 1 ||
      !attachment ||
      attachment.name !== "file" ||
      !(attachment.data instanceof ArrayBuffer) ||
      attachment.byteLength !== metadata.byteLength ||
      attachment.data.byteLength !== metadata.byteLength
    ) {
      throw invalidResponse("attachment length does not match its metadata");
    }
    if (baseMediaType(attachment.mediaType) !== attachmentMediaType(metadata.mediaType)) {
      throw invalidResponse("attachment media type does not match its metadata");
    }
    const data = attachment.data.slice(0);
    if (await sha256Hex(data) !== metadata.etag) {
      throw invalidResponse("attachment bytes do not match their SHA-256 etag");
    }
    return { ...metadata, data };
  }

  async writeBinary(
    path: string,
    mediaType: string,
    data: ArrayBuffer,
    condition: { ifMatch: string } | { ifNoneMatch: "*" },
    options: { delegationToken?: string } = {},
  ): Promise<BinaryFileMetadata> {
    if (!(data instanceof ArrayBuffer)) {
      throw invalidResponse("write data is not an ArrayBuffer");
    }
    const payload = data.slice(0);
    const expectedByteLength = payload.byteLength;
    const expectedMediaType = normalizeMediaType(mediaType);
    const expectedEtag = await sha256Hex(payload);
    const result = await this.callAttachments(
      {
        target: FILES_TARGET,
        name: "writeBinary",
        arguments: { path, mediaType: expectedMediaType, createParents: true, ...condition } as JsonObject,
      },
      [{
        name: "file",
        mediaType: attachmentMediaType(expectedMediaType),
        byteLength: expectedByteLength,
        data: payload,
      }],
      { ...(options.delegationToken ? { delegationToken: options.delegationToken } : {}) },
    );
    const metadata = parseMetadata(result.value);
    if (
      metadata.path !== path ||
      metadata.mediaType !== expectedMediaType ||
      metadata.byteLength !== expectedByteLength ||
      result.attachments.length !== 0 ||
      metadata.etag !== expectedEtag
    ) {
      throw invalidResponse("write result does not match the requested file and bytes");
    }
    return metadata;
  }
}

function parseMetadata(value: JsonValue): BinaryFileMetadata {
  if (!isObject(value)) throw invalidResponse("metadata is not an object");
  const path = requiredString(value.path, "path");
  const mediaType = normalizeMediaType(requiredString(value.mediaType, "mediaType"));
  const etag = requiredString(value.etag, "etag");
  if (!SHA_256_ETAG.test(etag)) {
    throw invalidResponse("etag is not a lowercase SHA-256 digest");
  }
  const byteLength = value.byteLength;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
    throw invalidResponse("byteLength is invalid");
  }
  if (value.size !== undefined && value.size !== byteLength) {
    throw invalidResponse("size and byteLength disagree");
  }
  if (value.etagSha256 !== undefined && value.etagSha256 !== etag) {
    throw invalidResponse("etag aliases disagree");
  }
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))) {
    throw invalidResponse("updatedAt is invalid");
  }
  const updatedAt = value.updatedAt as number | undefined;
  return { path, mediaType, etag, byteLength: byteLength as number, ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value) throw invalidResponse(`metadata is missing ${name}`);
  return value;
}

function normalizeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"-]+)*$/u.test(normalized)
  ) {
    throw invalidResponse("mediaType is invalid");
  }
  return normalized;
}

function baseMediaType(value: string): string {
  return normalizeMediaType(value).split(";", 1)[0]!;
}

function attachmentMediaType(value: string): string {
  const base = baseMediaType(value);
  return FILES_ATTACHMENT_MEDIA_TYPES.has(base) ? base : GENERIC_BINARY_MEDIA_TYPE;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function invalidResponse(reason: string): FilePortError {
  return new FilePortError(
    "FILES_INVALID_RESPONSE",
    "Files returned binary metadata or content that failed integrity validation",
    { reason },
  );
}

function isObject(value: JsonValue): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
