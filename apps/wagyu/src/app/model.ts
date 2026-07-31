export type ViewId =
  | "feed"
  | "notifications"
  | "relationships"
  | "profile"
  | "user-profile";

export type ProofState =
  | "loading"
  | "fresh"
  | "stale"
  | "unverified"
  | "unavailable";

export type VerificationState =
  | "candidate"
  | "fetching"
  | "http-certified"
  | "object-digest-valid"
  | "action-body-valid"
  | "verified"
  | "unavailable"
  | "unverified"
  | "invalid"
  | "unsupported";

/**
 * Bounded, presentation-safe reason codes. Raw verifier errors and proof bytes
 * must never be copied into UI state.
 */
export type VerificationIssueCode =
  | "fetch-unavailable"
  | "object-not-found"
  | "certificate-invalid"
  | "content-digest-mismatch"
  | "object-digest-mismatch"
  | "candid-invalid"
  | "binding-invalid"
  | "promotion-failed"
  | "unsupported"
  | "unknown";

export type FeedPromotionState =
  | "pending"
  | "committed"
  | "failed";

export type NotificationVerification =
  | "transport-authenticated"
  | "pending"
  | "verified"
  | "invalid"
  | "unavailable"
  | "unsupported";

export type RelationshipState =
  | "registering"
  | "active"
  | "credit-low"
  | "expired"
  | "cleanup-pending"
  | "incompatible"
  | "blocked";

export type RelationshipAction =
  | "follow"
  | "renew"
  | "unfollow"
  | "block"
  | "unblock";

export interface RelationshipBusy {
  nodeId: string;
  action: RelationshipAction;
}

export type PublishStage =
  | "draft"
  | "encoding"
  | "publishing"
  | "awaiting-proof"
  | "certified-ref-ready"
  | "withdrawal-closing"
  | "fanout-queued"
  | "sending"
  | "complete"
  | "partial"
  | "failed"
  | "uncertain";

export interface WagyuProfile {
  nodeId: string;
  profileGeneration: string;
  revision: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  avatar: {
    mediaType: "jpeg" | "png" | "webp";
    width: number;
    height: number;
    bytes: Uint8Array;
  } | null;
  proofState: ProofState;
  protocolVersion: string;
  compatible: boolean;
  updatedAt: string | null;
}

export interface WagyuStatus {
  nodeId: string;
  /**
   * Installer-seeded backend value. The UI compares it with, and never trusts
   * it over, trustedNetwork. Missing or mismatched values are fatal.
   */
  configuredNetworkId: string | null;
  networkConfigured: boolean;
  /** Whether the owner granted Wagyu access to its paid peer ingress method. */
  peerDeliveryEnabled: boolean;
  protocolVersion: string;
  unreadFeed: number;
  unreadNotifications: number;
  outboxErrors: number;
  outboxPaused: boolean;
  certifiedStoreReady: boolean;
  releaseGateMessage: string | null;
  preview: boolean;
}

export interface TrustedNetwork {
  networkId: string;
  target: "ic" | "pocketic" | "preview";
  rootKeyPolicy: "mainnet" | "fetch" | "preview";
  source: string;
}

export interface FeedAuthor {
  nodeId: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileProof: ProofState;
}

export interface FeedItem {
  id: string;
  localSequence: string;
  receivedAt: string;
  immediateSender: string;
  kind: "original" | "share" | "tombstone" | "unsupported";
  verification: VerificationState;
  /** Optional bounded reason for a non-terminal verification outcome. */
  verificationIssue?: VerificationIssueCode | null;
  /**
   * Whether the verifier result was durably promoted into the local canonical
   * feed. A verified tombstone suppresses content only after this is committed.
   */
  promotion: FeedPromotionState;
  author: FeedAuthor;
  postId: string;
  body: string | null;
  /** Post body hash (`wagyu.post-body.v1`), never an unverified remote claim. */
  bodyDigest: string | null;
  objectDigest: string | null;
  bodyLength: number | null;
  createdAt: string | null;
  sharedBy: FeedAuthor | null;
  replyTo: {
    authorNodeId: string;
    author: FeedAuthor | null;
    postId: string | null;
    body: string | null;
    verified: boolean;
  } | null;
  likedByOwner: boolean;
  likeSummary: {
    verified: number;
    invalid: number;
    unavailable: number;
    awaitingBatch: number;
  };
  localOrigin: boolean;
  /** Owner-local authenticated likers still awaiting a certified batch. */
  localAwaitingLikerIds?: readonly string[];
  /** Exact backend-provided event bytes retained for the verifier; never rendered. */
  opaqueEventBytes: Uint8Array | null;
  /**
   * Exact CertifiedPostRefV1 bytes recovered only after verification. Shares
   * re-use these bytes; they are never reconstructed from display fields.
   */
  originalPostRefBytes: Uint8Array | null;
  /** Number of committed verified delivery rows merged into this card. */
  verifiedDeliveryCount?: number;
  /** Direct replies counted from the author's verified mutable reply index. */
  verifiedReplyCount?: number;
}

