import type {
  AuthoredPage,
  FeedItem,
  FeedPage,
  NotificationPage,
} from "./model.ts";

/**
 * Produces the renderable local feed without treating a browser-only proof
 * result as a durable backend promotion.
 *
 * Only committed verified rows participate in canonical merging and
 * suppression. Failed promotions remain visible as separate proof results so
 * the owner can retry the local commit.
 */
export function canonicalFeedItems(
  items: readonly FeedItem[],
): FeedItem[] {
  const suppressionKeys = new Set<string>();
  for (const item of items) {
    if (
      item.verification === "verified" &&
      item.promotion === "committed" &&
      item.kind === "tombstone"
    ) {
      const key = canonicalObjectKey(item);
      if (key) suppressionKeys.add(key);
    }
  }

  const canonical = new Map<string, number>();
  const output: FeedItem[] = [];
  for (const item of items) {
    const key = canonicalObjectKey(item);
    const committed =
      item.verification === "verified" &&
      item.promotion === "committed";

    if (
      committed &&
      item.kind !== "tombstone" &&
      key &&
      suppressionKeys.has(key)
    ) {
      continue;
    }

    if (committed && key) {
      const existingIndex = canonical.get(key);
      if (existingIndex !== undefined) {
        const existing = output[existingIndex]!;
        // A committed tombstone is the canonical terminal representation.
        if (item.kind === "tombstone" && existing.kind !== "tombstone") {
          output[existingIndex] = {
            ...item,
            verifiedDeliveryCount:
              (existing.verifiedDeliveryCount ?? 1) +
              (item.verifiedDeliveryCount ?? 1),
          };
        } else {
          output[existingIndex] = mergeVerifiedDeliveries(existing, item);
        }
        continue;
      }
      canonical.set(key, output.length);
    }

    output.push(
      committed
        ? { ...item, verifiedDeliveryCount: item.verifiedDeliveryCount ?? 1 }
        : item,
    );
  }
  return output;
}

export function appendNotificationPage(
  current: NotificationPage,
  older: NotificationPage,
  requestedCursor: string,
): NotificationPage {
  if (
    current.nextCursor !== requestedCursor ||
    !revisionAtLeast(older.revision, current.revision)
  ) return current;
  const seen = new Set(current.items.map((item) => item.id));
  return {
    revision: maximumRevision(current.revision, older.revision),
    items: [
      ...current.items,
      ...older.items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    ],
    nextCursor:
      older.nextCursor === current.nextCursor
        ? null
        : older.nextCursor,
  };
}

export function appendFeedPage(
  current: FeedPage,
  older: FeedPage,
  requestedCursor: string,
): FeedPage {
  if (
    current.nextCursor !== requestedCursor ||
    !revisionAtLeast(older.revision, current.revision)
  ) return current;
  const seen = new Set(current.items.map((item) => item.id));
  return {
    revision: maximumRevision(current.revision, older.revision),
    items: [
      ...current.items,
      ...older.items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    ],
    nextCursor:
      older.nextCursor === current.nextCursor
        ? null
        : older.nextCursor,
  };
}

/**
 * Applies a newer authoritative feed page without discarding proof results
 * that exist only in this browser session.
 *
 * A committed backend row intentionally contains no remote body: every
 * browser must verify its exact event bytes itself. Immediately after the
 * browser promotes a candidate, however, the promotion update advances the
 * backend page revision. Replacing the whole page with that bodyless row
 * would erase the verification that just authorized rendering and force a
 * second refresh. Preserve it only when the authoritative row still names the
 * same committed candidate and carries the same exact event bytes.
 */
export function mergeFeedPageHydration(
  current: FeedPage,
  authoritative: FeedPage,
): FeedPage {
  const currentById = new Map(
    current.items.map((item) => [item.id, item] as const),
  );
  return {
    ...authoritative,
    items: authoritative.items.map((item) => {
      const hydrated = currentById.get(item.id);
      if (
        item.verification !== "candidate" ||
        item.promotion !== "committed" ||
        hydrated?.verification !== "verified" ||
        hydrated.promotion !== "committed" ||
        hydrated.immediateSender !== item.immediateSender ||
        hydrated.kind !== item.kind ||
        !sameBytes(hydrated.opaqueEventBytes, item.opaqueEventBytes)
      ) {
        return item;
      }
      return {
        ...hydrated,
        localSequence: item.localSequence,
        receivedAt: item.receivedAt,
        promotion: item.promotion,
        opaqueEventBytes: item.opaqueEventBytes?.slice() ?? null,
      };
    }),
  };
}

