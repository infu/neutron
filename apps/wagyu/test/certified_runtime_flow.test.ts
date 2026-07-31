import { Cbor, type HttpAgent } from "@dfinity/agent";
import { describe, expect, test } from "bun:test";
import {
  buildGoldenPackageValues,
  GOLDEN_ACTOR_A,
  GOLDEN_ACTOR_B,
  GOLDEN_MAINNET_ROOT_DER,
  GOLDEN_NETWORK_ID,
} from "../candid/fixtures/v1-values.ts";
import {
  deriveObjectDigest,
  encodeLikeActionV1,
  encodePostBodyV1,
  encodeShareActionV1,
  encodeTombstoneActionV1,
  lowerHex,
  WAGYU_CODECS,
} from "../src/protocol/index.ts";
import {
  createWagyuVerifier,
  expectedCertifiedHeaders,
  sha256,
  toBase64,
  trustedWagyuNetworkConfig,
  type HttpCertificationAdapterV1,
} from "../src/verifier/index.ts";
import {
  createCertifiedWagyuPorts,
  verifyCaptureAndFinalize,
  verifyFeedBatchWithWorker,
  verifyFeedWithWorker,
  type RuntimeVerifier,
} from "../src/app/certified_runtime.ts";
import type {
  FeedItem,
  NotificationItem,
  PublishResult,
  WagyuProfile,
} from "../src/app/model.ts";
import type {
  PreparedAction,
  TrustedRuntimeContext,
} from "../src/app/service_adapter.ts";
import type {
  WagyuResidentVerificationClientV1,
} from "../src/worker/resident_client.ts";
import type {
  VerifiedFeedValueV1,
} from "../src/worker/types.ts";

const CERTIFICATE_TIME_NS = 1_725_000_000_000_000_000n;

