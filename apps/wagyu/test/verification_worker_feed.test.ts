import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  bytes16,
  bytes32,
  deriveObjectDigest,
  derivePostBodyHash,
  derivePostId,
  encodeCertifiedPostRefV1,
  encodeCertifiedShareDeliveryV1,
  encodeCertifiedTombstoneV1,
  encodePostBodyV1,
  encodeReplyIndexV1,
  equalBytes,
  lowerHex,
  type CertifiedPostRefV1,
  type PostBodyV1,
} from "../src/protocol/index.ts";
import {
  buildGoldenPackageValues,
  GOLDEN_ACTOR_A,
  GOLDEN_ACTOR_B,
  GOLDEN_NETWORK_ID,
} from "../candid/fixtures/v1-values.ts";
import {
  type FetchAndVerifyRequestV1,
  type VerificationResultV1,
  type VerifyPortableRequestV1,
  type WagyuVerifierV1,
} from "../src/verifier/index.ts";
import {
  WagyuVerificationEngineV1,
  createMemoryVerificationStore,
  shareEdgeEvidenceKey,
  type WagyuVerificationStoreV1,
} from "../src/worker/index.ts";

const NOW_NS = 1_800_000_000_000_000_000n;

describe("Wagyu feed Worker verification", () => {
  test("counts a certified reply index without fetching reply bodies", async () => {
    const values = buildGoldenPackageValues();
    const indexBytes = encodeReplyIndexV1(values.ReplyIndexV1);
    let fetches = 0;
    const verifier: WagyuVerifierV1 = {
      networkId: GOLDEN_NETWORK_ID,
      gateway: {
        scheme: "https:",
        hostname: "icp0.io",
        port: "",
        origin: "https://icp0.io",
      },
      adapterName: "reply-count-fixture",
      async fetchAndVerify<T>(
        request: FetchAndVerifyRequestV1<T>,
      ): Promise<VerificationResultV1<T>> {
        fetches += 1;
        if (request.target.kind !== "reply-index") {
          return {
            state: "invalid",
            code: "reply_body_must_not_load",
            reason: "Summary mode fetched a reply body",
          };
        }
        return verifiedResult(
          {
            value: values.ReplyIndexV1,
            exact_bytes: indexBytes,
            object_digest: deriveObjectDigest(indexBytes),
          } as unknown as T,
          indexBytes,
          deriveObjectDigest(indexBytes),
        );
      },
      async verifyPortable() {
        return {
          state: "invalid",
          code: "portable_not_expected",
          reason: "Summary mode does not verify portable evidence",
        };
      },
    };
    const result = await engineFor(verifier).execute(
      {
        kind: "thread",
        postAuthor: values.CertifiedPostRefV1.author.toText(),
        postId: values.CertifiedPostRefV1.post_id,
        postBodyHash: values.CertifiedPostRefV1.body_hash,
        postObjectDigest: values.CertifiedPostRefV1.object_digest,
        postBodyLength: values.CertifiedPostRefV1.body_length,
        summaryOnly: true,
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      state: "verified",
      value: {
        replyCount: 1,
        replies: [],
      },
    });
    expect(fetches).toBe(1);
  });

  test("never verifies a raw reply-index 404 as an empty thread", async () => {
    const values = buildGoldenPackageValues();
    const verifier: WagyuVerifierV1 = {
      ...goldenFeedVerifier(),
      adapterName: "reply-index-404-fixture",
      async fetchAndVerify<T>(): Promise<VerificationResultV1<T>> {
        return {
          state: "unavailable",
          code: "http_404",
          reason: "The reply index is unavailable",
        };
      },
    };
    const result = await engineFor(verifier).execute(
      {
        kind: "thread",
        postAuthor: values.CertifiedPostRefV1.author.toText(),
        postId: values.CertifiedPostRefV1.post_id,
        postBodyHash: values.CertifiedPostRefV1.body_hash,
        postObjectDigest: values.CertifiedPostRefV1.object_digest,
        postBodyLength: values.CertifiedPostRefV1.body_length,
        summaryOnly: true,
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      state: "unavailable",
      code: "http_404",
      reason: "The reply index is unavailable",
    });
  });

  test("hydrates and verifies a reply parent before returning renderable context", async () => {
    const fixture = postFixture();
    const engine = engineFor(fixture.verifier);
    const result = await engine.execute(
      {
        kind: "feed",
        candidateId: "candidate-1",
        immediateSender: GOLDEN_ACTOR_A.toText(),
        eventKind: "original",
        exactEventBytes: encodeCertifiedPostRefV1(fixture.child.ref),
      },
      new AbortController().signal,
    );

    expect(result.state).toBe("verified");
    if (result.state !== "verified") return;
    expect(result.value).toMatchObject({
      eventKind: "original",
      bodyMarkdown: "Child reply",
      replyTo: {
        state: "verified",
        authorNodeId: GOLDEN_ACTOR_B.toText(),
        bodyMarkdown: "Parent context",
      },
    });
    expect(fixture.fetches()).toBe(2);
  });

  test("keeps primary transport failure unavailable and sender mismatch invalid", async () => {
    const unavailableFixture = postFixture({ unavailableChild: true });
    const unavailableResult = await engineFor(
      unavailableFixture.verifier,
    ).execute(
      {
        kind: "feed",
        candidateId: "candidate-2",
        immediateSender: GOLDEN_ACTOR_A.toText(),
        eventKind: "original",
        exactEventBytes: encodeCertifiedPostRefV1(
          unavailableFixture.child.ref,
        ),
      },
      new AbortController().signal,
    );
    expect(unavailableResult).toMatchObject({
      state: "unavailable",
      code: "fixture_fetch_unavailable",
    });

    const validFixture = postFixture();
    const invalidResult = await engineFor(validFixture.verifier).execute(
      {
        kind: "feed",
        candidateId: "candidate-3",
        immediateSender: GOLDEN_ACTOR_B.toText(),
        eventKind: "original",
        exactEventBytes: encodeCertifiedPostRefV1(validFixture.child.ref),
      },
      new AbortController().signal,
    );
    expect(invalidResult).toMatchObject({
      state: "invalid",
      code: "feed_sender_mismatch",
    });
  });

  test("accepts a relayed tombstone only with the exact canonical verified share edge", async () => {
    const values = buildGoldenPackageValues();
    const verifier = goldenFeedVerifier();
    const task = {
      kind: "feed" as const,
      candidateId: "candidate-4",
      immediateSender: GOLDEN_ACTOR_B.toText(),
      eventKind: "tombstone" as const,
      exactEventBytes: encodeCertifiedTombstoneV1(
        values.CertifiedTombstoneV1,
      ),
    };
    const missing = await engineFor(verifier).execute(
      task,
      new AbortController().signal,
    );
    expect(missing).toMatchObject({
      state: "unavailable",
      code: "share_edge_unavailable",
    });

    const metadataOnly = await engineFor(verifier).execute(
      {
        ...task,
        verifiedShareEdge: {
          immediateSender: GOLDEN_ACTOR_B.toText(),
          originalAuthor: GOLDEN_ACTOR_A.toText(),
          postId: values.TombstoneActionV1.post_id,
          bodyHash: values.TombstoneActionV1.post_body_hash,
          exactShareDeliveryBytes: new Uint8Array(),
        },
      },
      new AbortController().signal,
    );
    expect(metadataOnly).toMatchObject({
      state: "invalid",
      code: "invalid_provided_share_edge",
    });

    const exactShareDeliveryBytes = encodeCertifiedShareDeliveryV1(
      values.CertifiedShareDeliveryV1,
    );
    const accepted = await engineFor(verifier).execute(
      {
        ...task,
        verifiedShareEdge: {
          immediateSender: GOLDEN_ACTOR_B.toText(),
          originalAuthor: GOLDEN_ACTOR_A.toText(),
          postId: values.TombstoneActionV1.post_id,
          bodyHash: values.TombstoneActionV1.post_body_hash,
          exactShareDeliveryBytes,
        },
      },
      new AbortController().signal,
    );
    expect(accepted).toMatchObject({
      state: "verified",
      value: {
        eventKind: "tombstone",
        authorNodeId: GOLDEN_ACTOR_A.toText(),
        sharedByNodeId: GOLDEN_ACTOR_B.toText(),
      },
    });

    const tamperedEvidence = exactShareDeliveryBytes.slice();
    tamperedEvidence[0] = tamperedEvidence[0]! ^ 0xff;
    const tampered = await engineFor(verifier).execute(
      {
        ...task,
        verifiedShareEdge: {
          immediateSender: GOLDEN_ACTOR_B.toText(),
          originalAuthor: GOLDEN_ACTOR_A.toText(),
          postId: values.TombstoneActionV1.post_id,
          bodyHash: values.TombstoneActionV1.post_body_hash,
          exactShareDeliveryBytes: tamperedEvidence,
        },
      },
      new AbortController().signal,
    );
    expect(tampered).toMatchObject({
      state: "invalid",
      code: "invalid_provided_share_edge",
    });
  });

  test("re-verifies exact cached share evidence after restart and rejects tampering", async () => {
    const values = buildGoldenPackageValues();
    const verifier = goldenFeedVerifier();
    const storage = createMemoryVerificationStore();
    const share = await engineFor(verifier, storage).execute(
      {
        kind: "feed",
        candidateId: "candidate-share-edge",
        immediateSender: GOLDEN_ACTOR_B.toText(),
        eventKind: "share",
        exactEventBytes: encodeCertifiedShareDeliveryV1(
          values.CertifiedShareDeliveryV1,
        ),
      },
      new AbortController().signal,
    );
    expect(share).toMatchObject({ state: "verified" });

    const tombstoneTask = {
      kind: "feed" as const,
      candidateId: "candidate-relayed-tombstone",
      immediateSender: GOLDEN_ACTOR_B.toText(),
      eventKind: "tombstone" as const,
      exactEventBytes: encodeCertifiedTombstoneV1(
        values.CertifiedTombstoneV1,
      ),
    };
    const restarted = await engineFor(verifier, storage).execute(
      tombstoneTask,
      new AbortController().signal,
    );
    expect(restarted).toMatchObject({
      state: "verified",
      value: {
        authorNodeId: GOLDEN_ACTOR_A.toText(),
        sharedByNodeId: GOLDEN_ACTOR_B.toText(),
      },
    });

    const key = shareEdgeEvidenceKey(
      lowerHex(GOLDEN_NETWORK_ID),
      GOLDEN_ACTOR_B.toText(),
      GOLDEN_ACTOR_A.toText(),
      lowerHex(values.TombstoneActionV1.post_id),
      lowerHex(values.TombstoneActionV1.post_body_hash),
    );
    const cached = await storage.getVerifiedResult<{
      exactEventBytes: Uint8Array;
    }>(key);
    expect(cached).not.toBeNull();
    if (cached === null) return;
    cached.exactEventBytes[0] = cached.exactEventBytes[0]! ^ 0xff;
    await storage.putVerifiedResult(key, cached);

    const tampered = await engineFor(verifier, storage).execute(
      tombstoneTask,
      new AbortController().signal,
    );
    expect(tampered).toMatchObject({
      state: "invalid",
      code: "invalid_cached_share_edge",
    });
  });
});

