import {
  isJsonObject,
  querySelf,
  updateSelf,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import { Principal } from "@dfinity/principal";
import { WagyuOwnerBridge } from "../app/owner_bridge.ts";
import type {
  NotificationSummaryV1,
  NotificationVerificationV1,
} from "../protocol/types.ts";

export const WAGYU_RESIDENT_ENDPOINT = "app:wagyu:background" as const;

export const WAGYU_RESIDENT_TOPICS = {
  status: "wagyu_status",
  feed: "wagyu_feed",
  notifications: "wagyu_notifications",
  outbox: "wagyu_outbox",
} as const;

export const WAGYU_RESIDENT_TOOLS = {
  snapshot: "wagyu_resident_snapshot",
  refresh: "wagyu_resident_refresh",
  wake: "wagyu_resident_wake",
  drain: "wagyu_resident_drain",
  retry: "wagyu_resident_retry",
  setAutoDrain: "wagyu_resident_set_auto_drain",
} as const;

export const WAGYU_OUTBOX_PAGE_LIMIT = 8;
export const WAGYU_OUTBOX_PAGE_MAX = 50;
export const WAGYU_OUTBOX_PROJECTION_MAX = WAGYU_OUTBOX_PAGE_MAX;
export const WAGYU_DRAIN_LIMIT = 20;
export const WAGYU_TRAY_NOTIFICATION_MAX = 20;
export const WAGYU_NOTIFICATION_MARK_READ_MAX = 50;
export const WAGYU_RENEWAL_PAGE_LIMIT = 50;
export const WAGYU_TRAY_BADGE_MAX = 9_999;
export const WAGYU_LOCAL_COUNT_MAX = 100_000;

const NAT64_MAX = (1n << 64n) - 1n;
const QUERY_TIMEOUT_SECONDS = 30;
const UPDATE_TIMEOUT_SECONDS = 75;

export type WagyuBackendPauseReason =
  | "blocked"
  | "not_following"
  | "low_cycles"
  | "revoked"
  | "rate_limited"
  | "busy"
  | "incompatible"
  | "unknown_post"
  | "credit_exhausted"
  | "lease_expired"
  | "handler_failure"
  | "maintenance"
  | "unsupported";

export type WagyuBackendStatus = {
  node: string;
  networkId: number[];
  networkConfigured: boolean;
  protocol: "wagyu_v1";
  profileGeneration: string;
  profileRevision: string;
  certifiedAssetsReady: boolean;
  releaseGateMessage: string | null;
  stateRevision: string;
  feedRevision: string;
  notificationRevision: string;
  relationshipRevision: string;
  unreadFeedCount: number;
  unreadNotificationCount: number;
  outboundWorkPending: boolean;
  outboxQueuedCount: number;
  outboxErrorCount: number;
  outboxPaused: boolean;
  pauseReason: WagyuBackendPauseReason | null;
};

export type WagyuOutboxState =
  | "queued"
  | "sending"
  | "accepted"
  | "duplicate"
  | "paused"
  | "failed"
  | "uncertain"
  | "superseded"
  | "unsupported";

export type WagyuOutboxRoute =
  | "follow"
  | "unfollow"
  | "deliver"
  | "like"
  | "notice"
  | "unsupported";

export type WagyuFanoutState =
  | "queued"
  | "scanning"
  | "sending"
  | "complete"
  | "partial"
  | "paused"
  | "failed"
  | "unsupported";

export type WagyuFanoutProgress = {
  jobId: string;
  state: WagyuFanoutState;
  eligibleRecipientCount: number;
  queuedRecipientCount: number;
  completedRecipientCount: number;
  terminalRecipientCount: number;
  uncertainRecipientCount: number;
};

export type WagyuOutboxItem = {
  localSequence: string;
  recipient: string;
  route: WagyuOutboxRoute;
  state: WagyuOutboxState;
  attemptCount: number;
  retryable: boolean;
  nextRetryAtNs: string | null;
  lastError: string | null;
  createdAtNs: string;
  updatedAtNs: string;
  fanout: WagyuFanoutProgress | null;
};

export type WagyuOutboxPage = {
  revision: string;
  items: WagyuOutboxItem[];
  nextBeforeSequence: string | null;
};

export type WagyuResidentNotificationKind =
  | "follow"
  | "like"
  | "reply"
  | "share"
  | "unsupported";

export type WagyuResidentNotificationVerification =
  | "transport-authenticated"
  | "pending"
  | "verified"
  | "invalid"
  | "unavailable"
  | "unsupported";

export type WagyuResidentNotification = {
  localSequence: string;
  receivedAtNs: string;
  actorNodeId: string;
  kind: WagyuResidentNotificationKind;
  verification: WagyuResidentNotificationVerification;
  read: boolean;
};

export type WagyuResidentNotificationPage = {
  revision: string;
  items: WagyuResidentNotification[];
};

export type WagyuRenewalPage = {
  revision: string;
  dueNodeIds: string[];
  nextBeforeNode: string | null;
};

export type WagyuDrainResult = {
  stateRevision: string;
  outboxRevision: string;
  attempted: number;
  completed: number;
  remaining: number;
  errors: number;
  paused: boolean;
  pauseReason: WagyuBackendPauseReason | null;
};

export interface WagyuResidentBackend {
  status(): Promise<WagyuBackendStatus>;
  notificationPage(
    limit?: number,
  ): Promise<WagyuResidentNotificationPage>;
  markNotificationsRead(localSequences: string[]): Promise<string>;
  renewalPage(beforeNode?: string | null): Promise<WagyuRenewalPage>;
  renewFollowingIfDue(nodeId: string): Promise<boolean>;
  outboxPage(
    limit?: number,
    beforeSequence?: string | null,
    expectedRevision?: string | null,
  ): Promise<WagyuOutboxPage>;
  drain(limit?: number): Promise<WagyuDrainResult>;
  retry(localSequence: string): Promise<WagyuDrainResult>;
}

export class WagyuBackendResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WagyuBackendResponseError";
  }
}

