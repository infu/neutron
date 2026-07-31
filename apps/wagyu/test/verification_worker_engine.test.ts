import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  bytes32,
  lowerHex,
  type CertifiedLikeReceiptV1,
  type LikeBatchV1,
  type LikeHeadV1,
  type ProfileV1,
} from "../src/protocol/index.ts";
import {
  type FetchAndVerifyRequestV1,
  type VerificationResultV1,
  type VerifyPortableRequestV1,
  type WagyuVerifierV1,
} from "../src/verifier/index.ts";
import {
  WAGYU_LIKE_CHAIN_LIMIT,
  WAGYU_LIKE_RECEIPT_CONCURRENCY,
  WagyuVerificationEngineV1,
  createMemoryVerificationStore,
  likeHeadHighWaterKey,
  profileHighWaterKey,
  type VerifiedLikesValueV1,
} from "../src/worker/index.ts";

const NETWORK = bytes32(new Uint8Array(32).fill(0x5a));
const POST_ID = bytes32(new Uint8Array(32).fill(0x31));
const BODY_HASH = bytes32(new Uint8Array(32).fill(0x42));
const AUTHOR = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const NOW_NS = 1_800_000_000_000_000_000n;

describe("Wagyu Like Worker verification", () => {
  test("verifies 150 receipts at concurrency 12 and never trusts a derived cache", async () => {
    const fixture = likeVerifierFixture({
      batchCount: 1,
      receiptsPerBatch: 150,
      duplicateLastLiker: true,
    });
    const storage = createMemoryVerificationStore();
    const engine = new WagyuVerificationEngineV1({
      verifier: fixture.verifier,
      storage,
      nowNs: () => NOW_NS,
    });
    const task = {
      kind: "likes" as const,
      postAuthor: AUTHOR.toText(),
      postId: POST_ID,
      postBodyHash: BODY_HASH,
    };

    const first = await engine.execute(
      task,
      new AbortController().signal,
    );
    expect(first.state).toBe("verified");
    if (first.state !== "verified") return;
    const detail = first.value as Awaited<
      ReturnType<typeof verifiedLikesValue>
    >;
    expect(fixture.maximumPortableConcurrency()).toBe(
      WAGYU_LIKE_RECEIPT_CONCURRENCY,
    );
    expect(detail.verifiedIncluded).toBe(149);
    expect(detail.invalid).toBe(1);
    expect(detail.unavailable).toBe(0);
    expect(detail.packages).toHaveLength(1);
    expect(detail.packages[0]!.receipts[149]).toMatchObject({
      state: "invalid",
      code: "duplicate_liker",
      actorNodeId: detail.packages[0]!.receipts[0]!.actorNodeId,
    });
    expect(fixture.batchFetches()).toBe(1);
    expect(fixture.portableVerifications()).toBe(150);

    const second = await engine.execute(
      task,
      new AbortController().signal,
    );
    expect(second.state).toBe("verified");
    if (second.state !== "verified") return;
    const cached = second.value as typeof detail;
    expect(cached.verifiedIncluded).toBe(149);
    expect(cached.invalid).toBe(1);
    expect(cached.packages[0]!.cache).toBe("verified-now");
    expect(fixture.batchFetches()).toBe(2);
    expect(fixture.portableVerifications()).toBe(300);
    expect(fixture.headHighWaterDecisions()).toEqual([
      "advance",
      "replay",
    ]);
  });

  test("continues a V101 open-partial chain in bounded two-package pages", async () => {
    const fixture = likeVerifierFixture({
      batchCount: WAGYU_LIKE_CHAIN_LIMIT + 1,
      receiptsPerBatch: 1,
      duplicateLastLiker: false,
    });
    const engine = new WagyuVerificationEngineV1({
      verifier: fixture.verifier,
      storage: createMemoryVerificationStore(),
      nowNs: () => NOW_NS,
    });

    const result = await engine.execute(
      {
        kind: "likes",
        postAuthor: AUTHOR.toText(),
        postId: POST_ID,
        postBodyHash: BODY_HASH,
      },
      new AbortController().signal,
    );

    expect(result.state).toBe("verified");
    if (result.state !== "verified") return;
    expect(result.value).toMatchObject({
      head: { acceptingLikes: true },
    });
    const detail = result.value as Awaited<
      ReturnType<typeof verifiedLikesValue>
    >;
    expect(detail.packages).toHaveLength(WAGYU_LIKE_CHAIN_LIMIT);
    expect(detail.truncated).toBeTrue();
    expect(detail.continuation).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.batchFetches()).toBe(WAGYU_LIKE_CHAIN_LIMIT);
    expect(fixture.portableVerifications()).toBe(WAGYU_LIKE_CHAIN_LIMIT);

    const continuation = await engine.execute(
      {
        kind: "likes",
        postAuthor: AUTHOR.toText(),
        postId: POST_ID,
        postBodyHash: BODY_HASH,
        continuation: detail.continuation!,
      },
      new AbortController().signal,
    );
    expect(continuation.state).toBe("verified");
    if (continuation.state !== "verified") return;
    const remainder = continuation.value as typeof detail;
    expect(remainder.packages).toHaveLength(1);
    expect(remainder.packages[0]!.batchNumber).toBe("0");
    expect(remainder.truncated).toBeFalse();
    expect(remainder.continuation).toBeNull();
    expect(fixture.batchFetches()).toBe(WAGYU_LIKE_CHAIN_LIMIT + 1);
    expect(fixture.portableVerifications()).toBe(
      WAGYU_LIKE_CHAIN_LIMIT + 1,
    );

    const replay = await engine.execute(
      {
        kind: "likes",
        postAuthor: AUTHOR.toText(),
        postId: POST_ID,
        postBodyHash: BODY_HASH,
        continuation: detail.continuation!,
      },
      new AbortController().signal,
    );
    expect(replay).toEqual(continuation);
    expect(fixture.batchFetches()).toBe(WAGYU_LIKE_CHAIN_LIMIT + 1);
  });

  test("carries duplicate detection across an opaque continuation", async () => {
    const fixture = likeVerifierFixture({
      batchCount: WAGYU_LIKE_CHAIN_LIMIT + 1,
      receiptsPerBatch: 1,
      duplicateLastLiker: false,
      duplicateGenesisFromLatest: true,
    });
    const engine = new WagyuVerificationEngineV1({
      verifier: fixture.verifier,
      storage: createMemoryVerificationStore(),
      nowNs: () => NOW_NS,
    });
    const task = {
      kind: "likes" as const,
      postAuthor: AUTHOR.toText(),
      postId: POST_ID,
      postBodyHash: BODY_HASH,
    };
    const first = await engine.execute(
      task,
      new AbortController().signal,
    );
    expect(first.state).toBe("verified");
    if (first.state !== "verified") return;
    const firstPage = first.value as Awaited<
      ReturnType<typeof verifiedLikesValue>
    >;
    expect(firstPage.continuation).not.toBeNull();

    const second = await engine.execute(
      {
        ...task,
        continuation: firstPage.continuation!,
      },
      new AbortController().signal,
    );
    expect(second.state).toBe("verified");
    if (second.state !== "verified") return;
    const secondPage = second.value as typeof firstPage;
    expect(secondPage.packages[0]!.receipts[0]).toMatchObject({
      state: "invalid",
      code: "duplicate_liker",
    });
    expect(secondPage.verifiedIncluded).toBe(0);
    expect(secondPage.invalid).toBe(1);
  });

  test("never releases a head-declared total when a package is unavailable", async () => {
    const fixture = likeVerifierFixture({
      batchCount: 1,
      receiptsPerBatch: 7,
      duplicateLastLiker: false,
      unavailableBatchNumber: 0,
    });
    const engine = new WagyuVerificationEngineV1({
      verifier: fixture.verifier,
      storage: createMemoryVerificationStore(),
      nowNs: () => NOW_NS,
    });

    const result = await engine.execute(
      {
        kind: "likes",
        postAuthor: AUTHOR.toText(),
        postId: POST_ID,
        postBodyHash: BODY_HASH,
      },
      new AbortController().signal,
    );

    expect(result.state).toBe("verified");
    if (result.state !== "verified") return;
    const value = result.value as VerifiedLikesValueV1;
    expect(value.head).not.toHaveProperty("sealedReceiptCount");
    expect(value.verifiedIncluded).toBe(0);
    expect(value.packages).toEqual([
      expect.objectContaining({
        batchNumber: "0",
        receipts: [],
        state: "unavailable",
      }),
    ]);
  });
});