function postFixture(options: { unavailableChild?: boolean } = {}) {
  const proof = buildGoldenPackageValues().CertifiedHttpProofV1;
  const parent = makePost(
    GOLDEN_ACTOR_B,
    "Parent context",
    1n,
    null,
    proof,
  );
  const child = makePost(
    GOLDEN_ACTOR_A,
    "Child reply",
    2n,
    {
      author: GOLDEN_ACTOR_B,
      post_id: parent.ref.post_id,
      body_hash: parent.ref.body_hash,
      body_length: parent.ref.body_length,
      object_digest: parent.ref.object_digest,
    },
    proof,
  );
  const posts = [parent, child];
  let fetchCount = 0;
  const verifier: WagyuVerifierV1 = {
    networkId: GOLDEN_NETWORK_ID,
    gateway: {
      scheme: "https:",
      hostname: "icp0.io",
      port: "",
      origin: "https://icp0.io",
    },
    adapterName: "feed-fixture",
    async fetchAndVerify<T>(
      request: FetchAndVerifyRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      fetchCount += 1;
      if (
        options.unavailableChild &&
        request.target.kind === "action" &&
        equalBytes(request.target.digest, child.ref.object_digest)
      ) {
        return {
          state: "unavailable",
          code: "fixture_fetch_unavailable",
          reason: "Fixture post is unavailable",
        };
      }
      const target = request.target;
      const post = target.kind === "action"
        ? posts.find((entry) =>
            equalBytes(entry.ref.object_digest, target.digest)
          )
        : undefined;
      if (post === undefined) {
        return {
          state: "invalid",
          code: "fixture_unknown_post",
          reason: "Fixture post target is unknown",
        };
      }
      return verifiedResult(
        {
          value: post.body,
          exact_bytes: post.bytes,
          object_digest: post.ref.object_digest,
        } as unknown as T,
        post.bytes,
        post.ref.object_digest,
      );
    },
    async verifyPortable<T>(
      request: VerifyPortableRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      if (
        request.target.kind === "action" &&
        request.target.actionKind === "tombstone"
      ) {
        const tombstone = buildGoldenPackageValues().TombstoneActionV1;
        return verifiedResult(
          {
            value: tombstone,
            exact_bytes: request.body,
            object_digest: request.target.digest,
          } as unknown as T,
          request.body,
          request.target.digest,
        );
      }
      const post = request.target.kind === "action"
        ? posts.find((entry) =>
            equalBytes(entry.ref.object_digest, request.target.digest)
          )
        : undefined;
      if (post === undefined) {
        return {
          state: "invalid",
          code: "fixture_unknown_portable",
          reason: "Fixture portable target is unknown",
        };
      }
      return verifiedResult(
        {
          value: post.body,
          exact_bytes: post.bytes,
          object_digest: post.ref.object_digest,
        } as unknown as T,
        post.bytes,
        post.ref.object_digest,
      );
    },
  };
  return { verifier, parent, child, fetches: () => fetchCount };
}

