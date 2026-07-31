import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import {
  WAGYU_LOCAL_COUNT_MAX,
  WAGYU_OUTBOX_PROJECTION_MAX,
  WAGYU_TRAY_NOTIFICATION_MAX,
  WAGYU_TRAY_BADGE_MAX,
  trayBadgeForStatus,
  type WagyuBackendPauseReason,
  type WagyuBackendStatus,
  type WagyuFanoutProgress,
  type WagyuFanoutState,
  type WagyuOutboxItem,
  type WagyuOutboxRoute,
  type WagyuOutboxState,
  type WagyuResidentNotification,
} from "./contracts.ts";
import type {
  WagyuResidentError,
  WagyuResidentOperation,
  WagyuResidentPhase,
  WagyuResidentSnapshot,
} from "./orchestrator.ts";

// Tool descriptors reject grouping constructs so their regular expressions
// stay linear-time. The closed runtime parser below still enforces canonical
// Nat64 text (including the no-leading-zero rule).
const NAT64_PATTERN = "^[0-9]{1,20}$";
const POSITIVE_NAT64_PATTERN = "^[1-9][0-9]{0,19}$";

const pauseReasons = [
  "user",
  "blocked",
  "not_following",
  "low_cycles",
  "revoked",
  "rate_limited",
  "busy",
  "incompatible",
  "unknown_post",
  "credit_exhausted",
  "lease_expired",
  "handler_failure",
  "maintenance",
  "unsupported",
] as const;
const backendPauseReasons = pauseReasons.slice(1);
const phases = ["starting", "ready", "degraded", "paused"] as const;
const operations = [
  "status",
  "notification_page",
  "notification_mark_read",
  "renew",
  "outbox_page",
  "drain",
  "retry",
] as const;
const notificationKinds = [
  "follow",
  "like",
  "reply",
  "share",
  "unsupported",
] as const;
const notificationVerifications = [
  "transport-authenticated",
  "pending",
  "verified",
  "invalid",
  "unavailable",
  "unsupported",
] as const;
const outboxStates = [
  "queued",
  "sending",
  "accepted",
  "duplicate",
  "paused",
  "failed",
  "uncertain",
  "superseded",
  "unsupported",
] as const;
const outboxRoutes = [
  "follow",
  "unfollow",
  "deliver",
  "like",
  "notice",
  "unsupported",
] as const;
const fanoutStates = [
  "queued",
  "scanning",
  "sending",
  "complete",
  "partial",
  "paused",
  "failed",
  "unsupported",
] as const;

export const wagyuEmptyInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const wagyuRetryInputSchema: JsonObject = {
  type: "object",
  required: ["localSequence"],
  properties: {
    localSequence: {
      type: "string",
      pattern: POSITIVE_NAT64_PATTERN,
      maxLength: 20,
    },
  },
  additionalProperties: false,
};

export const wagyuSetAutoDrainInputSchema: JsonObject = {
  type: "object",
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
  additionalProperties: false,
};

const optionalTimestampSchema: JsonObject = {
  oneOf: [
    {
      type: "integer",
      minimum: 0,
      maximum: 8_640_000_000_000_000,
    },
    { type: "null" },
  ],
};

const optionalPauseReasonSchema: JsonObject = {
  oneOf: [
    { type: "string", enum: [...pauseReasons] },
    { type: "null" },
  ],
};