/**
 * The resident adapter uses only bounded local-canister calls. It never
 * constructs a peer URL and never invokes a public Wagyu route.
 */
export function createWagyuResidentBackend(): WagyuResidentBackend {
  const ownerBridge = new WagyuOwnerBridge({
    query: (method, args, timeoutSeconds) =>
      querySelf(method, args, timeoutSeconds),
    update: (method, args, timeoutSeconds) =>
      updateSelf(method, args, timeoutSeconds),
  });
  return {
    async status(): Promise<WagyuBackendStatus> {
      return parseWagyuBackendStatus(
        await querySelf("wagyu_status", [{}], QUERY_TIMEOUT_SECONDS),
      );
    },

    async notificationPage(
      limit = WAGYU_TRAY_NOTIFICATION_MAX,
    ): Promise<WagyuResidentNotificationPage> {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > WAGYU_TRAY_NOTIFICATION_MAX
      ) {
        throw new Error("Wagyu tray notification limit is invalid");
      }
      const page = await ownerBridge.notificationPage({
        before_sequence: null,
        limit,
      });
      return {
        revision: page.value.revision.toString(),
        items: page.value.items.map(residentNotification),
      };
    },

    async markNotificationsRead(localSequences): Promise<string> {
      if (
        localSequences.length < 1 ||
        localSequences.length > WAGYU_NOTIFICATION_MARK_READ_MAX
      ) {
        throw new Error("Wagyu notification mark-read batch is invalid");
      }
      const sequences = localSequences.map((sequence) =>
        natural(sequence, "Wagyu notification local sequence", false)
      );
      if (new Set(sequences).size !== sequences.length) {
        throw new Error("Wagyu notification mark-read batch is invalid");
      }
      return natural(
        await updateSelf(
          "wagyu_notifications_mark_read",
          [{ local_sequences: sequences }],
          UPDATE_TIMEOUT_SECONDS,
        ),
        "Wagyu notification revision",
        true,
      );
    },

    async renewalPage(beforeNode = null): Promise<WagyuRenewalPage> {
      const before =
        beforeNode === null
          ? null
          : principal(beforeNode, "Wagyu relationship cursor");
      return parseWagyuRenewalPage(
        await querySelf(
          "wagyu_relationships",
          [{
            ...(before === null ? {} : { before_node: before }),
            limit: WAGYU_RENEWAL_PAGE_LIMIT,
          }],
          QUERY_TIMEOUT_SECONDS,
        ),
      );
    },

    async renewFollowingIfDue(nodeId): Promise<boolean> {
      const node = principal(nodeId, "Wagyu automatic renewal user");
      const relationship = object(
        await updateSelf(
          "wagyu_auto_renew_self_v1",
          [{ node }],
          UPDATE_TIMEOUT_SECONDS,
        ),
        "Wagyu automatic renewal",
      );
      return optionalVariantTag(
        relationship.following_state,
        [
          "registering",
          "active",
          "credit_low",
          "expired",
          "cleanup_pending",
          "incompatible",
          "blocked",
        ],
        "Wagyu automatic renewal state",
      ) === "registering";
    },

    async outboxPage(
      limit = WAGYU_OUTBOX_PAGE_LIMIT,
      beforeSequence = null,
      expectedRevision = null,
    ): Promise<WagyuOutboxPage> {
      assertPageLimit(limit);
      const before =
        beforeSequence === null
          ? null
          : natural(
            beforeSequence,
            "Wagyu outbox page cursor",
            false,
          );
      const expected =
        expectedRevision === null
          ? null
          : natural(
            expectedRevision,
            "Wagyu expected outbox revision",
            true,
          );
      return parseWagyuOutboxPage(
        await querySelf(
          "wagyu_outbox_page",
          [{
            ...(before === null ? {} : { before_sequence: before }),
            ...(expected === null ? {} : { expected_revision: expected }),
            limit,
          }],
          QUERY_TIMEOUT_SECONDS,
        ),
        limit,
      );
    },

    async drain(limit = WAGYU_DRAIN_LIMIT): Promise<WagyuDrainResult> {
      assertDrainLimit(limit);
      return parseWagyuDrainResult(
        await updateSelf(
          "wagyu_outbox_drain",
          [{ limit }],
          UPDATE_TIMEOUT_SECONDS,
        ),
      );
    },

    async retry(localSequence: string): Promise<WagyuDrainResult> {
      const sequence = natural(
        localSequence,
        "Wagyu outbox local sequence",
        false,
      );
      return parseWagyuDrainResult(
        await updateSelf(
          "wagyu_outbox_retry",
          [{ local_sequence: sequence }],
          UPDATE_TIMEOUT_SECONDS,
        ),
      );
    },
  };
}

