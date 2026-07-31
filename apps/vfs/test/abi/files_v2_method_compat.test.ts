import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { IDL } from "@dfinity/candid";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonValue } from "neutron-tools/app";
import { generateFilesV2FutureCompat } from "../../scripts/generate_files_v2_future_compat.ts";
import {
  FILES_V2_METHODS,
  FilesBackendAdapter,
  parseCanonicalNat64,
  parseFilesId128,
  parseFilesV2Response,
  type FilesSelfCallTransport,
  type FilesSelfCallValue,
} from "../../src/protocol/index.ts";

const baselineDidUrl = new URL("../../candid/files-v2.did", import.meta.url);
const futureDidUrl = new URL(
  "../../candid/compat/files-v2-methods-future.did",
  import.meta.url,
);

type GeneratedBinding = Readonly<{
  idlFactory: IDL.InterfaceFactory;
}>;

let temporaryDirectory = "";
let baselineService: IDL.ServiceClass;
let futureService: IDL.ServiceClass;
let normalizeCandidBoundaryValue: (
  value: unknown,
  type: IDL.Type,
) => unknown;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "neutron-files-v2-method-compat-"),
  );
  // Load the production implementation at runtime: Files' TS project must not
  // absorb the kernel source graph merely to exercise this cross-boundary test.
  const normalizerModuleUrl = new URL(
    "../../../kernel/src/self_calls.ts",
    import.meta.url,
  ).href;
  const [baseline, future, normalizerModule] = await Promise.all([
    bindService(baselineDidUrl, "baseline"),
    bindService(futureDidUrl, "future"),
    import(normalizerModuleUrl) as Promise<{
      normalizeCandidBoundaryValue(
        value: unknown,
        type: IDL.Type,
      ): unknown;
    }>,
  ]);
  baselineService = baseline;
  futureService = future;
  normalizeCandidBoundaryValue =
    normalizerModule.normalizeCandidBoundaryValue;
});

