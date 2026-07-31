import { describe, expect, test } from "bun:test";
import {
  verifyLikesWithWorker,
} from "../src/app/certified_runtime.ts";
import { appendLikesPage } from "../src/app/likes_state.ts";
import type {
  FeedItem,
  LikePackage,
  LikesDetail,
} from "../src/app/model.ts";
import type {
  WagyuResidentVerificationClientV1,
} from "../src/worker/resident_client.ts";
import type {
  VerifiedLikesValueV1,
  VerifyLikesTaskV1,
} from "../src/worker/types.ts";

const POST_ID = "11".repeat(32);
const BODY_HASH = "22".repeat(32);
const AUTHOR = "rrkah-fqaaa-aaaaa-aaaaq-cai";

describe("Like drawer continuation", () => {
  test("keeps the opaque token in the runtime and forwards it to the Worker", async () => {
    const calls: Array<Omit<VerifyLikesTaskV1, "kind">> = [];
    const worker: Pick<WagyuResidentVerificationClientV1, "verifyLikes"> = {
      async verifyLikes(task) {
        calls.push(task);
        return {
          state: "verified",
          value: likesValue(
            task.continuation === undefined ? "a".repeat(64) : null,
            task.continuation === undefined ? "20" : "0",
            task.continuation === undefined
              ? "verified-cache"
              : "verified-now",
          ),
        };
      },
    };

    const first = await verifyLikesWithWorker(worker, feedItem());
    expect(first.loadOlder).toBeFunction();
    expect(first.packages[0]?.cache).toBe("verified-cache");
    expect(calls[0]?.continuation).toBeUndefined();

    const older = await first.loadOlder!();
    expect(calls[1]?.continuation).toBe("a".repeat(64));
    expect(older.loadOlder).toBeNull();
    expect(older.packages[0]?.batchNumber).toBe("0");
  });

  test("appends older packages and preserves an already verified cached result", () => {
    const currentPackage = likePackage(
      "newest",
      "20",
      "verified",
      "verified-cache",
    );
    const nextPage = async (): Promise<LikesDetail> => detail([]);
    const current = detail([currentPackage], async () => detail([]));
    const older = detail(
      [
        likePackage("newest", "20", "unavailable", "verified-now"),
        likePackage("oldest", "19", "verified", "verified-now"),
      ],
      nextPage,
    );

    const merged = appendLikesPage(current, older);
    expect(merged.packages).toHaveLength(2);
    expect(merged.packages[0]).toBe(currentPackage);
    expect(merged.packages[1]?.id).toBe("oldest");
    expect(merged.loadOlder).toBe(nextPage);
    expect(current.packages).toHaveLength(1);
  });

  test("replaces an unavailable boundary package after a successful retry", () => {
    const unavailable = likePackage(
      "retry-boundary",
      "7",
      "unavailable",
      "verified-now",
    );
    const verified = likePackage(
      "retry-boundary",
      "7",
      "verified",
      "verified-cache",
    );

    const merged = appendLikesPage(
      detail([unavailable], async () => detail([])),
      detail([verified]),
    );
    expect(merged.packages).toEqual([verified]);
    expect(merged.loadOlder).toBeNull();
    expect(merged.truncated).toBeFalse();
  });

  test("rejects a continuation that changes post or batch identity", () => {
    expect(() =>
      appendLikesPage(
        detail([likePackage("one", "4", "verified")]),
        { ...detail([]), postId: "33".repeat(32) },
      )
    ).toThrow("another post");
    expect(() =>
      appendLikesPage(
        detail([likePackage("one", "4", "verified")]),
        detail([likePackage("two", "4", "verified")]),
      )
    ).toThrow("changed a batch digest");
  });
});

function feedItem(): FeedItem {
  return {
    id: "feed-1",
    localSequence: "1",
    receivedAt: "2026-07-24T00:00:00.000Z",
    immediateSender: AUTHOR,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: {
      nodeId: AUTHOR,
      displayName: "Author",
      avatarUrl: null,
      profileProof: "fresh",
    },
    postId: POST_ID,
    body: "Verified post",
    bodyDigest: BODY_HASH,
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
  };
}

function likesValue(
  continuation: string | null,
  batchNumber: string,
  cache: "verified-now" | "verified-cache",
): VerifiedLikesValueV1 {
  return {
    postAuthor: AUTHOR,
    postId: POST_ID,
    postBodyHash: BODY_HASH,
    head: {
      storeGeneration: "1",
      revision: "2",
      bodyDigest: "44".repeat(32),
      acceptingLikes: true,
      sealedBatchCount: "21",
    },
    packages: [
      {
        batchDigest: batchNumber.padStart(64, "0"),
        batchNumber,
        state: "verified",
        code: null,
        receipts: [],
        cache,
      },
    ],
    verifiedIncluded: 0,
    invalid: 0,
    unavailable: 0,
    truncated: continuation !== null,
    continuation,
  };
}

function detail(
  packages: LikePackage[],
  loadOlder: LikesDetail["loadOlder"] = null,
): LikesDetail {
  return {
    postId: POST_ID,
    packages,
    awaitingBatch: [],
    truncated: loadOlder !== null,
    acceptingLikes: true,
    loadOlder,
  };
}

function likePackage(
  id: string,
  batchNumber: string,
  state: LikePackage["state"],
  cache?: LikePackage["cache"],
): LikePackage {
  return {
    id,
    batchNumber,
    state,
    receipts: [],
    ...(cache === undefined ? {} : { cache }),
  };
}
