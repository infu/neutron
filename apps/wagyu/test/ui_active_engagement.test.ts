import { expect, test } from "bun:test";
import {
  ACTIVE_ENGAGEMENT_REFRESH_MS,
  activeEngagementKey,
  displayedLikeCount,
  visibleLikeCount,
} from "../src/app/active_engagement.tsx";
import type {
  FeedItem,
  LikesDetail,
} from "../src/app/model.ts";

test("active post engagement refreshes every ten seconds", () => {
  expect(ACTIVE_ENGAGEMENT_REFRESH_MS).toBe(10_000);
});

test("active engagement identity binds the exact verified post", () => {
  const item = post();
  expect(activeEngagementKey(item)).toBe([
    item.author.nodeId,
    item.postId,
    item.bodyDigest,
    item.objectDigest,
    String(item.bodyLength),
  ].join("\u0000"));
});

test("an owner-submitted Like is an immediate count floor", () => {
  const item = post();
  expect(displayedLikeCount(item, 0, 1)).toBe(1);
  expect(displayedLikeCount(item, 1, 1)).toBe(1);
  expect(displayedLikeCount(item, 2, 1)).toBe(2);
});

test("visible Like counts use only verified receipts", () => {
  const item = post();
  const detail: LikesDetail = {
    postId: item.postId,
    packages: [
      {
        id: "batch-1",
        batchNumber: "1",
        state: "verified",
        receipts: [
          receipt("alpha", "verified"),
          receipt("bravo", "verified"),
          receipt("mallory", "invalid"),
        ],
      },
      {
        id: "batch-2",
        batchNumber: "2",
        state: "unavailable",
        receipts: [receipt("charlie", "verified")],
      },
    ],
    awaitingBatch: [],
  };

  expect(visibleLikeCount(detail, item)).toBe(2);
});

test("owner cards add their authenticated unsealed Like count", () => {
  const item: FeedItem = {
    ...post(),
    localOrigin: true,
    localAwaitingLikerIds: ["bravo", "charlie"],
    likeSummary: {
      verified: 0,
      invalid: 0,
      unavailable: 0,
      awaitingBatch: 2,
    },
  };
  const detail: LikesDetail = {
    postId: item.postId,
    packages: [{
      id: "batch-1",
      batchNumber: "1",
      state: "verified",
      receipts: [receipt("alpha", "verified")],
    }],
    awaitingBatch: [],
  };

  expect(visibleLikeCount(detail, item)).toBe(3);
});

function receipt(
  actorNodeId: string,
  state: "verified" | "invalid" | "unavailable",
) {
  return {
    id: actorNodeId,
    actorNodeId,
    actorDisplayName: null,
    state,
  } as const;
}

function post(): FeedItem {
  return {
    id: "post",
    localSequence: "1",
    receivedAt: "2026-07-25T00:00:00.000Z",
    immediateSender: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: {
      nodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      displayName: "Author",
      avatarUrl: null,
      profileProof: "fresh",
    },
    postId: "11".repeat(32),
    body: "Post",
    bodyDigest: "22".repeat(32),
    objectDigest: "33".repeat(32),
    bodyLength: 128,
    createdAt: "2026-07-25T00:00:00.000Z",
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
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  };
}