afterAll(async () => {
  if (temporaryDirectory !== "") {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("real Files V2 method-message compatibility", () => {
  test("the generated future fixture is current and both service directions type-check", async () => {
    const [baseline, future] = await Promise.all([
      readFile(baselineDidUrl, "utf8"),
      readFile(futureDidUrl, "utf8"),
    ]);
    expect(future).toBe(generateFilesV2FutureCompat(baseline));

    for (const [current, previous] of [
      [futureDidUrl, baselineDidUrl],
      [baselineDidUrl, futureDidUrl],
    ] as const) {
      const result = command("didc", [
        "check",
        fileURLToPath(current),
        fileURLToPath(previous),
      ]);
      expect(result.status, output(result)).toBe(0);
      expect(output(result)).toContain("special subtyping rules");
    }
  });

  test("real request records cross generated bindings in both directions", () => {
    const requestId = id(1, 2);
    const inputBlob = Uint8Array.of(0x41, 0x00, 0xff);
    const fixtures: Array<{
      method: string;
      future: Record<string, unknown>;
      nullField: string;
      body?: Uint8Array;
    }> = [
      {
        method: FILES_V2_METHODS.operationStatus,
        future: {
          request_id: requestId,
          target: [{ future_operation_target: null }],
          advisory: ["ignored by the baseline"],
        },
        nullField: "target",
      },
      {
        method: FILES_V2_METHODS.lookup,
        future: {
          locator: [{ future_lookup_locator: null }],
          body: inputBlob,
        },
        nullField: "locator",
        body: inputBlob,
      },
      {
        method: FILES_V2_METHODS.vaultWrite,
        future: {
          request_id: requestId,
          operation: [{ future_vault_write_operation: null }],
          expected_record_revision: [],
          proposed_record_revision: 3n,
          body_bytes: 3,
          body: inputBlob,
        },
        nullField: "operation",
        body: inputBlob,
      },
      {
        method: FILES_V2_METHODS.mutate,
        future: {
          request_id: requestId,
          action: [{ future_mutation_action: null }],
          body_bytes: 3,
          body: inputBlob,
        },
        nullField: "action",
        body: inputBlob,
      },
    ];

    for (const fixture of fixtures) {
      const futureMethod = method(futureService, fixture.method);
      const baselineMethod = method(baselineService, fixture.method);
      const bytes = IDL.encode(futureMethod.argTypes, [fixture.future]);
      expect(bytes.byteLength).toBeGreaterThan(4);
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("DIDL");

      const decoded = IDL.decode(baselineMethod.argTypes, bytes);
      const normalized = normalizeCandidBoundaryValue(
        decoded[0],
        baselineMethod.argTypes[0]!,
      ) as Record<string, unknown>;
      expect(
        normalized,
        `${fixture.method}.${fixture.nullField}`,
      ).not.toHaveProperty(fixture.nullField);
      expect(normalized).not.toHaveProperty("advisory");
      if (fixture.body !== undefined) {
        expect(Array.from(normalized.body as Uint8Array)).toEqual(
          Array.from(inputBlob),
        );
      }
    }

    const baselineStatus = method(
      baselineService,
      FILES_V2_METHODS.operationStatus,
    );
    const futureStatus = method(
      futureService,
      FILES_V2_METHODS.operationStatus,
    );
    const decodedByFuture = IDL.decode(
      futureStatus.argTypes,
      IDL.encode(baselineStatus.argTypes, [
        { request_id: requestId, target: [] },
      ]),
    );
    expect(
      normalizeCandidBoundaryValue(
        decodedByFuture[0],
        futureStatus.argTypes[0]!,
      ),
    ).toEqual({
      request_id: { hi: "1", lo: "2" },
    });
  });

  test("a future outcome in every real method response is omitted", () => {
    for (const [index, methodName] of Object.values(
      FILES_V2_METHODS,
    ).entries()) {
      const futureMethod = method(futureService, methodName);
      const baselineMethod = method(baselineService, methodName);
      const body = Uint8Array.of(index, 0xa5);
      const futureReturn = futureOutcomeReturn(
        futureMethod.retTypes[0]!,
        body,
      );
      const bytes = IDL.encode(futureMethod.retTypes, [futureReturn]);
      const [decoded] = IDL.decode(baselineMethod.retTypes, bytes);
      const {
        businessType,
        businessValue,
        attachment,
      } = splitReturn(baselineMethod.retTypes[0]!, decoded);
      expect(
        normalizeCandidBoundaryValue(
          businessValue,
          businessType,
        ),
        methodName,
      ).toEqual({});
      if (attachment !== null) {
        expect(Array.from(attachment)).toEqual(Array.from(body));
      }
    }
  });

  test("every real nested optional-variant boundary omits its future tag", () => {
    const bootstrap = decodeBusinessReturn(
      FILES_V2_METHODS.bootstrap,
      {
        outcome: [{
          ok: {
            vault: [{ future_vault_state: null }],
            quota: quota(),
            public_usage: publicUsage(),
            cleanup: {
              remaining_jobs: 0,
              has_more: false,
              state: [{ future_cleanup_state: null }],
            },
            active_operations: [{
              request_id: id(1, 2),
              kind: [{ future_operation_kind: null }],
              stage_id: [],
              expires_at_ns: [],
              target: [{ future_operation_target: null }],
            }],
            body_bytes: 0,
          },
        }],
      },
      Uint8Array.of(),
    ) as any;
    expect(bootstrap.outcome.ok).not.toHaveProperty("vault");
    expect(bootstrap.outcome.ok.cleanup).not.toHaveProperty("state");
    expect(bootstrap.outcome.ok.active_operations[0]).not.toHaveProperty("kind");
    expect(bootstrap.outcome.ok.active_operations[0]).not.toHaveProperty(
      "stage_id",
    );
    expect(bootstrap.outcome.ok.active_operations[0]).not.toHaveProperty(
      "expires_at_ns",
    );
    expect(bootstrap.outcome.ok.active_operations[0]).not.toHaveProperty("target");
    expect(
      parseFilesV2Response(FILES_V2_METHODS.bootstrap, bootstrap),
    ).toMatchObject({
      kind: "ok",
      value: {
        vault: null,
        cleanup: { state: null },
        active_operations: [{
          kind: null,
          stage_id: null,
          expires_at_ns: null,
          target: null,
        }],
      },
    });

    const lookup = decodeBusinessReturn(
      FILES_V2_METHODS.lookup,
      {
        outcome: [{
          ok: {
            node: {
              node_id: id(1, 2),
              parent_id: id(0, 0),
              kind: [{ future_node_kind: null }],
              structural_revision: 1n,
              metadata_revision: 1n,
              children_revision: 1n,
              declared_name_scalars: 1,
              subtree_height: 0,
              max_relative_path_scalars: 1,
              subtree_plaintext_bytes: 3n,
              encrypted_metadata_bytes: 3,
              active: true,
            },
            content: [{
              content_id: id(3, 4),
              block_count: 1,
              ciphertext_bytes: 3n,
              crypto_profile: [{ future_crypto_profile: null }],
            }],
            body_bytes: 3,
          },
        }],
      },
      Uint8Array.of(1, 2, 3),
    ) as any;
    expect(lookup.outcome.ok.node).not.toHaveProperty("kind");
    expect(lookup.outcome.ok.content).not.toHaveProperty("crypto_profile");
    expect(
      parseFilesV2Response(FILES_V2_METHODS.lookup, lookup),
    ).toMatchObject({
      kind: "ok",
      value: {
        node: { kind: null },
        content: { crypto_profile: null },
      },
    });

    const operationState = decodeBusinessReturn(
      FILES_V2_METHODS.operationStatus,
      {
        server_advisory: [],
        outcome: [{
          ok: {
            request_id: id(1, 2),
            target: [],
            state: [{ future_operation_state: null }],
            cleanup_state: [],
          },
        }],
      },
    ) as any;
    expect(operationState).not.toHaveProperty("server_advisory");
    expect(operationState.outcome.ok).not.toHaveProperty("state");
    expect(
      parseFilesV2Response(
        FILES_V2_METHODS.operationStatus,
        operationState,
      ),
    ).toMatchObject({
      kind: "ok",
      value: {
        target: null,
        state: null,
        cleanup_state: null,
      },
    });

    const committedDetail = decodeBusinessReturn(
      FILES_V2_METHODS.operationStatus,
      {
        server_advisory: [],
        outcome: [{
          ok: {
            request_id: id(1, 2),
            target: [],
            state: [{
              committed: {
                detail: [{ future_committed_detail: null }],
              },
            }],
            cleanup_state: [],
          },
        }],
      },
    ) as any;
    expect(committedDetail.outcome.ok.state.committed).not.toHaveProperty(
      "detail",
    );
    expect(
      parseFilesV2Response(
        FILES_V2_METHODS.operationStatus,
        committedDetail,
      ),
    ).toMatchObject({
      kind: "ok",
      value: { state: { committed: { detail: null } } },
    });

  });

  test("generated decode and production normalization feed adapter null handling and body discard", async () => {
    const transport = new DecodedTransport();
    const adapter = new FilesBackendAdapter(transport);

    const unknownOutcome = decodeForTransport(
      FILES_V2_METHODS.bootstrap,
      { outcome: [{ future_outcome: null }] },
      Uint8Array.of(0xde, 0xad),
    );
    transport.queryBlobValue = unknownOutcome.value;
    transport.queryBlobBody = unknownOutcome.body;
    const bootstrap = await adapter.bootstrap();
    expect(bootstrap.kind).toBe("unsupported");
    expect(bootstrap.body.byteLength).toBe(0);

    const unknownFrame = decodeForTransport(
      FILES_V2_METHODS.readChunk,
      {
        outcome: [{
          ok: {
            node_id: id(1, 2),
            structural_revision: 3n,
            metadata_revision: 4n,
            content_id: id(5, 6),
            index: 0,
            block_count: 1,
            ciphertext_block_bytes: 3,
            ciphertext_total_bytes: 3n,
            frame_kind: [{ future_frame_kind: null }],
          },
        }],
      },
      Uint8Array.of(1, 2, 3),
    );
    transport.queryBlobValue = unknownFrame.value;
    transport.queryBlobBody = unknownFrame.body;
    const read = await adapter.readChunk({
      node_id: canonicalId(1, 2),
      structural_revision: parseCanonicalNat64("3"),
      content_id: canonicalId(5, 6),
      index: 0,
    });
    expect(read.kind).toBe("unsupported");
    expect(read.body.byteLength).toBe(0);

    const unknownReason = decodeForTransport(
      FILES_V2_METHODS.operationStatus,
      {
        server_advisory: [],
        outcome: [{
          rejected: {
            reason: [{ future_reason: null }],
            retry_after_ns: [],
          },
        }],
      },
    );
    transport.queryValue = unknownReason.value;
    const status = await adapter.operationStatus({
      request_id: canonicalId(1, 2),
      target: null,
    });
    expect(status.kind).toBe("rejected");
    if (status.kind !== "rejected") throw new Error("expected rejection");
    expect(status.rejection.reason).toBeNull();
    expect(status.rejection.retryAfterNs).toBeNull();
  });

  test("the real Files plain variant rejects the same future tag", () => {
    const encoded = command("didc", [
      "encode",
      "--defs",
      fileURLToPath(futureDidUrl),
      "--types",
      "(FilesNodeKindV2)",
      "(variant { future_node_kind })",
    ]);
    expect(encoded.status, output(encoded)).toBe(0);
    const decoded = command("didc", [
      "decode",
      "--defs",
      fileURLToPath(baselineDidUrl),
      "--types",
      "(FilesNodeKindV2)",
      processText(encoded.stdout).trim(),
    ]);
    expect(decoded.status).not.toBe(0);
    expect(output(decoded)).toContain("Unknown variant field");
  });
});

async function bindService(
  didUrl: URL,
  label: string,
): Promise<IDL.ServiceClass> {
  const generated = command("didc", [
    "bind",
    "--target",
    "js",
    fileURLToPath(didUrl),
  ]);
  if (generated.status !== 0) throw new Error(output(generated));
  const bindingPath = join(temporaryDirectory, `${label}.mjs`);
  await writeFile(bindingPath, processText(generated.stdout), "utf8");
  const binding = await import(
    `${pathToFileURL(bindingPath).href}?fixture=${label}`
  ) as GeneratedBinding;
  return binding.idlFactory({ IDL }) as IDL.ServiceClass;
}

function method(
  service: IDL.ServiceClass,
  name: string,
): IDL.FuncClass {
  const candidate = service._fields.find(([methodName]) => methodName === name)?.[1];
  if (!(candidate instanceof IDL.FuncClass)) {
    throw new Error(`Generated binding has no method ${name}`);
  }
  return candidate;
}

function futureOutcomeReturn(
  returnType: IDL.Type,
  body: Uint8Array,
): unknown {
  if (isAttachmentOutput(returnType)) {
    const valueType = field(returnType, "value");
    return {
      value: withMissingOptions(valueType, {
        outcome: [{ future_outcome: null }],
      }),
      body,
    };
  }
  return withMissingOptions(returnType, {
    outcome: [{ future_outcome: null }],
  });
}

function decodeBusinessReturn(
  methodName: string,
  futureBusinessValue: Record<string, unknown>,
  body = Uint8Array.of(),
): unknown {
  return decodeForTransport(methodName, futureBusinessValue, body).value;
}

function decodeForTransport(
  methodName: string,
  futureBusinessValue: Record<string, unknown>,
  body = Uint8Array.of(),
): { value: JsonValue; body: ArrayBuffer } {
  const futureMethod = method(futureService, methodName);
  const baselineMethod = method(baselineService, methodName);
  const futureReturnType = futureMethod.retTypes[0]!;
  const futureReturn = isAttachmentOutput(futureReturnType)
    ? {
        value: withMissingOptions(
          field(futureReturnType, "value"),
          futureBusinessValue,
        ),
        body,
      }
    : withMissingOptions(futureReturnType, futureBusinessValue);
  const bytes = IDL.encode(futureMethod.retTypes, [futureReturn]);
  const [decoded] = IDL.decode(baselineMethod.retTypes, bytes);
  const split = splitReturn(baselineMethod.retTypes[0]!, decoded);
  const normalized = normalizeCandidBoundaryValue(
    split.businessValue,
    split.businessType,
  ) as JsonValue;
  const attachment = split.attachment ?? Uint8Array.of();
  return {
    value: normalized,
    body: exactArrayBuffer(attachment),
  };
}

function splitReturn(
  returnType: IDL.Type,
  decoded: unknown,
): {
  businessType: IDL.Type;
  businessValue: unknown;
  attachment: Uint8Array | null;
} {
  if (!isAttachmentOutput(returnType)) {
    return {
      businessType: returnType,
      businessValue: decoded,
      attachment: null,
    };
  }
  const record = decoded as { value: unknown; body: Uint8Array };
  return {
    businessType: field(returnType, "value"),
    businessValue: record.value,
    attachment: record.body,
  };
}

function isAttachmentOutput(type: IDL.Type): type is IDL.RecordClass {
  return (
    type instanceof IDL.RecordClass &&
    type._fields.some(([name]) => name === "value") &&
    type._fields.some(([name]) => name === "body")
  );
}

function field(type: IDL.RecordClass, name: string): IDL.Type {
  const result = type._fields.find(([fieldName]) => fieldName === name)?.[1];
  if (!result) throw new Error(`Generated record has no ${name} field`);
  return result;
}

function withMissingOptions(
  type: IDL.Type,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!(type instanceof IDL.RecordClass)) {
    throw new Error("Expected a generated Candid record");
  }
  const result = { ...value };
  for (const [name, child] of type._fields) {
    if (!(name in result) && child instanceof IDL.OptClass) result[name] = [];
  }
  return result;
}

function id(hi: number, lo: number): { hi: bigint; lo: bigint } {
  return { hi: BigInt(hi), lo: BigInt(lo) };
}

function canonicalId(hi: number, lo: number) {
  return parseFilesId128({ hi: String(hi), lo: String(lo) });
}

function quota() {
  return {
    nodes: 0n,
    committed_private_plaintext_bytes: 0n,
    committed_ciphertext_bytes: 0n,
    staged_ciphertext_bytes: 0n,
    physical_private_bytes: 0n,
    cleanup_jobs: 0,
  };
}

function publicUsage() {
  const word = 0n;
  const limits = {
    entries: word,
    committed_bytes: word,
    object_bytes: word,
    staged_bytes: word,
    pending_stages: word,
    batch_operations: word,
    batch_bytes: word,
    general_receipts: word,
    revocation_lanes: word,
  };
  return {
    current: {
      live_entries: word,
      occupied_entry_slots: word,
      committed_body_bytes: word,
      reserved_committed_body_bytes: word,
      allocated_body_bytes: word,
      charged_metadata_bytes: word,
      accepted_staged_bytes: word,
      reserved_staged_bytes: word,
      detached_charged_bytes: word,
      active_stages: word,
      reserved_entry_slots: word,
      receipt_lanes: word,
      general_receipt_lanes: word,
      reserved_general_receipt_lanes: word,
      reserved_revocation_lanes: word,
      filled_revocation_lanes: word,
      receipt_nonce_indexes: word,
      receipt_expiry_indexes: word,
      cleanup_jobs: word,
    },
    manifest_limits: limits,
    effective_limits: limits,
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
}

class DecodedTransport implements FilesSelfCallTransport {
  queryValue: JsonValue = { outcome: null };
  queryBlobValue: JsonValue = { outcome: null };
  queryBlobBody = new ArrayBuffer(0);

  async query(method: string): Promise<FilesSelfCallValue> {
    if (
      method === FILES_V2_METHODS.bootstrap ||
      method === FILES_V2_METHODS.list ||
      method === FILES_V2_METHODS.lookup ||
      method === FILES_V2_METHODS.readChunk
    ) {
      return {
        value: this.queryBlobValue,
        body: new Uint8Array(this.queryBlobBody).slice(),
      };
    }
    return this.queryValue;
  }

  async update(): Promise<FilesSelfCallValue> {
    throw new Error("unexpected update");
  }
}

function command(
  executable: string,
  arguments_: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(executable, arguments_, { encoding: "utf8" });
}

function output(result: ReturnType<typeof spawnSync>): string {
  return [result.stdout, result.stderr]
    .map(processText)
    .filter(Boolean)
    .join("\n");
}

function processText(value: string | Buffer | null): string {
  return value === null ? "" : value.toString();
}