export interface FeedPage {
  revision: string;
  items: FeedItem[];
  nextCursor: string | null;
}

export interface NotificationItem {
  id: string;
  localSequence: string;
  receivedAt: string;
  actorNodeId: string;
  actorDisplayName: string | null;
  actorAvatarUrl: string | null;
  actorProfileProof: ProofState;
  kind: "follow" | "like" | "reply" | "share" | "unsupported";
  verification: NotificationVerification;
  read: boolean;
  targetPostId: string | null;
  targetBodyHash: string | null;
  actionId: string | null;
  objectDigest: string | null;
  objectLength: number | null;
  /**
   * Renderable reply content released only after the remote post object and
   * its binding to this notification's locally authored target verify.
   */
  verifiedReply?: {
    authorNodeId: string;
    postId: string;
    bodyMarkdown: string;
    bodyHash: string;
    bodyLength: number;
    objectDigest: string;
    createdAt: string | null;
    replyTo: {
      authorNodeId: string;
      postId: string;
      bodyHash: string;
      bodyLength: number;
      objectDigest: string;
    };
  } | null;
}

export interface NotificationPage {
  revision: string;
  items: NotificationItem[];
  nextCursor: string | null;
}

export type AuthoredPostState =
  | "awaiting-proof"
  | "live"
  | "withdrawal-awaiting-proof"
  | "withdrawal-closing"
  | "withdrawn"
  | "unknown";

export type AuthoredProtocolActionState =
  | "awaiting-publication"
  | "awaiting-proof"
  | "certified"
  | "uncertain"
  | "failed"
  | "unknown";

interface AuthoredItemBase {
  sequence: string;
  actionId: string;
  objectDigest: string | null;
  createdAt: string | null;
}

export interface AuthoredPost extends AuthoredItemBase {
  kind: "post";
  /** The post action ID is the post ID in Wagyu V1. */
  postId: string;
  state: AuthoredPostState;
  /** Owner-local text from the exact retained post body. */
  bodyMarkdown?: string | null;
  /** Exact retained PostBodyV1 Candid byte length. */
  bodyLength?: number | null;
  replyTo?: {
    authorNodeId: string;
    postId: string;
  } | null;
  localLikeView?: {
    postBodyHash: string;
    unsealedReceiptCount: number;
    /** Owner-local authenticated callers for the currently unsealed receipts. */
    unsealedLikerIds: string[];
    revision: string;
  } | null;
}

export interface AuthoredProtocolAction extends AuthoredItemBase {
  kind: "share" | "like" | "tombstone";
  state: AuthoredProtocolActionState;
  /** Original post targeted by this owner-local protocol action. */
  targetPostId?: string | null;
}

export type AuthoredItem = AuthoredPost | AuthoredProtocolAction;

export interface AuthoredPage {
  revision: string;
  items: AuthoredItem[];
  nextCursor: string | null;
}

export interface Relationship {
  nodeId: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileProof: ProofState;
  youFollow: boolean;
  followsYou: boolean;
  /** State of this owner's outbound registration at the peer. */
  followingState: RelationshipState | null;
  /** State of the peer's inbound follower registration at this node. */
  followerState: RelationshipState | null;
  /** Delivery credits the peer prepaid to receive this node's fanout. */
  followerCredits: number;
  /** Expiry of the peer's inbound follower lease at this node. */
  followerLeaseExpiresAt: string | null;
  /** Latest verified delivery from this node asked this owner to renew following. */
  followingRenewalRequested: boolean;
  renewalCostCycles: string;
  protocolVersion: string;
  compatible: boolean;
  blocked: boolean;
}

export interface RelationshipPage {
  revision: string;
  items: Relationship[];
  nextCursor: string | null;
}

export interface SendQuote {
  followerRevision: string;
  registeredFollowers: number;
  eligibleRecipients: number;
  ineligibleFollowers: number;
  receiverFloorCycles: bigint;
  authorNoticeFloorCycles: bigint;
  callAndByteCycles: bigint;
  localPublicationCycles: bigint;
  totalCycles: bigint;
  limitWarning: string | null;
  /**
   * Bounded backend snapshot (at most eight) of currently eligible Node IDs.
   * It is authoritative for this quote, but is not a reservation or a promise
   * of final delivery.
   */
  recipientPreview: string[];
}

export interface LikeReceipt {
  id: string;
  actorNodeId: string;
  actorDisplayName: string | null;
  state: "verified" | "invalid" | "unavailable" | "awaiting-batch";
}