const backendStatusSchema: JsonObject = {
  type: "object",
  required: [
    "node",
    "networkId",
    "networkConfigured",
    "protocol",
    "profileGeneration",
    "profileRevision",
    "certifiedAssetsReady",
    "releaseGateMessage",
    "stateRevision",
    "feedRevision",
    "notificationRevision",
    "relationshipRevision",
    "unreadFeedCount",
    "unreadNotificationCount",
    "outboundWorkPending",
    "outboxQueuedCount",
    "outboxErrorCount",
    "outboxPaused",
    "pauseReason",
  ],
  properties: {
    node: {
      type: "string",
      pattern: "^[a-z0-9-]{5,128}$",
      maxLength: 128,
    },
    networkId: {
      type: "array",
      minItems: 32,
      maxItems: 32,
      items: { type: "integer", minimum: 0, maximum: 255 },
    },
    networkConfigured: { type: "boolean" },
    protocol: { type: "string", enum: ["wagyu_v1"] },
    profileGeneration: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    profileRevision: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    certifiedAssetsReady: { type: "boolean" },
    releaseGateMessage: {
      oneOf: [
        { type: "string", minLength: 1, maxLength: 240 },
        { type: "null" },
      ],
    },
    stateRevision: { type: "string", pattern: NAT64_PATTERN, maxLength: 20 },
    feedRevision: { type: "string", pattern: NAT64_PATTERN, maxLength: 20 },
    notificationRevision: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    relationshipRevision: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    unreadFeedCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    unreadNotificationCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    outboundWorkPending: { type: "boolean" },
    outboxQueuedCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    outboxErrorCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    outboxPaused: { type: "boolean" },
    pauseReason: {
      oneOf: [
        { type: "string", enum: [...backendPauseReasons] },
        { type: "null" },
      ],
    },
  },
  additionalProperties: false,
};

const fanoutProgressSchema: JsonObject = {
  type: "object",
  required: [
    "jobId",
    "state",
    "eligibleRecipientCount",
    "queuedRecipientCount",
    "completedRecipientCount",
    "terminalRecipientCount",
    "uncertainRecipientCount",
  ],
  properties: {
    jobId: {
      type: "string",
      pattern: POSITIVE_NAT64_PATTERN,
      maxLength: 20,
    },
    state: { type: "string", enum: [...fanoutStates] },
    eligibleRecipientCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    queuedRecipientCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    completedRecipientCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    terminalRecipientCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
    uncertainRecipientCount: {
      type: "integer",
      minimum: 0,
      maximum: WAGYU_LOCAL_COUNT_MAX,
    },
  },
  additionalProperties: false,
};

const outboxItemSchema: JsonObject = {
  type: "object",
  required: [
    "localSequence",
    "recipient",
    "route",
    "state",
    "attemptCount",
    "retryable",
    "nextRetryAtNs",
    "lastError",
    "createdAtNs",
    "updatedAtNs",
    "fanout",
  ],
  properties: {
    localSequence: {
      type: "string",
      pattern: POSITIVE_NAT64_PATTERN,
      maxLength: 20,
    },
    recipient: { type: "string", minLength: 1, maxLength: 128 },
    route: { type: "string", enum: [...outboxRoutes] },
    state: { type: "string", enum: [...outboxStates] },
    attemptCount: { type: "integer", minimum: 0, maximum: 65_535 },
    retryable: { type: "boolean" },
    nextRetryAtNs: {
      oneOf: [
        { type: "string", pattern: NAT64_PATTERN, maxLength: 20 },
        { type: "null" },
      ],
    },
    lastError: {
      oneOf: [
        { type: "string", minLength: 1, maxLength: 240 },
        { type: "null" },
      ],
    },
    createdAtNs: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    updatedAtNs: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    fanout: {
      oneOf: [fanoutProgressSchema, { type: "null" }],
    },
  },
  additionalProperties: false,
};

const residentNotificationSchema: JsonObject = {
  type: "object",
  required: [
    "localSequence",
    "receivedAtNs",
    "actorNodeId",
    "kind",
    "verification",
    "read",
  ],
  properties: {
    localSequence: {
      type: "string",
      pattern: POSITIVE_NAT64_PATTERN,
      maxLength: 20,
    },
    receivedAtNs: {
      type: "string",
      pattern: NAT64_PATTERN,
      maxLength: 20,
    },
    actorNodeId: {
      type: "string",
      pattern: "^[a-z0-9-]{5,128}$",
      maxLength: 128,
    },
    kind: { type: "string", enum: [...notificationKinds] },
    verification: {
      type: "string",
      enum: [...notificationVerifications],
    },
    read: { type: "boolean" },
  },
  additionalProperties: false,
};

const residentErrorSchema: JsonObject = {
  type: "object",
  required: ["operation", "message", "atMs"],
  properties: {
    operation: { type: "string", enum: [...operations] },
    message: { type: "string", minLength: 1, maxLength: 240 },
    atMs: {
      type: "integer",
      minimum: 0,
      maximum: 8_640_000_000_000_000,
    },
  },
  additionalProperties: false,
};

