import type { WagyuBackendPauseReason, WagyuBackendStatus } from "./contracts.ts";

export const WAGYU_RESIDENT_STORAGE_KEY = "neutron.wagyu.resident.v1";
const STORAGE_VERSION = 1;
const NAT64_MAX = (1n << 64n) - 1n;

export type WagyuResidentStoredProjection = {
  version: 1;
  autoDrainEnabled: boolean;
  lastAuthoritativeAtMs: number | null;
  status: WagyuBackendStatus | null;
};

export interface WagyuResidentStorage {
  load(): WagyuResidentStoredProjection | null;
  save(value: WagyuResidentStoredProjection): void;
}

export function emptyStoredProjection(): WagyuResidentStoredProjection {
  return {
    version: STORAGE_VERSION,
    autoDrainEnabled: true,
    lastAuthoritativeAtMs: null,
    status: null,
  };
}

export function browserWagyuResidentStorage(): WagyuResidentStorage {
  return {
    load(): WagyuResidentStoredProjection | null {
      try {
        const raw = window.localStorage.getItem(WAGYU_RESIDENT_STORAGE_KEY);
        if (raw === null || raw.length > 2_048) return null;
        return parseStoredProjection(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },

    save(value: WagyuResidentStoredProjection): void {
      const parsed = parseStoredProjection(value);
      if (parsed === null) throw new Error("Invalid Wagyu resident projection");
      try {
        window.localStorage.setItem(
          WAGYU_RESIDENT_STORAGE_KEY,
          JSON.stringify(parsed),
        );
      } catch {
        // Browser persistence is an optional rebuildable cache. The canonical
        // Wagyu state and every durable outbox item remain in the backend.
      }
    },
  };
}

export function parseStoredProjection(
  value: unknown,
): WagyuResidentStoredProjection | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, [
      "version",
      "autoDrainEnabled",
      "lastAuthoritativeAtMs",
      "status",
    ]) ||
    value.version !== STORAGE_VERSION ||
    typeof value.autoDrainEnabled !== "boolean"
  ) {
    return null;
  }
  const lastAuthoritativeAtMs =
    value.lastAuthoritativeAtMs === null
      ? null
      : safeTimestamp(value.lastAuthoritativeAtMs);
  if (
    value.lastAuthoritativeAtMs !== null &&
    lastAuthoritativeAtMs === null
  ) {
    return null;
  }
  const status = value.status === null ? null : parseStoredStatus(value.status);
  if (value.status !== null && status === null) return null;
  return {
    version: STORAGE_VERSION,
    autoDrainEnabled: value.autoDrainEnabled,
    lastAuthoritativeAtMs,
    status,
  };
}

function parseStoredStatus(value: unknown): WagyuBackendStatus | null {
  const hasOutboundWorkPending = isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "outboundWorkPending");
  if (
    !isRecord(value) ||
    !exactKeys(value, [
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
      ...(hasOutboundWorkPending ? ["outboundWorkPending"] : []),
      "outboxQueuedCount",
      "outboxErrorCount",
      "outboxPaused",
      "pauseReason",
    ])
  ) {
    return null;
  }
  const node = storedPrincipal(value.node);
  const networkId = storedBytes32(value.networkId);
  const networkConfigured =
    typeof value.networkConfigured === "boolean"
      ? value.networkConfigured
      : null;
  const protocol = value.protocol === "wagyu_v1" ? value.protocol : null;
  const profileGeneration = storedNat(value.profileGeneration);
  const profileRevision = storedNat(value.profileRevision);
  const certifiedAssetsReady =
    typeof value.certifiedAssetsReady === "boolean"
      ? value.certifiedAssetsReady
      : null;
  const releaseGateMessage = storedOptionalText(
    value.releaseGateMessage,
    240,
  );
  const stateRevision = storedNat(value.stateRevision);
  const feedRevision = storedNat(value.feedRevision);
  const notificationRevision = storedNat(value.notificationRevision);
  const relationshipRevision = storedNat(value.relationshipRevision);
  const unreadFeedCount = storedCount(value.unreadFeedCount);
  const unreadNotificationCount = storedCount(value.unreadNotificationCount);
  const outboxQueuedCount = storedCount(value.outboxQueuedCount);
  let outboundWorkPending: boolean | null = null;
  if (hasOutboundWorkPending) {
    if (typeof value.outboundWorkPending === "boolean") {
      outboundWorkPending = value.outboundWorkPending;
    }
  } else if (outboxQueuedCount !== null) {
    outboundWorkPending = outboxQueuedCount > 0;
  }
  const outboxErrorCount = storedCount(value.outboxErrorCount);
  const pauseReason = storedPauseReason(value.pauseReason);
  if (
    node === null ||
    networkId === null ||
    networkConfigured === null ||
    protocol === null ||
    profileGeneration === null ||
    profileRevision === null ||
    certifiedAssetsReady === null ||
    releaseGateMessage === undefined ||
    stateRevision === null ||
    feedRevision === null ||
    notificationRevision === null ||
    relationshipRevision === null ||
    unreadFeedCount === null ||
    unreadNotificationCount === null ||
    outboundWorkPending === null ||
    outboxQueuedCount === null ||
    outboxErrorCount === null ||
    typeof value.outboxPaused !== "boolean" ||
    pauseReason === undefined ||
    (!value.outboxPaused && pauseReason !== null) ||
    (!outboundWorkPending && outboxQueuedCount > 0)
  ) {
    return null;
  }
  const zeroNetwork = networkId.every((byte) => byte === 0);
  if (
    (networkConfigured && zeroNetwork) ||
    (!networkConfigured && !zeroNetwork)
  ) {
    return null;
  }
  return {
    node,
    networkId,
    networkConfigured,
    protocol,
    profileGeneration,
    profileRevision,
    certifiedAssetsReady,
    releaseGateMessage,
    stateRevision,
    feedRevision,
    notificationRevision,
    relationshipRevision,
    unreadFeedCount,
    unreadNotificationCount,
    outboundWorkPending,
    outboxQueuedCount,
    outboxErrorCount,
    outboxPaused: value.outboxPaused,
    pauseReason,
  };
}

function storedPauseReason(
  value: unknown,
): WagyuBackendPauseReason | null | undefined {
  if (value === null) return null;
  if (
    value === "blocked" ||
    value === "not_following" ||
    value === "low_cycles" ||
    value === "revoked" ||
    value === "rate_limited" ||
    value === "busy" ||
    value === "incompatible" ||
    value === "unknown_post" ||
    value === "credit_exhausted" ||
    value === "lease_expired" ||
    value === "handler_failure" ||
    value === "maintenance" ||
    value === "unsupported"
  ) {
    return value;
  }
  return undefined;
}

function storedNat(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(value) ||
    BigInt(value) > NAT64_MAX
  ) {
    return null;
  }
  return value;
}

function storedPrincipal(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 5 ||
    value.length > 128 ||
    !/^[a-z0-9-]+$/u.test(value)
  ) {
    return null;
  }
  return value;
}

function storedBytes32(value: unknown): number[] | null {
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
    return null;
  }
  return [...value] as number[];
}

function storedOptionalText(
  value: unknown,
  maximum: number,
): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  return undefined;
}

function storedCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 100_000
    ? value
    : null;
}

function safeTimestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
    ? value
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
