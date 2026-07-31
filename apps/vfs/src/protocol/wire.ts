import type {
  JsonObject,
  JsonValue,
  SelfCallObject,
} from "neutron-tools/app";
import {
  FILES_V2_LIMITS,
  FILES_V2_METHODS,
  type FilesV2Method,
} from "./constants.ts";
import {
  FilesProtocolValueError,
  parseCanonicalNat64,
  parseFilesId128,
  parseNat32,
} from "./ids.ts";
import {
  assertNormalizedRequest,
  parseFilesOutcome,
  requireRecord,
  singleVariant,
} from "./parsers.ts";
import type {
  CanonicalNat64,
  FilesAbortOkV2,
  FilesAbortRequestV2,
  FilesAttachmentOutcomeV2,
  FilesBootstrapOkV2,
  FilesBootstrapRequestV2,
  FilesCleanupOkV2,
  FilesCleanupRequestV2,
  FilesCleanupStateV2,
  FilesCleanupSummaryV2,
  FilesCommittedDetailV2,
  FilesCommittedNodeV2,
  FilesContentDescriptorV2,
  FilesDigest256V2,
  FilesFrameBlockMappingV2,
  FilesId128V2,
  FilesListCursorV2,
  FilesListOkV2,
  FilesListRequestV2,
  FilesLookupLocatorV2,
  FilesLookupOkV2,
  FilesLookupRequestV2,
  FilesMutateOkV2,
  FilesMutateRequestV2,
  FilesNodeBindingV2,
  FilesOperationKindV2,
  FilesOperationStateV2,
  FilesOperationStatusOkV2,
  FilesOperationStatusRequestV2,
  FilesOperationSummaryV2,
  FilesOperationTargetV2,
  FilesOutcomeV2,
  FilesPublicUsageCountersV2,
  FilesPublicUsageLimitsV2,
  FilesPublicUsageV2,
  FilesQuotaSnapshotV2,
  FilesRemoveOkV2,
  FilesRemoveRequestV2,
  FilesUnitVariantV2,
  FilesVaultStateV2,
  FilesVaultWriteOkV2,
  FilesVaultWriteRequestV2,
  FilesWriteBlockOkV2,
  FilesWriteBlockRequestV2,
} from "./types.ts";

export type FilesV2RequestByMethod = {
  [FILES_V2_METHODS.bootstrap]: FilesBootstrapRequestV2;
  [FILES_V2_METHODS.list]: FilesListRequestV2;
  [FILES_V2_METHODS.lookup]: FilesLookupRequestV2;
  [FILES_V2_METHODS.readChunk]: import("./types.ts").FilesReadChunkRequestV2;
  [FILES_V2_METHODS.operationStatus]: FilesOperationStatusRequestV2;
  [FILES_V2_METHODS.vaultWrite]: FilesVaultWriteRequestV2;
  [FILES_V2_METHODS.writeBlock]: FilesWriteBlockRequestV2;
  [FILES_V2_METHODS.mutate]: FilesMutateRequestV2;
  [FILES_V2_METHODS.remove]: FilesRemoveRequestV2;
  [FILES_V2_METHODS.abort]: FilesAbortRequestV2;
  [FILES_V2_METHODS.cleanup]: FilesCleanupRequestV2;
};

export type FilesV2OkByMethod = {
  [FILES_V2_METHODS.bootstrap]: FilesBootstrapOkV2;
  [FILES_V2_METHODS.list]: FilesListOkV2;
  [FILES_V2_METHODS.lookup]: FilesLookupOkV2;
  [FILES_V2_METHODS.readChunk]: JsonObject;
  [FILES_V2_METHODS.operationStatus]: FilesOperationStatusOkV2;
  [FILES_V2_METHODS.vaultWrite]: FilesVaultWriteOkV2;
  [FILES_V2_METHODS.writeBlock]: FilesWriteBlockOkV2;
  [FILES_V2_METHODS.mutate]: FilesMutateOkV2;
  [FILES_V2_METHODS.remove]: FilesRemoveOkV2;
  [FILES_V2_METHODS.abort]: FilesAbortOkV2;
  [FILES_V2_METHODS.cleanup]: FilesCleanupOkV2;
};

export function encodeFilesV2Request<M extends FilesV2Method>(
  method: M,
  request: FilesV2RequestByMethod[M],
): SelfCallObject {
  const value = request as unknown;
  let encoded: SelfCallObject;
  switch (method) {
    case FILES_V2_METHODS.bootstrap:
    case FILES_V2_METHODS.cleanup:
      encoded = emptyRequest(value, method);
      break;
    case FILES_V2_METHODS.list:
      encoded = encodeListRequest(value);
      break;
    case FILES_V2_METHODS.lookup:
      encoded = encodeLookupRequest(value);
      break;
    case FILES_V2_METHODS.readChunk:
      encoded = encodeReadRequest(value);
      break;
    case FILES_V2_METHODS.operationStatus:
      encoded = encodeOperationStatusRequest(value);
      break;
    case FILES_V2_METHODS.vaultWrite:
      encoded = encodeVaultWriteRequest(value);
      break;
    case FILES_V2_METHODS.writeBlock:
      encoded = encodeWriteBlockRequest(value);
      break;
    case FILES_V2_METHODS.mutate:
      encoded = encodeMutateRequest(value);
      break;
    case FILES_V2_METHODS.remove:
      encoded = encodeRemoveRequest(value);
      break;
    case FILES_V2_METHODS.abort:
      encoded = encodeAbortRequest(value);
      break;
    default:
      throw wireError(`Unsupported Files method: ${String(method)}`);
  }
  assertBoundedEncodedRequest(encoded, method);
  return encoded;
}
export function parseFilesV2Response<M extends FilesV2Method>(
  method: M,
  value: unknown,
): FilesOutcomeV2<FilesV2OkByMethod[M]> {
  if (method === FILES_V2_METHODS.readChunk) {
    throw wireError("Read chunk responses require Blob-aware parsing");
  }
  const outcome = parseFilesOutcome(value, method);
  if (outcome.kind !== "ok") {
    return outcome as FilesOutcomeV2<FilesV2OkByMethod[M]>;
  }
  const parsed = parseOk(method, outcome.value);
  return Object.freeze({
    kind: "ok",
    value: parsed,
  }) as FilesOutcomeV2<FilesV2OkByMethod[M]>;
}

