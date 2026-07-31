import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  ExactBlockStatusResolver,
  filterFeedItemsByExactBlockStatus,
  filterLikesByExactBlockStatus,
  type BlockStatusBatch,
  type ExactBlockStatusLookup,
} from "../src/app/service_adapter.ts";
import type {
  FeedItem,
  LikesDetail,
} from "../src/app/model.ts";
import {
  GOLDEN_ACTOR_A,
  GOLDEN_ACTOR_B,
} from "../candid/fixtures/v1-values.ts";

const A = GOLDEN_ACTOR_A.toText();
const B = GOLDEN_ACTOR_B.toText();

describe("exact Block status resolution", () => {
  test("deduplicates overlap and only persists fail-closed Block answers", async () => {
    const calls: string[][] = [];
    let revision = "5";
    const resolver = new ExactBlockStatusResolver(async (nodes) => {
      calls.push([...nodes]);
      await Promise.resolve();
      return batch(revision, nodes, new Set([B]));
    });
    resolver.observeRevision("5");

    const [first, overlapping] = await Promise.all([
      resolver.resolve([A, B, A]),
      resolver.resolve([B]),
    ]);
    expect(calls).toEqual([[A, B]]);
    expect(first.get(A)).toBe(false);
    expect(first.get(B)).toBe(true);
    expect(overlapping.get(B)).toBe(true);

    await resolver.resolve([B, A]);
    expect(calls).toEqual([[A, B], [A]]);
    revision = "6";
    resolver.observeRevision("6");
    await resolver.resolve([A]);
    expect(calls).toEqual([[A, B], [A], [A]]);
  });

  test("fails closed on unavailable, stale, and reordered answers", async () => {
    const unavailable = new ExactBlockStatusResolver(async () => {
      throw new Error("local query unavailable");
    });
    await expect(unavailable.resolve([A])).rejects.toThrow("unavailable");

    const stale = new ExactBlockStatusResolver(async (nodes) =>
      batch("8", nodes, new Set())
    );
    stale.observeRevision("9");
    await expect(stale.resolve([A])).rejects.toThrow("stale");

    const reordered = new ExactBlockStatusResolver(async () => ({
      relationshipRevision: "1",
      items: [
        { nodeId: B, blocked: false },
        { nodeId: A, blocked: false },
      ],
    }));
    await expect(reordered.resolve([A, B])).rejects.toThrow("reordered");
  });
});

describe("Worker-hydrated identity suppression", () => {
  test("checks and suppresses a blocked peer beyond a 50-row relationship page", async () => {
    const nodes = Array.from({ length: 51 }, (_, index) =>
      Principal.fromUint8Array(
        Uint8Array.of(index + 1, 0x01),
      ).toText()
    );
    const blocked = nodes.at(-1)!;
    const calls: string[][] = [];
    const resolver = new ExactBlockStatusResolver(async (requested) => {
      calls.push([...requested]);
      return batch("4", requested, new Set([blocked]));
    });
    resolver.observeRevision("4");
    const items = nodes.map((nodeId, index) =>
      feedItem(`reply-${index}`, nodeId, nodeId, null)
    );

    const visible = await filterFeedItemsByExactBlockStatus(
      items,
      resolver,
    );

    expect(calls).toEqual([nodes]);
    expect(visible).toHaveLength(50);
    expect(visible.some((item) => item.author.nodeId === blocked)).toBe(false);
  });

  test("drops replies when any newly hydrated identity is blocked or unresolved", async () => {
    const visible = feedItem("visible", A, A, null);
    const blockedAuthor = feedItem("author", B, B, null);
    const blockedSender = feedItem("sender", A, B, null);
    const blockedParent = feedItem("parent", A, A, B);
    const lookup = fixedLookup(new Map([
      [A, false],
      [B, true],
    ]));

    await expect(
      filterFeedItemsByExactBlockStatus(
        [visible, blockedAuthor, blockedSender, blockedParent],
        lookup,
      ),
    ).resolves.toEqual([visible]);

    await expect(
      filterFeedItemsByExactBlockStatus(
        [visible],
        fixedLookup(new Map()),
      ),
    ).resolves.toEqual([]);
    await expect(
      filterFeedItemsByExactBlockStatus(
        [visible],
        {
          async resolve() {
            throw new Error("exact Block status unavailable");
          },
        },
      ),
    ).rejects.toThrow("unavailable");
  });

  test("filters Like actors and recursively protects continuation pages", async () => {
    const older: LikesDetail = likesDetail("older", [
      receipt("older-visible", A),
      receipt("older-blocked", B),
    ]);
    const detail: LikesDetail = {
      ...likesDetail("first", [
        receipt("visible", A),
        receipt("blocked", B),
      ]),
      awaitingBatch: [receipt("awaiting-blocked", B)],
      loadOlder: async () => older,
    };
    const filtered = await filterLikesByExactBlockStatus(
      detail,
      fixedLookup(new Map([
        [A, false],
        [B, true],
      ])),
    );
    expect(filtered.packages[0]!.receipts.map((value) => value.id)).toEqual([
      "visible",
    ]);
    expect(filtered.awaitingBatch).toEqual([]);
    const filteredOlder = await filtered.loadOlder!();
    expect(
      filteredOlder.packages[0]!.receipts.map((value) => value.id),
    ).toEqual(["older-visible"]);
  });
});

function batch(
  relationshipRevision: string,
  nodes: readonly string[],
  blocked: ReadonlySet<string>,
): BlockStatusBatch {
  return {
    relationshipRevision,
    items: nodes.map((nodeId) => ({
      nodeId,
      blocked: blocked.has(nodeId),
    })),
  };
}

function fixedLookup(
  statuses: ReadonlyMap<string, boolean>,
): ExactBlockStatusLookup {
  return {
    async resolve() {
      return statuses;
    },
  };
}

function feedItem(
  id: string,
  author: string,
  immediateSender: string,
  replyAuthor: string | null,
): FeedItem {
  return {
    id,
    localSequence: "1",
    receivedAt: new Date(0).toISOString(),
    immediateSender,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: {
      nodeId: author,
      displayName: null,
      avatarUrl: null,
      profileProof: "fresh",
    },
    postId: "00".repeat(32),
    body: "verified",
    bodyDigest: "01".repeat(32),
    objectDigest: "02".repeat(32),
    bodyLength: 8,
    createdAt: new Date(0).toISOString(),
    sharedBy: null,
    replyTo: replyAuthor
      ? {
          authorNodeId: replyAuthor,
          author: null,
          postId: "03".repeat(32),
          body: null,
          verified: true,
        }
      : null,
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

function receipt(id: string, actorNodeId: string) {
  return {
    id,
    actorNodeId,
    actorDisplayName: null,
    state: "verified" as const,
  };
}

function likesDetail(id: string, receipts: ReturnType<typeof receipt>[]): LikesDetail {
  return {
    postId: id,
    packages: [{
      id: `${id}-package`,
      batchNumber: "1",
      state: "verified",
      receipts,
    }],
    awaitingBatch: [],
    loadOlder: null,
  };
}
