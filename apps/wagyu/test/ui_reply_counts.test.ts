import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isMissingCertifiedReplyIndexError,
  MissingCertifiedReplyIndexError,
  verifyThreadReplyCountWithWorker,
} from "../src/app/certified_runtime.ts";
import { FeedView } from "../src/app/components/FeedView.tsx";
import type { FeedItem } from "../src/app/model.ts";
import type {
  WagyuResidentVerificationClientV1,
} from "../src/worker/resident_client.ts";

test("the card count requests only the certified reply-index summary", async () => {
  const item = verifiedPost();
  const calls: unknown[] = [];
  const worker: Pick<WagyuResidentVerificationClientV1, "verifyThread"> = {
    async verifyThread(task) {
      calls.push(task);
      return {
        state: "verified",
        value: {
          postAuthor: item.author.nodeId,
          postId: item.postId,
          postBodyHash: item.bodyDigest!,
          replyCount: 7,
          index: {
            storeGeneration: "1",
            revision: "3",
            bodyDigest: "55".repeat(32),
          },
          replies: [],
        },
      };
    },
  };

  expect(await verifyThreadReplyCountWithWorker(worker, item)).toBe(7);
  expect(calls).toEqual([{
    postAuthor: item.author.nodeId,
    postId: new Uint8Array(32).fill(0x11),
    postBodyHash: new Uint8Array(32).fill(0x22),
    postObjectDigest: new Uint8Array(32).fill(0x33),
    postBodyLength: 128,
    summaryOnly: true,
  }]);
});

test("a missing legacy reply index remains unknown without becoming verified zero", async () => {
  const item = verifiedPost();
  const worker: Pick<WagyuResidentVerificationClientV1, "verifyThread"> = {
    async verifyThread() {
      return {
        state: "unavailable",
        code: "http_404",
        reason: "The exact Wagyu object was not available",
      };
    },
  };

  try {
    await verifyThreadReplyCountWithWorker(worker, item);
    throw new Error("expected the missing reply index to remain unavailable");
  } catch (reason) {
    expect(reason).toBeInstanceOf(MissingCertifiedReplyIndexError);
    expect(isMissingCertifiedReplyIndexError(reason)).toBe(true);
  }
});

test("a card shows the author-index count without locally received replies", () => {
  const item = { ...verifiedPost(), verifiedReplyCount: 7 };
  const html = renderToStaticMarkup(
    createElement(FeedView, {
      actionStages: new Map(),
      likingIds: new Set<string>(),
      loadingMore: false,
      onLike: () => undefined,
      onLoadMore: () => undefined,
      onOpenLikes: () => undefined,
      onReply: () => undefined,
      onShare: () => undefined,
      onVerify: () => undefined,
      page: { revision: "1", items: [item], nextCursor: null },
      replies: [],
      verifyingIds: new Set<string>(),
    }),
  );

  expect(html).toContain("; 7 replies");
  expect(html).toContain(">7</button>");
});

test("a card hides an unknown reply count without hiding the reply action", () => {
  const item = verifiedPost();
  const html = renderFeed(item);

  expect(html).toContain(
    "aria-label=\"Reply to post 1111111111…11111111 by Author\"",
  );
  expect(html).not.toContain("; 0 replies");
});

test("a certified zero reply count remains visible", () => {
  const html = renderFeed({ ...verifiedPost(), verifiedReplyCount: 0 });

  expect(html).toContain("; 0 replies");
});

function renderFeed(item: FeedItem): string {
  return renderToStaticMarkup(
    createElement(FeedView, {
      actionStages: new Map(),
      likingIds: new Set<string>(),
      loadingMore: false,
      onLike: () => undefined,
      onLoadMore: () => undefined,
      onOpenLikes: () => undefined,
      onReply: () => undefined,
      onShare: () => undefined,
      onVerify: () => undefined,
      page: { revision: "1", items: [item], nextCursor: null },
      replies: [],
      verifyingIds: new Set<string>(),
    }),
  );
}

function verifiedPost(): FeedItem {
  return {
    id: "post-1",
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