export function expectedFilesOutputBodyBytes(
  method: FilesV2Method,
  outcome: FilesOutcomeV2,
): number | null {
  if (outcome.kind !== "ok") return null;
  if (
    method !== FILES_V2_METHODS.bootstrap &&
    method !== FILES_V2_METHODS.list &&
    method !== FILES_V2_METHODS.lookup
  ) {
    return null;
  }
  const value = requireRecord(outcome.value, `${method} success`);
  return nat32(value.body_bytes, `${method}.body_bytes`);
}

export function assertFilesInputBodyLength(
  method: FilesV2Method,
  request: SelfCallObject,
): void {
  if (
    method !== FILES_V2_METHODS.vaultWrite &&
    method !== FILES_V2_METHODS.writeBlock &&
    method !== FILES_V2_METHODS.mutate
  ) {
    return;
  }
  const declared = nat32(request.body_bytes, `${method}.body_bytes`);
  const body = request.body;
  if (!(body instanceof Uint8Array)) {
    throw wireError(`${method} body must be a Uint8Array`);
  }
  if (declared !== body.byteLength) {
    throw wireError(`${method} body length does not match body_bytes`);
  }
}

function parseOk(method: FilesV2Method, value: JsonValue): JsonValue {
  switch (method) {
    case FILES_V2_METHODS.bootstrap:
      return parseBootstrapOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.list:
      return parseListOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.lookup:
      return parseLookupOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.operationStatus:
      return parseOperationStatusOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.vaultWrite:
      return parseVaultWriteOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.writeBlock:
      return parseWriteBlockOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.mutate:
      return parseMutateOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.remove:
      return parseRemoveOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.abort:
      return parseAbortOk(value) as unknown as JsonValue;
    case FILES_V2_METHODS.cleanup:
      return parseCleanupOk(value) as unknown as JsonValue;
    default:
      throw wireError(`${method} does not have a plain parsed response`);
  }
}

function encodeListRequest(value: unknown): JsonObject {
  const request = exact(value, [
    "parent_id",
    "expected_structural_revision",
    "cursor",
    "limit",
  ], "Files list request");
  return {
    parent_id: id(request.parent_id, "parent_id"),
    ...(request.expected_structural_revision === null
      ? {}
      : {
          expected_structural_revision: nat64(
            request.expected_structural_revision,
            "expected_structural_revision",
          ),
        }),
    ...(request.cursor === null
      ? {}
      : { cursor: listCursor(request.cursor, "cursor") }),
    limit: boundedNat(request.limit, 16, 1, FILES_V2_LIMITS.directChildPageMaximum, "limit"),
  };
}

function encodeLookupRequest(value: unknown): SelfCallObject {
  const request = exact(value, ["locator", "body"], "Files lookup request");
  const body = blob(request.body, "body");
  if (request.locator === null) return { body };
  const [tag, payload] = variant(
    request.locator,
    ["node", "child"] as const,
    "lookup locator",
  );
  if (tag === "node") {
    const node = exact(payload, ["node_id"], "node locator");
    return {
      locator: { node: { node_id: id(node.node_id, "node_id") } },
      body,
    };
  }
  const child = exact(
    payload,
    ["parent_id", "expected_children_revision"],
    "child locator",
  );
  return {
    locator: {
      child: {
        parent_id: id(child.parent_id, "parent_id"),
        ...(child.expected_children_revision === null
          ? {}
          : {
              expected_children_revision: nat64(
                child.expected_children_revision,
                "expected_children_revision",
              ),
            }),
      },
    },
    body,
  };
}

function encodeReadRequest(value: unknown): JsonObject {
  const request = exact(
    value,
    ["node_id", "structural_revision", "content_id", "index"],
    "Files read request",
  );
  return {
    node_id: id(request.node_id, "node_id"),
    structural_revision: nat64(request.structural_revision, "structural_revision"),
    content_id: id(request.content_id, "content_id"),
    index: nat32(request.index, "index"),
  };
}

function encodeOperationStatusRequest(value: unknown): JsonObject {
  const request = exact(value, ["request_id", "target"], "operation status request");
  return {
    request_id: id(request.request_id, "request_id"),
    ...(request.target === null
      ? {}
      : { target: encodeOperationTarget(request.target, "target") }),
  };
}

function encodeVaultWriteRequest(value: unknown): SelfCallObject {
  const request = exact(
    value,
    [
      "request_id",
      "operation",
      "expected_record_revision",
      "proposed_record_revision",
      "body_bytes",
      "body",
    ],
    "vault write request",
  );
  return {
    request_id: id(request.request_id, "request_id"),
    ...(request.operation === null
      ? {}
      : {
          operation: unitVariant(
            request.operation,
            ["initialize", "rewrap"] as const,
            "vault operation",
          ),
        }),
    ...(request.expected_record_revision === null
      ? {}
      : {
          expected_record_revision: nat64(
            request.expected_record_revision,
            "expected_record_revision",
          ),
        }),
    proposed_record_revision: nat64(
      request.proposed_record_revision,
      "proposed_record_revision",
    ),
    body_bytes: nat32(request.body_bytes, "body_bytes"),
    body: blob(request.body, "body"),
  };
}