test("profile high-water survives a new engine instance in rebuildable storage", async () => {
  const storage = createMemoryVerificationStore();
  const fixture = profileVerifierFixture();
  const firstEngine = new WagyuVerificationEngineV1({
    verifier: fixture.verifier,
    storage,
    nowNs: () => NOW_NS,
  });
  const task = { kind: "profile" as const, nodeId: AUTHOR.toText() };
  const first = await firstEngine.execute(
    task,
    new AbortController().signal,
  );
  expect(first).toMatchObject({
    state: "verified",
    value: { highWater: "advance", revision: "7" },
  });

  const stored = await storage.getHighWater(
    profileHighWaterKey(lowerHex(NETWORK), AUTHOR.toText()),
  );
  expect(stored).toMatchObject({
    kind: "profile",
    profileGeneration: "2",
    revision: "7",
  });

  const reloadedEngine = new WagyuVerificationEngineV1({
    verifier: fixture.verifier,
    storage,
    nowNs: () => NOW_NS,
  });
  const replay = await reloadedEngine.execute(
    task,
    new AbortController().signal,
  );
  expect(replay).toMatchObject({
    state: "verified",
    value: { highWater: "replay", revision: "7" },
  });
});

test("serializes 32 concurrent profile compare-and-commit operations", async () => {
  const storage = createMemoryVerificationStore();
  const fixture = racingMutableVerifierFixture("profile");
  const engine = new WagyuVerificationEngineV1({
    verifier: fixture.verifier,
    storage,
    nowNs: () => NOW_NS,
  });
  const results = await Promise.all(
    Array.from({ length: 32 }, () =>
      engine.execute(
        { kind: "profile", nodeId: AUTHOR.toText() },
        new AbortController().signal,
      )
    ),
  );

  expect(results.every((result) => result.state === "verified")).toBeTrue();
  expect(fixture.maximumMutableConcurrency()).toBe(1);
  expect(
    await storage.getHighWater(
      profileHighWaterKey(lowerHex(NETWORK), AUTHOR.toText()),
    ),
  ).toMatchObject({
    kind: "profile",
    profileGeneration: "32",
    revision: "0",
  });
});