export const wagyuResidentSnapshotSchema: JsonObject = {
  type: "object",
  required: [
    "version",
    "residentRevision",
    "source",
    "phase",
    "autoDrainEnabled",
    "pauseReason",
    "operation",
    "lastAuthoritativeAtMs",
    "consecutiveFailures",
    "lastError",
    "badge",
    "status",
    "notificationItems",
    "outboxItems",
  ],
  properties: {
    version: { type: "integer", enum: [1] },
    residentRevision: {
      type: "string",
      pattern: POSITIVE_NAT64_PATTERN,
      maxLength: 20,
    },
    source: {
      type: "string",
      enum: ["none", "cached", "authoritative"],
    },
    phase: { type: "string", enum: [...phases] },
    autoDrainEnabled: { type: "boolean" },
    pauseReason: optionalPauseReasonSchema,
    operation: {
      oneOf: [
        { type: "string", enum: [...operations] },
        { type: "null" },
      ],
    },
    lastAuthoritativeAtMs: optionalTimestampSchema,
    consecutiveFailures: { type: "integer", minimum: 0, maximum: 8 },
    lastError: {
      oneOf: [residentErrorSchema, { type: "null" }],
    },
    badge: {
      oneOf: [
        {
          type: "integer",
          minimum: 1,
          maximum: WAGYU_TRAY_BADGE_MAX,
        },
        { type: "null" },
      ],
    },
    status: {
      oneOf: [backendStatusSchema, { type: "null" }],
    },
    notificationItems: {
      type: "array",
      maxItems: WAGYU_TRAY_NOTIFICATION_MAX,
      items: residentNotificationSchema,
    },
    outboxItems: {
      type: "array",
      maxItems: WAGYU_OUTBOX_PROJECTION_MAX,
      items: outboxItemSchema,
    },
  },
  additionalProperties: false,
};

export function residentSnapshotJson(
  snapshot: WagyuResidentSnapshot,
): JsonObject {
  return snapshot as unknown as JsonObject;
}

export function parseResidentSnapshot(value: JsonValue): WagyuResidentSnapshot {
  const record = closedRecord(
    value,
    [
      "version",
      "residentRevision",
      "source",
      "phase",
      "autoDrainEnabled",
      "pauseReason",
      "operation",
      "lastAuthoritativeAtMs",
      "consecutiveFailures",
      "lastError",
      "badge",
      "status",
      "notificationItems",
      "outboxItems",
    ],
    "Wagyu resident snapshot",
  );
  if (record.version !== 1) throw invalid("Wagyu resident version");
  const source = oneOf(
    record.source,
    ["none", "cached", "authoritative"],
    "Wagyu resident source",
  );
  const phase = oneOf(record.phase, phases, "Wagyu resident phase");
  const autoDrainEnabled = bool(
    record.autoDrainEnabled,
    "Wagyu automatic drain state",
  );
  const pauseReason = nullableOneOf(
    record.pauseReason,
    pauseReasons,
    "Wagyu resident pause reason",
  );
  const operation = nullableOneOf(
    record.operation,
    operations,
    "Wagyu resident operation",
  );
  const lastAuthoritativeAtMs = nullableTimestamp(
    record.lastAuthoritativeAtMs,
    "Wagyu authoritative status time",
  );
  const lastError =
    record.lastError === null || record.lastError === undefined
      ? null
      : parseResidentError(record.lastError);
  const status =
    record.status === null || record.status === undefined
      ? null
      : parseResidentStatus(record.status);
  if (!Array.isArray(record.outboxItems)) {
    throw invalid("Wagyu resident outbox items");
  }
  if (record.outboxItems.length > WAGYU_OUTBOX_PROJECTION_MAX) {
    throw invalid("Wagyu resident outbox items");
  }
  if (
    !Array.isArray(record.notificationItems) ||
    record.notificationItems.length > WAGYU_TRAY_NOTIFICATION_MAX
  ) {
    throw invalid("Wagyu resident notification items");
  }
  const badge =
    record.badge === null
      ? null
      : integer(record.badge, "Wagyu tray badge", 1, WAGYU_TRAY_BADGE_MAX);
  const consecutiveFailures = integer(
    record.consecutiveFailures,
    "Wagyu consecutive failures",
    0,
    8,
  );
  if (
    (phase === "paused" && pauseReason === null) ||
    (phase !== "paused" && pauseReason !== null) ||
    (source === "none" && status !== null) ||
    (source === "authoritative" && lastAuthoritativeAtMs === null) ||
    (source !== "authoritative" &&
      (phase === "ready" || phase === "degraded")) ||
    (!autoDrainEnabled && pauseReason !== "user") ||
    (autoDrainEnabled && pauseReason === "user") ||
    (status === null && badge !== null) ||
    (status !== null && trayBadgeForStatus(status) !== badge)
  ) {
    throw invalid("Wagyu resident state");
  }
  return {
    version: 1,
    residentRevision: positiveDecimal(
      record.residentRevision,
      "Wagyu resident revision",
    ),
    source,
    phase: phase as WagyuResidentPhase,
    autoDrainEnabled,
    pauseReason: pauseReason as WagyuResidentSnapshot["pauseReason"],
    operation: operation as WagyuResidentOperation,
    lastAuthoritativeAtMs,
    consecutiveFailures,
    lastError,
    badge,
    status,
    notificationItems: record.notificationItems.map(
      parseResidentNotification,
    ),
    outboxItems: record.outboxItems.map(parseResidentOutboxItem),
  };
}

