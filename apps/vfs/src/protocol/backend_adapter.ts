import {
  querySelf,
  updateSelf,
  type JsonValue,
  type SelfCallObject,
  type SelfCallValue,
} from "neutron-tools/app";
import {
  FILES_V2_METHOD_CONTRACTS,
  FILES_V2_METHODS,
  type FilesV2Method,
} from "./constants.ts";
import { FilesProtocolValueError } from "./ids.ts";
import {
  bodyForSuccessfulOutcome,
  parseFilesReadChunkResponse,
} from "./parsers.ts";
import type {
  FilesAbortOkV2,
  FilesAbortRequestV2,
  FilesAttachmentOutcomeV2,
  FilesBootstrapOkV2,
  FilesBootstrapRequestV2,
  FilesCleanupOkV2,
  FilesCleanupRequestV2,
  FilesListOkV2,
  FilesListRequestV2,
  FilesLookupOkV2,
  FilesLookupRequestV2,
  FilesMutateOkV2,
  FilesMutateRequestV2,
  FilesOperationStatusOkV2,
  FilesOperationStatusRequestV2,
  FilesOutcomeV2,
  FilesReadChunkOutcomeV2,
  FilesReadChunkRequestV2,
  FilesRemoveOkV2,
  FilesRemoveRequestV2,
  FilesVaultWriteOkV2,
  FilesVaultWriteRequestV2,
  FilesWriteBlockOkV2,
  FilesWriteBlockRequestV2,
} from "./types.ts";
import {
  assertFilesInputBodyLength,
  encodeFilesV2Request,
  expectedFilesOutputBodyBytes,
  parseFilesV2Response,
} from "./wire.ts";

export type FilesSelfCallTransport = Readonly<{
  query(
    method: string,
    args: FilesSelfCallValue[],
    timeoutSeconds: number,
  ): Promise<FilesSelfCallValue>;
  update(
    method: string,
    args: FilesSelfCallValue[],
    timeoutSeconds: number,
  ): Promise<FilesSelfCallValue>;
}>;

export type FilesSelfCallValue = SelfCallValue;
export type FilesSelfCallObject = SelfCallObject;

export type FilesBackendAdapterOptions = Readonly<{
  queryTimeoutSeconds?: number;
  updateTimeoutSeconds?: number;
}>;

const DEFAULT_QUERY_TIMEOUT_SECONDS = 30;
const DEFAULT_UPDATE_TIMEOUT_SECONDS = 120;

export const DEFAULT_FILES_SELF_CALL_TRANSPORT: FilesSelfCallTransport =
  Object.freeze({
    query: (method, args, timeoutSeconds) =>
      querySelf<FilesSelfCallValue>(method, args, timeoutSeconds),
    update: (method, args, timeoutSeconds) =>
      updateSelf<FilesSelfCallValue>(method, args, timeoutSeconds),
  });

/**
 * Stable resident boundary for Files' private Vault backend methods.
 *
 * Binary bodies are ordinary `Blob` fields in the named Candid records. The
 * adapter snapshots Uint8Arrays at the shared self-call boundary and retains
 * Files' tighter semantic per-method byte limits.
 */
export class FilesBackendAdapter {
  readonly #queryTimeoutSeconds: number;
  readonly #updateTimeoutSeconds: number;

