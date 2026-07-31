import { Principal } from "@dfinity/principal";
import {
  assertActionHeader,
  assertLikeActionIdentity,
  assertTombstoneActionIdentity,
  bytes32,
  decodeCertifiedLikeReceiptV1,
  decodeCertifiedPostRefV1,
  decodeCertifiedShareDeliveryV1,
  decodeCertifiedTombstoneV1,
  decodeLikeActionV1,
  decodePostBodyV1,
  decodeShareActionV1,
  decodeTombstoneActionV1,
  derivePostIdentity,
  deriveShareId,
  equalBytes,
  lowerHex,
  WAGYU_CODECS,
  type ExactDecodedCandidV1,
  type LikeActionV1,
  type PostBodyV1,
  type ShareActionV1,
} from "../protocol/index.ts";
import {
  createWagyuVerifier,
  IC_CERTIFICATE_HEADER,
  likeV1Decoder,
  parseCertificateHeaderV2,
  toBase64,
  trustedWagyuNetworkConfig,
  verifierProofFromProtocol,
  type SemanticDecoderV1,
  type VerificationResultV1,
  type WagyuVerifierV1,
  type TrustedWagyuNetworkConfigV1,
} from "../verifier/index.ts";
import {
  createCanisterHttpQueryFetch,
} from "../verifier/canister_http_query_fetch.ts";
import {
  createWagyuResidentVerificationClient,
  type WagyuResidentVerificationClientV1,
} from "../worker/resident_client.ts";
import type {
  VerifiedFeedValueV1,
  VerifiedLikesValueV1,
  VerifiedProfileValueV1,
  VerifiedThreadValueV1,
  WagyuWorkerResultV1,
} from "../worker/types.ts";
import type {
  FeedAuthor,
  FeedItem,
  LikesDetail,
  NotificationItem,
  PublishResult,
  VerificationIssueCode,
  WagyuProfile,
} from "./model.ts";
import type {
  PreparedAction,
  TrustedRuntimeContext,
  WagyuAdapterPorts,
} from "./service_adapter.ts";

export interface RuntimeVerifier {
  readonly verifier: WagyuVerifierV1;
  readonly network: TrustedWagyuNetworkConfigV1;
  readonly fetch: typeof globalThis.fetch;
  readonly createVerifier: (
    fetcher: typeof globalThis.fetch,
  ) => WagyuVerifierV1;
}

type CanisterQueryFetchFactory = (
  agent: TrustedRuntimeContext["queryAgent"],
) => typeof globalThis.fetch;

export function selectCertifiedFetchForRuntime(
  trust: Pick<
    TrustedRuntimeContext,
    "allowInsecureLocalhost" | "queryAgent"
  >,
  browserFetch: typeof globalThis.fetch = globalThis.fetch,
  localFactory: CanisterQueryFetchFactory = createCanisterHttpQueryFetch,
): typeof globalThis.fetch {
  return trust.allowInsecureLocalhost
    ? localFactory(trust.queryAgent)
    : browserFetch.bind(globalThis);
}

interface PendingFeedVerification {
  readonly item: FeedItem;
  readonly signal?: AbortSignal;
  readonly resolve: (value: FeedItem) => void;
  readonly reject: (reason: unknown) => void;
}

async function runFeedVerificationBatch(
  batch: readonly PendingFeedVerification[],
  loadWorker: () => Promise<WagyuResidentVerificationClientV1>,
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
    signal?: AbortSignal,
  ) => Promise<WagyuProfile>,
): Promise<void> {
  let worker: WagyuResidentVerificationClientV1;
  try {
    worker = await loadWorker();
  } catch (error) {
    for (const entry of batch) entry.reject(error);
    return;
  }

  try {
    const results = await verifyFeedBatchWithWorker(
      worker,
      batch.map((entry) => entry.item),
      loadProfile,
      batch.map((entry) => entry.signal),
    );
    results.forEach((result, index) => batch[index]!.resolve(result));
  } catch (error) {
    for (const entry of batch) entry.reject(error);
  }
}

export async function verifyFeedBatchWithWorker(
  worker: Pick<WagyuResidentVerificationClientV1, "verifyFeed">,
  items: readonly FeedItem[],
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
    signal?: AbortSignal,
  ) => Promise<WagyuProfile>,
  signals: readonly (AbortSignal | undefined)[] = [],
): Promise<FeedItem[]> {
  const results = new Array<FeedItem>(items.length);
  const indexed = items.map((item, index) => ({ item, index }));
  const shares = indexed.filter((entry) => entry.item.kind === "share");
  const remaining = indexed.filter((entry) => entry.item.kind !== "share");
  const verify = async (
    entry: (typeof indexed)[number],
  ): Promise<void> => {
    results[entry.index] = await verifyFeedWithWorker(
      worker,
      entry.item,
      loadProfile,
      signals[entry.index],
    );
  };

  // A verified share commits its exact edge into the Worker cache. Processing
  // those edges before tombstones in the same visible page removes a
  // scheduling race without accepting a relayed tombstone absent evidence.
  await Promise.all(shares.map(verify));
  await Promise.all(remaining.map(verify));
  return results;
}