function encodeWriteBlockRequest(value: unknown): SelfCallObject {
  const request = exact(
    value,
    ["request_id", "stage_id", "frame_ordinal", "final", "body_bytes", "body"],
    "write block request",
  );
  return {
    request_id: id(request.request_id, "request_id"),
    ...(request.stage_id === null
      ? {}
      : { stage_id: nat64(request.stage_id, "stage_id") }),
    frame_ordinal: boundedNat(request.frame_ordinal, 8, 0, 255, "frame_ordinal"),
    final: bool(request.final, "final"),
    body_bytes: nat32(request.body_bytes, "body_bytes"),
    body: blob(request.body, "body"),
  };
}

function encodeMutateRequest(value: unknown): SelfCallObject {
  const request = exact(
    value,
    ["request_id", "action", "body_bytes", "body"],
    "mutate request",
  );
  return {
    request_id: id(request.request_id, "request_id"),
    ...(request.action === null
      ? {}
      : {
          action: unitVariant(
            request.action,
            ["create_folder", "rename", "move"] as const,
            "mutation action",
          ),
        }),
    body_bytes: nat32(request.body_bytes, "body_bytes"),
    body: blob(request.body, "body"),
  };
}

function encodeRemoveRequest(value: unknown): JsonObject {
  const request = exact(
    value,
    [
      "request_id",
      "node_id",
      "expected_structural_revision",
      "expected_parent_id",
      "expected_parent_children_revision",
      "recursive",
    ],
    "remove request",
  );
  return {
    request_id: id(request.request_id, "request_id"),
    node_id: id(request.node_id, "node_id"),
    expected_structural_revision: nat64(
      request.expected_structural_revision,
      "expected_structural_revision",
    ),
    expected_parent_id: id(request.expected_parent_id, "expected_parent_id"),
    expected_parent_children_revision: nat64(
      request.expected_parent_children_revision,
      "expected_parent_children_revision",
    ),
    recursive: bool(request.recursive, "recursive"),
  };
}

function encodeAbortRequest(value: unknown): JsonObject {
  const request = exact(
    value,
    ["request_id", "stage_id"],
    "abort request",
  );
  return {
    request_id: id(request.request_id, "request_id"),
    stage_id: nat64(request.stage_id, "stage_id"),
  };
}

function parseBootstrapOk(value: unknown): FilesBootstrapOkV2 {
  const ok = required(value, [
    "quota",
    "public_usage",
    "cleanup",
    "active_operations",
    "body_bytes",
  ], "bootstrap success");
  return {
    vault: isAbsent(ok.vault) ? null : vaultState(ok.vault, "vault"),
    quota: quota(ok.quota, "quota"),
    public_usage: publicUsage(ok.public_usage, "public_usage"),
    cleanup: cleanupSummary(ok.cleanup, "cleanup"),
    active_operations: array(ok.active_operations, 3, "active_operations").map(
      (item, index) => operationSummary(item, `active_operations[${index}]`),
    ),
    body_bytes: nat32(ok.body_bytes, "body_bytes"),
  };
}

function parseListOk(value: unknown): FilesListOkV2 {
  const ok = required(value, [
    "parent_id",
    "structural_revision",
    "children_revision",
    "total_children",
    "loaded_count",
    "has_more",
    "body_bytes",
  ], "list success");
  return {
    parent_id: id(ok.parent_id, "parent_id"),
    structural_revision: nat64(ok.structural_revision, "structural_revision"),
    children_revision: nat64(ok.children_revision, "children_revision"),
    total_children: nat32(ok.total_children, "total_children"),
    loaded_count: boundedNat(ok.loaded_count, 16, 0, FILES_V2_LIMITS.directChildPageMaximum, "loaded_count"),
    next_cursor:
      isAbsent(ok.next_cursor)
        ? null
        : listCursor(ok.next_cursor, "next_cursor"),
    has_more: bool(ok.has_more, "has_more"),
    body_bytes: nat32(ok.body_bytes, "body_bytes"),
  };
}

function parseLookupOk(value: unknown): FilesLookupOkV2 {
  const ok = required(value, ["node", "body_bytes"], "lookup success");
  return {
    node: nodeBinding(ok.node, "node"),
    content:
      isAbsent(ok.content) ? null : contentDescriptor(ok.content, "content"),
    body_bytes: nat32(ok.body_bytes, "body_bytes"),
  };
}

function parseOperationStatusOk(value: unknown): FilesOperationStatusOkV2 {
  const ok = required(
    value,
    ["request_id"],
    "operation status success",
  );
  return {
    request_id: id(ok.request_id, "request_id"),
    target: isAbsent(ok.target) ? null : operationTarget(ok.target, "target"),
    state: isAbsent(ok.state) ? null : operationState(ok.state, "state"),
    cleanup_state:
      isAbsent(ok.cleanup_state)
        ? null
        : cleanupState(ok.cleanup_state, "cleanup_state"),
  };
}

function parseVaultWriteOk(value: unknown): FilesVaultWriteOkV2 {
  const ok = required(
    value,
    ["request_id", "record_revision", "initialized"],
    "vault write success",
  );
  return {
    request_id: id(ok.request_id, "request_id"),
    record_revision: nat64(ok.record_revision, "record_revision"),
    initialized: bool(ok.initialized, "initialized"),
  };
}