function parseResidentNotification(
  value: JsonValue,
): WagyuResidentNotification {
  const record = closedRecord(
    value,
    [
      "localSequence",
      "receivedAtNs",
      "actorNodeId",
      "kind",
      "verification",
      "read",
    ],
    "Wagyu resident notification",
  );
  return {
    localSequence: positiveDecimal(
      record.localSequence,
      "Wagyu notification local sequence",
    ),
    receivedAtNs: decimal(
      record.receivedAtNs,
      "Wagyu notification receive time",
    ),
    actorNodeId: boundedPrincipal(
      record.actorNodeId,
      "Wagyu notification actor",
    ),
    kind: oneOf(
      record.kind,
      notificationKinds,
      "Wagyu notification kind",
    ),
    verification: oneOf(
      record.verification,
      notificationVerifications,
      "Wagyu notification verification",
    ),
    read: bool(record.read, "Wagyu notification read state"),
  };
}

function parseResidentStatus(value: JsonValue): WagyuBackendStatus {
  const record = closedRecord(
    value,
    [
      "node",
      "networkId",
      "networkConfigured",
      "protocol",
      "profileGeneration",
      "profileRevision",
      "certifiedAssetsReady",
      "releaseGateMessage",
      "stateRevision",
      "feedRevision",
      "notificationRevision",
      "relationshipRevision",
      "unreadFeedCount",
      "unreadNotificationCount",
      "outboundWorkPending",
      "outboxQueuedCount",
      "outboxErrorCount",
      "outboxPaused",
      "pauseReason",
    ],
    "Wagyu resident backend status",
  );
  const node = boundedPrincipal(record.node, "Wagyu node");
  const networkId = byteArray32(record.networkId, "Wagyu network id");
  const networkConfigured = bool(
    record.networkConfigured,
    "Wagyu network configuration state",
  );
  const status: WagyuBackendStatus = {
    node,
    networkId,
    networkConfigured,
    protocol: oneOf(
      record.protocol,
      ["wagyu_v1"] as const,
      "Wagyu protocol",
    ),
    profileGeneration: decimal(
      record.profileGeneration,
      "Wagyu profile generation",
    ),
    profileRevision: decimal(
      record.profileRevision,
      "Wagyu profile revision",
    ),
    certifiedAssetsReady: bool(
      record.certifiedAssetsReady,
      "Wagyu certified-assets state",
    ),
    releaseGateMessage:
      record.releaseGateMessage === null
        ? null
        : boundedText(
          record.releaseGateMessage,
          "Wagyu release gate message",
          240,
        ),
    stateRevision: decimal(record.stateRevision, "Wagyu state revision"),
    feedRevision: decimal(record.feedRevision, "Wagyu feed revision"),
    notificationRevision: decimal(
      record.notificationRevision,
      "Wagyu notification revision",
    ),
    relationshipRevision: decimal(
      record.relationshipRevision,
      "Wagyu relationship revision",
    ),
    unreadFeedCount: integer(
      record.unreadFeedCount,
      "Wagyu unread feed count",
      0,
      WAGYU_LOCAL_COUNT_MAX,
    ),
    unreadNotificationCount: integer(
      record.unreadNotificationCount,
      "Wagyu unread notification count",
      0,
      WAGYU_LOCAL_COUNT_MAX,
    ),
    outboundWorkPending: bool(
      record.outboundWorkPending,
      "Wagyu outbound work state",
    ),
    outboxQueuedCount: integer(
      record.outboxQueuedCount,
      "Wagyu outbox queued count",
      0,
      WAGYU_LOCAL_COUNT_MAX,
    ),
    outboxErrorCount: integer(
      record.outboxErrorCount,
      "Wagyu outbox error count",
      0,
      WAGYU_LOCAL_COUNT_MAX,
    ),
    outboxPaused: bool(record.outboxPaused, "Wagyu outbox pause state"),
    pauseReason: nullableOneOf(
      record.pauseReason,
      backendPauseReasons,
      "Wagyu backend pause reason",
    ) as WagyuBackendPauseReason | null,
  };
  if (!status.outboxPaused && status.pauseReason !== null) {
    throw invalid("Wagyu backend pause reason");
  }
  if (!status.outboundWorkPending && status.outboxQueuedCount > 0) {
    throw invalid("Wagyu outbound work state");
  }
  const zeroNetwork = networkId.every((byte) => byte === 0);
  if (
    (networkConfigured && zeroNetwork) ||
    (!networkConfigured && !zeroNetwork)
  ) {
    throw invalid("Wagyu network configuration state");
  }
  return status;
}

