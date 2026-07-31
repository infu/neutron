import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { SelfCallValue } from "neutron-tools/app";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import {
  FILES_PLAIN_METHODS,
  FilesPlainBackendAdapter,
  type FilesPlainTransport,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";

const appRoot = new URL("../", import.meta.url);

type CapturedCall = Readonly<{
  method: string;
  args: SelfCallValue[];
}>;

test("plain adapter emits schema-valid JSON shadows for every V3 method", async () => {
  const [backendSource, manifestSource] = await Promise.all([
    readFile(new URL("backend/main.mo", appRoot), "utf8"),
    readFile(new URL("neutron.json", appRoot), "utf8"),
  ]);
  const artifact = generateAppMethodSchemaArtifact(
    JSON.parse(manifestSource) as NeutronManifest,
    backendSource,
  );
  const calls: CapturedCall[] = [];
  const transport: FilesPlainTransport = {
    query: async (method, args) => {
      calls.push({ method, args });
      switch (method) {
        case FILES_PLAIN_METHODS.list:
          {
            const continuation =
              (args[0] as Record<string, SelfCallValue>).cursor !==
                undefined;
          return ok({
            revision: "8",
            entries: continuation ? [plainFile()] : [],
            total: continuation ? 2 : 0,
            next_cursor: null,
            has_more: false,
          });
          }
        case FILES_PLAIN_METHODS.stat:
          return ok(plainFile());
        case FILES_PLAIN_METHODS.readChunk:
          return {
            value: ok({
              entry: plainFile(),
              block_index: 0,
              block_count: 1,
              body_bytes: 0,
            }),
            body: new Uint8Array(0),
          };
        default:
          throw new Error(`unexpected query method: ${method}`);
      }
    },
    update: async (method, args) => {
      calls.push({ method, args });
      if (method === FILES_PLAIN_METHODS.writeBlock) {
        return ok({
          stage_id: null,
          committed: false,
          entry: null,
        });
      }
      return ok({ path: "/", revision: "9", changed: 0 });
    },
  };
  const adapter = new FilesPlainBackendAdapter(transport);

  await adapter.list({
    space: "workspace",
    path: "/",
    cursor: null,
    limit: 32,
  });
  await adapter.list({
    space: "workspace",
    path: "/",
    cursor: {
      after: "before.txt",
      revision: nat(8),
      parentNodeId: nat(3),
      seen: 1,
      total: 2,
    },
    limit: 32,
  });
  const stat = await adapter.stat({
    space: "workspace",
    path: "/report.txt",
  });
  await adapter.readChunk({
    space: "workspace",
    path: "/report.txt",
    blockIndex: 0,
  });
  await adapter.writeBlock({
    requestId: "schema-write",
    space: "shared",
    path: "/published/report.txt",
    stageId: null,
    blockIndex: 0,
    blockCount: 1,
    totalBytes: 2,
    contentKind: "text",
    mediaType: "text/plain",
    etagSha256: "ab".repeat(32),
    presentation: null,
    ifMatch: null,
    expectedNodeId: nat(41),
    expectedRevision: nat(7),
    ifNoneMatch: false,
    createParents: true,
    final: true,
    safeName: "report.txt",
    beginNonce: null,
    commitNonce: null,
    deleteNonce: null,
    moveSource: {
      path: "/draft/report.txt",
      expectedNodeId: nat(42),
      expectedRevision: nat(6),
      ifMatch: null,
    },
    body: Uint8Array.of(111, 107),
  });
  await adapter.mkdir({
    requestId: "schema-mkdir",
    space: "workspace",
    path: "/draft",
    recursive: true,
  });
  await adapter.move({
    requestId: "schema-move",
    space: "workspace",
    from: "/draft/report.txt",
    to: "/archive/report.txt",
    overwrite: false,
    expectedNodeId: nat(42),
    expectedRevision: nat(6),
    ifMatch: null,
  });
  await adapter.remove({
    requestId: "schema-remove",
    space: "workspace",
    path: "/archive/report.txt",
    recursive: false,
    expectedNodeId: nat(42),
    expectedRevision: nat(7),
    ifMatch: null,
    deleteNonce: null,
  });
  await adapter.abort({
    requestId: "schema-abort",
    space: "shared",
    stageId: nat(12),
  });
  await adapter.abort({
    requestId: "schema-abort-unknown-stage",
    space: "workspace",
    stageId: null,
  });
  await adapter.cleanup({
    requestId: "schema-cleanup",
    limit: 16,
  });

  expect(stat.nodeId).toBe(nat(41));
  expect(new Set(calls.map(({ method }) => method))).toEqual(
    new Set(Object.values(FILES_PLAIN_METHODS)),
  );

  for (const call of calls) {
    const args = call.args.map(toSchemaJson) as Parameters<
      typeof validateAppMethodArgs
    >[2];
    const result = validateAppMethodArgs(artifact, call.method, args);
    expect(
      result.valid,
      `${call.method}: ${JSON.stringify(result.errors)}`,
    ).toBe(true);
  }

  const listRequests = requestsFor(calls, FILES_PLAIN_METHODS.list);
  expect(listRequests[0]).not.toHaveProperty("cursor");
  expect(listRequests[1]).toMatchObject({
    cursor: {
      after: "before.txt",
      revision: "8",
      parent_node_id: "3",
    },
  });

  const write = requestFor(calls, FILES_PLAIN_METHODS.writeBlock);
  expect(write).toMatchObject({
    expected_node_id: "41",
    expected_revision: "7",
    safe_name: "report.txt",
    move_source: {
      path: "/draft/report.txt",
      expected_node_id: "42",
      expected_revision: "6",
    },
  });
  for (const optional of [
    "stage_id",
    "presentation",
    "if_match",
    "begin_nonce",
    "commit_nonce",
    "delete_nonce",
  ]) {
    expect(write).not.toHaveProperty(optional);
  }
  expect(write.move_source).not.toHaveProperty("if_match");

  expect(requestFor(calls, FILES_PLAIN_METHODS.move)).not.toHaveProperty(
    "if_match",
  );
  const remove = requestFor(calls, FILES_PLAIN_METHODS.remove);
  expect(remove).not.toHaveProperty("if_match");
  expect(remove).not.toHaveProperty("delete_nonce");
  expect(requestFor(calls, FILES_PLAIN_METHODS.cleanup)).toEqual({
    request_id: "schema-cleanup",
    limit: 16,
  });
});

function requestFor(
  calls: readonly CapturedCall[],
  method: string,
): Record<string, SelfCallValue> {
  const matches = requestsFor(calls, method);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function requestsFor(
  calls: readonly CapturedCall[],
  method: string,
): Array<Record<string, SelfCallValue>> {
  return calls
    .filter((call) => call.method === method)
    .map((call) => call.args[0] as Record<string, SelfCallValue>);
}

function toSchemaJson(
  value: SelfCallValue,
): Parameters<typeof validateAppMethodArgs>[2][number] {
  if (value instanceof Uint8Array) return [...value];
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (Array.isArray(value)) return value.map(toSchemaJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toSchemaJson(item as SelfCallValue),
      ]),
    );
  }
  return value;
}

function ok(value: SelfCallValue): SelfCallValue {
  return { outcome: { ok: value } };
}

function plainFile(): SelfCallValue {
  return {
    node_id: "41",
    path: "/report.txt",
    name: "report.txt",
    kind: { file: null },
    content_kind: { text: null },
    byte_length: "0",
    media_type: "text/plain",
    etag_sha256: "ab".repeat(32),
    created_at_ns: "4",
    modified_at_ns: "5",
    revision: "7",
    relative_url: null,
  };
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}
