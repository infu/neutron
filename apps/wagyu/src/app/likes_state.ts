import type {
  FeedItem,
  LikePackage,
  LikeReceipt,
  LikesDetail,
  NotificationItem,
} from "./model.ts";

/**
 * Joins the author's bounded local Like receipts to the certified batch walk.
 *
 * Browser-verified receipts may briefly await the next bounded seal pass.
 * V101 can publish that 1-149 receipt segment while the post remains open, but
 * until the head advances these identities are explicitly `awaiting-batch`
 * owner-local state, not remote certified totals.
 */
export function withLocalAwaitingLikes(
  detail: LikesDetail,
  item: FeedItem,
  notifications: readonly NotificationItem[],
  localLikerIds: readonly string[] = [],
): LikesDetail {
  const limit =
    item.localOrigin &&
      Number.isSafeInteger(item.likeSummary.awaitingBatch)
      ? Math.max(
          localLikerIds.length,
          0,
          item.likeSummary.awaitingBatch,
        )
      : 0;
  if (limit === 0) {
    return detail.awaitingBatch.length === 0
      ? detail
      : { ...detail, awaitingBatch: [] };
  }

  const sealedActors = new Set(
    detail.packages.flatMap((group) =>
      group.receipts.map((receipt) => receipt.actorNodeId)
    ),
  );
  const awaiting: LikeReceipt[] = [];
  const awaitingActors = new Set<string>();
  const append = (receipt: LikeReceipt) => {
    if (
      awaiting.length >= limit ||
      sealedActors.has(receipt.actorNodeId) ||
      awaitingActors.has(receipt.actorNodeId)
    ) {
      return;
    }
    awaitingActors.add(receipt.actorNodeId);
    awaiting.push({ ...receipt, state: "awaiting-batch" });
  };

  const notificationByActor = new Map(
    notifications
      .filter((notification) =>
        notification.kind === "like" &&
        (
          notification.verification === "transport-authenticated" ||
          notification.verification === "verified"
        ) &&
        notification.targetPostId === item.postId &&
        notification.targetBodyHash === item.bodyDigest
      )
      .map((notification) => [notification.actorNodeId, notification] as const),
  );
  for (const actorNodeId of localLikerIds) {
    const notification = notificationByActor.get(actorNodeId);
    append({
      id: notification?.id ?? `unsealed-like:${item.postId}:${actorNodeId}`,
      actorNodeId,
      actorDisplayName: notification?.actorDisplayName ?? null,
      state: "awaiting-batch",
    });
  }
  for (const receipt of detail.awaitingBatch) append(receipt);
  for (const notification of notifications) {
    if (
      awaiting.length >= limit ||
      notification.kind !== "like" ||
      (
        notification.verification !== "transport-authenticated" &&
        notification.verification !== "verified"
      ) ||
      notification.targetPostId !== item.postId ||
      notification.targetBodyHash !== item.bodyDigest
    ) {
      continue;
    }
    append({
      id: notification.id,
      actorNodeId: notification.actorNodeId,
      actorDisplayName: notification.actorDisplayName,
      state: "awaiting-batch",
    });
  }

  return { ...detail, awaitingBatch: awaiting };
}

/**
 * Appends an older Worker page without discarding packages that the user has
 * already seen. A retry may return the unavailable boundary package again, so
 * package digest is the stable merge identity.
 */
export function appendLikesPage(
  current: LikesDetail,
  older: LikesDetail,
): LikesDetail {
  if (older.postId !== current.postId) {
    throw new Error("Like continuation returned another post");
  }
  if (
    current.acceptingLikes !== undefined &&
    older.acceptingLikes !== undefined &&
    current.acceptingLikes !== older.acceptingLikes
  ) {
    throw new Error("Like continuation changed its verified head");
  }

  const packages = [...current.packages];
  const positionByDigest = new Map(
    packages.map((pkg, index) => [pkg.id, index] as const),
  );
  const digestByBatch = new Map(
    packages.map((pkg) => [pkg.batchNumber, pkg.id] as const),
  );
  for (const incoming of older.packages) {
    const batchDigest = digestByBatch.get(incoming.batchNumber);
    if (batchDigest !== undefined && batchDigest !== incoming.id) {
      throw new Error("Like continuation changed a batch digest");
    }
    const position = positionByDigest.get(incoming.id);
    if (position === undefined) {
      positionByDigest.set(incoming.id, packages.length);
      digestByBatch.set(incoming.batchNumber, incoming.id);
      packages.push(incoming);
      continue;
    }
    const existing = packages[position];
    if (existing === undefined || existing.batchNumber !== incoming.batchNumber) {
      throw new Error("Like continuation changed a batch number");
    }
    packages[position] = preferredPackage(existing, incoming);
  }

  const acceptingLikes = current.acceptingLikes ?? older.acceptingLikes;
  return {
    ...current,
    packages,
    // Awaiting-batch rows, when an owner API eventually supplies them, are
    // local state from the initial open and are not part of the remote chain.
    awaitingBatch: current.awaitingBatch,
    truncated: older.truncated ?? older.loadOlder != null,
    ...(acceptingLikes === undefined ? {} : { acceptingLikes }),
    loadOlder: older.loadOlder ?? null,
  };
}

function preferredPackage(
  existing: LikePackage,
  incoming: LikePackage,
): LikePackage {
  // Never let a transient retry downgrade a terminal result already rendered.
  if (
    existing.state === "verified" ||
    (existing.state === "invalid" && incoming.state === "unavailable")
  ) {
    return existing;
  }
  return incoming;
}