describe("prepared certified-action finalization", () => {
  const values = buildGoldenPackageValues();
  const fixtures = [
    {
      kind: "post" as const,
      actor: GOLDEN_ACTOR_A.toText(),
      actionId: values.CertifiedPostRefV1.post_id,
      body: encodePostBodyV1(values.PostBodyV1),
    },
    {
      kind: "share" as const,
      actor: GOLDEN_ACTOR_B.toText(),
      actionId: values.ShareActionV1.share_id,
      body: encodeShareActionV1(values.ShareActionV1),
    },
    {
      kind: "like" as const,
      actor: GOLDEN_ACTOR_B.toText(),
      actionId: values.LikeActionV1.like_id,
      body: encodeLikeActionV1(values.LikeActionV1),
    },
    {
      kind: "tombstone" as const,
      actor: GOLDEN_ACTOR_A.toText(),
      actionId: values.TombstoneActionV1.tombstone_id,
      body: encodeTombstoneActionV1(values.TombstoneActionV1),
    },
  ];

  for (const fixture of fixtures) {
    test(`verifies, captures, and finalizes ${fixture.kind} with nested API-1 Blobs`, async () => {
      const prepared: PreparedAction = {
        actor: fixture.actor,
        kind: fixture.kind,
        actionId: fixture.actionId.slice(),
        objectDigest: deriveObjectDigest(fixture.body),
      };
      let finalizeCalls = 0;
      const result = await verifyCaptureAndFinalize(
        await fixtureRuntime(fixture.body),
        prepared,
        async (received, exactProof) => {
          finalizeCalls += 1;
          expect(received).not.toBe(prepared);
          expect(received).toEqual(prepared);
          expect(received.actionId).not.toBe(prepared.actionId);
          expect(received.objectDigest).not.toBe(prepared.objectDigest);
          expect(exactProof).toBeInstanceOf(Uint8Array);
          const decoded = WAGYU_CODECS.CertifiedHttpProofV1.decode(exactProof);
          expect(decoded.value.certificate_cbor).toBeInstanceOf(Uint8Array);
          expect(decoded.value.witness_cbor).toBeInstanceOf(Uint8Array);
          expect(decoded.value.expression_path_cbor).toBeInstanceOf(
            Uint8Array,
          );
          expect(decoded.value.certificate_time_ns).toBe(
            CERTIFICATE_TIME_NS,
          );
          return publishResult();
        },
      );
      expect(result.stage).toBe("fanout-queued");
      expect(finalizeCalls).toBe(1);
    });
  }

  test("never finalizes missing/conflicting headers or wrong prepared identities", async () => {
    const fixture = fixtures[0]!;
    const digest = deriveObjectDigest(fixture.body);
    const failures = [
      {
        name: "missing Content-Digest",
        prepared: {
          actor: fixture.actor,
          kind: fixture.kind,
          actionId: fixture.actionId,
          objectDigest: digest,
        },
        mutate(headers: Headers) {
          headers.delete("Content-Digest");
        },
      },
      {
        name: "conflicting Content-Digest",
        prepared: {
          actor: fixture.actor,
          kind: fixture.kind,
          actionId: fixture.actionId,
          objectDigest: digest,
        },
        mutate(headers: Headers) {
          headers.set(
            "Content-Digest",
            "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:",
          );
        },
      },
      {
        name: "missing certificate",
        prepared: {
          actor: fixture.actor,
          kind: fixture.kind,
          actionId: fixture.actionId,
          objectDigest: digest,
        },
        mutate(headers: Headers) {
          headers.delete("IC-Certificate");
        },
      },
      {
        name: "wrong action identity",
        prepared: {
          actor: fixture.actor,
          kind: fixture.kind,
          actionId: new Uint8Array(32),
          objectDigest: digest,
        },
      },
      {
        name: "wrong object digest",
        prepared: {
          actor: fixture.actor,
          kind: fixture.kind,
          actionId: fixture.actionId,
          objectDigest: new Uint8Array(32).fill(0x99),
        },
      },
    ] satisfies Array<{
      name: string;
      prepared: PreparedAction;
      mutate?: (headers: Headers) => void;
    }>;

    for (const failure of failures) {
      let finalizeCalls = 0;
      await expect(
        verifyCaptureAndFinalize(
          await fixtureRuntime(fixture.body, failure.mutate),
          failure.prepared,
          async () => {
            finalizeCalls += 1;
            return publishResult();
          },
        ),
      ).rejects.toThrow();
      expect(finalizeCalls, failure.name).toBe(0);
    }
  });
});