export interface CertifiedWagyuCoordination {
  finalizePreparedAction(
    prepared: PreparedAction,
    exactProofCandid: Uint8Array,
  ): Promise<PublishResult>;
  recordCandidateDisposition(
    candidate: FeedItem,
    result: FeedItem,
  ): Promise<void>;
  recordNotificationDisposition(
    item: NotificationItem,
    result: NotificationItem,
  ): Promise<void>;
}

export interface CertifiedWagyuPortOptions {
  /**
   * The tile uses the message-bus facade while the resident can inject its
   * already-owned Worker directly. Both paths execute the same verifier.
   */
  loadWorker?: () => Promise<WagyuResidentVerificationClientV1>;
}

export function createCertifiedWagyuPorts(
  loadTrust: () => Promise<TrustedRuntimeContext>,
  coordination: CertifiedWagyuCoordination,
  options: CertifiedWagyuPortOptions = {},
): Required<
  Pick<
    WagyuAdapterPorts,
    | "hydrateCandidate"
    | "hydrateNotification"
    | "loadLikes"
    | "loadThreadReplyCount"
    | "loadThreadReplies"
    | "loadProfile"
    | "finalizePreparedAction"
  >
> {
  let runtimePromise: Promise<RuntimeVerifier> | null = null;
  let workerPromise: Promise<WagyuResidentVerificationClientV1> | null = null;
  let pendingFeedVerifications: PendingFeedVerification[] = [];
  let feedFlushScheduled = false;
  let feedExecutionTail: Promise<void> = Promise.resolve();
  const profileInflight = new Map<
    string,
    Promise<WagyuWorkerResultV1<VerifiedProfileValueV1>>
  >();
  const profileCache = new Map<
    string,
    { value: VerifiedProfileValueV1; expiresAtMs: number; bytes: number }
  >();
  let profileCacheBytes = 0;

  const loadRuntime = (): Promise<RuntimeVerifier> => {
    if (runtimePromise !== null) return runtimePromise;
    let retryable: Promise<RuntimeVerifier>;
    retryable = loadTrust().then((trust) => {
      const gateway = {
        origin: trust.gatewayOrigin,
        ...(trust.allowInsecureLocalhost
          ? { allowInsecureLocalhost: true as const }
          : {}),
      };
      const network = trustedWagyuNetworkConfig(trust.rootKey, gateway);
      if (!equalBytes(network.networkId, trust.networkIdBytes)) {
        throw new Error("Verifier network does not match the trusted runtime");
      }
      const fetcher = selectCertifiedFetchForRuntime(trust);
      const createVerifier = (
        selectedFetch: typeof globalThis.fetch,
      ): WagyuVerifierV1 =>
        createWagyuVerifier({ network, fetch: selectedFetch });
      return {
        verifier: createVerifier(fetcher),
        network,
        fetch: fetcher,
        createVerifier,
      };
    }).catch((error: unknown) => {
      if (runtimePromise === retryable) runtimePromise = null;
      throw error;
    });
    runtimePromise = retryable;
    return runtimePromise;
  };

  const loadWorker = (): Promise<WagyuResidentVerificationClientV1> => {
    if (workerPromise !== null) return workerPromise;
    let retryable: Promise<WagyuResidentVerificationClientV1>;
    retryable = Promise.resolve().then(() => {
      // The resident owns its trusted runtime and packaged Blob Worker on both
      // IC and PocketIC. Keeping one path ensures local verification exercises
      // the same isolation and message boundary as production.
      return options.loadWorker
        ? options.loadWorker()
        : createWagyuResidentVerificationClient();
    }).catch((error: unknown) => {
      if (workerPromise === retryable) workerPromise = null;
      throw error;
    });
    workerPromise = retryable;
    return workerPromise;
  };

  const scheduleFeedVerification = (
    item: FeedItem,
    signal?: AbortSignal,
  ): Promise<FeedItem> =>
    new Promise<FeedItem>((resolve, reject) => {
      pendingFeedVerifications.push({
        item,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      });
      if (feedFlushScheduled) return;
      feedFlushScheduled = true;
      queueMicrotask(() => {
        feedFlushScheduled = false;
        const batch = pendingFeedVerifications;
        pendingFeedVerifications = [];
        feedExecutionTail = feedExecutionTail
          .catch(() => undefined)
          .then(() =>
            runFeedVerificationBatch(
              batch,
              loadWorker,
              loadCertifiedProfile,
            )
          );
      });
    });

  const verifyProfile = (
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<WagyuWorkerResultV1<VerifiedProfileValueV1>> => {
    if (signal !== undefined) {
      return loadWorker().then((worker) =>
        worker.verifyProfile({ nodeId }, { signal })
      );
    }
    const now = Date.now();
    const cached = profileCache.get(nodeId);
    if (cached && cached.expiresAtMs > now) {
      profileCache.delete(nodeId);
      profileCache.set(nodeId, cached);
      return Promise.resolve({
        state: "verified",
        value: cached.value,
      });
    }
    if (cached) {
      profileCache.delete(nodeId);
      profileCacheBytes -= cached.bytes;
    }
    const existing = profileInflight.get(nodeId);
    if (existing) return existing;
    let pending: Promise<WagyuWorkerResultV1<VerifiedProfileValueV1>>;
    pending = loadWorker().then((worker) =>
      worker.verifyProfile({ nodeId })
    ).then((result) => {
      if (result.state === "verified") {
        profileCacheBytes = cacheVerifiedProfile(
          profileCache,
          profileCacheBytes,
          result.value,
        );
      }
      return result;
    }).finally(() => {
      if (profileInflight.get(nodeId) === pending) {
        profileInflight.delete(nodeId);
      }
    });
    profileInflight.set(nodeId, pending);
    return pending;
  };

  const loadCertifiedProfile = async (
    nodeId: string,
    fallback: WagyuProfile,
    signal?: AbortSignal,
  ): Promise<WagyuProfile> => {
    const result = await verifyProfile(nodeId, signal);
    if (result.state !== "verified") {
      return {
        ...fallback,
        displayName: nodeId === fallback.nodeId ? fallback.displayName : "",
        description: nodeId === fallback.nodeId ? fallback.description : "",
        avatarUrl: null,
        avatar: null,
        proofState:
          result.state === "unavailable" ? "unavailable" : "unverified",
      };
    }
    return profileFromWorker(result.value);
  };

  return {
    async hydrateCandidate(item, signal): Promise<FeedItem> {
      const result = await scheduleFeedVerification(item, signal);
      if (signal?.aborted) {
        throw new Error("Feed verification was cancelled");
      }
      return coordinateFeedDisposition(
        result,
        () => coordination.recordCandidateDisposition(item, result),
      );
    },

    async hydrateNotification(
      item,
      evidence,
      ownerNodeId,
    ): Promise<NotificationItem> {
      const { verifier } = await loadRuntime();
      const result = await verifyNotification(
        verifier,
        item,
        evidence,
        ownerNodeId,
        loadCertifiedProfile,
      );
      await safelyCoordinate(() =>
        coordination.recordNotificationDisposition(item, result)
      );
      return result;
    },

    async loadLikes(item): Promise<LikesDetail> {
      return verifyLikesWithWorker(await loadWorker(), item);
    },

    async loadThreadReplies(item): Promise<FeedItem[]> {
      return verifyThreadWithWorker(
        await loadWorker(),
        item,
        loadCertifiedProfile,
      );
    },

    async loadThreadReplyCount(item): Promise<number> {
      return verifyThreadReplyCountWithWorker(await loadWorker(), item);
    },

    loadProfile: loadCertifiedProfile,

    async finalizePreparedAction(prepared): Promise<PublishResult> {
      const runtime = await loadRuntime();
      return verifyCaptureAndFinalize(
        runtime,
        prepared,
        coordination.finalizePreparedAction,
      );
    },
  };
}

const PROFILE_CACHE_TTL_MS = 30_000;
const PROFILE_CACHE_MAX_ENTRIES = 32;
const PROFILE_CACHE_MAX_BYTES = 1 * 1_024 * 1_024;

function cacheVerifiedProfile(
  cache: Map<
    string,
    { value: VerifiedProfileValueV1; expiresAtMs: number; bytes: number }
  >,
  currentBytes: number,
  value: VerifiedProfileValueV1,
): number {
  const encoder = new TextEncoder();
  const bytes =
    (value.avatar?.bytes.byteLength ?? 0) +
    encoder.encode(value.displayName).byteLength +
    encoder.encode(value.description).byteLength +
    256;
  const previous = cache.get(value.nodeId);
  if (previous) {
    cache.delete(value.nodeId);
    currentBytes -= previous.bytes;
  }
  if (bytes > PROFILE_CACHE_MAX_BYTES) return currentBytes;
  while (
    cache.size >= PROFILE_CACHE_MAX_ENTRIES ||
    currentBytes + bytes > PROFILE_CACHE_MAX_BYTES
  ) {
    const oldest = cache.entries().next().value as
      | [string, { bytes: number }]
      | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    currentBytes -= oldest[1].bytes;
  }
  cache.set(value.nodeId, {
    value,
    expiresAtMs: Date.now() + PROFILE_CACHE_TTL_MS,
    bytes,
  });
  return currentBytes + bytes;
}

function profileFromWorker(profile: VerifiedProfileValueV1): WagyuProfile {
  const avatar = profile.avatar
    ? {
        mediaType: profile.avatar.mediaType,
        width: profile.avatar.width,
        height: profile.avatar.height,
        bytes: profile.avatar.bytes.slice(),
      }
    : null;
  return {
    nodeId: profile.nodeId,
    profileGeneration: profile.profileGeneration,
    revision: profile.revision,
    displayName: profile.displayName,
    description: profile.description,
    avatarUrl: avatar ? avatarDataUrl(avatar.mediaType, avatar.bytes) : null,
    avatar,
    proofState: "fresh",
    protocolVersion: "wagyu_v1",
    compatible: true,
    updatedAt: nanosecondsTextToIso(profile.updatedAtNs),
  };
}

export async function verifyFeedWithWorker(
  worker: Pick<WagyuResidentVerificationClientV1, "verifyFeed">,
  item: FeedItem,
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
    signal?: AbortSignal,
  ) => Promise<WagyuProfile>,
  signal?: AbortSignal,
): Promise<FeedItem> {
  if (!item.opaqueEventBytes || item.kind === "unsupported") {
    return {
      ...item,
      verification: item.kind === "unsupported" ? "unsupported" : "invalid",
      verificationIssue:
        item.kind === "unsupported" ? "unsupported" : "candid-invalid",
      body: null,
      sharedBy: null,
    };
  }
  const exactEventBytes = item.opaqueEventBytes.slice();
  const result = await worker.verifyFeed(
    {
      candidateId: item.id,
      immediateSender: item.immediateSender,
      eventKind: item.kind,
      exactEventBytes,
    },
    signal === undefined ? {} : { signal },
  );
  if (result.state !== "verified") {
    return failedFeedItem(
      { ...item, opaqueEventBytes: exactEventBytes },
      result.state,
      verificationIssueFromFailure(result.state, result.code, result.reason),
    );
  }
  try {
    return await feedItemFromWorker(
      item,
      exactEventBytes,
      result.value,
      loadProfile,
      signal,
    );
  } catch (error) {
    return failedFeedItem(
      { ...item, opaqueEventBytes: exactEventBytes },
      "invalid",
      verificationIssueFromFailure(
        "invalid",
        "invalid_worker_result",
        error instanceof Error ? error.message : "",
      ),
    );
  }
}