function parseResidentOutboxItem(value: JsonValue): WagyuOutboxItem {
  const record = closedRecord(
    value,
    [
      "localSequence",
      "recipient",
      "route",
      "state",
      "attemptCount",
      "retryable",
      "nextRetryAtNs",
      "lastError",
      "createdAtNs",
      "updatedAtNs",
      "fanout",
    ],
    "Wagyu resident outbox item",
  );
  const state = oneOf(record.state, outboxStates, "Wagyu outbox state");
  const route = oneOf(record.route, outboxRoutes, "Wagyu outbox route");
  const retryable = bool(record.retryable, "Wagyu outbox retryable state");
  if (
    retryable &&
    state !== "failed" &&
    state !== "uncertain" &&
    state !== "paused"
  ) {
    throw invalid("Wagyu outbox retryable state");
  }
  const createdAtNs = decimal(
    record.createdAtNs,
    "Wagyu outbox creation time",
  );
  const updatedAtNs = decimal(
    record.updatedAtNs,
    "Wagyu outbox update time",
  );
  if (BigInt(updatedAtNs) < BigInt(createdAtNs)) {
    throw invalid("Wagyu outbox update time");
  }
  return {
    localSequence: positiveDecimal(
      record.localSequence,
      "Wagyu outbox local sequence",
    ),
    recipient: boundedText(record.recipient, "Wagyu outbox recipient", 128),
    route: route as WagyuOutboxRoute,
    state: state as WagyuOutboxState,
    attemptCount: integer(
      record.attemptCount,
      "Wagyu outbox attempt count",
      0,
      65_535,
    ),
    retryable,
    nextRetryAtNs:
      record.nextRetryAtNs === null
        ? null
        : decimal(record.nextRetryAtNs, "Wagyu next retry time"),
    lastError:
      record.lastError === null
        ? null
        : boundedText(record.lastError, "Wagyu outbox error", 240),
    createdAtNs,
    updatedAtNs,
    fanout:
      record.fanout === null || record.fanout === undefined
        ? null
        : parseResidentFanoutProgress(record.fanout),
  };
}