  constructor(
    private readonly transport: FilesSelfCallTransport =
      DEFAULT_FILES_SELF_CALL_TRANSPORT,
    options: FilesBackendAdapterOptions = {},
  ) {
    this.#queryTimeoutSeconds = timeout(
      options.queryTimeoutSeconds ?? DEFAULT_QUERY_TIMEOUT_SECONDS,
      "query timeout",
    );
    this.#updateTimeoutSeconds = timeout(
      options.updateTimeoutSeconds ?? DEFAULT_UPDATE_TIMEOUT_SECONDS,
      "update timeout",
    );
  }

  bootstrap(
    request: FilesBootstrapRequestV2 = {},
  ): Promise<FilesAttachmentOutcomeV2<FilesBootstrapOkV2>> {
    return this.#queryBlobOutput(FILES_V2_METHODS.bootstrap, request);
  }

  list(
    request: FilesListRequestV2,
  ): Promise<FilesAttachmentOutcomeV2<FilesListOkV2>> {
    return this.#queryBlobOutput(FILES_V2_METHODS.list, request);
  }

  lookup(
    request: FilesLookupRequestV2,
  ): Promise<FilesAttachmentOutcomeV2<FilesLookupOkV2>> {
    const blindTag = request.body;
    if (
      !(blindTag instanceof Uint8Array) ||
      (blindTag.byteLength !== 0 && blindTag.byteLength !== 32)
    ) {
      throw new FilesProtocolValueError(
        "FILES_LOOKUP_BLOB_INVALID",
        "Lookup input must contain exactly zero or 32 bytes",
      );
    }
    if (
      request.locator !== null &&
      (("node" in request.locator && blindTag.byteLength !== 0) ||
        ("child" in request.locator && blindTag.byteLength !== 32))
    ) {
      throw new FilesProtocolValueError(
        "FILES_LOOKUP_BLOB_INVALID",
        "Node lookup requires zero bytes and child lookup requires a 32-byte blind tag",
      );
    }
    return this.#queryBlobOutput(FILES_V2_METHODS.lookup, request);
  }

  async readChunk(
    request: FilesReadChunkRequestV2,
  ): Promise<FilesReadChunkOutcomeV2> {
    const encoded = encodeFilesV2Request(FILES_V2_METHODS.readChunk, request);
    const result = await this.#rawBlobQuery(
      FILES_V2_METHODS.readChunk,
      encoded,
    );
    return parseFilesReadChunkResponse(result.value, result.body);
  }

  operationStatus(
    request: FilesOperationStatusRequestV2,
  ): Promise<FilesOutcomeV2<FilesOperationStatusOkV2>> {
    return this.#query(FILES_V2_METHODS.operationStatus, request);
  }

  vaultWrite(
    request: FilesVaultWriteRequestV2,
  ): Promise<FilesOutcomeV2<FilesVaultWriteOkV2>> {
    return this.#updateInputBlob(FILES_V2_METHODS.vaultWrite, request);
  }

  writeBlock(
    request: FilesWriteBlockRequestV2,
  ): Promise<FilesOutcomeV2<FilesWriteBlockOkV2>> {
    return this.#updateInputBlob(FILES_V2_METHODS.writeBlock, request);
  }

  mutate(
    request: FilesMutateRequestV2,
  ): Promise<FilesOutcomeV2<FilesMutateOkV2>> {
    return this.#updateInputBlob(FILES_V2_METHODS.mutate, request);
  }

  remove(
    request: FilesRemoveRequestV2,
  ): Promise<FilesOutcomeV2<FilesRemoveOkV2>> {
    return this.#update(FILES_V2_METHODS.remove, request);
  }

  abort(
    request: FilesAbortRequestV2,
  ): Promise<FilesOutcomeV2<FilesAbortOkV2>> {
    return this.#update(FILES_V2_METHODS.abort, request);
  }

  cleanup(
    request: FilesCleanupRequestV2 = {},
  ): Promise<FilesOutcomeV2<FilesCleanupOkV2>> {
    if (Object.keys(request).length !== 0) {
      throw new FilesProtocolValueError(
        "FILES_CLEANUP_REQUEST_INVALID",
        "files_cleanup_v2 requires the canonical empty request",
      );
    }
    return this.#update(FILES_V2_METHODS.cleanup, request);
  }

  async #query<
    M extends typeof FILES_V2_METHODS.operationStatus,
  >(
    method: M,
    request: import("./wire.ts").FilesV2RequestByMethod[M],
  ): Promise<FilesOutcomeV2<import("./wire.ts").FilesV2OkByMethod[M]>> {
    assertPlainMethod(method, "query");
    const encoded = encodeFilesV2Request(method, request);
    const value = await this.transport.query(
      method,
      [encoded],
      this.#queryTimeoutSeconds,
    );
    return parseFilesV2Response(method, value);
  }

  async #update<
    M extends
      | typeof FILES_V2_METHODS.remove
      | typeof FILES_V2_METHODS.abort
      | typeof FILES_V2_METHODS.cleanup,
  >(
    method: M,
    request: import("./wire.ts").FilesV2RequestByMethod[M],
  ): Promise<FilesOutcomeV2<import("./wire.ts").FilesV2OkByMethod[M]>> {
    assertPlainMethod(method, "update");
    const encoded = encodeFilesV2Request(method, request);
    const value = await this.transport.update(
      method,
      [encoded],
      this.#updateTimeoutSeconds,
    );
    return parseFilesV2Response(method, value);
  }

  async #queryBlobOutput<
    M extends
      | typeof FILES_V2_METHODS.bootstrap
      | typeof FILES_V2_METHODS.list
      | typeof FILES_V2_METHODS.lookup,
  >(
    method: M,
    request: import("./wire.ts").FilesV2RequestByMethod[M],
  ): Promise<FilesAttachmentOutcomeV2<import("./wire.ts").FilesV2OkByMethod[M]>> {
    const encoded = encodeFilesV2Request(method, request);
    const result = await this.#rawBlobQuery(method, encoded);
    const outcome = parseFilesV2Response(method, result.value);
    const body = bodyForSuccessfulOutcome(outcome, result.body);
    const expected = expectedFilesOutputBodyBytes(method, outcome);
    if (expected !== null && expected !== body.byteLength) {
      throw new FilesProtocolValueError(
        "FILES_BLOB_LENGTH_MISMATCH",
        `${method} body length does not match body_bytes`,
      );
    }
    return Object.freeze({
      ...outcome,
      body,
    }) as FilesAttachmentOutcomeV2<import("./wire.ts").FilesV2OkByMethod[M]>;
  }

  async #rawBlobQuery(
    method: FilesV2Method,
    request: FilesSelfCallObject,
  ): Promise<{ value: JsonValue; body: ArrayBuffer }> {
    const contract = FILES_V2_METHOD_CONTRACTS[method];
    if (contract.mode !== "query" || contract.outputBlobMaxBytes === 0) {
      throw new FilesProtocolValueError(
        "FILES_METHOD_CONTRACT_INVALID",
        `${method} is not a blob-bearing query`,
      );
    }
    if (contract.inputBlobMaxBytes > 0) {
      assertBlobBody(method, request.body, contract.inputBlobMaxBytes);
    }
    const result = await this.transport.query(
      method,
      [request],
      this.#queryTimeoutSeconds,
    );
    return splitBlobOutput(method, result, contract.outputBlobMaxBytes);
  }

  async #updateInputBlob<
    M extends
      | typeof FILES_V2_METHODS.vaultWrite
      | typeof FILES_V2_METHODS.writeBlock
      | typeof FILES_V2_METHODS.mutate,
  >(
    method: M,
    request: import("./wire.ts").FilesV2RequestByMethod[M],
  ): Promise<FilesOutcomeV2<import("./wire.ts").FilesV2OkByMethod[M]>> {
    const contract = FILES_V2_METHOD_CONTRACTS[method];
    if (contract.mode !== "update" || contract.inputBlobMaxBytes === 0) {
      throw new FilesProtocolValueError(
        "FILES_METHOD_CONTRACT_INVALID",
        `${method} is not a blob-bearing update`,
      );
    }
    const encoded = encodeFilesV2Request(method, request);
    assertBlobBody(
      method,
      encoded.body,
      contract.inputBlobMaxBytes,
    );
    assertFilesInputBodyLength(method, encoded);
    const value = await this.transport.update(
      method,
      [encoded],
      this.#updateTimeoutSeconds,
    );
    return parseFilesV2Response(method, value);
  }
}