async function feedItemFromWorker(
  candidate: FeedItem,
  exactEventBytes: Uint8Array,
  verified: VerifiedFeedValueV1,
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
    signal?: AbortSignal,
  ) => Promise<WagyuProfile>,
  signal?: AbortSignal,
): Promise<FeedItem> {
  if (
    verified.candidateId !== candidate.id ||
    verified.eventKind !== candidate.kind
  ) {
    throw new Error("Verification Worker returned another feed candidate");
  }
  const exactOriginalPostRef =
    verified.eventKind === "original"
      ? exactEventBytes.slice()
      : verified.eventKind === "share"
        ? decodeCertifiedShareDeliveryV1(exactEventBytes)
            .value.original_post_ref_candid.slice()
        : null;
  const [author, sharedBy, replyAuthor] = await Promise.all([
    verifiedFeedAuthor(verified.authorNodeId, loadProfile, signal),
    verified.sharedByNodeId
      ? verifiedFeedAuthor(verified.sharedByNodeId, loadProfile, signal)
      : Promise.resolve(null),
    verified.replyTo?.state === "verified"
      ? verifiedFeedAuthor(
          verified.replyTo.authorNodeId,
          loadProfile,
          signal,
        )
      : Promise.resolve(null),
  ]);
  return {
    ...candidate,
    kind: verified.eventKind,
    verification: "verified",
    verificationIssue: null,
    author,
    postId: verified.postId,
    body: verified.bodyMarkdown,
    bodyDigest: verified.bodyHash,
    objectDigest: verified.objectDigest,
    bodyLength: verified.bodyLength,
    createdAt: nanosecondsTextToIso(verified.actionTimeNs),
    sharedBy,
    replyTo: verified.replyTo
      ? {
          authorNodeId: verified.replyTo.authorNodeId,
          author: replyAuthor,
          postId: verified.replyTo.postId,
          body: verified.replyTo.state === "verified"
            ? verified.replyTo.bodyMarkdown
            : null,
          verified: verified.replyTo.state === "verified",
        }
      : null,
    opaqueEventBytes: exactEventBytes.slice(),
    originalPostRefBytes: exactOriginalPostRef,
  };
}