describe("certified feed runtime boundaries", () => {
  test("uses one exact event snapshot and keeps valid content when profile lookup fails", async () => {
    const originalBytes = Uint8Array.of(68, 73, 68, 76, 1, 2, 3);
    const item = feedItem("original", originalBytes);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const workerBytes: number[] = [];
    const worker: Pick<
      WagyuResidentVerificationClientV1,
      "verifyFeed"
    > = {
      async verifyFeed(task) {
        workerBytes.push(...task.exactEventBytes);
        entered();
        await gate;
        return {
          state: "verified",
          value: verifiedFeedValue(task.candidateId, "original"),
        };
      },
    };

    const pending = verifyFeedWithWorker(
      worker,
      item,
      async () => {
        throw new Error("profile transport unavailable");
      },
    );
    await started;
    originalBytes.fill(0xff);
    release();
    const result = await pending;

    expect(workerBytes).toEqual([68, 73, 68, 76, 1, 2, 3]);
    expect(result.verification).toBe("verified");
    expect(result.body).toBe("verified body");
    expect(result.author).toMatchObject({
      nodeId: GOLDEN_ACTOR_A.toText(),
      displayName: null,
      profileProof: "unavailable",
    });
    expect(result.originalPostRefBytes).toEqual(
      Uint8Array.of(68, 73, 68, 76, 1, 2, 3),
    );
    expect(result.opaqueEventBytes).toEqual(
      Uint8Array.of(68, 73, 68, 76, 1, 2, 3),
    );
  });

  test("verifies share edges before relayed tombstones from the same visible batch", async () => {
    const calls: string[] = [];
    const worker: Pick<
      WagyuResidentVerificationClientV1,
      "verifyFeed"
    > = {
      async verifyFeed(task) {
        calls.push(task.eventKind);
        return {
          state: "unavailable",
          code: task.eventKind === "tombstone"
            ? "share_edge_unavailable"
            : "fixture_unavailable",
          reason: "fixture",
        };
      },
    };
    const items = [
      feedItem("tombstone", Uint8Array.of(1)),
      feedItem("share", Uint8Array.of(2)),
    ];
    const results = await verifyFeedBatchWithWorker(
      worker,
      items,
      profileFallback,
    );
    expect(calls).toEqual(["share", "tombstone"]);
    expect(results.map((item) => item.kind)).toEqual([
      "tombstone",
      "share",
    ]);
    expect(results[0]!.verificationIssue).toBe("fetch-unavailable");
  });

  test("passes feed cancellation into the resident verification call", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const worker: Pick<
      WagyuResidentVerificationClientV1,
      "verifyFeed"
    > = {
      async verifyFeed(_task, options) {
        receivedSignal = options?.signal;
        return await new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve({
              state: "unavailable",
              code: "worker_cancelled",
              reason: "Verification was cancelled",
            }), { once: true });
        });
      },
    };
    const pending = verifyFeedWithWorker(
      worker,
      feedItem("original", Uint8Array.of(1)),
      profileFallback,
      controller.signal,
    );
    controller.abort();

    expect((await pending).verification).toBe("unavailable");
    expect(receivedSignal).toBe(controller.signal);
  });

  test("clears one rejected trusted-runtime promise and shares the retry", async () => {
    let trustReads = 0;
    let releaseTrust!: () => void;
    const trustGate = new Promise<void>((resolve) => {
      releaseTrust = resolve;
    });
    const ports = createCertifiedWagyuPorts(
      async () => {
        trustReads += 1;
        if (trustReads === 1) throw new Error("transient trusted runtime read");
        await trustGate;
        return trustedRuntime();
      },
      {
        async finalizePreparedAction() {
          return publishResult();
        },
        async recordCandidateDisposition() {},
        async recordNotificationDisposition() {},
      },
    );
    const notification = rejectedFollowNotification();

    await expect(
      ports.hydrateNotification(notification, null, GOLDEN_ACTOR_A.toText()),
    ).rejects.toThrow("transient");
    const retryA = ports.hydrateNotification(
      notification,
      null,
      GOLDEN_ACTOR_A.toText(),
    );
    const retryB = ports.hydrateNotification(
      notification,
      null,
      GOLDEN_ACTOR_A.toText(),
    );
    expect(trustReads).toBe(2);
    releaseTrust();
    const [first, second] = await Promise.all([retryA, retryB]);
    expect(first.verification).toBe("invalid");
    expect(second.verification).toBe("invalid");
    expect(trustReads).toBe(2);
  });
});

async function fixtureRuntime(
  body: Uint8Array,
  mutate?: (headers: Headers) => void,
): Promise<RuntimeVerifier> {
  const network = trustedWagyuNetworkConfig(
    GOLDEN_MAINNET_ROOT_DER,
    { origin: "https://icp0.io" },
  );
  const fetcher = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const digest = await sha256(body);
    const headers = new Headers();
    for (
      const [name, value] of expectedCertifiedHeaders(
        "immutable_blob",
        body.byteLength,
        digest,
      )
    ) {
      headers.set(name, value);
    }
    headers.set("IC-Certificate", certificateHeader());
    mutate?.(headers);
    const exact = body.slice();
    const response = new Response(exact.buffer, {
      status: 200,
      headers,
    });
    Object.defineProperty(response, "url", {
      value: input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : input,
    });
    return response;
  }) as typeof globalThis.fetch;
  const adapter: HttpCertificationAdapterV1 = {
    name: "certified-runtime-fixture",
    available: true,
    async verify() {
      return {
        state: "verified",
        evidence: {
          certificateTimeNs: CERTIFICATE_TIME_NS,
          certifiedDataRoot: new Uint8Array(32),
          witnessRoot: new Uint8Array(32),
        },
      };
    },
  };
  const createVerifier = (
    selectedFetch: typeof globalThis.fetch,
  ) =>
    createWagyuVerifier({
      network,
      fetch: selectedFetch,
      adapter,
    });
  return {
    verifier: createVerifier(fetcher),
    network,
    fetch: fetcher,
    createVerifier,
  };
}