function parseWriteBlockOk(value: unknown): FilesWriteBlockOkV2 {
  const ok = required(value, [
    "request_id",
    "frame_ordinal",
    "accepted_frames_bitmap",
    "committed_nodes",
  ], "write block success");
  const committedNodes = array(
    ok.committed_nodes,
    FILES_V2_LIMITS.committedNodesPerReceipt,
    "committed_nodes",
  ).map((node, index) =>
    committedNode(node, `committed_nodes[${index}]`)
  );
  assertCanonicalNodeOrder(committedNodes, "committed_nodes");
  return {
    request_id: id(ok.request_id, "request_id"),
    stage_id: optionalNat64(ok.stage_id, "stage_id"),
    frame_ordinal: boundedNat(ok.frame_ordinal, 8, 0, 255, "frame_ordinal"),
    accepted_frames_bitmap: boundedNat(
      ok.accepted_frames_bitmap,
      16,
      0,
      0xffff,
      "accepted_frames_bitmap",
    ),
    committed_nodes: committedNodes,
    cleanup_state:
      isAbsent(ok.cleanup_state)
        ? null
        : cleanupState(ok.cleanup_state, "cleanup_state"),
  };
}

function parseMutateOk(value: unknown): FilesMutateOkV2 {
  const ok = required(value, [
    "request_id",
    "node_id",
    "parent_id",
    "structural_revision",
    "metadata_revision",
  ], "mutate success");
  return {
    request_id: id(ok.request_id, "request_id"),
    node_id: id(ok.node_id, "node_id"),
    parent_id: id(ok.parent_id, "parent_id"),
    structural_revision: nat64(ok.structural_revision, "structural_revision"),
    metadata_revision: nat64(ok.metadata_revision, "metadata_revision"),
  };
}

function parseRemoveOk(value: unknown): FilesRemoveOkV2 {
  const ok = required(value, [
    "request_id",
    "node_id",
    "detached_plaintext_bytes",
    "reclaimed_entries",
    "reclaimed_ciphertext_bytes",
  ], "remove success");
  return {
    request_id: id(ok.request_id, "request_id"),
    node_id: id(ok.node_id, "node_id"),
    detached_plaintext_bytes: nat64(
      ok.detached_plaintext_bytes,
      "detached_plaintext_bytes",
    ),
    reclaimed_entries: boundedNat(ok.reclaimed_entries, 16, 0, 0xffff, "reclaimed_entries"),
    reclaimed_ciphertext_bytes: nat64(
      ok.reclaimed_ciphertext_bytes,
      "reclaimed_ciphertext_bytes",
    ),
    cleanup_state:
      isAbsent(ok.cleanup_state)
        ? null
        : cleanupState(ok.cleanup_state, "cleanup_state"),
  };
}

function parseAbortOk(value: unknown): FilesAbortOkV2 {
  const ok = required(
    value,
    ["request_id", "stage_id"],
    "abort success",
  );
  return {
    request_id: id(ok.request_id, "request_id"),
    stage_id: nat64(ok.stage_id, "stage_id"),
    cleanup_state:
      isAbsent(ok.cleanup_state)
        ? null
        : cleanupState(ok.cleanup_state, "cleanup_state"),
  };
}

function parseCleanupOk(value: unknown): FilesCleanupOkV2 {
  const ok = required(value, [
    "reclaimed_entries",
    "reclaimed_ciphertext_bytes",
    "reclaimed_charged_bytes",
    "remaining_jobs",
    "has_more",
  ], "cleanup success");
  return {
    reclaimed_entries: boundedNat(ok.reclaimed_entries, 16, 0, 0xffff, "reclaimed_entries"),
    reclaimed_ciphertext_bytes: nat64(
      ok.reclaimed_ciphertext_bytes,
      "reclaimed_ciphertext_bytes",
    ),
    reclaimed_charged_bytes: nat64(
      ok.reclaimed_charged_bytes,
      "reclaimed_charged_bytes",
    ),
    remaining_jobs: boundedNat(ok.remaining_jobs, 16, 0, 0xffff, "remaining_jobs"),
    has_more: bool(ok.has_more, "has_more"),
  };
}

function id(value: unknown, label: string): FilesId128V2 {
  return parseFilesId128(value, label);
}

function optionalId(value: unknown, label: string): FilesId128V2 | null {
  return isAbsent(value) ? null : id(value, label);
}

function digest(value: unknown, label: string): FilesDigest256V2 {
  const record = exact(value, ["a", "b", "c", "d"], label);
  return {
    a: nat64(record.a, `${label}.a`),
    b: nat64(record.b, `${label}.b`),
    c: nat64(record.c, `${label}.c`),
    d: nat64(record.d, `${label}.d`),
  };
}

function listCursor(value: unknown, label: string): FilesListCursorV2 {
  const cursor = exact(
    value,
    ["parent_id", "children_revision", "last_name_tag"],
    label,
  );
  return {
    parent_id: id(cursor.parent_id, `${label}.parent_id`),
    children_revision: nat64(
      cursor.children_revision,
      `${label}.children_revision`,
    ),
    last_name_tag: digest(cursor.last_name_tag, `${label}.last_name_tag`),
  };
}

