import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FILES_V2_LIMITS,
  FILES_V2_METHOD_CONTRACTS,
  FILES_V2_METHODS,
  FilesBackendAdapter,
  FilesProtocolValueError,
  assertNormalizedRequest,
  parseFilesOutcome,
  parseFilesV2Response,
  type CanonicalNat64,
  type FilesId128V2,
  type FilesSelfCallTransport,
  type FilesSelfCallValue,
} from "../../src/protocol/index.ts";
import type { JsonValue } from "neutron-tools/app";

type Call = {
  kind: "query" | "update";
  method: string;
  value: FilesSelfCallValue;
  body?: ArrayBuffer;
};

class FixtureTransport implements FilesSelfCallTransport {
  readonly calls: Call[] = [];
  queryValue: JsonValue = { outcome: null };
  updateValue: JsonValue = { outcome: null };
  queryBlobValue: JsonValue = { outcome: null };
  queryBlobBody = new ArrayBuffer(0);

  async query(
    method: string,
    args: FilesSelfCallValue[],
    _timeoutSeconds: number,
  ): Promise<FilesSelfCallValue> {
    const value = args[0] ?? null;
    this.calls.push({
      kind: "query",
      method,
      value,
      ...bodyFromRequest(value),
    });
    if (
      FILES_V2_METHOD_CONTRACTS[method as keyof typeof FILES_V2_METHOD_CONTRACTS]
        .outputBlobMaxBytes > 0
    ) {
      return {
        value: this.queryBlobValue,
        body: new Uint8Array(this.queryBlobBody).slice(),
      };
    }
    return this.queryValue;
  }

  async update(
    method: string,
    args: FilesSelfCallValue[],
    _timeoutSeconds: number,
  ): Promise<FilesSelfCallValue> {
    const value = args[0] ?? null;
    this.calls.push({
      kind: "update",
      method,
      value,
      ...bodyFromRequest(value),
    });
    return this.updateValue;
  }
}

test("the resident method table exactly matches the checked-in ABI fixture", async () => {
  const abi = JSON.parse(
    await readFile(
      new URL("../../candid/files-v2.abi.json", import.meta.url),
      "utf8",
    ),
  ) as {
    methods: Array<{
      name: string;
      mode: "query" | "update";
      input_blob: { max_bytes: number } | null;
      output_blob: { max_bytes: number } | null;
    }>;
  };
  const residentMethods: string[] = Object.values(FILES_V2_METHODS);
  expect(residentMethods.sort()).toEqual(
    abi.methods.map(({ name }) => name).sort(),
  );
  for (const method of abi.methods) {
    const resident = FILES_V2_METHOD_CONTRACTS[
      method.name as keyof typeof FILES_V2_METHOD_CONTRACTS
    ];
    expect(resident, `${method.name} resident contract`).toBeDefined();
    expect(resident.mode, `${method.name} resident mode`).toBe(method.mode);
    expect(
      resident.inputBlobMaxBytes,
      `${method.name} resident input cap`,
    ).toBe(method.input_blob?.max_bytes ?? 0);
    expect(
      resident.outputBlobMaxBytes,
      `${method.name} resident output cap`,
    ).toBe(method.output_blob?.max_bytes ?? 0);
  }
});