function makePost(
  actor: Principal,
  markdown: string,
  sequence: bigint,
  reply: PostBodyV1["reply_to"][number] | null,
  proof: CertifiedPostRefV1["proof"],
) {
  const body: PostBodyV1 = {
    header: {
      network_id: GOLDEN_NETWORK_ID,
      actor,
      action_kind: [{ post: null }],
    },
    author_sequence: sequence,
    nonce: bytes16(new Uint8Array(16).fill(Number(sequence))),
    created_at_ns: NOW_NS - sequence,
    body_markdown: markdown,
    reply_to: reply === null ? [] : [reply],
  };
  const bytes = encodePostBodyV1(body);
  const bodyHash = derivePostBodyHash(bytes);
  const ref: CertifiedPostRefV1 = {
    author: actor,
    post_id: derivePostId(GOLDEN_NETWORK_ID, actor, bodyHash),
    body_hash: bodyHash,
    body_length: bytes.byteLength,
    object_digest: deriveObjectDigest(bytes),
    proof,
  };
  return { body, bytes, ref };
}

function engineFor(
  verifier: WagyuVerifierV1,
  storage: WagyuVerificationStoreV1 = createMemoryVerificationStore(),
) {
  return new WagyuVerificationEngineV1({
    verifier,
    storage,
    nowNs: () => NOW_NS,
  });
}