function encodeOperationTarget(value: unknown, label: string): JsonObject {
  const [tag, payload] = variant(
    value,
    ["vault", "private_write", "mutation", "remove", "abort"] as const,
    label,
  );
  if (tag === "vault") {
    const item = exact(payload, ["expected_record_revision"], `${label}.vault`);
    return {
      vault: {
        ...(item.expected_record_revision === null
          ? {}
          : {
              expected_record_revision: nat64(
                item.expected_record_revision,
                `${label}.vault.expected_record_revision`,
              ),
            }),
      },
    };
  }
  if (tag === "private_write") {
    const item = exact(payload, ["nodes"], `${label}.private_write`);
    const nodes = array(
      item.nodes,
      FILES_V2_LIMITS.operationWriteTargetNodes,
      `${label}.private_write.nodes`,
    );
    if (nodes.length === 0) {
      throw wireError(`${label}.private_write.nodes must not be empty`);
    }
    const encodedNodes = nodes.map((node, index) => {
      const target = exact(
        node,
        ["node_id", "content_id"],
        `${label}.private_write.nodes[${index}]`,
      );
      return {
        node_id: id(
          target.node_id,
          `${label}.private_write.nodes[${index}].node_id`,
        ),
        ...(target.content_id === null
          ? {}
          : {
              content_id: id(
                target.content_id,
                `${label}.private_write.nodes[${index}].content_id`,
              ),
            }),
      };
    });
    assertCanonicalNodeOrder(
      encodedNodes,
      `${label}.private_write.nodes`,
    );
    return { private_write: { nodes: encodedNodes } };
  }
  if (tag === "mutation" || tag === "remove") {
    const item = exact(payload, ["node_id"], `${label}.${tag}`);
    return {
      [tag]: { node_id: id(item.node_id, `${label}.${tag}.node_id`) },
    };
  }
  if (tag === "abort") {
    const item = exact(
      payload,
      ["stage_id"],
      `${label}.abort`,
    );
    return {
      abort: {
        stage_id: nat64(item.stage_id, `${label}.abort.stage_id`),
      },
    };
  }
  throw wireError(`${label} has an unsupported operation target`);
}

function operationTarget(value: unknown, label: string): FilesOperationTargetV2 {
  const [tag, payload] = variant(
    value,
    ["vault", "private_write", "mutation", "remove", "abort"] as const,
    label,
  );
  if (tag === "vault") {
    const item = exactOptional(
      payload,
      [],
      ["expected_record_revision"],
      `${label}.vault`,
    );
    return {
      vault: {
        expected_record_revision: optionalNat64(
          item.expected_record_revision,
          `${label}.vault.expected_record_revision`,
        ),
      },
    };
  }
  if (tag === "private_write") {
    const item = exactOptional(payload, ["nodes"], [], `${label}.private_write`);
    const nodes = array(
      item.nodes,
      FILES_V2_LIMITS.operationWriteTargetNodes,
      `${label}.private_write.nodes`,
    );
    if (nodes.length === 0) {
      throw wireError(`${label}.private_write.nodes must not be empty`);
    }
    const parsedNodes = nodes.map((node, index) => {
      const target = exactOptional(
        node,
        ["node_id"],
        ["content_id"],
        `${label}.private_write.nodes[${index}]`,
      );
      return {
        node_id: id(
          target.node_id,
          `${label}.private_write.nodes[${index}].node_id`,
        ),
        content_id: optionalId(
          target.content_id,
          `${label}.private_write.nodes[${index}].content_id`,
        ),
      };
    });
    assertCanonicalNodeOrder(
      parsedNodes,
      `${label}.private_write.nodes`,
    );
    return {
      private_write: {
        nodes: parsedNodes,
      },
    };
  }
  if (tag === "mutation" || tag === "remove") {
    const item = exact(payload, ["node_id"], `${label}.${tag}`);
    return {
      [tag]: { node_id: id(item.node_id, `${label}.${tag}.node_id`) },
    } as FilesOperationTargetV2;
  }
  if (tag === "abort") {
    const item = exactOptional(
      payload,
      ["stage_id"],
      [],
      `${label}.abort`,
    );
    return {
      abort: {
        stage_id: nat64(item.stage_id, `${label}.abort.stage_id`),
      },
    };
  }
  throw wireError(`${label} has an unsupported operation target`);
}

function quota(value: unknown, label: string): FilesQuotaSnapshotV2 {
  const item = required(value, [
    "nodes",
    "committed_private_plaintext_bytes",
    "committed_ciphertext_bytes",
    "staged_ciphertext_bytes",
    "physical_private_bytes",
    "cleanup_jobs",
  ], label);
  return {
    nodes: nat64(item.nodes, `${label}.nodes`),
    committed_private_plaintext_bytes: nat64(
      item.committed_private_plaintext_bytes,
      `${label}.committed_private_plaintext_bytes`,
    ),
    committed_ciphertext_bytes: nat64(
      item.committed_ciphertext_bytes,
      `${label}.committed_ciphertext_bytes`,
    ),
    staged_ciphertext_bytes: nat64(
      item.staged_ciphertext_bytes,
      `${label}.staged_ciphertext_bytes`,
    ),
    physical_private_bytes: nat64(
      item.physical_private_bytes,
      `${label}.physical_private_bytes`,
    ),
    cleanup_jobs: boundedNat(item.cleanup_jobs, 16, 0, 0xffff, `${label}.cleanup_jobs`),
  };
}

function publicUsage(value: unknown, label: string): FilesPublicUsageV2 {
  const item = required(
    value,
    ["current", "manifest_limits", "effective_limits"],
    label,
  );
  return {
    current: publicUsageCounters(item.current, `${label}.current`),
    manifest_limits: publicUsageLimits(
      item.manifest_limits,
      `${label}.manifest_limits`,
    ),
    effective_limits: publicUsageLimits(
      item.effective_limits,
      `${label}.effective_limits`,
    ),
  };
}