test("all eleven adapter entry points dispatch through ordinary self calls", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  const frame = Uint8Array.of(1).buffer;

  await adapter.bootstrap();
  await adapter.list({
    parent_id: id(0, 0),
    expected_structural_revision: null,
    cursor: null,
    limit: 1,
  });
  await adapter.lookup({
    locator: { node: { node_id: id(1, 2) } },
    body: new Uint8Array(),
  });
  await adapter.readChunk(readRequest());
  await adapter.operationStatus({
    request_id: id(1, 2),
    target: null,
  });
  await adapter.vaultWrite(
    {
      request_id: id(1, 2),
      operation: { initialize: null },
      expected_record_revision: null,
      proposed_record_revision: nat64(1),
      body_bytes: 1,
      body: new Uint8Array(frame).slice(),
    },
  );
  await adapter.writeBlock(
    {
      request_id: id(1, 2),
      stage_id: null,
      frame_ordinal: 0,
      final: true,
      body_bytes: 1,
      body: new Uint8Array(frame).slice(),
    },
  );
  await adapter.mutate(
    {
      request_id: id(1, 2),
      action: { rename: null },
      body_bytes: 1,
      body: new Uint8Array(frame).slice(),
    },
  );
  await adapter.remove({
    request_id: id(1, 2),
    node_id: id(3, 4),
    expected_structural_revision: nat64(1),
    expected_parent_id: id(0, 0),
    expected_parent_children_revision: nat64(1),
    recursive: false,
  });
  await adapter.abort({
    request_id: id(1, 2),
    stage_id: nat64(1),
  });
  await adapter.cleanup();

  expect(
    transport.calls.map(({ kind, method }) => ({ kind, method })),
  ).toEqual([
    { kind: "query", method: FILES_V2_METHODS.bootstrap },
    { kind: "query", method: FILES_V2_METHODS.list },
    { kind: "query", method: FILES_V2_METHODS.lookup },
    { kind: "query", method: FILES_V2_METHODS.readChunk },
    { kind: "query", method: FILES_V2_METHODS.operationStatus },
    { kind: "update", method: FILES_V2_METHODS.vaultWrite },
    { kind: "update", method: FILES_V2_METHODS.writeBlock },
    { kind: "update", method: FILES_V2_METHODS.mutate },
    { kind: "update", method: FILES_V2_METHODS.remove },
    { kind: "update", method: FILES_V2_METHODS.abort },
    { kind: "update", method: FILES_V2_METHODS.cleanup },
  ]);
});

test("normalized bridge limits accept exact request bounds and reject plus one", () => {
  expect(FILES_V2_LIMITS).toMatchObject({
    normalizedValueBytes: 65_536,
    rawNonAttachmentCandidBytes: 131_072,
    decoderAllocationBytes: 524_288,
    candidTypeEntries: 256,
    candidDepth: 32,
    candidDecodedElements: 4_096,
    committedNodesPerReceipt: 64,
    operationWriteTargetNodes: 64,
  });

  const exactBytes = { pad: "x".repeat(65_526) };
  expect(new TextEncoder().encode(JSON.stringify(exactBytes)).byteLength).toBe(
    65_536,
  );
  expect(() => assertNormalizedRequest(exactBytes)).not.toThrow();
  expect(() =>
    assertNormalizedRequest({ pad: `${exactBytes.pad}x` })
  ).toThrow("normalized value bound");

  expect(() => assertNormalizedRequest(nestedValue(32))).not.toThrow();
  expect(() => assertNormalizedRequest(nestedValue(33))).toThrow(
    "normalized depth bound",
  );

  expect(() =>
    assertNormalizedRequest({ items: Array.from({ length: 4_095 }, () => null) })
  ).not.toThrow();
  expect(() =>
    assertNormalizedRequest({ items: Array.from({ length: 4_096 }, () => null) })
  ).toThrow("normalized element bound");
});

test("normalized responses independently accept exactly 65,536 bytes and reject plus one", () => {
  const empty = { outcome: { ok: { pad: "" } } };
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
  const exact = {
    outcome: {
      ok: {
        pad: "x".repeat(FILES_V2_LIMITS.normalizedValueBytes - overhead),
      },
    },
  };
  expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(
    65_536,
  );
  expect(parseFilesOutcome(exact).kind).toBe("ok");
  expect(() =>
    parseFilesOutcome({
      outcome: { ok: { pad: `${exact.outcome.ok.pad}x` } },
    })
  ).toThrow("normalized value bound");
});

