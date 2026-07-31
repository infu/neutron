import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  FeedItem,
  NotificationItem,
  SendQuote,
} from "../src/app/model.ts";
import { PublishProgress } from "../src/app/components/Composer.tsx";
import {
  FeedView,
  verificationIssueCopy,
} from "../src/app/components/FeedView.tsx";
import {
  notificationNeedsAutomaticHydration,
  NotificationsView,
} from "../src/app/components/NotificationsView.tsx";
import {
  feedMayRenderBody,
  formatCyclesAsTc,
  markdownByteLength,
  notificationCopy,
  publishStageIsDurableHandoff,
  publishStageRequiresOpenTile,
  quoteRows,
  safeFeedBody,
  shortenNodeId,
  verificationPresentation,
} from "../src/app/presentation.ts";

describe("publication lifecycle presentation", () => {
  test("treats durable fanout queueing as a safe composer handoff", () => {
    expect(publishStageRequiresOpenTile("awaiting-proof")).toBe(true);
    expect(publishStageRequiresOpenTile("fanout-queued")).toBe(false);
    expect(publishStageIsDurableHandoff("fanout-queued")).toBe(true);
    expect(publishStageIsDurableHandoff("uncertain")).toBe(false);
  });
});

const candidate: FeedItem = {
  id: "candidate",
  localSequence: "1",
  receivedAt: "2026-07-23T00:00:00.000Z",
  immediateSender: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  kind: "original",
  verification: "candidate",
  promotion: "pending",
  author: {
    nodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    displayName: "Untrusted asserted author",
    avatarUrl: "https://attacker.invalid/avatar.png",
    profileProof: "unverified",
  },
  postId: "00".repeat(32),
  body: "<img src=x onerror=alert(1)>hostile bytes",
  bodyDigest: null,
  objectDigest: null,
  bodyLength: null,
  createdAt: null,
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
  opaqueEventBytes: new Uint8Array([1, 2, 3]),
  originalPostRefBytes: null,
};

describe("feed trust presentation", () => {
  test("renders a remote body only in the terminal verified state", () => {
    const nonRenderedStates = [
      "candidate",
      "fetching",
      "http-certified",
      "object-digest-valid",
      "action-body-valid",
      "unavailable",
      "unverified",
      "invalid",
      "unsupported",
    ] as const;
    for (const state of nonRenderedStates) {
      expect(feedMayRenderBody(state)).toBeFalse();
      expect(safeFeedBody({ ...candidate, verification: state })).toBeNull();
    }
    expect(
      safeFeedBody({
        ...candidate,
        verification: "verified",
        promotion: "committed",
      }),
    ).toBe(candidate.body);
    expect(
      safeFeedBody({
        ...candidate,
        verification: "verified",
        promotion: "failed",
      }),
    ).toBeNull();
  });

  test("describes quarantine without echoing remote bytes", () => {
    const invalid = verificationPresentation("invalid");
    expect(invalid.label).toBe("Quarantined");
    expect(invalid.detail).not.toContain(candidate.body!);
    expect(invalid.tone).toBe("danger");
  });

  test("maps verifier failures to bounded user copy while keeping bytes hidden", () => {
    const hiddenCopy = "Wagyu couldn't confirm this post, so it remains hidden.";
    expect(verificationIssueCopy("content-digest-mismatch")).toBe(hiddenCopy);
    expect(verificationIssueCopy("certificate-invalid")).toBe(hiddenCopy);
    expect(verificationIssueCopy("object-digest-mismatch")).toBe(hiddenCopy);
    expect(verificationIssueCopy("fetch-unavailable")).toContain(
      "couldn't be loaded",
    );
    expect(hiddenCopy).not.toContain(candidate.body!);
    expect(hiddenCopy).not.toContain("Content-Digest");
  });
});