test("serializes 32 concurrent Like-head compare-and-commit operations", async () => {
  const storage = createMemoryVerificationStore();
  const fixture = racingMutableVerifierFixture("like-head");
  const engine = new WagyuVerificationEngineV1({
    verifier: fixture.verifier,
    storage,
    nowNs: () => NOW_NS,
  });
  const results = await Promise.all(
    Array.from({ length: 32 }, () =>
      engine.execute(
        {
          kind: "likes",
          postAuthor: AUTHOR.toText(),
          postId: POST_ID,
          postBodyHash: BODY_HASH,
        },
        new AbortController().signal,
      )
    ),
  );

  expect(results.every((result) => result.state === "verified")).toBeTrue();
  expect(fixture.maximumMutableConcurrency()).toBe(1);
  expect(
    await storage.getHighWater(
      likeHeadHighWaterKey(
        lowerHex(NETWORK),
        AUTHOR.toText(),
        lowerHex(POST_ID),
      ),
    ),
  ).toMatchObject({
    kind: "like-head",
    storeGeneration: "32",
    revision: "0",
  });
});

function likeVerifierFixture(options: {
  readonly batchCount: number;
  readonly receiptsPerBatch: number;
  readonly duplicateLastLiker: boolean;
  readonly duplicateGenesisFromLatest?: boolean;
  readonly unavailableBatchNumber?: number;
}) {
  const batchDigests = Array.from(
    { length: options.batchCount },
    (_, index) => bytes32(new Uint8Array(32).fill(index + 1)),
  );
  const batches = new Map<string, LikeBatchV1>();
  for (let number = 0; number < options.batchCount; number += 1) {
    const receipts = Array.from(
      { length: options.receiptsPerBatch },
      (_, index) => receipt(
        number,
        index,
        options.duplicateLastLiker &&
            number === options.batchCount - 1 &&
            index === options.receiptsPerBatch - 1
          ? 0
          : options.duplicateGenesisFromLatest === true &&
              number === 0 &&
              index === 0
            ? (options.batchCount - 1) * options.receiptsPerBatch
            : number * options.receiptsPerBatch + index,
      ),
    );
    batches.set(lowerHex(batchDigests[number]!), {
      network_id: NETWORK,
      post_author: AUTHOR,
      post_id: POST_ID,
      post_body_hash: BODY_HASH,
      batch_number: BigInt(number),
      previous_batch_digest:
        number === 0 ? [] : [batchDigests[number - 1]!],
      first_accepted_sequence:
        BigInt(number * options.receiptsPerBatch + 1),
      last_accepted_sequence:
        BigInt((number + 1) * options.receiptsPerBatch),
      final_partial: receipts.length < 150,
      receipts,
    });
  }
  const latestNumber = BigInt(options.batchCount - 1);
  const latestDigest = batchDigests.at(-1)!;
  const head: LikeHeadV1 = {
    network_id: NETWORK,
    post_author: AUTHOR,
    post_id: POST_ID,
    post_body_hash: BODY_HASH,
    store_generation: 3n,
    revision: 9n,
    previous_head_hash: [],
    latest_batch_number: [latestNumber],
    latest_batch_digest: [latestDigest],
    sealed_batch_count: BigInt(options.batchCount),
    sealed_receipt_count: BigInt(
      options.batchCount * options.receiptsPerBatch,
    ),
    accepting_likes: true,
  };
  let batchFetchCount = 0;
  let portableCount = 0;
  let activePortable = 0;
  let maximumPortable = 0;
  const highWaterDecisions: string[] = [];

  const verifier: WagyuVerifierV1 = {
    networkId: NETWORK,
    gateway: {
      scheme: "https:",
      hostname: "icp0.io",
      port: "",
      origin: "https://icp0.io",
    },
    adapterName: "fixture",
    async fetchAndVerify<T>(
      request: FetchAndVerifyRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      if (request.target.kind === "like-head") {
        const decoded = {
          value: head,
          exact_bytes: Uint8Array.of(1),
          object_digest: bytes32(new Uint8Array(32).fill(0xa1)),
        } as unknown as T;
        const digest = new Uint8Array(32).fill(0xa1);
        const decision = request.mutable!.checkHighWater(decoded, digest);
        if (decision.state === "reject") {
          return {
            state: "invalid",
            code: decision.code,
            reason: decision.reason,
          };
        }
        highWaterDecisions.push(decision.state);
        return verifierVerified(decoded, digest, decision.state);
      }
      if (request.target.kind === "like-batch") {
        batchFetchCount += 1;
        const digestHex = lowerHex(request.target.digest);
        const batch = batches.get(digestHex);
        if (
          batch !== undefined &&
          options.unavailableBatchNumber === Number(batch.batch_number)
        ) {
          return {
            state: "unavailable",
            code: "fixture_batch_unavailable",
            reason: "Fixture batch is temporarily unavailable",
          };
        }
        if (batch === undefined) {
          return {
            state: "unavailable",
            code: "fixture_missing_batch",
            reason: "Fixture batch is unavailable",
          };
        }
        return verifierVerified(
          {
            value: batch,
            exact_bytes: Uint8Array.of(2),
            object_digest: request.target.digest,
          } as unknown as T,
          request.target.digest,
          null,
        );
      }
      return {
        state: "invalid",
        code: "fixture_unexpected_fetch",
        reason: "Fixture received an unexpected fetch",
      };
    },
    async verifyPortable<T>(
      request: VerifyPortableRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      portableCount += 1;
      activePortable += 1;
      maximumPortable = Math.max(maximumPortable, activePortable);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activePortable -= 1;
      const actor = Principal.fromText(request.actor);
      return verifierVerified(
        {
          value: {
            header: {
              network_id: NETWORK,
              actor,
              action_kind: [{ like: null }],
            },
            like_id: request.target.digest,
            issued_at_ns: NOW_NS,
            post_author: AUTHOR,
            post_id: POST_ID,
            post_body_hash: BODY_HASH,
          },
          exact_bytes: request.body,
          object_digest: request.target.digest,
        } as unknown as T,
        request.target.digest,
        null,
      );
    },
  };
  return {
    verifier,
    batchFetches: () => batchFetchCount,
    portableVerifications: () => portableCount,
    maximumPortableConcurrency: () => maximumPortable,
    headHighWaterDecisions: () => [...highWaterDecisions],
  };
}