test("batch commit receipts preserve 64 canonical nodes and reject a 65th", () => {
  const sixtyFour = committedNodes(64);
  const write = parseFilesV2Response(FILES_V2_METHODS.writeBlock, {
    outcome: {
      ok: {
        request_id: wireId(1, 2),
        stage_id: null,
        frame_ordinal: 6,
        accepted_frames_bitmap: 0x7f,
        committed_nodes: sixtyFour,
        cleanup_state: null,
      },
    },
  });
  expect(write.kind).toBe("ok");
  if (write.kind !== "ok") throw new Error("expected write success");
  expect(write.value.committed_nodes).toHaveLength(64);
  expect(write.value.committed_nodes[63]).toEqual({
    node_id: id(63, 64),
    content_id: id(163, 164),
    structural_revision: nat64(64),
    metadata_revision: nat64(65),
  });

  const status = parseFilesV2Response(FILES_V2_METHODS.operationStatus, {
    outcome: {
      ok: {
        request_id: wireId(1, 2),
        target: null,
        state: {
          committed: {
            detail: {
              private_write: {
                request_id: wireId(1, 2),
                stage_id: null,
                frame_ordinal: 6,
                accepted_frames_bitmap: 0x7f,
                committed_nodes: sixtyFour,
                cleanup_state: null,
              },
            },
          },
        },
        cleanup_state: null,
      },
    },
  });
  expect(status.kind).toBe("ok");
  if (status.kind !== "ok") throw new Error("expected status success");
  const state = status.value.state;
  const detail =
    state !== null && "committed" in state
      ? state.committed.detail
      : null;
  expect(
    detail !== null && "private_write" in detail
      ? detail.private_write.committed_nodes
      : [],
  ).toHaveLength(64);

  const sixtyFive = committedNodes(65);
  expect(() =>
    parseFilesV2Response(FILES_V2_METHODS.writeBlock, {
      outcome: {
        ok: {
          request_id: wireId(1, 2),
          stage_id: null,
          frame_ordinal: 6,
          accepted_frames_bitmap: 0x7f,
          committed_nodes: sixtyFive,
          cleanup_state: null,
        },
      },
    })
  ).toThrow("committed_nodes is not a bounded array");
  expect(() =>
    parseFilesV2Response(FILES_V2_METHODS.operationStatus, {
      outcome: {
        ok: {
          request_id: wireId(1, 2),
          target: null,
          state: {
            committed: {
              detail: {
                private_write: {
                  request_id: wireId(1, 2),
                  stage_id: null,
                  frame_ordinal: 6,
                  accepted_frames_bitmap: 0x7f,
                  committed_nodes: sixtyFive,
                  cleanup_state: null,
                },
              },
            },
          },
          cleanup_state: null,
        },
      },
    })
  ).toThrow("committed_nodes is not a bounded array");

  for (const noncanonical of [
    [committedNodes(2)[1], committedNodes(2)[0]],
    [committedNodes(1)[0], committedNodes(1)[0]],
  ]) {
    expect(() =>
      parseFilesV2Response(FILES_V2_METHODS.writeBlock, {
        outcome: {
          ok: {
            request_id: wireId(1, 2),
            stage_id: null,
            frame_ordinal: 6,
            accepted_frames_bitmap: 0x7f,
            committed_nodes: noncanonical,
            cleanup_state: null,
          },
        },
      })
    ).toThrow("strict canonical ascending node_id order");
  }
});

test("batch reconciliation binds up to 64 ordered file and folder targets", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  const nodes = writeTargetNodes(64).map((node, index) =>
    index === 0 ? { ...node, content_id: null } : node
  );
  await adapter.operationStatus({
    request_id: id(1, 2),
    target: { private_write: { nodes } },
  });
  expect(transport.calls[0]?.value).toEqual({
    request_id: wireId(1, 2),
    target: {
      private_write: {
        nodes: nodes.map(({ node_id, content_id }) => ({
          node_id: wireId(
            Number(node_id.hi),
            Number(node_id.lo),
          ),
          ...(content_id === null
            ? {}
            : {
                content_id: wireId(
                  Number(content_id.hi),
                  Number(content_id.lo),
                ),
              }),
        })),
      },
    },
  });

  await expect(
    adapter.operationStatus({
      request_id: id(1, 2),
      target: { private_write: { nodes: [] } },
    }),
  ).rejects.toThrow("must not be empty");
  await expect(
    adapter.operationStatus({
      request_id: id(1, 2),
      target: { private_write: { nodes: writeTargetNodes(65) } },
    }),
  ).rejects.toThrow("is not a bounded array");
  await expect(
    adapter.operationStatus({
      request_id: id(1, 2),
      target: {
        private_write: {
          nodes: [writeTargetNodes(2)[1]!, writeTargetNodes(2)[0]!],
        },
      },
    }),
  ).rejects.toThrow("strict canonical ascending node_id order");
  expect(() =>
    parseFilesV2Response(FILES_V2_METHODS.operationStatus, {
      outcome: {
        ok: {
          request_id: wireId(1, 2),
          target: {
            private_write: {
              nodes: [
                {
                  node_id: wireId(4, 2),
                  content_id: null,
                },
                {
                  node_id: wireId(4, 1),
                  content_id: null,
                },
              ],
            },
          },
          state: null,
          cleanup_state: null,
        },
      },
    })
  ).toThrow("strict canonical ascending node_id order");
  await expect(
    adapter.operationStatus({
      request_id: id(1, 2),
      target: {
        private_write: {
          nodes: [writeTargetNodes(1)[0]!, writeTargetNodes(1)[0]!],
        },
      },
    }),
  ).rejects.toThrow("strict canonical ascending node_id order");
  await expect(
    adapter.operationStatus({
      request_id: id(1, 2),
      target: {
        private_write: {
          node_id: id(3, 4),
          content_id: id(5, 6),
        },
      } as never,
    }),
  ).rejects.toBeInstanceOf(FilesProtocolValueError);
  expect(transport.calls).toHaveLength(1);
});