export async function verifyThreadWithWorker(
  worker: Pick<WagyuResidentVerificationClientV1, "verifyThread">,
  item: FeedItem,
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
  ) => Promise<WagyuProfile>,
): Promise<FeedItem[]> {
  const result = await verifyThreadResult(worker, item, false);
  return threadRepliesFromWorker(item, result, loadProfile);
}

export async function verifyThreadReplyCountWithWorker(
  worker: Pick<WagyuResidentVerificationClientV1, "verifyThread">,
  item: FeedItem,
): Promise<number> {
  const result = await verifyThreadResult(worker, item, true);
  return result.replyCount;
}

export class MissingCertifiedReplyIndexError extends Error {
  readonly code = "http_404";

  constructor(reason: string) {
    super(`Certified reply index unavailable: ${reason}`);
    this.name = "MissingCertifiedReplyIndexError";
  }
}

export function isMissingCertifiedReplyIndexError(
  reason: unknown,
): reason is MissingCertifiedReplyIndexError {
  return reason instanceof MissingCertifiedReplyIndexError;
}

async function verifyThreadResult(
  worker: Pick<WagyuResidentVerificationClientV1, "verifyThread">,
  item: FeedItem,
  summaryOnly: boolean,
): Promise<VerifiedThreadValueV1> {
  const postId = parseHex32(item.postId);
  const postBodyHash = parseHex32(item.bodyDigest);
  const postObjectDigest = parseHex32(item.objectDigest);
  if (
    !postId ||
    !postBodyHash ||
    !postObjectDigest ||
    item.bodyLength === null
  ) {
    throw new Error("Verified post metadata is incomplete");
  }
  const result = await worker.verifyThread({
    postAuthor: item.author.nodeId,
    postId,
    postBodyHash,
    postObjectDigest,
    postBodyLength: item.bodyLength,
    summaryOnly,
  });
  if (result.state !== "verified") {
    if (result.state === "unavailable" && result.code === "http_404") {
      throw new MissingCertifiedReplyIndexError(result.reason);
    }
    throw new Error(
      `Certified reply index ${result.state}: ${result.reason}`,
    );
  }
  if (
    result.value.postAuthor !== item.author.nodeId ||
    result.value.postId !== item.postId ||
    result.value.postBodyHash !== item.bodyDigest
  ) throw new Error("Verification Worker returned another thread");
  return result.value;
}

