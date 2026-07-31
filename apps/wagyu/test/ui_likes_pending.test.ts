import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LikesDrawer } from "../src/app/components/LikesDrawer.tsx";
import { withLocalAwaitingLikes } from "../src/app/likes_state.ts";
import type {
  FeedItem,
  LikesDetail,
  NotificationItem,
} from "../src/app/model.ts";

const EMPTY_DETAIL: LikesDetail = {
  postId: "11".repeat(32),
  packages: [],
  awaitingBatch: [],
  acceptingLikes: true,
  truncated: false,
  loadOlder: null,
};

function feedItem(
  localOrigin: boolean,
  awaitingBatch: number,
): FeedItem {
  return {
    id: "post",
    localSequence: "1",
    receivedAt: "2026-07-24T00:00:00.000Z",
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
    postId: EMPTY_DETAIL.postId,
    body: "A post with recent likes.",
    bodyDigest: "22".repeat(32),
    objectDigest: "33".repeat(32),
    bodyLength: 25,
    createdAt: "2026-07-24T00:00:00.000Z",
    sharedBy: null,
    replyTo: null,
    likedByOwner: false,
    likeSummary: {
      verified: 0,
      invalid: 0,
      unavailable: 0,
      awaitingBatch,
    },
    localOrigin,
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  };
}

function renderDrawer(
  item: FeedItem,
  awaitingBatch: LikesDetail["awaitingBatch"] = [],
): string {
  return renderToStaticMarkup(
    createElement(LikesDrawer, {
      continuing: false,
      continuationError: null,
      detail: { ...EMPTY_DETAIL, awaitingBatch },
      error: null,
      item,
      loading: false,
      onClose: () => undefined,
      onLoadOlder: () => undefined,
      onOpenUser: () => undefined,
    }),
  );
}

describe("recent owner-local Like presentation", () => {
  test("shows a known recent local liker immediately", () => {
    const html = renderDrawer(feedItem(true, 1), [{
      id: "notification-1",
      actorNodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      actorDisplayName: "Mina Seo",
      state: "awaiting-batch",
    }]);

    expect(html).toContain('aria-label="Likes"');
    expect(html).toContain("1 verified like shown");
    expect(html).toContain("Mina Seo");
    expect(html).toContain("rrkah-fqaaa-aaaaa-aaaaq-cai");
    expect(html).not.toContain("still being processed");
    expect(html).not.toContain("No likes yet");
    expect(html).toContain('aria-label="People who liked this post"');
  });

  test("does not promise an unavailable local identity is being processed", () => {
    const html = renderDrawer(feedItem(true, 2));

    expect(html).toContain("2 more likes couldn&#x27;t be loaded");
    expect(html).not.toContain("still being processed");
    expect(html).not.toContain("No likes yet");
  });

  test("does not treat a remote card's summary hint as owner-local evidence", () => {
    const html = renderDrawer(feedItem(false, 2));

    expect(html).toContain("No likes yet");
    expect(html).not.toContain("couldn&#x27;t be loaded");
    expect(html).not.toContain('aria-label="People who liked this post"');
  });

  test("does not turn an unavailable package into a verified count or zero", () => {
    const html = renderToStaticMarkup(
      createElement(LikesDrawer, {
        continuing: false,
        continuationError: null,
        detail: {
          ...EMPTY_DETAIL,
          packages: [{
            id: "44".repeat(32),
            batchNumber: "0",
            state: "unavailable",
            receipts: [],
          }],
        },
        error: null,
        item: feedItem(false, 0),
        loading: false,
        onClose: () => undefined,
        onLoadOlder: () => undefined,
        onOpenUser: () => undefined,
      }),
    );

    expect(html).toContain("0 verified likes shown");
    expect(html).toContain(
      "Some likes couldn&#x27;t be verified and aren&#x27;t included.",
    );
    expect(html).not.toContain("No likes yet");
  });
});

describe("recent owner-local Like identity", () => {
  const likeNotification: NotificationItem = {
    id: "notification-8",
    localSequence: "8",
    receivedAt: "2026-07-24T00:00:01.000Z",
    actorNodeId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    actorDisplayName: "Mina Seo",
    actorAvatarUrl: null,
    actorProfileProof: "fresh",
    kind: "like",
    verification: "verified",
    read: false,
    targetPostId: EMPTY_DETAIL.postId,
    targetBodyHash: "22".repeat(32),
    actionId: "44".repeat(32),
    objectDigest: "55".repeat(32),
    objectLength: 100,
  };

  test("joins an authenticated local notification to its authored post", () => {
    const detail = withLocalAwaitingLikes(
      EMPTY_DETAIL,
      feedItem(true, 1),
      [likeNotification],
    );

    expect(detail.awaitingBatch).toEqual([{
      id: likeNotification.id,
      actorNodeId: likeNotification.actorNodeId,
      actorDisplayName: "Mina Seo",
      state: "awaiting-batch",
    }]);
  });

  test("never exposes the owner's notification state on a remote card", () => {
    const detail = withLocalAwaitingLikes(
      EMPTY_DETAIL,
      feedItem(false, 1),
      [likeNotification],
    );

    expect(detail.awaitingBatch).toEqual([]);
  });

  test("uses durable owner-local liker IDs after notifications are paged away", () => {
    const detail = withLocalAwaitingLikes(
      EMPTY_DETAIL,
      feedItem(true, 2),
      [],
      [
        "ryjl3-tyaaa-aaaaa-aaaba-cai",
        "y2dvw-l7777-77774-aaabq-cai",
      ],
    );

    expect(detail.awaitingBatch.map((receipt) => receipt.actorNodeId)).toEqual([
      "ryjl3-tyaaa-aaaaa-aaaba-cai",
      "y2dvw-l7777-77774-aaabq-cai",
    ]);
  });
});
