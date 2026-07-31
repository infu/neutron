import { describe, expect, test } from "bun:test";
import type {
  FeedAuthor,
  FeedItem,
  FeedPage,
  NotificationItem,
  NotificationPage,
} from "../src/app/model.ts";
import {
  appendNotificationPage,
  canonicalFeedItems,
  mergeFeedPageHydration,
} from "../src/app/feed_state.ts";
import { coordinateFeedDisposition } from "../src/app/certified_runtime.ts";

const AUTHOR: FeedAuthor = {
  nodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  displayName: "Author",
  avatarUrl: null,
  profileProof: "fresh",
};
const SHARER: FeedAuthor = {
  nodeId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  displayName: "Sharer",
  avatarUrl: null,
  profileProof: "fresh",
};

function feedItem(
  id: string,
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return {
    id,
    localSequence: id.replace(/\D/gu, "") || "1",
    receivedAt: "2026-07-24T00:00:00.000Z",
    immediateSender: AUTHOR.nodeId,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: AUTHOR,
    postId: "11".repeat(32),
    body: "verified body",
    bodyDigest: "22".repeat(32),
    objectDigest: "33".repeat(32),
    bodyLength: 13,
    createdAt: "2026-07-24T00:00:00.000Z",
    sharedBy: null,
    replyTo: null,
    likedByOwner: false,
    likeSummary: {
      verified: 0,
      invalid: 0,
      unavailable: 0,
      awaitingBatch: 0,
    },
    localOrigin: false,
    opaqueEventBytes: new Uint8Array([1]),
    originalPostRefBytes: new Uint8Array([2]),
    ...overrides,
  };
}