export function parseWagyuRenewalPage(value: JsonValue): WagyuRenewalPage {
  const record = object(value, "Wagyu relationship renewal page");
  exactKeys(
    record,
    ["revision", "items"],
    "Wagyu relationship renewal page",
    ["next_before_node"],
  );
  if (
    !Array.isArray(record.items) ||
    record.items.length > WAGYU_RENEWAL_PAGE_LIMIT
  ) {
    throw invalid("Wagyu relationship renewal page");
  }
  const dueNodeIds: string[] = [];
  const pageNodeIds: string[] = [];
  for (const value of record.items) {
    const item = object(value, "Wagyu relationship renewal row");
    exactKeys(
      item,
      [
        "node",
        "following",
        "follower",
        "follower_delivery_credits",
        "following_renewal_requested",
        "following_auto_renew_due",
        "blocked",
        "bond_cycles",
        "protocol",
        "compatible",
      ],
      "Wagyu relationship renewal row",
      [
        "following_state",
        "follower_state",
        "follower_lease_expires_ns",
      ],
    );
    const nodeId = principal(item.node, "Wagyu relationship renewal user");
    pageNodeIds.push(nodeId);
    const following = boolean(
      item.following,
      "Wagyu relationship following state",
    );
    boolean(item.follower, "Wagyu relationship follower state");
    const blocked = boolean(
      item.blocked,
      "Wagyu relationship block state",
    );
    const compatible = boolean(
      item.compatible,
      "Wagyu relationship compatibility",
    );
    const state = optionalVariantTag(
      item.following_state,
      [
        "registering",
        "active",
        "credit_low",
        "expired",
        "cleanup_pending",
        "incompatible",
        "blocked",
      ],
      "Wagyu relationship following state",
    );
    optionalVariantTag(
      item.follower_state,
      [
        "registering",
        "active",
        "credit_low",
        "expired",
        "cleanup_pending",
        "incompatible",
        "blocked",
      ],
      "Wagyu relationship follower state",
    );
    boundedNat32Count(
      item.follower_delivery_credits,
      "Wagyu relationship follower delivery credits",
      0xffff,
    );
    optionalNatural(
      item.follower_lease_expires_ns,
      "Wagyu relationship follower lease expiry",
      true,
    );
    boolean(
      item.following_renewal_requested,
      "Wagyu relationship renewal request state",
    );
    const due = boolean(
      item.following_auto_renew_due,
      "Wagyu relationship automatic renewal state",
    );
    natural(item.bond_cycles, "Wagyu relationship bond cycles", true);
    protocol(item.protocol);
    if (due && following && !blocked && compatible && state === "active") {
      dueNodeIds.push(nodeId);
    }
  }
  if (new Set(pageNodeIds).size !== pageNodeIds.length) {
    throw invalid("Wagyu relationship renewal page");
  }
  const nextBeforeNode = optionalPrincipal(
    record.next_before_node,
    "Wagyu relationship cursor",
  );
  if (
    nextBeforeNode !== null &&
    pageNodeIds.at(-1) !== nextBeforeNode
  ) {
    throw invalid("Wagyu relationship cursor");
  }
  return {
    revision: natural(
      record.revision,
      "Wagyu relationship revision",
      true,
    ),
    dueNodeIds,
    nextBeforeNode,
  };
}

