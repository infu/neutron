import { expect, test } from "bun:test";
import {
  FILES_V2_METHOD_CONTRACTS,
  FILES_V2_METHODS,
  FilesBackendAdapter,
  FilesProtocolValueError,
  encodeFilesV2Request,
  filesId128FromKey,
  filesId128ToKey,
  lsbBitmapHas,
  lsbBitmapSet,
  parseCanonicalNat64,
  parseFilesId128,
  parseFilesReadChunkResponse,
  parseFilesV2Response,
  validateLsbBitmap,
  type FilesSelfCallTransport,
  type FilesSelfCallValue,
} from "../src/protocol/index.ts";

const ZERO = parseCanonicalNat64("0");
const ONE = parseCanonicalNat64("1");
const ID = parseFilesId128({ hi: "1", lo: "2" });
const OTHER_ID = parseFilesId128({ hi: "3", lo: "4" });
const ZERO_PUBLIC_USAGE = {
  current: {
    live_entries: "0",
    occupied_entry_slots: "0",
    committed_body_bytes: "0",
    reserved_committed_body_bytes: "0",
    reserved_entry_slots: "0",
    allocated_body_bytes: "0",
    charged_metadata_bytes: "0",
    accepted_staged_bytes: "0",
    reserved_staged_bytes: "0",
    detached_charged_bytes: "0",
    active_stages: "0",
    receipt_lanes: "0",
    general_receipt_lanes: "0",
    reserved_general_receipt_lanes: "0",
    reserved_revocation_lanes: "0",
    filled_revocation_lanes: "0",
    receipt_nonce_indexes: "0",
    receipt_expiry_indexes: "0",
    cleanup_jobs: "0",
  },
  manifest_limits: {
    entries: "0",
    committed_bytes: "0",
    object_bytes: "0",
    staged_bytes: "0",
    pending_stages: "0",
    batch_operations: "0",
    batch_bytes: "0",
    general_receipts: "0",
    revocation_lanes: "0",
  },
  effective_limits: {
    entries: "0",
    committed_bytes: "0",
    object_bytes: "0",
    staged_bytes: "0",
    pending_stages: "0",
    batch_operations: "0",
    batch_bytes: "0",
    general_receipts: "0",
    revocation_lanes: "0",
  },
} as const;

test("Files V2 freezes all 11 method modes and semantic Blob limits", () => {
  expect(Object.values(FILES_V2_METHODS)).toHaveLength(11);
  expect(FILES_V2_METHOD_CONTRACTS.files_lookup_v2).toEqual({
    mode: "query",
    inputBlobMaxBytes: 32,
    outputBlobMaxBytes: 8_192,
  });
  expect(FILES_V2_METHOD_CONTRACTS.files_write_block_v2).toMatchObject({
    mode: "update",
    inputBlobMaxBytes: 1_900_000,
  });
});

test("nat64, ID, and LSB bitmap helpers reject noncanonical values", () => {
  expect(String(parseCanonicalNat64("18446744073709551615"))).toBe(
    "18446744073709551615",
  );
  expect(() => parseCanonicalNat64("01")).toThrow("canonical");
  expect(String(parseCanonicalNat64(1n))).toBe("1");
  expect(() => parseCanonicalNat64("18446744073709551616")).toThrow(
    "exceeds nat64",
  );

  const key = filesId128ToKey(ID);
  expect(String(key)).toBe("00000000000000010000000000000002");
  expect(filesId128FromKey(key)).toEqual(ID);
  expect(() =>
    filesId128FromKey(
      "A0000000000000010000000000000002" as typeof key,
    ),
  ).toThrow("lowercase");

  const bitmap = new Uint8Array(2);
  lsbBitmapSet(bitmap, 0);
  lsbBitmapSet(bitmap, 9);
  expect(lsbBitmapHas(bitmap, 0)).toBe(true);
  expect(lsbBitmapHas(bitmap, 8)).toBe(false);
  expect(lsbBitmapHas(bitmap, 9)).toBe(true);
  validateLsbBitmap(bitmap, 10);
  bitmap[1] = 0x82;
  expect(() => validateLsbBitmap(bitmap, 10)).toThrow("unused high bits");
});

test("request encoders follow the actual backend records and reject extras", () => {
  expect(
    encodeFilesV2Request(FILES_V2_METHODS.list, {
      parent_id: ID,
      expected_structural_revision: ONE,
      cursor: null,
      limit: 200,
    }),
  ).toEqual({
    parent_id: ID,
    expected_structural_revision: "1",
    limit: 200,
  });

  expect(() =>
    encodeFilesV2Request(FILES_V2_METHODS.list, {
      parent_id: ID,
      expected_structural_revision: null,
      cursor: null,
      limit: 201,
    }),
  ).toThrow("outside its allowed range");

  expect(() =>
    encodeFilesV2Request(
      FILES_V2_METHODS.cleanup,
      { unexpected: true } as never,
    ),
  ).toThrow("unexpected fields");
});