describe("canonical local feed projection", () => {
  test("merges committed direct and shared deliveries without losing attribution", () => {
    const direct = feedItem("direct");
    const shared = feedItem("share", {
      kind: "share",
      immediateSender: SHARER.nodeId,
      sharedBy: SHARER,
      originalPostRefBytes: new Uint8Array([8, 9]),
    });

    const result = canonicalFeedItems([direct, shared]);
    expect(result).toHaveLength(1);
    expect(result[0]?.sharedBy?.nodeId).toBe(SHARER.nodeId);
    expect(result[0]?.verifiedDeliveryCount).toBe(2);
  });

  test("canonical delivery merging never invents an unknown reply count", () => {
    const unknown = canonicalFeedItems([
      feedItem("direct"),
      feedItem("share", { kind: "share", sharedBy: SHARER }),
    ]);
    expect(unknown[0]?.verifiedReplyCount).toBeUndefined();

    const known = canonicalFeedItems([
      feedItem("direct", { verifiedReplyCount: 2 }),
      feedItem("share", {
        kind: "share",
        sharedBy: SHARER,
        verifiedReplyCount: 5,
      }),
    ]);
    expect(known[0]?.verifiedReplyCount).toBe(5);
  });

  test("does not merge a conflicting body identity", () => {
    const result = canonicalFeedItems([
      feedItem("one"),
      feedItem("two", { bodyDigest: "44".repeat(32) }),
    ]);
    expect(result).toHaveLength(2);
  });

  test("a committed verified tombstone suppresses every matching live copy", () => {
    const tombstone = feedItem("tombstone", {
      kind: "tombstone",
      body: null,
      originalPostRefBytes: null,
    });
    const result = canonicalFeedItems([
      feedItem("delayed-direct"),
      feedItem("shared", { kind: "share", sharedBy: SHARER }),
      tombstone,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("tombstone");
  });

  test("a failed tombstone promotion never suppresses or merges", () => {
    const result = canonicalFeedItems([
      feedItem("direct"),
      feedItem("tombstone", {
        kind: "tombstone",
        promotion: "failed",
        body: null,
      }),
    ]);
    expect(result.map((item) => item.kind)).toEqual([
      "original",
      "tombstone",
    ]);
  });

  test("proof results with failed promotion stay separate", () => {
    const result = canonicalFeedItems([
      feedItem("one", { promotion: "failed" }),
      feedItem("two", {
        kind: "share",
        promotion: "failed",
        sharedBy: SHARER,
      }),
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("promotion outcome truthfulness", () => {
  test("does not durably terminalize a retryable unavailable result", async () => {
    let dispositionWrites = 0;
    const result = await coordinateFeedDisposition(
      feedItem("candidate", {
        verification: "unavailable",
        promotion: "pending",
      }),
      async () => {
        dispositionWrites += 1;
      },
    );
    expect(result.verification).toBe("unavailable");
    expect(dispositionWrites).toBe(0);
  });

  test("does not durably discard an unavailable remote object", async () => {
    let dispositionWrites = 0;
    const result = await coordinateFeedDisposition(
      feedItem("candidate", {
        verification: "unavailable",
        verificationIssue: "object-not-found",
        promotion: "pending",
      }),
      async () => {
        dispositionWrites += 1;
      },
    );
    expect(result.verificationIssue).toBe("object-not-found");
    expect(dispositionWrites).toBe(0);
  });

  test("still coordinates a terminal semantic-invalid result", async () => {
    let dispositionWrites = 0;
    await coordinateFeedDisposition(
      feedItem("candidate", {
        verification: "invalid",
        verificationIssue: "binding-invalid",
        promotion: "pending",
      }),
      async () => {
        dispositionWrites += 1;
      },
    );
    expect(dispositionWrites).toBe(1);
  });

  test("marks a verified result committed only after the bridge succeeds", async () => {
    const result = await coordinateFeedDisposition(
      feedItem("candidate", { promotion: "pending" }),
      async () => undefined,
    );
    expect(result.promotion).toBe("committed");
  });

  test("keeps a verified proof but marks rejected local promotion failed", async () => {
    const result = await coordinateFeedDisposition(
      feedItem("candidate", { promotion: "pending" }),
      async () => {
        throw new Error("conflict");
      },
    );
    expect(result.verification).toBe("verified");
    expect(result.promotion).toBe("failed");
  });
});

describe("authoritative feed refresh", () => {
  test("keeps a just-verified card when promotion advances the backend page", () => {
    const verified = feedItem("candidate-1");
    const current: FeedPage = {
      revision: "4",
      items: [verified],
      nextCursor: null,
    };
    const authoritative: FeedPage = {
      revision: "5",
      items: [
        feedItem("candidate-1", {
          verification: "candidate",
          promotion: "committed",
          body: null,
          bodyDigest: null,
          objectDigest: null,
          bodyLength: null,
          createdAt: null,
          originalPostRefBytes: null,
        }),
      ],
      nextCursor: null,
    };

    const merged = mergeFeedPageHydration(current, authoritative);
    expect(merged.revision).toBe("5");
    expect(merged.items[0]?.verification).toBe("verified");
    expect(merged.items[0]?.body).toBe("verified body");
  });

  test("does not preserve hydrated bytes for another event or terminal disposition", () => {
    const current: FeedPage = {
      revision: "4",
      items: [feedItem("candidate-1")],
      nextCursor: null,
    };
    const changedEvent = feedItem("candidate-1", {
      verification: "candidate",
      promotion: "committed",
      body: null,
      opaqueEventBytes: new Uint8Array([9]),
    });
    const invalid = feedItem("candidate-1", {
      verification: "invalid",
      promotion: "pending",
      body: null,
    });

    expect(
      mergeFeedPageHydration(current, {
        revision: "5",
        items: [changedEvent],
        nextCursor: null,
      }).items[0],
    ).toBe(changedEvent);
    expect(
      mergeFeedPageHydration(current, {
        revision: "6",
        items: [invalid],
        nextCursor: null,
      }).items[0],
    ).toBe(invalid);
  });
});

describe("notification continuation", () => {
  test("deduplicates overlap and keeps already hydrated current rows", () => {
    const hydrated = notification("notification-50", "50", "verified");
    const current: NotificationPage = {
      revision: "9",
      items: [hydrated],
      nextCursor: "50",
    };
    const older: NotificationPage = {
      revision: "10",
      items: [
        notification("notification-50", "50", "pending"),
        notification("notification-49", "49", "pending"),
      ],
      nextCursor: "49",
    };

    const result = appendNotificationPage(current, older, "50");
    expect(result.revision).toBe("10");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.verification).toBe("verified");
    expect(result.nextCursor).toBe("49");
  });

  test("ignores an older-page response after its cursor became stale", () => {
    const current: NotificationPage = {
      revision: "11",
      items: [notification("notification-60", "60", "pending")],
      nextCursor: "60",
    };
    const older: NotificationPage = {
      revision: "10",
      items: [notification("notification-49", "49", "pending")],
      nextCursor: null,
    };
    expect(appendNotificationPage(current, older, "50")).toBe(current);
  });

  test("ignores a lower-revision response even when its cursor still matches", () => {
    const current: NotificationPage = {
      revision: "11",
      items: [notification("notification-60", "60", "pending")],
      nextCursor: "50",
    };
    const older: NotificationPage = {
      revision: "10",
      items: [notification("notification-49", "49", "pending")],
      nextCursor: null,
    };
    expect(appendNotificationPage(current, older, "50")).toBe(current);
  });
});

function notification(
  id: string,
  sequence: string,
  verification: NotificationItem["verification"],
): NotificationItem {
  return {
    id,
    localSequence: sequence,
    receivedAt: "2026-07-24T00:00:00.000Z",
    actorNodeId: SHARER.nodeId,
    actorDisplayName: verification === "verified" ? "Sharer" : null,
    actorAvatarUrl: null,
    actorProfileProof: verification === "verified" ? "fresh" : "loading",
    kind: "share",
    verification,
    read: false,
    targetPostId: "11".repeat(32),
    targetBodyHash: "22".repeat(32),
    actionId: "44".repeat(32),
    objectDigest: "55".repeat(32),
    objectLength: 128,
  };
}