function residentNotification(
  item: NotificationSummaryV1,
): WagyuResidentNotification {
  return {
    localSequence: item.local_sequence.toString(),
    receivedAtNs: item.received_at_ns.toString(),
    actorNodeId: item.actor.toText(),
    kind: residentNotificationKind(item),
    verification: residentNotificationVerification(item.verification[0]),
    read: item.read,
  };
}

function residentNotificationKind(
  item: NotificationSummaryV1,
): WagyuResidentNotificationKind {
  const kind = item.kind[0];
  if (kind === undefined) return "unsupported";
  if ("new_follower" in kind) return "follow";
  if ("like" in kind) return "like";
  if ("reply" in kind) return "reply";
  if ("share" in kind) return "share";
  return "unsupported";
}

function residentNotificationVerification(
  verification: NotificationVerificationV1 | undefined,
): WagyuResidentNotificationVerification {
  if (verification === undefined) return "unsupported";
  if ("transport_authenticated" in verification) {
    return "transport-authenticated";
  }
  if ("pending" in verification) return "pending";
  if ("verified" in verification) return "verified";
  if ("invalid" in verification) return "invalid";
  if ("unavailable" in verification) return "unavailable";
  return "unsupported";
}

export function parseWagyuBackendStatus(value: JsonValue): WagyuBackendStatus {
  const record = object(value, "Wagyu status");
  exactKeys(
    record,
    [
      "state_revision",
      "node",
      "network_id",
      "protocol",
      "profile_generation",
      "profile_revision",
      "certified_assets_ready",
      "feed_revision",
      "notification_revision",
      "relationship_revision",
      "unread_feed_count",
      "unread_notification_count",
      "outbound_work_pending",
      "outbox_queued_count",
      "outbox_error_count",
      "outbox_paused",
    ],
    "Wagyu status",
    ["release_gate_message", "pause_reason"],
  );

  const networkId = bytes32(record.network_id, "Wagyu network id");
  const status: WagyuBackendStatus = {
    node: principal(record.node, "Wagyu node"),
    networkId,
    networkConfigured: networkId.some((byte) => byte !== 0),
    protocol: protocol(record.protocol),
    profileGeneration: natural(
      record.profile_generation,
      "Wagyu profile generation",
      true,
    ),
    profileRevision: natural(
      record.profile_revision,
      "Wagyu profile revision",
      true,
    ),
    certifiedAssetsReady: boolean(
      record.certified_assets_ready,
      "Wagyu certified-assets state",
    ),
    releaseGateMessage: optionalString(
      record.release_gate_message,
      "Wagyu release gate message",
      240,
    ),
    stateRevision: natural(record.state_revision, "Wagyu state revision", true),
    feedRevision: natural(record.feed_revision, "Wagyu feed revision", true),
    notificationRevision: natural(
      record.notification_revision,
      "Wagyu notification revision",
      true,
    ),
    relationshipRevision: natural(
      record.relationship_revision,
      "Wagyu relationship revision",
      true,
    ),
    unreadFeedCount: boundedCount(
      record.unread_feed_count,
      "Wagyu unread feed count",
    ),
    unreadNotificationCount: boundedCount(
      record.unread_notification_count,
      "Wagyu unread notification count",
    ),
    outboundWorkPending: boolean(
      record.outbound_work_pending,
      "Wagyu outbound work state",
    ),
    outboxQueuedCount: boundedCount(
      record.outbox_queued_count,
      "Wagyu queued outbox count",
    ),
    outboxErrorCount: boundedCount(
      record.outbox_error_count,
      "Wagyu outbox error count",
    ),
    outboxPaused: boolean(record.outbox_paused, "Wagyu outbox pause state"),
    pauseReason: optionalPauseReason(record.pause_reason),
  };
  if (!status.outboxPaused && status.pauseReason !== null) {
    throw invalid("Wagyu status pause reason");
  }
  if (!status.outboundWorkPending && status.outboxQueuedCount > 0) {
    throw invalid("Wagyu outbound work state");
  }
  return status;
}

