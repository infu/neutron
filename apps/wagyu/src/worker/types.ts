export const WAGYU_VERIFICATION_WORKER_PROTOCOL = 1 as const;
export const WAGYU_VERIFICATION_WORKER_NAME =
  "neutron-wagyu-verifier-v1" as const;

export const WAGYU_LIKE_RECEIPT_CONCURRENCY = 12;
// One task verifies at most two packages (300 receipts). The opaque
// continuation carries the exact verified position for the next request.
export const WAGYU_LIKE_CHAIN_LIMIT = 2;
export const WAGYU_THREAD_REPLY_LIMIT = 25;
export const WAGYU_WORKER_DEFAULT_TIMEOUT_MS = 30_000;
export const WAGYU_WORKER_MAX_TIMEOUT_MS = 120_000;
export const WAGYU_WORKER_MAX_FEED_EVENT_BYTES = 512 * 1_024;
export const WAGYU_WORKER_MAX_SHARE_EDGE_BYTES = 16 * 1_024;

export interface WagyuWorkerTrustedConfigV1 {
  /** Exact root SPKI DER obtained from the trusted Neutron runtime. */
  readonly rootKey: Uint8Array;
  /** Locally derived expected ID; the Worker derives and compares it again. */
  readonly networkId: Uint8Array;
  readonly gatewayOrigin: string;
  readonly allowInsecureLocalhost?: boolean;
  /**
   * Exact package asset origin used for local replica queries. A blob-backed
   * Worker has an opaque location, so it cannot rediscover this safely.
   */
  readonly localAgentHost?: string;
  /**
   * Only the manifest-authorized background surface may select persistence.
   * Direct tile Workers default to bounded in-memory state.
   */
  readonly storageMode?: "memory" | "persistent-background";
}

export interface VerifyProfileTaskV1 {
  readonly kind: "profile";
  readonly nodeId: string;
}

export interface VerifiedProfileValueV1 {
  readonly nodeId: string;
  readonly profileGeneration: string;
  readonly revision: string;
  readonly bodyDigest: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly updatedAtNs: string;
  readonly certificateTimeNs: string;
  readonly highWater: "advance" | "replay";
  readonly avatar:
    | null
    | {
        readonly mediaType: "jpeg" | "png" | "webp";
        readonly width: number;
        readonly height: number;
        readonly bytes: Uint8Array;
      };
}

export interface VerifiedShareEdgeV1 {
  readonly immediateSender: string;
  readonly originalAuthor: string;
  readonly postId: Uint8Array;
  readonly bodyHash: Uint8Array;
  /**
   * Exact CertifiedShareDeliveryV1 bytes. Metadata alone is never authority:
   * the Worker decodes and cryptographically re-verifies this evidence.
   */
  readonly exactShareDeliveryBytes: Uint8Array;
}

export interface VerifyFeedTaskV1 {
  readonly kind: "feed";
  readonly candidateId: string;
  readonly immediateSender: string;
  readonly eventKind: "original" | "share" | "tombstone";
  /** Exact backend-quarantined event Candid bytes. */
  readonly exactEventBytes: Uint8Array;
  /**
   * Optional proof-bearing local hint for a relayed tombstone. When absent,
   * the Worker may use exact cached share-delivery bytes. In either case it
   * cryptographically re-verifies the share; metadata alone is never enough.
   */
  readonly verifiedShareEdge?: VerifiedShareEdgeV1;
}

export interface VerifiedFeedValueV1 {
  readonly candidateId: string;
  readonly eventKind: "original" | "share" | "tombstone";
  readonly authorNodeId: string;
  readonly sharedByNodeId: string | null;
  readonly postId: string;
  readonly bodyHash: string;
  readonly objectDigest: string;
  readonly bodyLength: number;
  readonly bodyMarkdown: string | null;
  readonly actionTimeNs: string;
  readonly replyTo:
    | null
    | {
        readonly state: "verified" | "invalid" | "unavailable";
        readonly code: string | null;
        readonly authorNodeId: string;
        readonly postId: string;
        readonly bodyHash: string;
        readonly objectDigest: string;
        readonly bodyLength: number;
        readonly bodyMarkdown: string | null;
      };
}

export interface VerifyLikesTaskV1 {
  readonly kind: "likes";
  readonly postAuthor: string;
  readonly postId: Uint8Array;
  readonly postBodyHash: Uint8Array;
  /**
   * Opaque continuation issued by this Worker instance. It binds the next
   * page to the exact verified head and duplicate-detection state.
   */
  readonly continuation?: string;
}

export interface VerifyThreadTaskV1 {
  readonly kind: "thread";
  readonly postAuthor: string;
  readonly postId: Uint8Array;
  readonly postBodyHash: Uint8Array;
  readonly postObjectDigest: Uint8Array;
  readonly postBodyLength: number;
  /**
   * Verify only the author-certified index and return its direct-reply count.
   * Reply bodies remain unopened until the user opens the thread.
   */
  readonly summaryOnly?: boolean;
}

