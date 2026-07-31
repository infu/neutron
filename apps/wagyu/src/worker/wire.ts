import type { JsonObject, JsonValue } from "neutron-tools/app";
import { toBase64 } from "../verifier/bytes.ts";
import {
  WAGYU_WORKER_MAX_FEED_EVENT_BYTES,
  WAGYU_WORKER_MAX_SHARE_EDGE_BYTES,
  type VerifyFeedTaskV1,
  type VerifyLikesTaskV1,
  type VerifyProfileTaskV1,
  type VerifyThreadTaskV1,
  type WagyuWorkerResultV1,
} from "./types.ts";

export const WAGYU_RESIDENT_VERIFICATION_TOOLS = {
  profile: "wagyu_resident_verify_profile",
  feed: "wagyu_resident_verify_feed",
  likes: "wagyu_resident_verify_likes",
  thread: "wagyu_resident_verify_thread",
  cancel: "wagyu_resident_verify_cancel",
} as const;

const bytes32Schema: JsonObject = {
  type: "array",
  minItems: 32,
  maxItems: 32,
  items: { type: "integer", minimum: 0, maximum: 255 },
};

const requestIdSchema: JsonObject = {
  type: "string",
  pattern: "^[a-z0-9]{16,48}:[1-9][0-9]{0,15}$",
};

export const verifyProfileInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "nodeId"],
  properties: {
    requestId: requestIdSchema,
    nodeId: { type: "string", minLength: 5, maxLength: 128 },
  },
};

export const verifyFeedInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestId",
    "candidateId",
    "immediateSender",
    "eventKind",
    "exactEventBytes",
  ],
  properties: {
    requestId: requestIdSchema,
    candidateId: { type: "string", minLength: 1, maxLength: 128 },
    immediateSender: { type: "string", minLength: 5, maxLength: 128 },
    eventKind: {
      type: "string",
      enum: ["original", "share", "tombstone"],
    },
    exactEventBytes: {
      type: "array",
      minItems: 1,
      maxItems: WAGYU_WORKER_MAX_FEED_EVENT_BYTES,
      items: { type: "integer", minimum: 0, maximum: 255 },
    },
    verifiedShareEdge: {
      type: "object",
      additionalProperties: false,
      required: [
        "immediateSender",
        "originalAuthor",
        "postId",
        "bodyHash",
        "exactShareDeliveryBytes",
      ],
      properties: {
        immediateSender: { type: "string", minLength: 5, maxLength: 128 },
        originalAuthor: { type: "string", minLength: 5, maxLength: 128 },
        postId: bytes32Schema,
        bodyHash: bytes32Schema,
        exactShareDeliveryBytes: {
          type: "array",
          minItems: 1,
          maxItems: WAGYU_WORKER_MAX_SHARE_EDGE_BYTES,
          items: { type: "integer", minimum: 0, maximum: 255 },
        },
      },
    },
  },
};

export const verifyLikesInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "postAuthor", "postId", "postBodyHash"],
  properties: {
    requestId: requestIdSchema,
    postAuthor: { type: "string", minLength: 5, maxLength: 128 },
    postId: bytes32Schema,
    postBodyHash: bytes32Schema,
    continuation: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
    },
  },
};

export const verifyThreadInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestId",
    "postAuthor",
    "postId",
    "postBodyHash",
    "postObjectDigest",
    "postBodyLength",
  ],
  properties: {
    requestId: requestIdSchema,
    postAuthor: { type: "string", minLength: 5, maxLength: 128 },
    postId: bytes32Schema,
    postBodyHash: bytes32Schema,
    postObjectDigest: bytes32Schema,
    postBodyLength: {
      type: "integer",
      minimum: 1,
      maximum: 1_044_480,
    },
    summaryOnly: { type: "boolean" },
  },
};

export const cancelVerificationInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["requestId"],
  properties: {
    requestId: requestIdSchema,
  },
};

export const cancelVerificationOutputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["cancelled"],
  properties: {
    cancelled: { type: "boolean" },
  },
};

export function parseVerificationRequestId(
  value: JsonValue | undefined,
): string {
  const requestId = text(value, "Verification request ID", 65);
  if (!/^[a-z0-9]{16,48}:[1-9][0-9]{0,15}$/u.test(requestId)) {
    throw new Error("Verification request ID is invalid");
  }
  return requestId;
}

export const workerResultOutputSchema: JsonObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "value"],
      properties: {
        state: { const: "verified" },
        value: { type: "object" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "code", "reason"],
      properties: {
        state: { enum: ["invalid", "unavailable"] },
        code: { type: "string", minLength: 1, maxLength: 128 },
        reason: { type: "string", maxLength: 512 },
      },
    },
  ],
};