export function parseWagyuOutboxPage(
  value: JsonValue,
  requestedLimit = WAGYU_OUTBOX_PAGE_LIMIT,
): WagyuOutboxPage {
  assertPageLimit(requestedLimit);
  const record = object(value, "Wagyu outbox page");
  exactKeys(
    record,
    ["revision", "items"],
    "Wagyu outbox page",
    ["next_before_sequence"],
  );
  if (!Array.isArray(record.items) || record.items.length > requestedLimit) {
    throw invalid("Wagyu outbox page items");
  }
  const items = record.items.map(parseOutboxItem);
  for (let index = 1; index < items.length; index += 1) {
    if (
      BigInt(items[index - 1]!.localSequence) <=
      BigInt(items[index]!.localSequence)
    ) {
      throw invalid("Wagyu outbox page order");
    }
  }
  const nextBeforeSequence = optionalNatural(
    record.next_before_sequence,
    "Wagyu next outbox sequence",
    false,
  );
  if (
    nextBeforeSequence !== null &&
    items.at(-1)?.localSequence !== nextBeforeSequence
  ) {
    throw invalid("Wagyu next outbox sequence");
  }
  return {
    revision: natural(record.revision, "Wagyu outbox revision", true),
    items,
    nextBeforeSequence,
  };
}

export function parseWagyuDrainResult(value: JsonValue): WagyuDrainResult {
  const record = object(value, "Wagyu outbox drain result");
  exactKeys(
    record,
    [
      "state_revision",
      "outbox_revision",
      "attempted",
      "completed",
      "remaining",
      "errors",
      "paused",
    ],
    "Wagyu outbox drain result",
    ["pause_reason"],
  );
  const attempted = boundedBatchCount(record.attempted, "Wagyu attempted count");
  const completed = boundedBatchCount(record.completed, "Wagyu completed count");
  if (completed > attempted) {
    throw invalid("Wagyu completed count");
  }
  const result: WagyuDrainResult = {
    stateRevision: natural(
      record.state_revision,
      "Wagyu drain state revision",
      true,
    ),
    outboxRevision: natural(
      record.outbox_revision,
      "Wagyu drain outbox revision",
      true,
    ),
    attempted,
    completed,
    remaining: boundedCount(record.remaining, "Wagyu remaining count"),
    errors: boundedCount(record.errors, "Wagyu drain error count"),
    paused: boolean(record.paused, "Wagyu drain pause state"),
    pauseReason: optionalPauseReason(record.pause_reason),
  };
  if (!result.paused && result.pauseReason !== null) {
    throw invalid("Wagyu drain pause reason");
  }
  return result;
}

export function trayBadgeForStatus(status: WagyuBackendStatus): number | null {
  if (status.unreadNotificationCount <= 0) return null;
  return Math.min(status.unreadNotificationCount, WAGYU_TRAY_BADGE_MAX);
}