async function threadRepliesFromWorker(
  parent: FeedItem,
  verified: VerifiedThreadValueV1,
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
  ) => Promise<WagyuProfile>,
): Promise<FeedItem[]> {
  const released = verified.replies.filter(
    (reply) =>
      reply.state === "verified" &&
      reply.bodyHash !== null &&
      reply.bodyMarkdown !== null &&
      reply.createdAtNs !== null,
  );
  const authors = new Map<string, FeedAuthor>();
  await Promise.all(
    [...new Set(released.map((reply) => reply.authorNodeId))].map(
      async (nodeId) => {
        authors.set(
          nodeId,
          await verifiedFeedAuthor(nodeId, loadProfile),
        );
      },
    ),
  );
  return released.map((reply) => ({
    id:
      `thread-reply:${parent.author.nodeId}:${parent.postId}:` +
      `${reply.authorNodeId}:${reply.postId}`,
    localSequence: reply.receivedAtNs,
    receivedAt: nanosecondsTextToIso(reply.receivedAtNs) ??
      new Date(0).toISOString(),
    immediateSender: reply.authorNodeId,
    kind: "original",
    verification: "verified",
    verificationIssue: null,
    promotion: "committed",
    author: authors.get(reply.authorNodeId)!,
    postId: reply.postId,
    body: reply.bodyMarkdown,
    bodyDigest: reply.bodyHash,
    objectDigest: reply.objectDigest,
    bodyLength: reply.bodyLength,
    createdAt: nanosecondsTextToIso(reply.createdAtNs!),
    sharedBy: null,
    replyTo: {
      authorNodeId: parent.author.nodeId,
      author: parent.author,
      postId: parent.postId,
      body: parent.body,
      verified: true,
    },
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
  }));
}

export async function verifyLikesWithWorker(
  worker: Pick<WagyuResidentVerificationClientV1, "verifyLikes">,
  item: FeedItem,
  continuation?: string,
): Promise<LikesDetail> {
  const postId = parseHex32(item.postId);
  const postBodyHash = parseHex32(item.bodyDigest);
  if (!postId || !postBodyHash) {
    throw new Error("Verified post metadata is incomplete");
  }
  const result = await worker.verifyLikes({
    postAuthor: item.author.nodeId,
    postId,
    postBodyHash,
    ...(continuation === undefined ? {} : { continuation }),
  });
  if (result.state !== "verified") {
    throw new Error(`Certified Like evidence ${result.state}: ${result.reason}`);
  }
  const detail = likesFromWorker(item, result.value);
  const next = result.value.continuation;
  return {
    ...detail,
    loadOlder: next === null
      ? null
      : () => verifyLikesWithWorker(worker, item, next),
  };
}

function likesFromWorker(
  item: FeedItem,
  verified: VerifiedLikesValueV1,
): LikesDetail {
  if (
    verified.postAuthor !== item.author.nodeId ||
    verified.postId !== item.postId ||
    verified.postBodyHash !== item.bodyDigest
  ) {
    throw new Error("Verification Worker returned Likes for another post");
  }
  return {
    postId: item.postId,
    packages: verified.packages.map((batch) => ({
      id: batch.batchDigest,
      batchNumber: batch.batchNumber,
      state: batch.state,
      cache: batch.cache,
      receipts: batch.receipts.map((receipt) => ({
        id: receipt.id,
        actorNodeId: receipt.actorNodeId,
        actorDisplayName: null,
        state: receipt.state,
      })),
    })),
    awaitingBatch: [],
    truncated: verified.truncated,
    acceptingLikes: verified.head.acceptingLikes,
  };
}

async function verifiedFeedAuthor(
  nodeId: string,
  loadProfile: (
    nodeId: string,
    fallback: WagyuProfile,
    signal?: AbortSignal,
  ) => Promise<WagyuProfile>,
  signal?: AbortSignal,
): Promise<FeedAuthor> {
  const fallback: WagyuProfile = {
    nodeId,
    profileGeneration: "0",
    revision: "0",
    displayName: "",
    description: "",
    avatarUrl: null,
    avatar: null,
    proofState: "loading",
    protocolVersion: "wagyu_v1",
    compatible: true,
    updatedAt: null,
  };
  let profile: WagyuProfile;
  try {
    profile = await loadProfile(nodeId, fallback, signal);
  } catch {
    // Profile presentation is an independent certified object. Its transport
    // or decode failure cannot invalidate an already verified post/action.
    return {
      nodeId,
      displayName: null,
      avatarUrl: null,
      profileProof: "unavailable",
    };
  }
  return {
    nodeId,
    displayName:
      profile.proofState === "fresh" || profile.proofState === "stale"
        ? profile.displayName || null
        : null,
    avatarUrl:
      profile.proofState === "fresh" || profile.proofState === "stale"
        ? profile.avatarUrl
        : null,
    profileProof: profile.proofState,
  };
}