function parseResidentFanoutProgress(value: JsonValue): WagyuFanoutProgress {
  const record = closedRecord(
    value,
    [
      "jobId",
      "state",
      "eligibleRecipientCount",
      "queuedRecipientCount",
      "completedRecipientCount",
      "terminalRecipientCount",
      "uncertainRecipientCount",
    ],
    "Wagyu resident fanout progress",
  );
  const eligibleRecipientCount = integer(
    record.eligibleRecipientCount,
    "Wagyu eligible recipient count",
    0,
    WAGYU_LOCAL_COUNT_MAX,
  );
  const queuedRecipientCount = integer(
    record.queuedRecipientCount,
    "Wagyu queued recipient count",
    0,
    WAGYU_LOCAL_COUNT_MAX,
  );
  const completedRecipientCount = integer(
    record.completedRecipientCount,
    "Wagyu completed recipient count",
    0,
    WAGYU_LOCAL_COUNT_MAX,
  );
  const terminalRecipientCount = integer(
    record.terminalRecipientCount,
    "Wagyu terminal recipient count",
    0,
    WAGYU_LOCAL_COUNT_MAX,
  );
  const uncertainRecipientCount = integer(
    record.uncertainRecipientCount,
    "Wagyu uncertain recipient count",
    0,
    WAGYU_LOCAL_COUNT_MAX,
  );
  if (
    queuedRecipientCount > eligibleRecipientCount ||
    completedRecipientCount +
      terminalRecipientCount +
      uncertainRecipientCount >
      queuedRecipientCount
  ) {
    throw invalid("Wagyu fanout recipient accounting");
  }
  return {
    jobId: positiveDecimal(record.jobId, "Wagyu fanout job"),
    state: oneOf(
      record.state,
      fanoutStates,
      "Wagyu fanout state",
    ) as WagyuFanoutState,
    eligibleRecipientCount,
    queuedRecipientCount,
    completedRecipientCount,
    terminalRecipientCount,
    uncertainRecipientCount,
  };
}

function parseResidentError(value: JsonValue): WagyuResidentError {
  const record = closedRecord(
    value,
    ["operation", "message", "atMs"],
    "Wagyu resident error",
  );
  return {
    operation: oneOf(
      record.operation,
      operations,
      "Wagyu error operation",
    ) as Exclude<WagyuResidentOperation, null>,
    message: boundedText(record.message, "Wagyu resident error", 240),
    atMs: timestamp(record.atMs, "Wagyu resident error time"),
  };
}

function closedRecord(
  value: JsonValue,
  keys: readonly string[],
  label: string,
): JsonObject {
  if (!isJsonObject(value)) throw invalid(label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw invalid(label);
  }
  return value;
}

function oneOf<T extends string>(
  value: JsonValue | undefined,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw invalid(label);
  }
  return value as T;
}

function nullableOneOf<T extends string>(
  value: JsonValue | undefined,
  values: readonly T[],
  label: string,
): T | null {
  return value === null ? null : oneOf(value, values, label);
}

function decimal(value: JsonValue | undefined, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(value) ||
    BigInt(value) > ((1n << 64n) - 1n)
  ) {
    throw invalid(label);
  }
  return value;
}

function positiveDecimal(
  value: JsonValue | undefined,
  label: string,
): string {
  const parsed = decimal(value, label);
  if (parsed === "0") throw invalid(label);
  return parsed;
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
  ) {
    throw invalid(label);
  }
  return value;
}

function timestamp(value: JsonValue | undefined, label: string): number {
  return integer(value, label, 0, 8_640_000_000_000_000);
}

function nullableTimestamp(
  value: JsonValue | undefined,
  label: string,
): number | null {
  return value === null ? null : timestamp(value, label);
}

function boundedText(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(label);
  }
  return value;
}

function boundedPrincipal(
  value: JsonValue | undefined,
  label: string,
): string {
  const text = boundedText(value, label, 128);
  if (!/^[a-z0-9-]{5,128}$/u.test(text)) throw invalid(label);
  return text;
}

function byteArray32(
  value: JsonValue | undefined,
  label: string,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 32 ||
    !value.every(
      (byte) =>
        typeof byte === "number" &&
        Number.isInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  ) {
    throw invalid(label);
  }
  return [...value] as number[];
}

function bool(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(label);
  return value;
}

function invalid(label: string): Error {
  return new Error(`${label} is invalid`);
}