function assertPlainMethod(
  method: FilesV2Method,
  mode: "query" | "update",
): void {
  const contract = FILES_V2_METHOD_CONTRACTS[method];
  if (
    contract.mode !== mode ||
    contract.inputBlobMaxBytes !== 0 ||
    contract.outputBlobMaxBytes !== 0
  ) {
    throw new FilesProtocolValueError(
      "FILES_METHOD_CONTRACT_INVALID",
      `${method} is not a plain ${mode} method`,
    );
  }
}

function assertBlobBody(
  method: FilesV2Method,
  body: unknown,
  maximumBytes: number,
): asserts body is Uint8Array {
  if (!(body instanceof Uint8Array)) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_INVALID",
      `${method} blob must be a Uint8Array`,
    );
  }
  if (body.byteLength > maximumBytes) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_TOO_LARGE",
      `${method} blob exceeds ${maximumBytes} bytes`,
    );
  }
}

function splitBlobOutput(
  method: FilesV2Method,
  result: FilesSelfCallValue,
  maximumBytes: number,
): { value: JsonValue; body: ArrayBuffer } {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    result instanceof Uint8Array ||
    result instanceof ArrayBuffer
  ) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_OUTPUT_INVALID",
      `${method} returned an invalid blob response record`,
    );
  }
  const keys = Object.keys(result);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(result, "value") ||
    !Object.prototype.hasOwnProperty.call(result, "body")
  ) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_OUTPUT_INVALID",
      `${method} blob response must contain exactly value and body`,
    );
  }
  const body = result.body;
  if (!(body instanceof Uint8Array)) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_OUTPUT_INVALID",
      `${method} response body is not a Uint8Array`,
    );
  }
  if (body.byteLength > maximumBytes) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_TOO_LARGE",
      `${method} response blob exceeds ${maximumBytes} bytes`,
    );
  }
  const value = result.value;
  if (value instanceof Uint8Array) {
    throw new FilesProtocolValueError(
      "FILES_BLOB_OUTPUT_INVALID",
      `${method} response value is not a record`,
    );
  }
  const copied = body.slice();
  return {
    value: value as JsonValue,
    body: copied.buffer as ArrayBuffer,
  };
}

function timeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 300) {
    throw new FilesProtocolValueError(
      "FILES_TIMEOUT_INVALID",
      `${label} must be within 1..300 seconds`,
    );
  }
  return value;
}