async function verifyNotification(
  verifier: WagyuVerifierV1,
  item: NotificationItem,
  evidence: Uint8Array | null,
  ownerNodeId: string,
  loadProfile: (nodeId: string, fallback: WagyuProfile) => Promise<WagyuProfile>,
): Promise<NotificationItem> {
  if (item.kind === "follow") {
    return item.verification === "transport-authenticated"
      ? notificationWithProfile(
          item,
          await verifiedFeedAuthor(item.actorNodeId, loadProfile),
        )
      : failedNotification(item, "invalid");
  }
  if (item.kind === "unsupported") return item;
  const actionId = notificationBytes(item.actionId);
  const objectDigest = notificationBytes(item.objectDigest);
  const targetPostId = notificationBytes(item.targetPostId);
  const targetBodyHash = notificationBytes(item.targetBodyHash);
  if (
    !actionId ||
    !objectDigest ||
    !targetPostId ||
    !targetBodyHash ||
    item.objectLength === null
  ) {
    return failedNotification(item, "invalid");
  }
  try {
    let result:
      | VerificationResultV1<ExactDecodedCandidV1<PostBodyV1>>
      | VerificationResultV1<ExactDecodedCandidV1<ShareActionV1>>
      | VerificationResultV1<ExactDecodedCandidV1<LikeActionV1>>;
    let verifiedReply: NotificationItem["verifiedReply"] = null;
    if (item.kind === "like") {
      if (!evidence) return failedNotification(item, "unavailable");
      const receipt = decodeCertifiedLikeReceiptV1(evidence).value;
      if (
        receipt.ref.actor.toText() !== item.actorNodeId ||
        !equalBytes(receipt.ref.object_digest, objectDigest) ||
        receipt.ref.body_length !== item.objectLength
      ) {
        return failedNotification(item, "invalid");
      }
      result = await verifier.verifyPortable({
        actor: item.actorNodeId,
        target: {
          kind: "action",
          actionKind: "like",
          digest: objectDigest,
        },
        body: receipt.like_action_candid,
        proof: verifierProofFromProtocol(receipt.ref.proof_snapshot),
        decoder: likeV1Decoder(receipt.ref),
      });
      if (result.state === "verified") {
        const like = result.value.value;
        if (
          !equalBytes(like.like_id, actionId) ||
          like.post_author.toText() !== ownerNodeId ||
          !equalBytes(like.post_id, targetPostId) ||
          !equalBytes(like.post_body_hash, targetBodyHash)
        ) {
          return failedNotification(item, "invalid");
        }
      }
    } else if (item.kind === "reply") {
      const replyResult = await verifier.fetchAndVerify({
        actor: item.actorNodeId,
        target: {
          kind: "action",
          actionKind: "post",
          digest: objectDigest,
        },
        decoder: notificationReplyDecoder(
          item.actorNodeId,
          ownerNodeId,
          actionId,
          objectDigest,
          item.objectLength,
          targetPostId,
          targetBodyHash,
        ),
      });
      result = replyResult;
      if (replyResult.state === "verified") {
        const identity = derivePostIdentity(replyResult.value);
        const replyTo = replyResult.value.value.reply_to[0]!;
        verifiedReply = {
          authorNodeId: item.actorNodeId,
          postId: lowerHex(identity.post_id),
          bodyMarkdown: replyResult.value.value.body_markdown,
          bodyHash: lowerHex(identity.body_hash),
          bodyLength: identity.body_length,
          objectDigest: lowerHex(identity.object_digest),
          createdAt: nanosecondsTextToIso(
            replyResult.value.value.created_at_ns.toString(),
          ),
          replyTo: {
            authorNodeId: replyTo.author.toText(),
            postId: lowerHex(replyTo.post_id),
            bodyHash: lowerHex(replyTo.body_hash),
            bodyLength: replyTo.body_length,
            objectDigest: lowerHex(replyTo.object_digest),
          },
        };
      }
    } else {
      result = await verifier.fetchAndVerify({
        actor: item.actorNodeId,
        target: {
          kind: "action",
          actionKind: "share",
          digest: objectDigest,
        },
        decoder: notificationShareDecoder(
          item.actorNodeId,
          ownerNodeId,
          actionId,
          objectDigest,
          item.objectLength,
          targetPostId,
          targetBodyHash,
        ),
      });
    }
    if (result.state !== "verified") {
      return failedNotification(item, result.state);
    }
    return notificationWithProfile(
      { ...item, verification: "verified", verifiedReply },
      await verifiedFeedAuthor(item.actorNodeId, loadProfile),
    );
  } catch {
    return failedNotification(item, "invalid");
  }
}