function publicUsageCounters(
  value: unknown,
  label: string,
): FilesPublicUsageCountersV2 {
  const item = required(
    value,
    [
      "live_entries",
      "occupied_entry_slots",
      "committed_body_bytes",
      "reserved_committed_body_bytes",
      "reserved_entry_slots",
      "allocated_body_bytes",
      "charged_metadata_bytes",
      "accepted_staged_bytes",
      "reserved_staged_bytes",
      "detached_charged_bytes",
      "active_stages",
      "receipt_lanes",
      "general_receipt_lanes",
      "reserved_general_receipt_lanes",
      "reserved_revocation_lanes",
      "filled_revocation_lanes",
      "receipt_nonce_indexes",
      "receipt_expiry_indexes",
      "cleanup_jobs",
    ],
    label,
  );
  return {
    live_entries: nat64(item.live_entries, `${label}.live_entries`),
    occupied_entry_slots: nat64(
      item.occupied_entry_slots,
      `${label}.occupied_entry_slots`,
    ),
    committed_body_bytes: nat64(
      item.committed_body_bytes,
      `${label}.committed_body_bytes`,
    ),
    reserved_committed_body_bytes: nat64(
      item.reserved_committed_body_bytes,
      `${label}.reserved_committed_body_bytes`,
    ),
    reserved_entry_slots: nat64(
      item.reserved_entry_slots,
      `${label}.reserved_entry_slots`,
    ),
    allocated_body_bytes: nat64(
      item.allocated_body_bytes,
      `${label}.allocated_body_bytes`,
    ),
    charged_metadata_bytes: nat64(
      item.charged_metadata_bytes,
      `${label}.charged_metadata_bytes`,
    ),
    accepted_staged_bytes: nat64(
      item.accepted_staged_bytes,
      `${label}.accepted_staged_bytes`,
    ),
    reserved_staged_bytes: nat64(
      item.reserved_staged_bytes,
      `${label}.reserved_staged_bytes`,
    ),
    detached_charged_bytes: nat64(
      item.detached_charged_bytes,
      `${label}.detached_charged_bytes`,
    ),
    active_stages: nat64(item.active_stages, `${label}.active_stages`),
    receipt_lanes: nat64(item.receipt_lanes, `${label}.receipt_lanes`),
    general_receipt_lanes: nat64(
      item.general_receipt_lanes,
      `${label}.general_receipt_lanes`,
    ),
    reserved_general_receipt_lanes: nat64(
      item.reserved_general_receipt_lanes,
      `${label}.reserved_general_receipt_lanes`,
    ),
    reserved_revocation_lanes: nat64(
      item.reserved_revocation_lanes,
      `${label}.reserved_revocation_lanes`,
    ),
    filled_revocation_lanes: nat64(
      item.filled_revocation_lanes,
      `${label}.filled_revocation_lanes`,
    ),
    receipt_nonce_indexes: nat64(
      item.receipt_nonce_indexes,
      `${label}.receipt_nonce_indexes`,
    ),
    receipt_expiry_indexes: nat64(
      item.receipt_expiry_indexes,
      `${label}.receipt_expiry_indexes`,
    ),
    cleanup_jobs: nat64(item.cleanup_jobs, `${label}.cleanup_jobs`),
  };
}

function publicUsageLimits(
  value: unknown,
  label: string,
): FilesPublicUsageLimitsV2 {
  const item = required(
    value,
    [
      "entries",
      "committed_bytes",
      "object_bytes",
      "staged_bytes",
      "pending_stages",
      "batch_operations",
      "batch_bytes",
      "general_receipts",
      "revocation_lanes",
    ],
    label,
  );
  return {
    entries: nat64(item.entries, `${label}.entries`),
    committed_bytes: nat64(
      item.committed_bytes,
      `${label}.committed_bytes`,
    ),
    object_bytes: nat64(item.object_bytes, `${label}.object_bytes`),
    staged_bytes: nat64(item.staged_bytes, `${label}.staged_bytes`),
    pending_stages: nat64(item.pending_stages, `${label}.pending_stages`),
    batch_operations: nat64(
      item.batch_operations,
      `${label}.batch_operations`,
    ),
    batch_bytes: nat64(item.batch_bytes, `${label}.batch_bytes`),
    general_receipts: nat64(
      item.general_receipts,
      `${label}.general_receipts`,
    ),
    revocation_lanes: nat64(
      item.revocation_lanes,
      `${label}.revocation_lanes`,
    ),
  };
}

function cleanupSummary(value: unknown, label: string): FilesCleanupSummaryV2 {
  const item = required(value, ["remaining_jobs", "has_more"], label);
  return {
    remaining_jobs: boundedNat(item.remaining_jobs, 16, 0, 0xffff, `${label}.remaining_jobs`),
    has_more: bool(item.has_more, `${label}.has_more`),
    state:
      isAbsent(item.state)
        ? null
        : cleanupState(item.state, `${label}.state`),
  };
}

function cleanupState(value: unknown, label: string): FilesCleanupStateV2 {
  const [tag, payload] = variant(value, ["clean", "pending"] as const, label);
  if (tag === "clean") {
    unit(payload, `${label}.clean`);
    return { clean: null };
  }
  const pending = required(payload, ["remaining_jobs"], `${label}.pending`);
  return {
    pending: {
      remaining_jobs: boundedNat(
        pending.remaining_jobs,
        16,
        0,
        0xffff,
        `${label}.pending.remaining_jobs`,
      ),
    },
  };
}

function vaultState(value: unknown, label: string): FilesVaultStateV2 {
  const [tag, payload] = variant(value, ["absent", "present"] as const, label);
  if (tag === "absent") {
    unit(payload, `${label}.absent`);
    return { absent: null };
  }
  const present = required(payload, [
    "format",
    "record_revision",
    "slot_generation",
    "public_key_fingerprint",
    "wrapper_frame_bytes",
  ], `${label}.present`);
  return {
    present: {
      format: boundedNat(present.format, 16, 0, 0xffff, `${label}.format`),
      record_revision: nat64(present.record_revision, `${label}.record_revision`),
      slot_generation: nat64(present.slot_generation, `${label}.slot_generation`),
      public_key_fingerprint: digest(
        present.public_key_fingerprint,
        `${label}.public_key_fingerprint`,
      ),
      wrapper_frame_bytes: nat32(
        present.wrapper_frame_bytes,
        `${label}.wrapper_frame_bytes`,
      ),
    },
  };
}