export function parseVerifyProfileArguments(
  value: JsonObject,
): Omit<VerifyProfileTaskV1, "kind"> {
  return {
    nodeId: text(value.nodeId, "Profile node", 128),
  };
}

export function parseVerifyFeedArguments(
  value: JsonObject,
): Omit<VerifyFeedTaskV1, "kind"> {
  const eventKind = value.eventKind;
  if (
    eventKind !== "original" &&
    eventKind !== "share" &&
    eventKind !== "tombstone"
  ) {
    throw new Error("Feed event kind is invalid");
  }
  const edgeValue = value.verifiedShareEdge;
  let verifiedShareEdge: VerifyFeedTaskV1["verifiedShareEdge"];
  if (edgeValue !== undefined) {
    const edge = object(edgeValue, "Verified share edge");
    verifiedShareEdge = {
      immediateSender: text(
        edge.immediateSender,
        "Share-edge sender",
        128,
      ),
      originalAuthor: text(
        edge.originalAuthor,
        "Share-edge author",
        128,
      ),
      postId: bytes(edge.postId, "Share-edge post ID", 32, 32),
      bodyHash: bytes(edge.bodyHash, "Share-edge body hash", 32, 32),
      exactShareDeliveryBytes: bytes(
        edge.exactShareDeliveryBytes,
        "Exact share delivery",
        1,
        WAGYU_WORKER_MAX_SHARE_EDGE_BYTES,
      ),
    };
  }
  return {
    candidateId: text(value.candidateId, "Candidate ID", 128),
    immediateSender: text(value.immediateSender, "Immediate sender", 128),
    eventKind,
    exactEventBytes: bytes(
      value.exactEventBytes,
      "Feed event",
      1,
      WAGYU_WORKER_MAX_FEED_EVENT_BYTES,
    ),
    ...(verifiedShareEdge === undefined ? {} : { verifiedShareEdge }),
  };
}

export function parseVerifyLikesArguments(
  value: JsonObject,
): Omit<VerifyLikesTaskV1, "kind"> {
  return {
    postAuthor: text(value.postAuthor, "Post author", 128),
    postId: bytes(value.postId, "Post ID", 32, 32),
    postBodyHash: bytes(value.postBodyHash, "Post body hash", 32, 32),
    ...(value.continuation === undefined
      ? {}
      : {
          continuation: text(
            value.continuation,
            "Like continuation",
            64,
          ),
        }),
  };
}

export function parseVerifyThreadArguments(
  value: JsonObject,
): Omit<VerifyThreadTaskV1, "kind"> {
  return {
    postAuthor: text(value.postAuthor, "Post author", 128),
    postId: bytes(value.postId, "Post ID", 32, 32),
    postBodyHash: bytes(value.postBodyHash, "Post body hash", 32, 32),
    postObjectDigest: bytes(
      value.postObjectDigest,
      "Post object digest",
      32,
      32,
    ),
    postBodyLength: integer(
      value.postBodyLength,
      "Post body length",
      1,
      1_044_480,
    ),
    ...(value.summaryOnly === undefined
      ? {}
      : { summaryOnly: boolean(value.summaryOnly, "Summary-only mode") }),
  };
}

export function workerResultJson(
  result: WagyuWorkerResultV1<unknown>,
): JsonValue {
  return jsonValue(result);
}

export function parseWorkerResultJson<T>(
  value: JsonValue,
  parseValue: (value: JsonValue) => T,
): WagyuWorkerResultV1<T> {
  const record = object(value, "Worker result");
  if (record.state === "verified") {
    return {
      state: "verified",
      value: parseValue(record.value ?? null),
    };
  }
  if (record.state === "invalid" || record.state === "unavailable") {
    return {
      state: record.state,
      code: text(record.code, "Worker result code", 128),
      reason: text(record.reason, "Worker result reason", 512, true),
    };
  }
  throw new Error("Verification Worker result state is invalid");
}

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Binary worker results cross a JSON-only resident bus. Canonical base64
  // avoids the large allocation multiplier of one JSON number per byte.
  if (value instanceof Uint8Array) return toBase64(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = jsonValue(item);
    }
    return result;
  }
  throw new Error("Verification Worker result is not JSON serializable");
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value as JsonObject;
}

function text(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function bytes(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    !value.every(
      (item) =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= 255,
    )
  ) {
    throw new Error(`${label} bytes are invalid`);
  }
  return Uint8Array.from(value as number[]);
}

function integer(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) throw new Error(`${label} is invalid`);
  return value;
}

function boolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