export interface VerifiedThreadReplyValueV1 {
  readonly state: "verified" | "invalid" | "unavailable";
  readonly code: string | null;
  readonly authorNodeId: string;
  readonly postId: string;
  readonly objectDigest: string;
  readonly bodyLength: number;
  readonly receivedAtNs: string;
  readonly bodyHash: string | null;
  readonly bodyMarkdown: string | null;
  readonly createdAtNs: string | null;
}

export interface VerifiedThreadValueV1 {
  readonly postAuthor: string;
  readonly postId: string;
  readonly postBodyHash: string;
  readonly replyCount: number;
  readonly index: {
    readonly storeGeneration: string;
    readonly revision: string;
    readonly bodyDigest: string;
  } | null;
  readonly replies: readonly VerifiedThreadReplyValueV1[];
}

export type VerifiedLikeReceiptStateV1 =
  | "verified"
  | "invalid"
  | "unavailable";

export interface VerifiedLikeReceiptValueV1 {
  readonly id: string;
  readonly actorNodeId: string;
  readonly state: VerifiedLikeReceiptStateV1;
  readonly code: string | null;
}

export interface VerifiedLikePackageValueV1 {
  readonly batchDigest: string;
  readonly batchNumber: string;
  readonly state: "verified" | "invalid" | "unavailable";
  readonly code: string | null;
  readonly receipts: readonly VerifiedLikeReceiptValueV1[];
  readonly cache: "verified-now" | "verified-cache";
}

export interface VerifiedLikesValueV1 {
  readonly postAuthor: string;
  readonly postId: string;
  readonly postBodyHash: string;
  readonly head: {
    readonly storeGeneration: string;
    readonly revision: string;
    readonly bodyDigest: string;
    readonly acceptingLikes: boolean;
    readonly sealedBatchCount: string;
  };
  readonly packages: readonly VerifiedLikePackageValueV1[];
  readonly verifiedIncluded: number;
  readonly invalid: number;
  readonly unavailable: number;
  /** True when a valid chain has more than the bounded two packages. */
  readonly truncated: boolean;
  /**
   * Opaque cursor for the next bounded page, or null at genesis/terminal
   * invalidity. Cursors expire and cannot be moved to another post.
   */
  readonly continuation: string | null;
}

export type WagyuWorkerTaskV1 =
  | VerifyProfileTaskV1
  | VerifyFeedTaskV1
  | VerifyThreadTaskV1
  | VerifyLikesTaskV1;

export interface WagyuWorkerTaskMapV1 {
  readonly profile: {
    readonly task: VerifyProfileTaskV1;
    readonly value: VerifiedProfileValueV1;
  };
  readonly feed: {
    readonly task: VerifyFeedTaskV1;
    readonly value: VerifiedFeedValueV1;
  };
  readonly likes: {
    readonly task: VerifyLikesTaskV1;
    readonly value: VerifiedLikesValueV1;
  };
  readonly thread: {
    readonly task: VerifyThreadTaskV1;
    readonly value: VerifiedThreadValueV1;
  };
}

export type WagyuWorkerFailureV1 =
  | {
      readonly state: "invalid";
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly state: "unavailable";
      readonly code: string;
      readonly reason: string;
    };

export type WagyuWorkerResultV1<T> =
  | {
      readonly state: "verified";
      readonly value: T;
    }
  | WagyuWorkerFailureV1;

export type WagyuWorkerInitRequestV1 = {
  readonly protocol: typeof WAGYU_VERIFICATION_WORKER_PROTOCOL;
  readonly type: "init";
  readonly requestId: string;
  readonly trusted: WagyuWorkerTrustedConfigV1;
};

export type WagyuWorkerTaskRequestV1 = {
  readonly protocol: typeof WAGYU_VERIFICATION_WORKER_PROTOCOL;
  readonly type: "task";
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly task: WagyuWorkerTaskV1;
};

export type WagyuWorkerCancelRequestV1 = {
  readonly protocol: typeof WAGYU_VERIFICATION_WORKER_PROTOCOL;
  readonly type: "cancel";
  readonly requestId: string;
};

export type WagyuWorkerRequestV1 =
  | WagyuWorkerInitRequestV1
  | WagyuWorkerTaskRequestV1
  | WagyuWorkerCancelRequestV1;

export type WagyuWorkerResponseV1 = {
  readonly protocol: typeof WAGYU_VERIFICATION_WORKER_PROTOCOL;
  readonly type: "response";
  readonly requestId: string;
  readonly result: WagyuWorkerResultV1<unknown>;
};

export interface WagyuWorkerCallOptionsV1 {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface WagyuWorkerLikeV1 {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  terminate?(): void;
}

export interface WagyuVerificationWorkerClientV1 {
  readonly ready: Promise<WagyuWorkerResultV1<{ readonly networkId: string }>>;
  verifyProfile(
    task: Omit<VerifyProfileTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedProfileValueV1>>;
  verifyFeed(
    task: Omit<VerifyFeedTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedFeedValueV1>>;
  verifyLikes(
    task: Omit<VerifyLikesTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedLikesValueV1>>;
  verifyThread(
    task: Omit<VerifyThreadTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedThreadValueV1>>;
  close(): void;
}