function operationSummary(value: unknown, label: string): FilesOperationSummaryV2 {
  const item = required(
    value,
    ["request_id"],
    label,
  );
  return {
    request_id: id(item.request_id, `${label}.request_id`),
    kind:
      isAbsent(item.kind)
        ? null
        : unitVariant(
            item.kind,
            ["vault", "private_write", "mutation", "remove", "abort"] as const,
            `${label}.kind`,
          ) as FilesOperationKindV2,
    stage_id: optionalNat64(item.stage_id, `${label}.stage_id`),
    expires_at_ns: optionalNat64(item.expires_at_ns, `${label}.expires_at_ns`),
    target:
      isAbsent(item.target)
        ? null
        : operationTarget(item.target, `${label}.target`),
  };
}

function nodeBinding(value: unknown, label: string): FilesNodeBindingV2 {
  const node = required(value, [
    "node_id",
    "parent_id",
    "structural_revision",
    "metadata_revision",
    "children_revision",
    "declared_name_scalars",
    "subtree_height",
    "max_relative_path_scalars",
    "subtree_plaintext_bytes",
    "encrypted_metadata_bytes",
    "active",
  ], label);
  return {
    node_id: id(node.node_id, `${label}.node_id`),
    parent_id: id(node.parent_id, `${label}.parent_id`),
    kind:
      isAbsent(node.kind)
        ? null
        : unitVariant(node.kind, ["folder", "file"] as const, `${label}.kind`),
    structural_revision: nat64(node.structural_revision, `${label}.structural_revision`),
    metadata_revision: nat64(node.metadata_revision, `${label}.metadata_revision`),
    children_revision: nat64(node.children_revision, `${label}.children_revision`),
    declared_name_scalars: boundedNat(node.declared_name_scalars, 16, 0, 100, `${label}.declared_name_scalars`),
    subtree_height: boundedNat(node.subtree_height, 8, 0, 64, `${label}.subtree_height`),
    max_relative_path_scalars: boundedNat(node.max_relative_path_scalars, 16, 0, 240, `${label}.max_relative_path_scalars`),
    subtree_plaintext_bytes: nat64(node.subtree_plaintext_bytes, `${label}.subtree_plaintext_bytes`),
    encrypted_metadata_bytes: nat32(node.encrypted_metadata_bytes, `${label}.encrypted_metadata_bytes`),
    active: bool(node.active, `${label}.active`),
  };
}

function contentDescriptor(value: unknown, label: string): FilesContentDescriptorV2 {
  const item = required(
    value,
    ["content_id", "block_count", "ciphertext_bytes"],
    label,
  );
  return {
    content_id: id(item.content_id, `${label}.content_id`),
    block_count: boundedNat(item.block_count, 32, 1, 36, `${label}.block_count`),
    ciphertext_bytes: nat64(item.ciphertext_bytes, `${label}.ciphertext_bytes`),
    crypto_profile:
      isAbsent(item.crypto_profile)
        ? null
        : unitVariant(
            item.crypto_profile,
            ["aes_256_gcm_files_v2"] as const,
            `${label}.crypto_profile`,
          ),
  };
}

function operationState(value: unknown, label: string): FilesOperationStateV2 {
  const [tag, payload] = variant(
    value,
    ["active", "committed", "aborted", "expired", "superseded", "unknown"] as const,
    label,
  );
  if (tag === "unknown") {
    unit(payload, `${label}.unknown`);
    return { unknown: null };
  }
  if (tag === "active") {
    const item = required(payload, [
      "accepted_frames_bitmap",
      "frame_block_mapping",
      "staged_bytes",
    ], `${label}.active`);
    return {
      active: {
        stage_id: optionalNat64(item.stage_id, `${label}.stage_id`),
        accepted_frames_bitmap: boundedNat(item.accepted_frames_bitmap, 16, 0, 0xffff, `${label}.accepted_frames_bitmap`),
        frame_block_mapping: array(
          item.frame_block_mapping,
          20,
          `${label}.frame_block_mapping`,
        ).map((mapping, index) =>
          frameBlockMapping(mapping, `${label}.frame_block_mapping[${index}]`)
        ),
        staged_bytes: nat64(item.staged_bytes, `${label}.staged_bytes`),
        expires_at_ns: optionalNat64(item.expires_at_ns, `${label}.expires_at_ns`),
      },
    };
  }
  if (tag === "committed") {
    const item = required(payload, [], `${label}.committed`);
    return {
      committed: {
        detail:
          isAbsent(item.detail)
            ? null
            : committedDetail(item.detail, `${label}.committed.detail`),
      },
    };
  }
  if (tag === "aborted" || tag === "expired") {
    const item = required(
      payload,
      ["terminal_at_ns", "reconcile_until_ns"],
      `${label}.${tag}`,
    );
    return {
      [tag]: {
        terminal_at_ns: nat64(item.terminal_at_ns, `${label}.terminal_at_ns`),
        reconcile_until_ns: nat64(
          item.reconcile_until_ns,
          `${label}.reconcile_until_ns`,
        ),
      },
    } as FilesOperationStateV2;
  }
  const item = required(payload, [], `${label}.superseded`);
  return {
    superseded: {
      revision: optionalNat64(item.revision, `${label}.revision`),
    },
  };
}

function frameBlockMapping(value: unknown, label: string): FilesFrameBlockMappingV2 {
  const item = required(
    value,
    ["frame_ordinal", "content_id", "block_index"],
    label,
  );
  return {
    frame_ordinal: boundedNat(item.frame_ordinal, 8, 0, 255, `${label}.frame_ordinal`),
    content_id: id(item.content_id, `${label}.content_id`),
    block_index: nat32(item.block_index, `${label}.block_index`),
  };
}