test("bootstrap preserves exact private-write restart authority", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  const target = {
    private_write: {
      nodes: [{
        node_id: id(4, 5),
        content_id: id(6, 7),
      }],
    },
  };

  transport.queryBlobValue = {
    outcome: {
      ok: {
        vault: null,
        quota: {
          nodes: "0",
          committed_private_plaintext_bytes: "0",
          committed_ciphertext_bytes: "0",
          staged_ciphertext_bytes: "0",
          physical_private_bytes: "0",
          cleanup_jobs: 0,
        },
        public_usage: publicUsage("0"),
        cleanup: {
          remaining_jobs: 0,
          has_more: false,
          state: null,
        },
        active_operations: [{
          request_id: wireId(1, 2),
          kind: { private_write: null },
          stage_id: "15",
          expires_at_ns: "16",
          target,
        }],
        body_bytes: 0,
      },
    },
  };

  const bootstrap = await adapter.bootstrap();
  expect(bootstrap.kind).toBe("ok");
  if (bootstrap.kind !== "ok") throw new Error("expected bootstrap success");
  expect(bootstrap.value.active_operations[0]).toEqual({
    request_id: id(1, 2),
    kind: { private_write: null },
    stage_id: nat64(15),
    expires_at_ns: nat64(16),
    target,
  });
});