/**
 * Appends one newest-first owner-local authored page.
 *
 * Authored rows contain recovery controls, so a delayed continuation must not
 * overwrite a refreshed head page or replace an already rendered row with an
 * overlapping copy. The cursor is a decimal author sequence in V1; accepting
 * only a strictly decreasing continuation also turns a malformed cursor loop
 * into a terminal page instead of an unbounded "load more" cycle.
 */
export function appendAuthoredPage(
  current: AuthoredPage,
  older: AuthoredPage,
  requestedCursor: string,
): AuthoredPage {
  if (
    current.nextCursor !== requestedCursor ||
    !revisionAtLeast(older.revision, current.revision)
  ) return current;

  const requestedSequence = decimalSequence(requestedCursor);
  if (requestedSequence === null) return current;

  const seenSequences = new Set(current.items.map((item) => item.sequence));
  const seenActions = new Set(
    current.items.map((item) => authoredIdentity(item.kind, item.actionId)),
  );
  const appended = older.items.filter((item) => {
    const sequence = decimalSequence(item.sequence);
    const identity = authoredIdentity(item.kind, item.actionId);
    if (
      sequence === null ||
      sequence >= requestedSequence ||
      seenSequences.has(item.sequence) ||
      seenActions.has(identity)
    ) {
      return false;
    }
    seenSequences.add(item.sequence);
    seenActions.add(identity);
    return true;
  });

  const continuation = decimalSequence(older.nextCursor);
  return {
    revision: maximumRevision(current.revision, older.revision),
    items: [...current.items, ...appended],
    nextCursor:
      continuation !== null && continuation < requestedSequence
        ? older.nextCursor
        : null,
  };
}

function canonicalObjectKey(item: FeedItem): string | null {
  if (!item.bodyDigest) return null;
  return `${item.author.nodeId}\u0000${item.postId}\u0000${item.bodyDigest}`;
}

function mergeVerifiedDeliveries(
  current: FeedItem,
  incoming: FeedItem,
): FeedItem {
  const currentCount = current.verifiedDeliveryCount ?? 1;
  const incomingCount = incoming.verifiedDeliveryCount ?? 1;
  return {
    ...current,
    likedByOwner: current.likedByOwner || incoming.likedByOwner,
    ...(current.verifiedReplyCount !== undefined ||
        incoming.verifiedReplyCount !== undefined
      ? {
          verifiedReplyCount: Math.max(
            current.verifiedReplyCount ?? 0,
            incoming.verifiedReplyCount ?? 0,
          ),
        }
      : {}),
    likeSummary: {
      verified: Math.max(
        current.likeSummary.verified,
        incoming.likeSummary.verified,
      ),
      invalid: Math.max(
        current.likeSummary.invalid,
        incoming.likeSummary.invalid,
      ),
      unavailable: Math.max(
        current.likeSummary.unavailable,
        incoming.likeSummary.unavailable,
      ),
      awaitingBatch: Math.max(
        current.likeSummary.awaitingBatch,
        incoming.likeSummary.awaitingBatch,
      ),
    },
    localOrigin: current.localOrigin || incoming.localOrigin,
    sharedBy: current.sharedBy ?? incoming.sharedBy,
    originalPostRefBytes:
      current.originalPostRefBytes ?? incoming.originalPostRefBytes,
    verifiedDeliveryCount: currentCount + incomingCount,
  };
}

function maximumRevision(left: string, right: string): string {
  try {
    return BigInt(right) > BigInt(left) ? right : left;
  } catch {
    return left;
  }
}

function revisionAtLeast(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) >= BigInt(current);
  } catch {
    return false;
  }
}

function decimalSequence(value: string | null): bigint | null {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function authoredIdentity(kind: string, actionId: string): string {
  return `${kind}\u0000${actionId}`;
}

function sameBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null || left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