function notificationReplyDecoder(
  actorNodeId: string,
  ownerNodeId: string,
  actionId: Uint8Array,
  objectDigest: Uint8Array,
  objectLength: number,
  targetPostId: Uint8Array,
  targetBodyHash: Uint8Array,
): SemanticDecoderV1<ExactDecodedCandidV1<PostBodyV1>> {
  return {
    async decodeAndValidate(exactBody, context) {
      const actor = Principal.fromText(actorNodeId);
      const decoded = decodePostBodyV1(exactBody);
      assertActionHeader(
        decoded.value.header,
        bytes32(context.networkId, "trusted network_id"),
        actor,
        "post",
      );
      const identity = derivePostIdentity(decoded);
      const reply = decoded.value.reply_to[0];
      if (
        context.actor !== actorNodeId ||
        !equalBytes(identity.post_id, actionId) ||
        !equalBytes(identity.object_digest, objectDigest) ||
        identity.body_length !== objectLength ||
        !reply ||
        reply.author.toText() !== ownerNodeId ||
        !equalBytes(reply.post_id, targetPostId) ||
        !equalBytes(reply.body_hash, targetBodyHash)
      ) {
        throw new Error("Reply notification does not bind its local target");
      }
      return decoded;
    },
  };
}

function notificationShareDecoder(
  actorNodeId: string,
  ownerNodeId: string,
  actionId: Uint8Array,
  objectDigest: Uint8Array,
  objectLength: number,
  targetPostId: Uint8Array,
  targetBodyHash: Uint8Array,
): SemanticDecoderV1<ExactDecodedCandidV1<ShareActionV1>> {
  return {
    async decodeAndValidate(exactBody, context) {
      const actor = Principal.fromText(actorNodeId);
      const decoded = decodeShareActionV1(exactBody);
      assertActionHeader(
        decoded.value.header,
        bytes32(context.networkId, "trusted network_id"),
        actor,
        "share",
      );
      const expectedShareId = deriveShareId(
        decoded.value.header.network_id,
        actor,
        decoded.value.original_author,
        decoded.value.original_post_id,
      );
      if (
        context.actor !== actorNodeId ||
        !equalBytes(decoded.object_digest, objectDigest) ||
        decoded.exact_bytes.byteLength !== objectLength ||
        !equalBytes(decoded.value.share_id, expectedShareId) ||
        !equalBytes(decoded.value.share_id, actionId) ||
        decoded.value.original_author.toText() !== ownerNodeId ||
        !equalBytes(decoded.value.original_post_id, targetPostId) ||
        !equalBytes(decoded.value.original_body_hash, targetBodyHash)
      ) {
        throw new Error("Share notification does not bind its local target");
      }
      return decoded;
    },
  };
}

function notificationWithProfile(
  item: NotificationItem,
  actor: FeedAuthor,
): NotificationItem {
  return {
    ...item,
    actorDisplayName: actor.displayName,
    actorAvatarUrl: actor.avatarUrl,
    actorProfileProof: actor.profileProof,
  };
}

function failedNotification(
  item: NotificationItem,
  state: "invalid" | "unavailable",
): NotificationItem {
  return {
    ...item,
    verification: state,
    actorDisplayName: null,
    actorAvatarUrl: null,
    actorProfileProof: state === "unavailable" ? "unavailable" : "unverified",
    verifiedReply: null,
  };
}

function notificationBytes(value: string | null): Uint8Array | null {
  return parseHex32(value);
}

function failedFeedItem(
  item: FeedItem,
  state: "invalid" | "unavailable",
  issue: VerificationIssueCode = state === "unavailable"
    ? "fetch-unavailable"
    : "unknown",
): FeedItem {
  return {
    ...item,
    verification: state,
    verificationIssue: issue,
    body: null,
    sharedBy: null,
  };
}

function verificationIssueFromFailure(
  state: "invalid" | "unavailable",
  code: string,
  reason: string,
): VerificationIssueCode {
  // No transport status or error string is certified evidence that a
  // discovered object never existed. Keep all live-fetch failures retryable.
  if (state === "unavailable") return "fetch-unavailable";
  const evidence = `${code} ${reason}`.toLowerCase();
  if (
    evidence.includes("was not visible") ||
    evidence.includes("did not expose")
  ) {
    return "fetch-unavailable";
  }
  if (
    evidence.includes("content-digest") ||
    evidence.includes("content digest")
  ) {
    return "content-digest-mismatch";
  }
  if (
    evidence.includes("body digest") ||
    evidence.includes("object digest") ||
    evidence.includes("content-addressed")
  ) {
    return "object-digest-mismatch";
  }
  if (
    evidence.includes("certificate") ||
    evidence.includes("certification") ||
    evidence.includes("witness") ||
    evidence.includes("expression path")
  ) {
    return "certificate-invalid";
  }
  if (
    evidence.includes("candid") ||
    evidence.includes("decode") ||
    evidence.includes("malformed")
  ) {
    return "candid-invalid";
  }
  if (evidence.includes("unsupported")) return "unsupported";
  return "binding-invalid";
}

async function safelyCoordinate(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // The proof result remains truthful if local bookkeeping is temporarily
    // unavailable. Refreshing the page retries the audited bridge update.
  }
}

export async function coordinateFeedDisposition(
  result: FeedItem,
  run: () => Promise<void>,
): Promise<FeedItem> {
  if (result.verification === "unavailable") {
    // Transport, resident startup, and remote availability failures are
    // retryable observations, not durable evidence about the candidate.
    // Keeping the backend row pending lets a later browser session retry it
    // automatically instead of turning one transient outage into a terminal
    // local disposition.
    return result;
  }
  if (result.verification !== "verified") {
    await safelyCoordinate(run);
    return result;
  }
  try {
    await run();
    return { ...result, promotion: "committed" };
  } catch {
    return {
      ...result,
      promotion: "failed",
      verificationIssue: "promotion-failed",
    };
  }
}