test("every committed status detail is parsed as its exact update success record", () => {
  const fixtures = [
    {
      tag: "vault",
      method: FILES_V2_METHODS.vaultWrite,
      payload: {
        request_id: wireId(1, 2),
        record_revision: "3",
        initialized: true,
      },
    },
    {
      tag: "private_write",
      method: FILES_V2_METHODS.writeBlock,
      payload: {
        request_id: wireId(1, 2),
        stage_id: null,
        frame_ordinal: 0,
        accepted_frames_bitmap: 1,
        committed_nodes: committedNodes(1),
        cleanup_state: null,
      },
    },
    {
      tag: "mutation",
      method: FILES_V2_METHODS.mutate,
      payload: {
        request_id: wireId(1, 2),
        node_id: wireId(3, 4),
        parent_id: wireId(0, 0),
        structural_revision: "5",
        metadata_revision: "6",
      },
    },
    {
      tag: "remove",
      method: FILES_V2_METHODS.remove,
      payload: {
        request_id: wireId(1, 2),
        node_id: wireId(3, 4),
        detached_plaintext_bytes: "7",
        reclaimed_entries: 8,
        reclaimed_ciphertext_bytes: "9",
        cleanup_state: null,
      },
    },
    {
      tag: "abort",
      method: FILES_V2_METHODS.abort,
      payload: {
        request_id: wireId(1, 2),
        stage_id: "3",
        cleanup_state: null,
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    const direct = parseFilesV2Response(fixture.method, {
      outcome: { ok: fixture.payload },
    });
    expect(direct.kind, `${fixture.tag} direct result`).toBe("ok");
    if (direct.kind !== "ok") throw new Error("expected direct success");

    const status = parseFilesV2Response(FILES_V2_METHODS.operationStatus, {
      outcome: {
        ok: {
          request_id: wireId(1, 2),
          target: null,
          state: {
            committed: {
              detail: {
                [fixture.tag]: fixture.payload,
              },
            },
          },
          cleanup_state: null,
        },
      },
    });
    expect(status.kind, `${fixture.tag} status result`).toBe("ok");
    if (status.kind !== "ok") throw new Error("expected status success");
    const state = status.value.state;
    const actualDetail =
      state !== null && "committed" in state
        ? state.committed.detail
        : null;
    expect(
      actualDetail as unknown,
      `${fixture.tag} exact committed detail`,
    ).toEqual({ [fixture.tag]: direct.value } as unknown);
  }

  const nullDetail = parseFilesV2Response(
    FILES_V2_METHODS.operationStatus,
    {
      outcome: {
        ok: {
          request_id: wireId(1, 2),
          target: null,
          state: { committed: { detail: null } },
          cleanup_state: null,
        },
      },
    },
  );
  expect(nullDetail.kind).toBe("ok");
  if (nullDetail.kind !== "ok") throw new Error("expected status success");
  const state = nullDetail.value.state;
  expect(
    state !== null && "committed" in state
      ? state.committed.detail
      : undefined,
  ).toBeNull();
});

test("abort reconciliation binds the exact private stage", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  const target = {
    abort: {
      stage_id: nat64(3),
    },
  };
  await adapter.operationStatus({
    request_id: id(1, 2),
    target,
  });
  expect(transport.calls[0]?.value).toEqual({
    request_id: wireId(1, 2),
    target,
  });

  await expect(
    adapter.operationStatus({
      request_id: id(1, 2),
      target: {
        abort: {
          ...target.abort,
          unexpected: true,
        },
      } as never,
    }),
  ).rejects.toBeInstanceOf(FilesProtocolValueError);
  expect(transport.calls).toHaveLength(1);
});

test("active private status preserves bounded frame progress", () => {
  const response = (acceptedFrames = 0x7f) => ({
    outcome: {
      ok: {
        request_id: wireId(1, 2),
        target: null,
        state: {
          active: {
            stage_id: "1",
            accepted_frames_bitmap: acceptedFrames,
            frame_block_mapping: [],
            staged_bytes: "0",
            expires_at_ns: null,
          },
        },
        cleanup_state: null,
      },
    },
  });
  const parsed = parseFilesV2Response(
    FILES_V2_METHODS.operationStatus,
    response(),
  );
  expect(parsed.kind).toBe("ok");
  if (parsed.kind !== "ok") throw new Error("expected status success");
  const state = parsed.value.state;
  expect(
    state !== null && "active" in state
      ? state.active.accepted_frames_bitmap
      : null,
  ).toBe(0x7f);
  expect(() =>
    parseFilesV2Response(
      FILES_V2_METHODS.operationStatus,
      response(0x1_0000),
    )
  ).toThrow("outside its allowed range");
});

test("bootstrap public usage accepts every nat64 maximum and rejects overflow", () => {
  const maximum = "18446744073709551615" as CanonicalNat64;
  const response = parseFilesV2Response(FILES_V2_METHODS.bootstrap, {
    outcome: {
      ok: {
        vault: null,
        quota: {
          nodes: "0",
          committed_private_plaintext_bytes: "0",
          committed_ciphertext_bytes: "0",
          staged_ciphertext_bytes: "0",
          physical_private_bytes: "0",
          cleanup_jobs: 0,
        },
        public_usage: publicUsage(maximum),
        cleanup: {
          remaining_jobs: 0,
          has_more: false,
          state: null,
        },
        active_operations: [],
        body_bytes: 0,
      },
    },
  });
  expect(response.kind).toBe("ok");
  if (response.kind !== "ok") throw new Error("expected bootstrap success");
  expect(response.value.public_usage.current.cleanup_jobs).toBe(maximum);
  expect(response.value.public_usage.manifest_limits.revocation_lanes).toBe(
    maximum,
  );
  expect(response.value.public_usage.effective_limits.entries).toBe(maximum);

  const overflow = publicUsage(maximum, "18446744073709551616");
  expect(() =>
    parseFilesV2Response(FILES_V2_METHODS.bootstrap, {
      outcome: {
        ok: {
          vault: null,
          quota: {
            nodes: "0",
            committed_private_plaintext_bytes: "0",
            committed_ciphertext_bytes: "0",
            staged_ciphertext_bytes: "0",
            physical_private_bytes: "0",
            cleanup_jobs: 0,
          },
          public_usage: overflow,
          cleanup: {
            remaining_jobs: 0,
            has_more: false,
            state: null,
          },
          active_operations: [],
          body_bytes: 0,
        },
      },
    })
  ).toThrow("exceeds nat64");
});

test("a future outcome decoded as null becomes unsupported and discards its Blob", async () => {
  const transport = new FixtureTransport();
  transport.queryBlobBody = Uint8Array.from([1, 2, 3]).buffer;
  const adapter = new FilesBackendAdapter(transport);

  const result = await adapter.bootstrap();
  expect(result.kind).toBe("unsupported");
  expect(result.body.byteLength).toBe(0);
  expect(transport.calls).toHaveLength(1);
  expect(transport.calls[0]).toMatchObject({
    kind: "query",
    method: FILES_V2_METHODS.bootstrap,
    value: {},
  });
});

test("null and unknown read frame kinds never release an opaque body", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  transport.queryBlobBody = Uint8Array.from([0xaa, 0xbb]).buffer;
  transport.queryBlobValue = readSuccess(null, 2);

  const unsupported = await adapter.readChunk(readRequest());
  expect(unsupported.kind).toBe("unsupported");
  expect(unsupported.body.byteLength).toBe(0);

  transport.queryBlobValue = readSuccess(
    { future_frame_kind: null },
    2,
  );
  const unknown = await adapter.readChunk(readRequest());
  expect(unknown.kind).toBe("unsupported");
  expect(unknown.body.byteLength).toBe(0);
});