describe("notification trust presentation", () => {
  const pending: NotificationItem = {
    id: "n1",
    localSequence: "1",
    receivedAt: "2026-07-23T00:00:00.000Z",
    actorNodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    actorDisplayName: "Forged celebrity name",
    actorAvatarUrl: "https://attacker.invalid/a.png",
    actorProfileProof: "unverified",
    kind: "reply",
    verification: "pending",
    read: false,
    targetPostId: "00".repeat(32),
    targetBodyHash: "11".repeat(32),
    actionId: "22".repeat(32),
    objectDigest: "33".repeat(32),
    objectLength: 128,
  };

  test("pending activity never uses asserted profile or action text", () => {
    const copy = notificationCopy(pending);
    expect(copy).toContain("Unverified activity from");
    expect(copy).not.toContain("Forged celebrity name");
    expect(copy).not.toContain("replied");
  });

  test("verified activity may use a separately certified profile", () => {
    const copy = notificationCopy({
      ...pending,
      actorProfileProof: "fresh",
      verification: "verified",
    });
    expect(copy).toBe("Forged celebrity name replied to your post");
  });

  test("verified post activity links to its post without making retry the link", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationsView, {
        page: {
          revision: "1",
          items: [{
            ...pending,
            kind: "share",
            actorProfileProof: "fresh",
            verification: "verified",
          }],
          nextCursor: null,
        },
        loadingMore: false,
        verifyingIds: new Set<string>(),
        onLoadMore: () => undefined,
        onOpenPost: () => undefined,
        onVerify: () => undefined,
      }),
    );
    expect(html).toContain('role="link"');
    expect(html).toContain(
      "Open post for Forged celebrity name shared your post",
    );
    expect(html).toContain("is-openable");
    expect(html).not.toContain("Load notification");
  });

  test("keeps Follow authentication separate from profile certification", () => {
    const follow: NotificationItem = {
      ...pending,
      kind: "follow",
      verification: "transport-authenticated",
      actorProfileProof: "loading",
      targetPostId: null,
      targetBodyHash: null,
      actionId: null,
      objectDigest: null,
      objectLength: null,
    };
    const html = renderToStaticMarkup(
      createElement(NotificationsView, {
        page: {
          revision: "1",
          items: [follow],
          nextCursor: null,
        },
        loadingMore: false,
        verifyingIds: new Set<string>(),
        onLoadMore: () => undefined,
        onVerify: () => undefined,
      }),
    );
    expect(html).toContain(
      `${shortenNodeId(follow.actorNodeId)} followed you`,
    );
    expect(html).toContain("Load profile");
    expect(html).not.toContain("Caller authenticated");
    expect(html).not.toContain("certified profile");
    expect(html).not.toContain("Forged celebrity name");
    expect(html).not.toContain("attacker.invalid");
    expect(notificationNeedsAutomaticHydration(follow)).toBeTrue();
    expect(
      notificationNeedsAutomaticHydration({
        ...follow,
        actorProfileProof: "fresh",
      }),
    ).toBeFalse();
  });

  test("keeps verified notification evidence under the hood without a dead profile retry", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationsView, {
        page: {
          revision: "1",
          items: [{
            ...pending,
            verification: "verified",
            actorProfileProof: "unavailable",
          }],
          nextCursor: null,
        },
        loadingMore: false,
        verifyingIds: new Set<string>(),
        onLoadMore: () => undefined,
        onVerify: () => undefined,
      }),
    );
    expect(html).toContain(
      `${shortenNodeId(pending.actorNodeId)} replied to your post`,
    );
    expect(html).not.toContain('aria-label="Load user profile"');
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain("Target body hash");
    expect(html).not.toContain("Action object digest");
    expect(html).not.toContain("11".repeat(32));
    expect(html).not.toContain("33".repeat(32));
  });
});

describe("internal composer accounting", () => {
  const quote: SendQuote = {
    followerRevision: "9",
    registeredFollowers: 11,
    eligibleRecipients: 8,
    ineligibleFollowers: 3,
    recipientPreview: [],
    receiverFloorCycles: 1_600_000_000n,
    authorNoticeFloorCycles: 100_000_000n,
    callAndByteCycles: 50_000_000n,
    localPublicationCycles: 25_000_000n,
    totalCycles: 1_775_000_000n,
    limitWarning: null,
  };

  test("shows registered, eligible, floors, overhead, and total separately", () => {
    const rows = quoteRows(quote);
    expect(rows.map(({ label }) => label)).toEqual([
      "Follower Neutrons",
      "Eligible recipients",
      "Receiver floors",
      "Remote author-notice floor",
      "Publication / calls",
      "Estimated total",
    ]);
    expect(rows[3]).toEqual({
      label: "Remote author-notice floor",
      value: "0.000100 TC",
    });
    expect(rows[4]).toEqual({
      label: "Publication / calls",
      value: "0.000075 TC",
    });
    expect(rows.at(-1)).toEqual({
      label: "Estimated total",
      value: "0.001775 TC",
      emphasis: true,
    });
  });

  test("formats cycle estimates and counts UTF-8 bytes exactly", () => {
    expect(formatCyclesAsTc(200_000_000n)).toBe("0.000200");
    expect(markdownByteLength("wagyu 🐂")).toBe(10);
  });

  test("recipient previews cannot change authoritative quote totals", () => {
    expect(
      quoteRows({
        ...quote,
        recipientPreview: ["rrkah-fqaaa-aaaaa-aaaaq-cai"],
      }),
    ).toEqual(quoteRows(quote));
  });

  test("shows ordinary send status without claiming remote acceptance", () => {
    const base = {
      stage: "complete" as const,
      postId: "post",
      queuedRecipients: 3,
      acceptedRecipients: 2,
      failedRecipients: 1,
      message: "Reply certified.",
    };
    const queued = renderToStaticMarkup(
      createElement(PublishProgress, {
        authorNoticeExpected: true,
        error: null,
        result: { ...base, queuedNotices: 1 },
        stage: "complete",
      }),
    );
    expect(queued).toContain("Sent");
    expect(queued).toContain("Some people may see it a little later.");
    expect(queued).not.toContain("accepted");
    expect(queued).not.toContain("remote author notice");
    const missing = renderToStaticMarkup(
      createElement(PublishProgress, {
        authorNoticeExpected: true,
        error: null,
        result: { ...base, queuedNotices: 0 },
        stage: "complete",
      }),
    );
    expect(missing).toContain("Sent");
    expect(missing).toContain("Some people may see it a little later.");
    expect(missing).not.toContain("accepted");
    expect(missing).not.toContain("remote author notice");
  });
});