export interface LikePackage {
  id: string;
  batchNumber: string;
  state: "verified" | "invalid" | "unavailable";
  receipts: LikeReceipt[];
  /** Whether a verified package was checked now or reused from verified storage. */
  cache?: "verified-now" | "verified-cache";
}

export interface LikesDetail {
  postId: string;
  packages: LikePackage[];
  awaitingBatch: LikeReceipt[];
  /** True when more packages remain after the current two-package Worker page. */
  truncated?: boolean;
  acceptingLikes?: boolean;
  /**
   * Continues the exact Worker-bound verified-head traversal. The opaque token
   * intentionally stays inside the certified runtime and is never UI state.
   */
  loadOlder?: (() => Promise<LikesDetail>) | null;
}

export interface PublishResult {
  stage: PublishStage;
  postId: string | null;
  queuedRecipients: number;
  queuedNotices: number;
  acceptedRecipients: number;
  failedRecipients: number;
  message: string;
}

export interface ProfileDraft {
  displayName: string;
  description: string;
  avatar: File | null;
  clearAvatar: boolean;
}

export interface AppSnapshot {
  status: WagyuStatus;
  trustedNetwork: TrustedNetwork;
  profile: WagyuProfile;
  feed: FeedPage;
  authored: AuthoredPage;
  notifications: NotificationPage;
  relationships: RelationshipPage;
  /**
   * Local slices that could not be refreshed for this snapshot. Their last
   * successful bounded page is retained when available, so one failed query
   * does not blank unrelated views.
   */
  degradedSlices: Array<
    "profile" | "feed" | "authored" | "notifications" | "relationships"
  >;
}

export interface WagyuOwnerIdentity {
  status: WagyuStatus;
  profile: WagyuProfile;
}

export interface WagyuService {
  /** Bounded owner bootstrap used by resident tools without loading every UI page. */
  loadOwner(): Promise<WagyuOwnerIdentity>;
  loadSnapshot(): Promise<AppSnapshot>;
  loadFeed(cursor: string | null, limit?: number): Promise<FeedPage>;
  hydrateCandidate(
    item: FeedItem,
    signal?: AbortSignal,
  ): Promise<FeedItem>;
  loadThreadReplyCount(item: FeedItem): Promise<number>;
  loadThreadReplies(item: FeedItem): Promise<FeedItem[]>;
  loadNotifications(cursor: string | null): Promise<NotificationPage>;
  hydrateNotification(item: NotificationItem): Promise<NotificationItem>;
  markNotificationsRead(sequences: string[]): Promise<void>;
  loadAuthored(cursor: string | null, limit?: number): Promise<AuthoredPage>;
  loadRelationships(
    cursor: string | null,
    expectedRevision?: string | null,
    limit?: number,
  ): Promise<RelationshipPage>;
  loadUserProfile(nodeId: string): Promise<WagyuProfile>;
  hydrateRelationshipProfile(
    relationship: Relationship,
  ): Promise<Relationship>;
  follow(nodeId: string): Promise<Relationship>;
  unfollow(nodeId: string): Promise<void>;
  setBlocked(nodeId: string, blocked: boolean): Promise<void>;
  getSendQuote(
    estimatedObjectBytes: number,
    noticeTarget?: string,
    sendKind?: "post" | "reply" | "share" | "tombstone",
  ): Promise<SendQuote>;
  publishPost(
    markdown: string,
    onStage: (stage: PublishStage) => void,
    replyTo?: FeedItem | null,
    nonce?: Uint8Array,
  ): Promise<PublishResult>;
  like(item: FeedItem): Promise<PublishResult>;
  share(
    item: FeedItem,
    onStage: (stage: PublishStage) => void,
  ): Promise<PublishResult>;
  resumeAuthoredAction(
    item: AuthoredItem,
    onStage: (stage: PublishStage) => void,
  ): Promise<PublishResult>;
  /** @deprecated Use resumeAuthoredAction for every prepared action kind. */
  resumeAuthoredPost(
    item: AuthoredPost,
    onStage: (stage: PublishStage) => void,
  ): Promise<PublishResult>;
  withdrawPost(
    item: AuthoredPost,
    onStage: (stage: PublishStage) => void,
    signal?: AbortSignal,
  ): Promise<PublishResult>;
  advanceWithdrawal(
    item: AuthoredPost,
    onStage: (stage: PublishStage) => void,
    signal?: AbortSignal,
  ): Promise<PublishResult>;
  loadLikes(item: FeedItem): Promise<LikesDetail>;
  saveProfile(draft: ProfileDraft): Promise<WagyuProfile>;
  enablePeerDelivery(): Promise<WagyuStatus>;
}