function racingMutableVerifierFixture(kind: "profile" | "like-head") {
  let callCount = 0;
  let active = 0;
  let maximumActive = 0;
  const verifier: WagyuVerifierV1 = {
    networkId: NETWORK,
    gateway: {
      scheme: "https:",
      hostname: "icp0.io",
      port: "",
      origin: "https://icp0.io",
    },
    adapterName: "racing-mutable-fixture",
    async fetchAndVerify<T>(
      request: FetchAndVerifyRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      callCount += 1;
      const call = callCount;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      // Without per-key serialization, newer generations finish first and
      // generation 1 performs the final blind write.
      await new Promise((resolve) => setTimeout(resolve, 33 - call));
      active -= 1;
      const digest = new Uint8Array(32).fill(call);
      if (kind === "profile" && request.target.kind === "profile") {
        const profile: ProfileV1 = {
          network_id: NETWORK,
          node: AUTHOR,
          profile_generation: BigInt(call),
          revision: 0n,
          updated_at_ns: NOW_NS,
          previous_profile_digest: [],
          display_name: `Wagyu ${call}`,
          description: "Concurrent profile",
          capabilities: [],
          avatar: [],
        };
        const decoded = {
          decoded: {
            value: profile,
            exact_bytes: Uint8Array.of(call),
            object_digest: digest,
          },
          avatar: { state: "absent" },
        } as unknown as T;
        const decision = request.mutable!.checkHighWater(decoded, digest);
        return decision.state === "reject"
          ? {
              state: "invalid",
              code: decision.code,
              reason: decision.reason,
            }
          : verifierVerified(decoded, digest, decision.state);
      }
      if (kind === "like-head" && request.target.kind === "like-head") {
        const head: LikeHeadV1 = {
          network_id: NETWORK,
          post_author: AUTHOR,
          post_id: POST_ID,
          post_body_hash: BODY_HASH,
          store_generation: BigInt(call),
          revision: 0n,
          previous_head_hash: [],
          latest_batch_number: [],
          latest_batch_digest: [],
          sealed_batch_count: 0n,
          sealed_receipt_count: 0n,
          accepting_likes: true,
        };
        const decoded = {
          value: head,
          exact_bytes: Uint8Array.of(call),
          object_digest: digest,
        } as unknown as T;
        const decision = request.mutable!.checkHighWater(decoded, digest);
        return decision.state === "reject"
          ? {
              state: "invalid",
              code: decision.code,
              reason: decision.reason,
            }
          : verifierVerified(decoded, digest, decision.state);
      }
      return {
        state: "invalid",
        code: "fixture_unexpected_fetch",
        reason: "Racing fixture received an unexpected fetch",
      };
    },
    async verifyPortable<T>(
      _request: VerifyPortableRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      return {
        state: "invalid",
        code: "fixture_unexpected_portable",
        reason: "Racing fixture has no portable evidence",
      };
    },
  };
  return {
    verifier,
    maximumMutableConcurrency: () => maximumActive,
  };
}