test("typed response parsers preserve null optional variants and decimal nat64", () => {
  const response = parseFilesV2Response(FILES_V2_METHODS.cleanup, {
    outcome: {
      ok: {
        reclaimed_entries: 2,
        reclaimed_ciphertext_bytes: "18446744073709551615",
        reclaimed_charged_bytes: "9",
        remaining_jobs: 1,
        has_more: true,
      },
    },
  });
  expect(response).toMatchObject({
    kind: "ok",
    value: {
      reclaimed_entries: 2,
      reclaimed_ciphertext_bytes: "18446744073709551615",
      remaining_jobs: 1,
      has_more: true,
    },
  });

  expect(
    parseFilesV2Response(FILES_V2_METHODS.cleanup, { outcome: null }),
  ).toEqual({ kind: "unsupported" });
  expect(
    parseFilesV2Response(FILES_V2_METHODS.cleanup, {}),
  ).toEqual({ kind: "unsupported" });
  expect(() =>
    parseFilesV2Response(FILES_V2_METHODS.cleanup, {
      outcome: { future_success: null },
    }),
  ).toThrow("unsupported normalized tag");
  expect(() =>
    parseFilesV2Response(FILES_V2_METHODS.cleanup, {
      outcome: {
        rejected: {
          reason: { future_reason: null },
          retry_after_ns: null,
        },
      },
    }),
  ).toThrow("unsupported normalized tag");
});

test("read response treats the body as a bounded FilesFrameV2", () => {
  const body = new Uint8Array([0, 0, 0, 0, 1, 2, 3]).buffer;
  const base = {
    node_id: ID,
    structural_revision: "1",
    metadata_revision: "2",
    content_id: OTHER_ID,
    index: 0,
    block_count: 1,
    ciphertext_block_bytes: 3,
    ciphertext_total_bytes: "3",
  };
  const unsupported = parseFilesReadChunkResponse(
    { outcome: { ok: { ...base, frame_kind: null } } },
    body,
  );
  expect(unsupported.kind).toBe("unsupported");
  expect(unsupported.body.byteLength).toBe(0);
  const omittedOutcome = parseFilesReadChunkResponse({}, body);
  expect(omittedOutcome.kind).toBe("unsupported");
  expect(omittedOutcome.body.byteLength).toBe(0);
  const omittedFrameKind = parseFilesReadChunkResponse(
    { outcome: { ok: base } },
    body,
  );
  expect(omittedFrameKind.kind).toBe("unsupported");
  expect(omittedFrameKind.body.byteLength).toBe(0);

  const ok = parseFilesReadChunkResponse(
    { outcome: { ok: { ...base, frame_kind: { first: null } } } },
    body,
  );
  expect(ok.kind).toBe("ok");
  expect(ok.body.byteLength).toBe(7);

  expect(() =>
    parseFilesReadChunkResponse(
      {
        outcome: {
          ok: {
            ...base,
            frame_kind: { first: null },
          },
        },
      },
      new ArrayBuffer(0),
    ),
  ).toThrow("empty or exceeds");
});

test("backend adapter uses ordinary self calls and enforces Blob bindings", async () => {
  const calls: Array<{
    kind: string;
    method: string;
    request: FilesSelfCallValue;
  }> = [];
  const transport: FilesSelfCallTransport = {
    async query(method, args) {
      calls.push({ kind: "query", method, request: args[0]! });
      if (method === FILES_V2_METHODS.bootstrap) {
        return {
          value: {
            outcome: {
              ok: {
                vault: { absent: null },
                quota: {
                  nodes: "1",
                  committed_private_plaintext_bytes: "0",
                  committed_ciphertext_bytes: "0",
                  staged_ciphertext_bytes: "0",
                  physical_private_bytes: "0",
                  cleanup_jobs: 0,
                },
                public_usage: ZERO_PUBLIC_USAGE,
                cleanup: {
                  remaining_jobs: 0,
                  has_more: false,
                  state: { clean: null },
                },
                active_operations: [],
                body_bytes: 0,
              },
            },
          },
          body: new Uint8Array(),
        };
      }
      return {
        outcome: {
          ok: {
            reclaimed_entries: 0,
            reclaimed_ciphertext_bytes: "0",
            reclaimed_charged_bytes: "0",
            remaining_jobs: 0,
            has_more: false,
          },
        },
      };
    },
    async update(method, args) {
      calls.push({ kind: "update", method, request: args[0]! });
      return {
        outcome: {
          ok: {
            reclaimed_entries: 0,
            reclaimed_ciphertext_bytes: "0",
            reclaimed_charged_bytes: "0",
            remaining_jobs: 0,
            has_more: false,
          },
        },
      };
    },
  };
  const adapter = new FilesBackendAdapter(transport);
  expect(await adapter.bootstrap()).toMatchObject({ kind: "ok" });
  expect(calls[0]).toMatchObject({
    kind: "query",
    method: "files_bootstrap_v2",
    request: {},
  });

  expect(() =>
    adapter.lookup({
      locator: { node: { node_id: ID } },
      body: new Uint8Array(32),
    }),
  ).toThrow("Node lookup requires zero bytes");

  await expect(
    adapter.writeBlock(
      {
        request_id: ID,
        stage_id: null,
        frame_ordinal: 0,
        final: true,
        body_bytes: 2,
        body: new Uint8Array(1),
      },
    ),
  ).rejects.toBeInstanceOf(FilesProtocolValueError);
  expect(calls).toHaveLength(1);
});

test("adapter discards a Blob body for rejected outcomes", async () => {
  const transport: FilesSelfCallTransport = {
    query: async () => ({
      value: {
        outcome: {
          rejected: {
            reason: { busy: null },
            retry_after_ns: "9",
          },
        },
      },
      body: new Uint8Array([9, 8, 7]),
    }),
    update: async () => null,
  };
  const result = await new FilesBackendAdapter(transport).bootstrap();
  expect(result).toMatchObject({
    kind: "rejected",
    rejection: { reason: { tag: "busy" }, retryAfterNs: "9" },
  });
  expect(result.body.byteLength).toBe(0);
  expect(String(ZERO)).toBe("0");
});