test("a future rejection reason decoded as null remains a known rejection with no retry default", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  transport.queryValue = {
    outcome: {
      rejected: {
        reason: null,
        retry_after_ns: null,
      },
    },
  };

  const result = await adapter.operationStatus({
    request_id: id(10, 20),
    target: { mutation: { node_id: id(30, 40) } },
  });
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("expected rejection");
  expect(result.rejection.reason).toBeNull();
  expect(result.rejection.retryAfterNs).toBeNull();

  transport.queryValue = {
    outcome: {
      rejected: {
        reason: { future_reason: null },
        retry_after_ns: null,
      },
    },
  };
  await expect(
    adapter.operationStatus({
      request_id: id(10, 20),
      target: { mutation: { node_id: id(30, 40) } },
    }),
  ).rejects.toMatchObject({ code: "FILES_INVALID_RESPONSE" });
});

test("lookup carries its blind tag in the request record and drops rejection bodies", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  transport.queryBlobValue = {
    outcome: {
      rejected: {
        reason: { not_found: null },
        retry_after_ns: null,
      },
    },
  };
  transport.queryBlobBody = Uint8Array.from([9, 9, 9]).buffer;

  const node = await adapter.lookup({
    locator: { node: { node_id: id(1, 2) } },
    body: new Uint8Array(),
  });
  expect(node.kind).toBe("rejected");
  expect(node.body.byteLength).toBe(0);
  expect(transport.calls[0]?.body?.byteLength).toBe(0);

  const tag = Uint8Array.from({ length: 32 }, (_, index) => index);
  await adapter.lookup({
    locator: {
      child: {
        parent_id: id(3, 4),
        expected_children_revision: nat64(5),
      },
    },
    body: tag.slice(),
  });
  expect(new Uint8Array(transport.calls[1]?.body ?? new ArrayBuffer(0))).toEqual(
    tag,
  );
  expect(transport.calls[1]?.body?.byteLength).toBe(32);

  expect(() =>
    adapter.lookup({
      locator: { node: { node_id: id(1, 2) } },
      body: tag.slice(),
    })
  ).toThrow("Node lookup requires zero bytes");
  expect(() =>
    adapter.lookup({
      locator: {
        child: {
          parent_id: id(3, 4),
          expected_children_revision: null,
        },
      },
      body: new Uint8Array(),
    })
  ).toThrow("child lookup requires a 32-byte blind tag");
  expect(transport.calls).toHaveLength(2);
});

test("input Blobs remain correlated to body_bytes and unknown mutations fail before dispatch", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  const frame = Uint8Array.from([4, 5, 6]).buffer;
  const request = {
    request_id: id(1, 2),
    operation: { initialize: null } as const,
    expected_record_revision: null,
    proposed_record_revision: nat64(1),
    body_bytes: 3,
    body: new Uint8Array(frame).slice(),
  };

  const result = await adapter.vaultWrite(request);
  expect(result.kind).toBe("unsupported");
  const {
    expected_record_revision: _expectedRecordRevision,
    ...encodedRequest
  } = request;
  expect(transport.calls[0]).toMatchObject({
    kind: "update",
    method: FILES_V2_METHODS.vaultWrite,
    value: encodedRequest,
  });
  expect(new Uint8Array(transport.calls[0]?.body ?? new ArrayBuffer(0))).toEqual(
    new Uint8Array(frame),
  );

  await expect(
    adapter.vaultWrite({ ...request, body_bytes: 2 }),
  ).rejects.toMatchObject({ code: "FILES_INVALID_WIRE_VALUE" });
  await expect(
    adapter.vaultWrite({
      ...request,
      operation: { future_operation: null } as never,
    }),
  ).rejects.toBeInstanceOf(FilesProtocolValueError);
  expect(transport.calls).toHaveLength(1);
});