function profileVerifierFixture() {
  const profile: ProfileV1 = {
    network_id: NETWORK,
    node: AUTHOR,
    profile_generation: 2n,
    revision: 7n,
    updated_at_ns: NOW_NS - 1_000_000n,
    previous_profile_digest: [],
    display_name: "Wagyu",
    description: "Verified in a Worker",
    capabilities: [["wagyu_v1:test"]],
    avatar: [],
  };
  const digest = new Uint8Array(32).fill(0xb2);
  const verifier: WagyuVerifierV1 = {
    networkId: NETWORK,
    gateway: {
      scheme: "https:",
      hostname: "icp0.io",
      port: "",
      origin: "https://icp0.io",
    },
    adapterName: "fixture",
    async fetchAndVerify<T>(
      request: FetchAndVerifyRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      const decoded = {
        decoded: {
          value: profile,
          exact_bytes: Uint8Array.of(3),
          object_digest: digest,
        },
        avatar: { state: "absent" },
      } as unknown as T;
      const decision = request.mutable!.checkHighWater(decoded, digest);
      if (decision.state === "reject") {
        return {
          state: "invalid",
          code: decision.code,
          reason: decision.reason,
        };
      }
      return verifierVerified(decoded, digest, decision.state);
    },
    async verifyPortable<T>(
      _request: VerifyPortableRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      return {
        state: "invalid",
        code: "fixture_unexpected_portable",
        reason: "Profile fixture has no portable proof",
      };
    },
  };
  return { verifier };
}