function parseOutboxItem(value: JsonValue): WagyuOutboxItem {
  const record = object(value, "Wagyu outbox item");
  exactKeys(
    record,
    [
      "local_sequence",
      "recipient",
      "created_at_ns",
      "updated_at_ns",
      "state",
      "attempt_count",
      "retryable",
    ],
    "Wagyu outbox item",
    ["route", "next_retry_at_ns", "last_error", "fanout"],
  );
  const state = (optionalVariantTag(
    record.state,
    [
      "queued",
      "sending",
      "accepted",
      "duplicate",
      "paused",
      "failed",
      "uncertain",
      "superseded",
    ],
    "Wagyu outbox state",
  ) ?? "unsupported") as WagyuOutboxState;
  const retryable = boolean(record.retryable, "Wagyu outbox retryable state");
  if (
    retryable &&
    state !== "failed" &&
    state !== "uncertain" &&
    state !== "paused"
  ) {
    throw invalid("Wagyu outbox retryable state");
  }
  const createdAtNs = natural(
    record.created_at_ns,
    "Wagyu outbox creation time",
    true,
  );
  const updatedAtNs = natural(
    record.updated_at_ns,
    "Wagyu outbox update time",
    true,
  );
  if (BigInt(updatedAtNs) < BigInt(createdAtNs)) {
    throw invalid("Wagyu outbox update time");
  }
  return {
    localSequence: natural(
      record.local_sequence,
      "Wagyu outbox local sequence",
      false,
    ),
    recipient: boundedString(record.recipient, "Wagyu outbox recipient", 128),
    route: (optionalVariantTag(
      record.route,
      ["follow", "unfollow", "deliver", "like", "notice"],
      "Wagyu outbox route",
    ) ?? "unsupported") as WagyuOutboxRoute,
    state,
    attemptCount: boundedCount(
      record.attempt_count,
      "Wagyu outbox attempt count",
      65_535,
    ),
    retryable,
    nextRetryAtNs: optionalNatural(
      record.next_retry_at_ns,
      "Wagyu next retry time",
      true,
    ),
    lastError: optionalString(
      record.last_error,
      "Wagyu outbox error",
      240,
    ),
    createdAtNs,
    updatedAtNs,
    fanout: parseFanoutProgress(record.fanout),
  };
}

function parseFanoutProgress(
  value: JsonValue | undefined,
): WagyuFanoutProgress | null {
  const option = projectedOptionalValue(value, "Wagyu fanout progress");
  if (option === null) return null;
  const record = object(option, "Wagyu fanout progress");
  exactKeys(
    record,
    [
      "job_id",
      "state",
      "eligible_recipient_count",
      "queued_recipient_count",
      "completed_recipient_count",
      "terminal_recipient_count",
      "uncertain_recipient_count",
    ],
    "Wagyu fanout progress",
  );
  const eligibleRecipientCount = boundedNat32Count(
    record.eligible_recipient_count,
    "Wagyu eligible recipient count",
  );
  const queuedRecipientCount = boundedNat32Count(
    record.queued_recipient_count,
    "Wagyu queued recipient count",
  );
  const completedRecipientCount = boundedNat32Count(
    record.completed_recipient_count,
    "Wagyu completed recipient count",
  );
  const terminalRecipientCount = boundedNat32Count(
    record.terminal_recipient_count,
    "Wagyu terminal recipient count",
  );
  const uncertainRecipientCount = boundedNat32Count(
    record.uncertain_recipient_count,
    "Wagyu uncertain recipient count",
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
    jobId: natural(record.job_id, "Wagyu fanout job", false),
    state: (optionalVariantTag(
      record.state,
      [
        "queued",
        "scanning",
        "sending",
        "complete",
        "partial",
        "paused",
        "failed",
      ],
      "Wagyu fanout state",
    ) ?? "unsupported") as WagyuFanoutState,
    eligibleRecipientCount,
    queuedRecipientCount,
    completedRecipientCount,
    terminalRecipientCount,
    uncertainRecipientCount,
  };
}