test("successful Blob metadata must bind the exact returned body length", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  transport.queryBlobValue = {
    outcome: {
      ok: {
        parent_id: wireId(0, 0),
        structural_revision: "1",
        children_revision: "1",
        total_children: 0,
        loaded_count: 0,
        next_cursor: null,
        has_more: false,
        body_bytes: 2,
      },
    },
  };
  transport.queryBlobBody = Uint8Array.from([1, 2, 3]).buffer;

  await expect(
    adapter.list({
      parent_id: id(0, 0),
      expected_structural_revision: null,
      cursor: null,
      limit: 100,
    }),
  ).rejects.toMatchObject({ code: "FILES_BLOB_LENGTH_MISMATCH" });
});

test("canonical nat64 and exact request records are enforced before the normalized bridge", async () => {
  const transport = new FixtureTransport();
  const adapter = new FilesBackendAdapter(transport);
  const request = {
    request_id: id(1, 2),
    node_id: id(3, 4),
    expected_structural_revision: nat64(5),
    expected_parent_id: id(0, 0),
    expected_parent_children_revision: nat64(6),
    recursive: true,
  };
  await adapter.remove(request);
  expect(transport.calls[0]).toMatchObject({
    kind: "update",
    method: FILES_V2_METHODS.remove,
    value: {
      expected_structural_revision: "5",
      expected_parent_children_revision: "6",
    },
  });

  await expect(
    adapter.remove({
      ...request,
      expected_structural_revision: "05" as CanonicalNat64,
    }),
  ).rejects.toBeInstanceOf(FilesProtocolValueError);
  await expect(
    adapter.remove({
      ...request,
      future_field: null,
    } as never),
  ).rejects.toBeInstanceOf(FilesProtocolValueError);
  expect(transport.calls).toHaveLength(1);
});

function readRequest() {
  return {
    node_id: id(1, 2),
    structural_revision: nat64(3),
    content_id: id(4, 5),
    index: 0,
  };
}

function bodyFromRequest(
  value: FilesSelfCallValue,
): { body?: ArrayBuffer } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return {};
  }
  const body = value.body;
  if (!(body instanceof Uint8Array)) return {};
  const copy = body.slice();
  return { body: copy.buffer as ArrayBuffer };
}

function nestedValue(depth: number): JsonValue {
  let value: JsonValue = null;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

function committedNodes(count: number): JsonValue[] {
  return Array.from({ length: count }, (_, index) => ({
    node_id: wireId(index, index + 1),
    content_id: wireId(index + 100, index + 101),
    structural_revision: String(index + 1),
    metadata_revision: String(index + 2),
  }));
}

function writeTargetNodes(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    node_id: id(index, index + 1),
    content_id: id(index + 100, index + 101),
  }));
}

function publicUsage(word: string, liveEntries = word): JsonValue {
  return {
    current: {
      live_entries: liveEntries,
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
    manifest_limits: publicUsageLimits(word),
    effective_limits: publicUsageLimits(word),
  };
}

function publicUsageLimits(word: string): JsonValue {
  return {
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
}

function readSuccess(frameKind: JsonValue, bodyBytes: number): JsonValue {
  return {
    outcome: {
      ok: {
        node_id: wireId(1, 2),
        structural_revision: "3",
        metadata_revision: "4",
        content_id: wireId(4, 5),
        index: 0,
        block_count: 1,
        ciphertext_block_bytes: bodyBytes,
        ciphertext_total_bytes: String(bodyBytes),
        frame_kind: frameKind,
      },
    },
  };
}

function id(hi: number, lo: number): FilesId128V2 {
  return {
    hi: nat64(hi),
    lo: nat64(lo),
  };
}

function wireId(hi: number, lo: number): JsonValue {
  return {
    hi: String(hi),
    lo: String(lo),
  };
}

function nat64(value: number): CanonicalNat64 {
  return String(value) as CanonicalNat64;
}