function goldenFeedVerifier(): WagyuVerifierV1 {
  const values = buildGoldenPackageValues();
  const postBytes = encodePostBodyV1(values.PostBodyV1);
  return {
    networkId: GOLDEN_NETWORK_ID,
    gateway: {
      scheme: "https:",
      hostname: "icp0.io",
      port: "",
      origin: "https://icp0.io",
    },
    adapterName: "golden-feed-fixture",
    async fetchAndVerify<T>(
      request: FetchAndVerifyRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      if (
        request.target.kind !== "action" ||
        !equalBytes(
          request.target.digest,
          values.CertifiedPostRefV1.object_digest,
        )
      ) {
        return {
          state: "invalid",
          code: "fixture_unknown_post",
          reason: "Fixture post target is unknown",
        };
      }
      return verifiedResult(
        {
          value: values.PostBodyV1,
          exact_bytes: postBytes,
          object_digest: values.CertifiedPostRefV1.object_digest,
        } as unknown as T,
        postBytes,
        values.CertifiedPostRefV1.object_digest,
      );
    },
    async verifyPortable<T>(
      request: VerifyPortableRequestV1<T>,
    ): Promise<VerificationResultV1<T>> {
      if (
        request.target.kind === "action" &&
        request.target.actionKind === "post"
      ) {
        return verifiedResult(
          {
            value: values.PostBodyV1,
            exact_bytes: request.body,
            object_digest: values.CertifiedPostRefV1.object_digest,
          } as unknown as T,
          request.body,
          values.CertifiedPostRefV1.object_digest,
        );
      }
      if (
        request.target.kind === "action" &&
        request.target.actionKind === "share"
      ) {
        return verifiedResult(
          {
            value: values.ShareActionV1,
            exact_bytes: request.body,
            object_digest: values.CertifiedShareRefV1.object_digest,
          } as unknown as T,
          request.body,
          values.CertifiedShareRefV1.object_digest,
        );
      }
      if (
        request.target.kind === "action" &&
        request.target.actionKind === "tombstone"
      ) {
        return verifiedResult(
          {
            value: values.TombstoneActionV1,
            exact_bytes: request.body,
            object_digest: request.target.digest,
          } as unknown as T,
          request.body,
          request.target.digest,
        );
      }
      return {
        state: "invalid",
        code: "fixture_unknown_portable",
        reason: "Fixture portable target is unknown",
      };
    },
  };
}

function verifiedResult<T>(
  value: T,
  body: Uint8Array,
  digest: Uint8Array,
): VerificationResultV1<T> {
  return {
    state: "verified",
    value,
    body: body.slice(),
    bodyDigest: bytes32(digest),
    path: "/fixture",
    certificateTimeNs: NOW_NS,
    highWater: null,
    verifierVersion: "wagyu-verifier-v1",
  };
}
