import type {
  ProofState,
  RelationshipPage,
} from "./model.ts";

export interface RelationshipProfilePresentation {
  displayName: string | null;
  avatarUrl: string | null;
  profileProof: ProofState;
}

/**
 * A relationship mutation advances the backend revision, so any continuation
 * cursor captured before that mutation is no longer safe to use. This drops
 * only the cursor; it deliberately does not fabricate relationship row state.
 */
export function invalidateRelationshipContinuation(
  current: RelationshipPage,
): RelationshipPage {
  return current.nextCursor === null
    ? current
    : { ...current, nextCursor: null };
}

export function appendRelationshipPage(
  current: RelationshipPage,
  older: RelationshipPage,
  requestedCursor: string,
): RelationshipPage {
  if (
    current.nextCursor !== requestedCursor ||
    older.revision !== current.revision
  ) {
    throw new Error("The relationship ledger changed; refresh before continuing");
  }
  const seen = new Set(current.items.map((item) => item.nodeId));
  for (const item of older.items) {
    if (seen.has(item.nodeId)) {
      throw new Error("The relationship page repeated a Node ID");
    }
    seen.add(item.nodeId);
  }
  return {
    revision: current.revision,
    items: [...current.items, ...older.items],
    nextCursor: older.nextCursor,
  };
}

export function applyRelationshipProfileHydration(
  current: RelationshipPage,
  expectedRevision: string,
  nodeId: string,
  profile: RelationshipProfilePresentation,
): RelationshipPage {
  if (current.revision !== expectedRevision) return current;
  const index = current.items.findIndex((item) => item.nodeId === nodeId);
  if (index < 0) return current;
  const mayRender =
    profile.profileProof === "fresh" || profile.profileProof === "stale";
  return {
    ...current,
    items: current.items.map((item, itemIndex) =>
      itemIndex === index
        ? {
            ...item,
            displayName: mayRender ? profile.displayName : null,
            avatarUrl: mayRender ? profile.avatarUrl : null,
            profileProof: profile.profileProof,
          }
        : item
    ),
  };
}

export function markRelationshipProfileUnavailable(
  current: RelationshipPage,
  expectedRevision: string,
  nodeId: string,
): RelationshipPage {
  return applyRelationshipProfileHydration(
    current,
    expectedRevision,
    nodeId,
    {
      displayName: null,
      avatarUrl: null,
      profileProof: "unavailable",
    },
  );
}