function optionalPauseReason(value: JsonValue | undefined): WagyuBackendPauseReason | null {
  return optionalVariantTag(
    value,
    [
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
    ],
    "Wagyu pause reason",
  ) as WagyuBackendPauseReason | null;
}

function optionalVariantTag(
  value: JsonValue | undefined,
  allowed: readonly string[],
  label: string,
): string | null {
  const option = projectedOptionalValue(value, label);
  if (option === null) return null;
  if (!isJsonObject(option)) return "unsupported";
  const keys = Object.keys(option);
  if (keys.length !== 1) throw invalid(label);
  const tag = keys[0];
  if (tag === undefined) throw invalid(label);
  if (!allowed.includes(tag)) return "unsupported";
  if (option[tag] !== null) throw invalid(label);
  return tag;
}

function optionalNatural(
  value: JsonValue | undefined,
  label: string,
  allowZero: boolean,
): string | null {
  const option = projectedOptionalValue(value, label);
  return option === null ? null : natural(option, label, allowZero);
}

function optionalString(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string | null {
  const option = projectedOptionalValue(value, label);
  return option === null ? null : boundedString(option, label, maximum);
}

function optionalPrincipal(
  value: JsonValue | undefined,
  label: string,
): string | null {
  const option = projectedOptionalValue(value, label);
  return option === null ? null : principal(option, label);
}

function projectedOptionalValue(
  value: JsonValue | undefined,
  label: string,
): JsonValue | null {
  if (value === undefined) return null;
  if (value === null || Array.isArray(value)) throw invalid(label);
  return value;
}

function exactKeys(
  record: JsonObject,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(record).sort();
  const required = new Set(keys);
  const allowed = new Set([...keys, ...optional]);
  if (actual.some((key) => !allowed.has(key))) throw invalid(label);
  if ([...required].some((key) => !actual.includes(key))) throw invalid(label);
}

function object(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw invalid(label);
  return value;
}

function natural(
  value: JsonValue | undefined,
  label: string,
  allowZero: boolean,
): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(value)
  ) {
    throw invalid(label);
  }
  const parsed = BigInt(value);
  if (parsed > NAT64_MAX || (!allowZero && parsed === 0n)) {
    throw invalid(label);
  }
  return value;
}

function boundedCount(
  value: JsonValue | undefined,
  label: string,
  maximum = WAGYU_LOCAL_COUNT_MAX,
): number {
  const decimal = natural(value, label, true);
  const parsed = Number(BigInt(decimal));
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw invalid(label);
  return parsed;
}

function boundedNat32Count(
  value: JsonValue | undefined,
  label: string,
  maximum = WAGYU_LOCAL_COUNT_MAX,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum ||
    value > 0xffff_ffff
  ) {
    throw invalid(label);
  }
  return value;
}

function boundedBatchCount(
  value: JsonValue | undefined,
  label: string,
): number {
  return boundedCount(value, label, WAGYU_DRAIN_LIMIT);
}

function boundedString(
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

function principal(value: JsonValue | undefined, label: string): string {
  const text = boundedString(value, label, 128);
  try {
    const parsed = Principal.fromText(text);
    if (parsed.toText() !== text) throw invalid(label);
    return text;
  } catch {
    throw invalid(label);
  }
}

function bytes32(value: JsonValue | undefined, label: string): number[] {
  if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) {
    return Array.from({ length: 32 }, (_unused, index) =>
      Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    );
  }
  throw invalid(label);
}

function protocol(value: JsonValue | undefined): "wagyu_v1" {
  if (value !== "wagyu_v1") throw invalid("Wagyu protocol");
  return value;
}

function boolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(label);
  return value;
}

function assertPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > WAGYU_OUTBOX_PAGE_MAX) {
    throw new Error(`Wagyu outbox page limit must be from 1 to ${WAGYU_OUTBOX_PAGE_MAX}`);
  }
}

function assertDrainLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > WAGYU_DRAIN_LIMIT) {
    throw new Error(`Wagyu drain limit must be from 1 to ${WAGYU_DRAIN_LIMIT}`);
  }
}

function invalid(label: string): WagyuBackendResponseError {
  return new WagyuBackendResponseError(`${label} returned an invalid response`);
}