export async function verifyCaptureAndFinalize(
  runtime: RuntimeVerifier,
  prepared: PreparedAction,
  finalize: CertifiedWagyuCoordination["finalizePreparedAction"],
): Promise<PublishResult> {
  const exactPrepared: PreparedAction = {
    actor: prepared.actor,
    kind: prepared.kind,
    actionId: prepared.actionId.slice(),
    objectDigest: prepared.objectDigest.slice(),
  };
  let certificateHeader: string | null = null;
  const captureFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await runtime.fetch(input, init);
    certificateHeader = response.headers.get(IC_CERTIFICATE_HEADER);
    return response;
  };
  // The verifier only invokes the standard fetch call signature. Bun adds a
  // non-standard `preconnect` member to `typeof fetch`, so keep the capture
  // wrapper narrow and bridge that ambient typing at this boundary.
  const verifier = runtime.createVerifier(
    captureFetch as typeof globalThis.fetch,
  );
  const result = await verifier.fetchAndVerify({
    actor: exactPrepared.actor,
    target: {
      kind: "action",
      actionKind: exactPrepared.kind,
      digest: exactPrepared.objectDigest,
    },
    decoder: preparedActionDecoder(exactPrepared),
  });
  if (result.state !== "verified") {
    throw new Error(
      `Certified ${exactPrepared.kind} proof was not finalized: ${result.reason}`,
    );
  }
  if (!certificateHeader) {
    throw new Error("Certified action response omitted its proof header");
  }
  const proof = parseCertificateHeaderV2(certificateHeader);
  // The exact response was already verified above. Only that same captured
  // proof is encoded into the ordinary API-1 finalize request. No proof bytes
  // are re-fetched or accepted from a backend response.
  const exactProof = WAGYU_CODECS.CertifiedHttpProofV1.encode({
    certificate_version: proof.certificateVersion,
    certificate_cbor: proof.certificateCbor,
    witness_cbor: proof.witnessCbor,
    expression_path_cbor: proof.expressionPathCbor,
    certificate_time_ns: result.certificateTimeNs,
  });
  return finalize(exactPrepared, exactProof);
}

function preparedActionDecoder(
  prepared: PreparedAction,
): SemanticDecoderV1<unknown> {
  return {
    decodeAndValidate(exactBody, context) {
      const actor = Principal.fromText(prepared.actor);
      const networkId = bytes32(context.networkId, "trusted network_id");
      switch (prepared.kind) {
        case "post": {
          const decoded = decodePostBodyV1(exactBody);
          assertActionHeader(decoded.value.header, networkId, actor, "post");
          const identity = derivePostIdentity(decoded);
          if (
            !equalBytes(identity.post_id, prepared.actionId) ||
            !equalBytes(identity.object_digest, prepared.objectDigest)
          ) {
            throw new Error("Prepared post identity does not match certified bytes");
          }
          return decoded;
        }
        case "share": {
          const decoded = decodeShareActionV1(exactBody);
          assertActionHeader(decoded.value.header, networkId, actor, "share");
          const shareId = deriveShareId(
            networkId,
            actor,
            decoded.value.original_author,
            decoded.value.original_post_id,
          );
          if (
            !equalBytes(shareId, prepared.actionId) ||
            !equalBytes(decoded.object_digest, prepared.objectDigest)
          ) {
            throw new Error("Prepared share identity does not match certified bytes");
          }
          return decoded;
        }
        case "like": {
          const decoded = decodeLikeActionV1(exactBody);
          assertLikeActionIdentity(decoded.value, networkId, actor);
          if (
            !equalBytes(decoded.value.like_id, prepared.actionId) ||
            !equalBytes(decoded.object_digest, prepared.objectDigest)
          ) {
            throw new Error("Prepared Like identity does not match certified bytes");
          }
          return decoded;
        }
        case "tombstone": {
          const decoded = decodeTombstoneActionV1(exactBody);
          assertTombstoneActionIdentity(decoded.value, networkId, actor);
          if (
            !equalBytes(decoded.value.tombstone_id, prepared.actionId) ||
            !equalBytes(decoded.object_digest, prepared.objectDigest)
          ) {
            throw new Error(
              "Prepared tombstone identity does not match certified bytes",
            );
          }
          return decoded;
        }
      }
    },
  };
}

function nanosecondsToIso(value: bigint): string | null {
  const milliseconds = value / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return new Date(Number(milliseconds)).toISOString();
}

function nanosecondsTextToIso(value: string): string | null {
  try {
    return nanosecondsToIso(BigInt(value));
  } catch {
    return null;
  }
}

export function avatarDataUrl(
  mediaType: "jpeg" | "png" | "webp",
  bytes: Uint8Array,
): string {
  const type = mediaType === "jpeg" ? "jpeg" : mediaType;
  return `data:image/${type};base64,${toBase64(bytes)}`;
}

function parseHex32(value: string | null): Uint8Array | null {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