function certificateHeader(): string {
  const path = Cbor.encode([
    "http_expr",
    "app",
    "wagyu",
    "_route",
    "protocol",
    "v1",
    "objects",
    "post",
    "sha256",
    "00".repeat(32),
    "<$>",
  ]);
  return `certificate=:AQ==:, tree=:Ag==:, expr_path=:${toBase64(path)}:, version=2`;
}

function publishResult(): PublishResult {
  return {
    stage: "fanout-queued",
    postId: null,
    queuedRecipients: 0,
    queuedNotices: 0,
    acceptedRecipients: 0,
    failedRecipients: 0,
    message: "fixture",
  };
}

function feedItem(
  kind: FeedItem["kind"],
  opaqueEventBytes: Uint8Array,
): FeedItem {
  return {
    id: `${kind}-candidate`,
    localSequence: "1",
    receivedAt: new Date(0).toISOString(),
    immediateSender: GOLDEN_ACTOR_B.toText(),
    kind,
    verification: "candidate",
    verificationIssue: null,
    promotion: "pending",
    author: {
      nodeId: GOLDEN_ACTOR_A.toText(),
      displayName: null,
      avatarUrl: null,
      profileProof: "loading",
    },
    postId: "00".repeat(32),
    body: null,
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
    opaqueEventBytes,
    originalPostRefBytes: null,
  };
}

function verifiedFeedValue(
  candidateId: string,
  eventKind: VerifiedFeedValueV1["eventKind"],
): VerifiedFeedValueV1 {
  return {
    candidateId,
    eventKind,
    authorNodeId: GOLDEN_ACTOR_A.toText(),
    sharedByNodeId: null,
    postId: "11".repeat(32),
    bodyHash: "22".repeat(32),
    objectDigest: "33".repeat(32),
    bodyLength: 123,
    bodyMarkdown: "verified body",
    actionTimeNs: "1725000000000000000",
    replyTo: null,
  };
}

async function profileFallback(
  _nodeId: string,
  fallback: WagyuProfile,
): Promise<WagyuProfile> {
  return fallback;
}

function trustedRuntime(): TrustedRuntimeContext {
  return {
    network: {
      networkId: lowerHex(GOLDEN_NETWORK_ID),
      target: "ic",
      rootKeyPolicy: "mainnet",
      source: "fixture",
    },
    networkIdBytes: GOLDEN_NETWORK_ID,
    rootKey: GOLDEN_MAINNET_ROOT_DER,
    gatewayOrigin: "https://icp0.io",
    allowInsecureLocalhost: false,
    queryAgent: {} as HttpAgent,
  };
}

function rejectedFollowNotification(): NotificationItem {
  return {
    id: "follow-1",
    localSequence: "1",
    receivedAt: new Date(0).toISOString(),
    actorNodeId: GOLDEN_ACTOR_B.toText(),
    actorDisplayName: null,
    actorAvatarUrl: null,
    actorProfileProof: "unverified",
    kind: "follow",
    verification: "invalid",
    read: false,
    targetPostId: null,
    targetBodyHash: null,
    actionId: null,
    objectDigest: null,
    objectLength: null,
  };
}