function receipt(
  batchNumber: number,
  index: number,
  likerNumber: number,
): CertifiedLikeReceiptV1 {
  const actor = Principal.fromUint8Array(
    Uint8Array.of(
      (likerNumber >>> 8) & 0xff,
      likerNumber & 0xff,
      0x01,
    ),
  );
  const digest = bytes32(
    Uint8Array.from(
      { length: 32 },
      (_, byte) => (batchNumber * 17 + index * 3 + byte) & 0xff,
    ),
  );
  return {
    like_action_candid: Uint8Array.of(batchNumber, index) as never,
    ref: {
      actor,
      action_kind: [{ like: null }],
      object_digest: digest,
      body_length: 2,
      proof_snapshot: {
        certificate_version: 2,
        certificate_cbor: Uint8Array.of(1, batchNumber),
        witness_cbor: Uint8Array.of(2, index),
        expression_path_cbor: Uint8Array.of(3),
        certificate_time_ns: NOW_NS,
      },
    },
  };
}

function verifierVerified<T>(
  value: T,
  bodyDigest: Uint8Array,
  highWater: "advance" | "replay" | null,
): VerificationResultV1<T> {
  return {
    state: "verified",
    value,
    body: Uint8Array.of(0),
    bodyDigest: bodyDigest.slice(),
    path: "/fixture",
    certificateTimeNs: NOW_NS,
    highWater,
    verifierVersion: "wagyu-verifier-v1",
  };
}

async function verifiedLikesValue() {
  return {
    verifiedIncluded: 0,
    invalid: 0,
    unavailable: 0,
    packages: [] as Array<{
      batchNumber: string;
      cache: string;
      receipts: Array<{
        state: string;
        code: string | null;
        actorNodeId: string;
      }>;
    }>,
    truncated: false,
    continuation: null as string | null,
  };
}