function committedDetail(
  value: unknown,
  label: string,
): FilesCommittedDetailV2 {
  const [tag, payload] = variant(
    value,
    [
      "vault",
      "private_write",
      "mutation",
      "remove",
      "abort",
    ] as const,
    label,
  );
  if (tag === "vault") {
    return { vault: parseVaultWriteOk(payload) };
  }
  if (tag === "private_write") {
    return { private_write: parseWriteBlockOk(payload) };
  }
  if (tag === "mutation") {
    return { mutation: parseMutateOk(payload) };
  }
  if (tag === "remove") {
    return { remove: parseRemoveOk(payload) };
  }
  return { abort: parseAbortOk(payload) };
}

function committedNode(value: unknown, label: string): FilesCommittedNodeV2 {
  const item = required(
    value,
    [
      "node_id",
      "structural_revision",
      "metadata_revision",
    ],
    label,
  );
  return {
    node_id: id(item.node_id, `${label}.node_id`),
    content_id: optionalId(item.content_id, `${label}.content_id`),
    structural_revision: nat64(
      item.structural_revision,
      `${label}.structural_revision`,
    ),
    metadata_revision: nat64(
      item.metadata_revision,
      `${label}.metadata_revision`,
    ),
  };
}

function assertCanonicalNodeOrder<T extends { node_id: FilesId128V2 }>(
  nodes: readonly T[],
  label: string,
): void {
  for (let index = 1; index < nodes.length; index += 1) {
    if (compareIds(nodes[index - 1]!.node_id, nodes[index]!.node_id) >= 0) {
      throw wireError(
        `${label} must be in strict canonical ascending node_id order`,
      );
    }
  }
}

function compareIds(left: FilesId128V2, right: FilesId128V2): number {
  const leftHi = BigInt(left.hi);
  const rightHi = BigInt(right.hi);
  if (leftHi < rightHi) return -1;
  if (leftHi > rightHi) return 1;
  const leftLo = BigInt(left.lo);
  const rightLo = BigInt(right.lo);
  return leftLo < rightLo ? -1 : leftLo > rightLo ? 1 : 0;
}


function emptyRequest(value: unknown, label: string): JsonObject {
  exact(value, [], label);
  return {};
}

function blob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw wireError(`${label} must be a Uint8Array`);
  }
  return value.slice();
}

function assertBoundedEncodedRequest(
  value: SelfCallObject,
  label: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(value, "body")) {
    assertNormalizedRequest(value as JsonObject, label);
    return;
  }
  const body = value.body;
  if (!(body instanceof Uint8Array)) {
    throw wireError(`${label} body must be a Uint8Array`);
  }
  const { body: _body, ...metadata } = value;
  assertNormalizedRequest(metadata as JsonObject, label);
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label) as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw wireError(`${label} has unexpected fields`);
  }
  return record;
}

function exactOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label) as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(record);
  if (
    actual.some((key) => !allowed.has(key)) ||
    requiredKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    )
  ) {
    throw wireError(`${label} has unexpected fields`);
  }
  return record;
}

function required(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, JsonValue> {
  const record = requireRecord(value, label);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw wireError(`${label}.${key} is missing`);
    }
  }
  return record;
}

function variant<const Tag extends string>(
  value: unknown,
  allowed: readonly Tag[],
  label: string,
): [Tag, unknown] {
  const parsed = singleVariant(value, label);
  if (!allowed.includes(parsed.tag as Tag)) {
    throw wireError(`${label} contains an unsupported normalized tag`);
  }
  return [parsed.tag as Tag, parsed.value];
}

function unitVariant<const Tag extends string>(
  value: unknown,
  allowed: readonly Tag[],
  label: string,
): FilesUnitVariantV2<Tag> {
  const [tag, payload] = variant(value, allowed, label);
  unit(payload, `${label}.${tag}`);
  return { [tag]: null } as FilesUnitVariantV2<Tag>;
}

function optionalUnitVariant<const Tag extends string>(
  value: unknown,
  allowed: readonly Tag[],
  label: string,
): FilesUnitVariantV2<Tag> | null {
  return isAbsent(value) ? null : unitVariant(value, allowed, label);
}

function unit(value: unknown, label: string): void {
  if (value !== null) throw wireError(`${label} must be a unit variant`);
}

function nat64(value: unknown, label: string): CanonicalNat64 {
  return parseCanonicalNat64(value, label);
}

function optionalNat64(value: unknown, label: string): CanonicalNat64 | null {
  return isAbsent(value) ? null : nat64(value, label);
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function nat32(value: unknown, label: string): number {
  return parseNat32(value, label);
}

function boundedNat(
  value: unknown,
  bits: 8 | 16 | 32,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const hardMaximum =
    bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffff_ffff;
  const parsed = nat32(value, label);
  if (parsed < minimum || parsed > Math.min(maximum, hardMaximum)) {
    throw wireError(`${label} is outside its allowed range`);
  }
  return parsed;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw wireError(`${label} must be boolean`);
  return value;
}

function text(value: unknown, maximumBytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw wireError(`${label} is invalid or too large`);
  }
  return value;
}

function safeName(value: unknown, label: string): string {
  const parsed = text(value, 100, label);
  if (
    parsed === "." ||
    parsed === ".." ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(parsed)
  ) {
    throw wireError(`${label} is not a safe public filename`);
  }
  return parsed;
}

function array(
  value: unknown,
  maximumItems: number,
  label: string,
): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw wireError(`${label} is not a bounded array`);
  }
  return value as JsonValue[];
}

function wireError(message: string): FilesProtocolValueError {
  return new FilesProtocolValueError("FILES_INVALID_WIRE_VALUE", message);
}