test("a verified feed post uses the social card while evidence stays under the hood", () => {
  const html = renderToStaticMarkup(
    createElement(FeedView, {
      page: {
        revision: "1",
        items: [{
          ...candidate,
          verification: "verified",
          promotion: "committed",
          author: {
            ...candidate.author,
            profileProof: "fresh",
          },
          bodyDigest: "11".repeat(32),
          objectDigest: "22".repeat(32),
        }],
        nextCursor: null,
      },
      loadingMore: false,
      verifyingIds: new Set<string>(),
      likingIds: new Set<string>(),
      actionStages: new Map(),
      onVerify: () => undefined,
      onLike: () => undefined,
      onOpenLikes: () => undefined,
      onReply: () => undefined,
      onShare: () => undefined,
      onLoadMore: () => undefined,
    }),
  );
  expect(html).toContain('aria-label="Post by Untrusted asserted author"');
  expect(html).toContain('class="wg-feed-card"');
  expect(html).toContain("hostile bytes");
  expect(html).toContain(
    'aria-label="Like post 0000000000…00000000 by Untrusted asserted author"',
  );
  expect(html).not.toContain("Body hash");
  expect(html).not.toContain("Object digest");
  expect(html).not.toContain("11".repeat(32));
  expect(html).not.toContain("22".repeat(32));
});

test("outbound feed actions stay locked if install permission is missing", () => {
  const feed = renderToStaticMarkup(
    createElement(FeedView, {
      page: {
        revision: "1",
        items: [{
          ...candidate,
          verification: "verified",
          promotion: "committed",
          author: {
            ...candidate.author,
            profileProof: "fresh",
          },
          originalPostRefBytes: new Uint8Array([1]),
        }],
        nextCursor: null,
      },
      loadingMore: false,
      verifyingIds: new Set<string>(),
      likingIds: new Set<string>(),
      actionStages: new Map(),
      peerDeliveryEnabled: false,
      onVerify: () => undefined,
      onLike: () => undefined,
      onOpenLikes: () => undefined,
      onReply: () => undefined,
      onShare: () => undefined,
      onLoadMore: () => undefined,
    }),
  );
  expect(
    feed.split(
      "Enable peer delivery before interacting with other users.",
    ).length - 1,
  ).toBeGreaterThanOrEqual(3);
  expect(feed).toContain(
    'aria-label="Like post 0000000000…00000000 by Untrusted asserted author"',
  );
  expect(feed).toContain(
    'aria-label="Reply to post 0000000000…00000000 by Untrusted asserted author"',
  );
  expect(feed).toContain(
    'aria-label="Share post 0000000000…00000000 by Untrusted asserted author"',
  );
});

test("a pending feed post uses a post-shaped skeleton without unsafe bytes", () => {
  const html = renderToStaticMarkup(
    createElement(FeedView, {
      page: {
        revision: "1",
        items: [candidate],
        nextCursor: null,
      },
      loadingMore: false,
      verifyingIds: new Set(["candidate"]),
      likingIds: new Set<string>(),
      actionStages: new Map(),
      onVerify: () => undefined,
      onLike: () => undefined,
      onOpenLikes: () => undefined,
      onReply: () => undefined,
      onShare: () => undefined,
      onLoadMore: () => undefined,
    }),
  );
  expect(html).toContain("wg-post-skeleton");
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("Loading post");
  expect(html).not.toContain(candidate.body!);
  expect(html).not.toContain(candidate.author.displayName!);
});

test("user IDs shorten visually without replacing identity", () => {
  const node = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const short = shortenNodeId(node);
  expect(short).toStartWith(node.slice(0, 8));
  expect(short).toEndWith(node.slice(-5));
  expect(short).not.toBe(node);
});
