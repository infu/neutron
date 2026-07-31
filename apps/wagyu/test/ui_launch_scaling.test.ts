import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FeedView,
  notificationThreadTarget,
} from "../src/app/components/FeedView.tsx";
import { createPreviewWagyuService } from "../src/app/demo_data.ts";
import type { FeedItem, NotificationItem } from "../src/app/model.ts";

test("timeline rendering stays bounded while retaining local older navigation", async () => {
  const snapshot = await createPreviewWagyuService().loadSnapshot();
  const fixture = snapshot.feed.items.find(
    (item) => item.verification === "verified",
  );
  if (!fixture) throw new Error("Preview feed omitted a verified post");
  const items = Array.from({ length: 85 }, (_, index): FeedItem => ({
    ...fixture,
    id: `timeline-${index}`,
    postId: index.toString(16).padStart(64, "0"),
    bodyDigest: (index + 100).toString(16).padStart(64, "0"),
    body: `Mounted timeline post ${index}`,
  }));
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
      page: {
        revision: "1",
        items,
        nextCursor: null,
      },
      verifyingIds: new Set<string>(),
    }),
  );
  expect(html.match(/class="wg-timeline-thread"/gu)?.length).toBe(60);
  expect(html).toContain("Show older posts");
  expect(html).not.toContain("Mounted timeline post 84");
});

test("notification navigation binds the owner, post ID, and body hash", async () => {
  const snapshot = await createPreviewWagyuService().loadSnapshot();
  const authored = snapshot.authored.items.find(
    (item) => item.kind === "post",
  );
  if (!authored || authored.kind !== "post") {
    throw new Error("Preview authored page omitted a post");
  }
  const targetBodyHash = "ab".repeat(32);
  const exactAuthored = {
    ...authored,
    bodyMarkdown: "Exact local target",
    bodyLength: 18,
    localLikeView: {
      postBodyHash: targetBodyHash,
      revision: snapshot.authored.revision,
      unsealedReceiptCount: 0,
      unsealedLikerIds: [],
    },
  };
  const notification: NotificationItem = {
    ...snapshot.notifications.items[0]!,
    kind: "like",
    verification: "verified",
    targetPostId: authored.postId,
    targetBodyHash,
  };
  expect(
    notificationThreadTarget(
      notification,
      [exactAuthored],
      snapshot.profile,
      [],
    )?.postId,
  ).toBe(authored.postId);
  expect(
    notificationThreadTarget(
      { ...notification, targetBodyHash: "cd".repeat(32) },
      [exactAuthored],
      snapshot.profile,
      [],
    ),
  ).toBeNull();

  const foreignCollision: FeedItem = {
    ...snapshot.feed.items[0]!,
    verification: "verified",
    promotion: "committed",
    postId: authored.postId,
    bodyDigest: targetBodyHash,
  };
  expect(
    notificationThreadTarget(
      notification,
      [],
      snapshot.profile,
      [foreignCollision],
    ),
  ).toBeNull();
});

test("launch UI coalesces snapshots and resident wake acknowledges before drain", async () => {
  const [app, adapter, residentService, relationships] = await Promise.all([
    readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/service_adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/service.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../src/app/components/RelationshipsView.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  expect(app).toContain("snapshotLoadPendingRef");
  expect(app).toContain("scrollPositionsRef");
  expect(adapter).toContain("Promise.allSettled");
  expect(adapter).toContain("degradedSlices");
  expect(residentService).toContain("void resident.wake().catch");
  expect(residentService).toContain(
    "return residentSnapshotJson(resident.snapshot())",
  );
  expect(relationships).toContain("IntersectionObserver");
  expect(relationships).toContain('rootMargin: "160px 0px"');
});
