import { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  listBackendCallReservations,
  loadNeutronCanisterId,
  querySelf,
  requestBackendCallReservations,
  updateSelf,
  type JsonObject,
  type JsonValue,
  type SelfCallValue,
} from "neutron-tools/app";
import {
  KERNEL_RUNTIME_CONFIG_PATH,
  parseKernelRuntimeConfig,
} from "neutron-tools/src/runtime_config.js";
import { physicalPublicIngressMethodName } from "neutron-tools/src/physical_names.js";
import { lowerHex } from "../protocol/bytes.ts";
import { WAGYU_LIMITS } from "../protocol/constants.ts";
import { deriveNetworkId } from "../protocol/ids.ts";
import { readTrustedRuntimeConfigBytes } from "../worker/trusted_runtime_response.ts";
import { sanitizeAvatarUpload } from "./avatar_pipeline.ts";
import { continueWithdrawalUntilComplete } from "./withdrawal_progress.ts";
import { createCertifiedWagyuPorts } from "./certified_runtime.ts";
import { createPreviewWagyuService } from "./demo_data.ts";
import {
  WagyuOwnerBridge,
  type ProfileEditSelfResultV1,
  type PublishSelfResultV1,
  type WagyuOwnerSelfCallTransport,
} from "./owner_bridge.ts";
import type {
  WagyuResidentVerificationClientV1,
} from "../worker/resident_client.ts";
import type {
  FeedPageV1,
  NotificationEvidenceV1,
  NotificationPageV1,
} from "../protocol/types.ts";
import type {
  AppSnapshot,
  AuthoredItem,
  AuthoredPage,
  AuthoredPost,
  FeedItem,
  FeedPage,
  LikesDetail,
  NotificationItem,
  NotificationPage,
  NotificationVerification,
  ProfileDraft,
  PublishResult,
  PublishStage,
  Relationship,
  RelationshipPage,
  RelationshipState,
  SendQuote,
  TrustedNetwork,
  VerificationState,
  WagyuOwnerIdentity,
  WagyuProfile,
  WagyuService,
  WagyuStatus,
} from "./model.ts";

const METHODS = {
  status: "wagyu_status",
  profile: "wagyu_profile",
  relationships: "wagyu_relationships",
  notificationsMarkRead: "wagyu_notifications_mark_read",
  authoredPage: "wagyu_authored_page",
  unfollow: "wagyu_unfollow",
  block: "wagyu_block",
  unblock: "wagyu_unblock",
  sendQuote: "wagyu_get_send_quote_v1",
} as const;

const ZERO_NETWORK_ID = "0".repeat(64);
const RELATIONSHIP_PAGE_LIMIT = 50;
const SEND_QUOTE_RECIPIENT_PREVIEW_LIMIT = 8;
const WAGYU_PUBLIC_INGRESS_METHOD = physicalPublicIngressMethodName(
  "wagyu",
  "wagyu_v1",
  "update",
);

const DEFAULT_OWNER_TRANSPORT: WagyuOwnerSelfCallTransport = {
  query: (method, args, timeoutSeconds) =>
    querySelf(method, args, timeoutSeconds),
  update: (method, args, timeoutSeconds) =>
    updateSelf(method, args, timeoutSeconds),
};

export interface WagyuAdapterPorts {
  hydrateCandidate?: (
    item: FeedItem,
    signal?: AbortSignal,
  ) => Promise<FeedItem>;
  hydrateNotification?: (
    item: NotificationItem,
    evidence: Uint8Array | null,
    ownerNodeId: string,
  ) => Promise<NotificationItem>;
  loadLikes?: (item: FeedItem) => Promise<LikesDetail>;
  loadThreadReplyCount?: (item: FeedItem) => Promise<number>;
  loadThreadReplies?: (item: FeedItem) => Promise<FeedItem[]>;
  loadBlockStatuses?: (
    nodeIds: readonly string[],
  ) => Promise<BlockStatusBatch>;
  loadProfile?: (
    nodeId: string,
    fallback: WagyuProfile,
  ) => Promise<WagyuProfile>;
  finalizePreparedAction?: (
    prepared: PreparedAction,
  ) => Promise<PublishResult>;
}

export interface BlockStatusBatch {
  readonly relationshipRevision: string;
  readonly items: readonly {
    readonly nodeId: string;
    readonly blocked: boolean;
  }[];
}

export interface PreparedAction {
  readonly actor: string;
  readonly kind: "post" | "share" | "like" | "tombstone";
  readonly actionId: Uint8Array;
  readonly objectDigest: Uint8Array;
}

export interface WagyuAdapterOptions extends WagyuAdapterPorts {
  /**
   * The preview is intentionally opt-in. Standalone development pages may set
   * `?preview=1`; an embedded Neutron tile always uses its real backend.
   */
  preview?: boolean;
  /**
   * Invocation-scoped owner calls used by resident cross-app tools. The normal
   * tile omits this and uses its own source-bound Neutron client.
   */
  ownerTransport?: WagyuOwnerSelfCallTransport;
  /**
   * A resident handler injects its already-owned verification Worker instead
   * of recursively calling its own message-bus endpoint.
   */
  loadVerificationWorker?: () => Promise<WagyuResidentVerificationClientV1>;
  /** Reuse one deployment-bound trusted runtime inside a resident process. */
  trustedRuntimeLoader?: () => Promise<TrustedRuntimeContext>;
}

export function shouldUseWagyuPreview(
  location: Pick<Location, "search"> = globalThis.location,
  embedded = globalThis.window ? globalThis.window.parent !== globalThis.window : false,
): boolean {
  if (embedded) return false;
  return new URLSearchParams(location.search).get("preview") === "1";
}

export function createNeutronWagyuService(
  options: WagyuAdapterOptions = {},
): WagyuService {
  if (options.preview || shouldUseWagyuPreview()) {
    return createPreviewWagyuService();
  }
  return new NeutronWagyuService(options);
}

class NeutronWagyuService implements WagyuService {
  readonly #ports: WagyuAdapterPorts;
  readonly #ownerTransport: WagyuOwnerSelfCallTransport;
  readonly #owner: WagyuOwnerBridge;
  readonly #trustedRuntimeLoader: () => Promise<TrustedRuntimeContext>;
  #trustedRuntime: Promise<TrustedRuntimeContext> | null = null;
  #profile: WagyuProfile | null = null;
  #nodeId: string | null = null;
  #lastSnapshot: AppSnapshot | null = null;
  #snapshotRead: Promise<AppSnapshot> | null = null;
  readonly #blockStatuses: ExactBlockStatusResolver;

  constructor(options: WagyuAdapterOptions) {
    const {
      ownerTransport = DEFAULT_OWNER_TRANSPORT,
      loadVerificationWorker,
      trustedRuntimeLoader = loadTrustedRuntime,
      preview: _preview,
      ...ports
    } = options;
    this.#ownerTransport = ownerTransport;
    this.#owner = new WagyuOwnerBridge(ownerTransport);
    this.#trustedRuntimeLoader = trustedRuntimeLoader;
    const certified = createCertifiedWagyuPorts(
      () => this.#loadTrustedRuntime(),
      {
        finalizePreparedAction: (prepared, exactProofCandid) =>
          finalizePreparedActionThroughBridge(
            this.#owner,
            prepared,
            exactProofCandid,
          ),
        recordCandidateDisposition: (candidate, result) =>
          recordCandidateDispositionThroughBridge(
            this.#owner,
            candidate,
            result,
          ),
        recordNotificationDisposition: (item, result) =>
          recordNotificationDispositionThroughBridge(
            this.#owner,
            item,
            result,
          ),
      },
      loadVerificationWorker
        ? { loadWorker: loadVerificationWorker }
        : {},
    );
    this.#ports = {
      ...certified,
      ...ports,
    };
    this.#blockStatuses = new ExactBlockStatusResolver(
      ports.loadBlockStatuses ??
        ((nodeIds) => loadExactBlockStatuses(this.#owner, nodeIds)),
    );
  }

  async loadOwner(): Promise<WagyuOwnerIdentity> {
    const [statusValue, trustedRuntime, peerDeliveryEnabled, profileValue] =
      await Promise.all([
        ownerQueryWith<SelfCallValue>(
          this.#ownerTransport,
          METHODS.status,
          [{}],
        ),
        this.#loadTrustedRuntime(),
        readPeerDeliveryEnabled().catch(() => false),
        ownerQueryWith<SelfCallValue>(
          this.#ownerTransport,
          METHODS.profile,
          [{}],
        ),
      ]);
    const status = {
      ...parseStatus(statusValue),
      peerDeliveryEnabled,
    };
    assertInstalledNetwork(status, trustedRuntime.network.networkId);
    this.#nodeId = status.nodeId;
    const localProfile = parseProfile(profileValue);
    const profile = this.#ports.loadProfile
      ? await this.#ports.loadProfile(status.nodeId, localProfile)
      : localProfile;
    if (profile.nodeId !== status.nodeId) {
      throw new Error("Wagyu owner profile belongs to another user ID");
    }
    this.#profile = profile;
    return { status, profile };
  }

  loadSnapshot(): Promise<AppSnapshot> {
    if (this.#snapshotRead !== null) return this.#snapshotRead;
    let pending: Promise<AppSnapshot>;
    pending = this.#readSnapshot().finally(() => {
      if (this.#snapshotRead === pending) this.#snapshotRead = null;
    });
    this.#snapshotRead = pending;
    return pending;
  }

  async #readSnapshot(): Promise<AppSnapshot> {
    const [statusValue, trustedRuntime, peerDeliveryEnabled] = await Promise.all([
      ownerQueryWith<SelfCallValue>(this.#ownerTransport, METHODS.status, [{}]),
      this.#loadTrustedRuntime(),
      readPeerDeliveryEnabled().catch(() => false),
    ]);
    const status = {
      ...parseStatus(statusValue),
      peerDeliveryEnabled,
    };
    assertInstalledNetwork(status, trustedRuntime.network.networkId);
    this.#nodeId = status.nodeId;
    const [
      profileValue,
      feedResult,
      notificationsResult,
      authoredValue,
      relationshipsValue,
    ] = await Promise.allSettled([
      ownerQueryWith<SelfCallValue>(
        this.#ownerTransport,
        METHODS.profile,
        [{}],
      ),
      this.#owner.feedPage({ before_sequence: null, limit: 25 }),
      this.#owner.notificationPage({ before_sequence: null, limit: 50 }),
      ownerQueryWith(
        this.#ownerTransport,
        METHODS.authoredPage,
        [pageRequest(null, 50)],
      ),
      ownerQueryWith(this.#ownerTransport, METHODS.relationships, [
        relationshipPageRequest(null, null),
      ]),
    ]);
    const degradedSlices: AppSnapshot["degradedSlices"] = [];
    let previous =
      this.#lastSnapshot?.status.nodeId === status.nodeId
        ? this.#lastSnapshot
        : null;
    let profile: WagyuProfile;
    if (profileValue.status === "fulfilled") {
      try {
        const localProfile = parseProfile(profileValue.value);
        if (
          previous?.profile.profileGeneration !==
            localProfile.profileGeneration
        ) {
          previous = null;
        }
        if (this.#ports.loadProfile) {
          try {
            profile = await this.#ports.loadProfile(
              status.nodeId,
              localProfile,
            );
          } catch {
            degradedSlices.push("profile");
            profile = localProfile;
          }
        } else {
          profile = localProfile;
        }
      } catch {
        degradedSlices.push("profile");
        profile = previous?.profile ?? relationshipProfileFallback(status.nodeId);
      }
    } else {
      degradedSlices.push("profile");
      profile = previous?.profile ?? relationshipProfileFallback(status.nodeId);
    }
    this.#profile = profile;

    const slice = <T>(
      name: AppSnapshot["degradedSlices"][number],
      result: PromiseSettledResult<unknown>,
      parse: (value: unknown) => T,
      fallback: T,
    ): T => {
      if (result.status === "fulfilled") {
        try {
          return parse(result.value);
        } catch {
          // A malformed slice is isolated exactly like a failed local query.
        }
      }
      degradedSlices.push(name);
      return fallback;
    };
    const next: AppSnapshot = {
      status,
      trustedNetwork: trustedRuntime.network,
      profile,
      feed: slice(
        "feed",
        feedResult,
        (value) =>
          parseBridgeFeedPage(
            (
              value as Awaited<
                ReturnType<WagyuOwnerBridge["feedPage"]>
              >
            ).value,
          ),
        previous?.feed ?? emptyFeedPage(),
      ),
      authored: slice(
        "authored",
        authoredValue,
        (value) => parseAuthoredPage(value as JsonValue),
        previous?.authored ?? emptyAuthoredPage(),
      ),
      notifications: slice(
        "notifications",
        notificationsResult,
        (value) =>
          parseBridgeNotificationPage(
            (value as Awaited<
              ReturnType<WagyuOwnerBridge["notificationPage"]>
            >).value,
          ),
        previous?.notifications ?? emptyNotificationPage(),
      ),
      relationships: slice(
        "relationships",
        relationshipsValue,
        (value) => parseRelationshipPage(value as JsonValue),
        previous?.relationships ?? emptyRelationshipPage(),
      ),
      degradedSlices,
    };
    this.#blockStatuses.observeRevision(next.relationships.revision);
    this.#lastSnapshot = next;
    return next;
  }

  async loadFeed(
    cursor: string | null,
    limit = WAGYU_LIMITS.feedPageItems,
  ): Promise<FeedPage> {
    return parseBridgeFeedPage(
      (await this.#owner.feedPage({
        before_sequence: cursor,
        limit: boundedPageLimit(
          limit,
          WAGYU_LIMITS.feedPageItems,
          "feed",
        ),
      })).value,
    );
  }

  async hydrateCandidate(
    item: FeedItem,
    signal?: AbortSignal,
  ): Promise<FeedItem> {
    if (!this.#ports.hydrateCandidate) return item;
    return this.#ports.hydrateCandidate(item, signal);
  }

  async loadNotifications(cursor: string | null): Promise<NotificationPage> {
    return parseBridgeNotificationPage(
      (await this.#owner.notificationPage({
        before_sequence: cursor,
        limit: 50,
      })).value,
    );
  }

  async hydrateNotification(item: NotificationItem): Promise<NotificationItem> {
    if (!this.#ports.hydrateNotification) return item;
    if (!this.#nodeId) {
      throw new Error("Reload Wagyu before verifying notification evidence");
    }
    let evidence: Uint8Array | null = null;
    if (item.kind === "like") {
      const value = await this.#owner.notificationEvidence({
        local_sequence: item.localSequence,
      });
      evidence = parseBridgeLikeNotificationEvidence(
        value.value,
        item.localSequence,
      );
    }
    return this.#ports.hydrateNotification(item, evidence, this.#nodeId);
  }

  async markNotificationsRead(sequences: string[]): Promise<void> {
    if (sequences.length === 0) return;
    await ownerUpdateWith(
      this.#ownerTransport,
      METHODS.notificationsMarkRead,
      [{ local_sequences: sequences }],
    );
  }

  async loadAuthored(
    cursor: string | null,
    limit = RELATIONSHIP_PAGE_LIMIT,
  ): Promise<AuthoredPage> {
    return parseAuthoredPage(
      await ownerQueryWith(
        this.#ownerTransport,
        METHODS.authoredPage,
        [
          pageRequest(
            cursor,
            boundedPageLimit(limit, RELATIONSHIP_PAGE_LIMIT, "authored"),
          ),
        ],
      ),
    );
  }

  async loadRelationships(
    cursor: string | null,
    expectedRevision: string | null = null,
    limit = RELATIONSHIP_PAGE_LIMIT,
  ): Promise<RelationshipPage> {
    const page = parseRelationshipPage(
      await ownerQueryWith(
        this.#ownerTransport,
        METHODS.relationships,
        [
          relationshipPageRequest(
            cursor,
            expectedRevision,
            boundedPageLimit(
              limit,
              RELATIONSHIP_PAGE_LIMIT,
              "relationship",
            ),
          ),
        ],
      ),
    );
    this.#blockStatuses.observeRevision(page.revision);
    return page;
  }

  async hydrateRelationshipProfile(
    relationship: Relationship,
  ): Promise<Relationship> {
    return hydrateRelationshipProfileWithLoader(
      relationship,
      this.#ports.loadProfile,
    );
  }

  async loadUserProfile(nodeId: string): Promise<WagyuProfile> {
    const fallback = relationshipProfileFallback(nodeId);
    if (!this.#ports.loadProfile) {
      return { ...fallback, proofState: "unavailable" };
    }
    const profile = await this.#ports.loadProfile(nodeId, fallback);
    if (profile.nodeId !== nodeId) {
      throw new Error(
        "Certified profile loader returned another Wagyu user ID",
      );
    }
    return profile;
  }

  async follow(nodeId: string): Promise<Relationship> {
    if (this.#nodeId !== null && nodeId === this.#nodeId) {
      throw new Error(
        "This is your own Neutron Node ID. Followers must follow you from their node.",
      );
    }
    try {
      const value = await this.#owner.follow({
        node: nodeId,
        subscription_id: randomBytes(16),
      });
      return parseRelationship(value);
    } catch (reason) {
      throw followError(reason);
    }
  }

  async unfollow(nodeId: string): Promise<void> {
    await ownerUpdateWith(
      this.#ownerTransport,
      METHODS.unfollow,
      [{ node: nodeId }],
    );
  }

  async setBlocked(nodeId: string, blocked: boolean): Promise<void> {
    this.#blockStatuses.invalidate();
    try {
      await ownerUpdateWith(
        this.#ownerTransport,
        blocked ? METHODS.block : METHODS.unblock,
        [{ node: nodeId }],
      );
    } finally {
      this.#blockStatuses.invalidate();
    }
  }

  async getSendQuote(
    estimatedObjectBytes: number,
    noticeTarget?: string,
    sendKind?: "post" | "reply" | "share" | "tombstone",
  ): Promise<SendQuote> {
    const kind = sendKind ?? (noticeTarget ? "reply" : "post");
    return parseSendQuote(
      await ownerQueryWith(this.#ownerTransport, METHODS.sendQuote, [
        {
          send_kind: { [kind]: null },
          estimated_object_bytes: estimatedObjectBytes,
          ...(noticeTarget === undefined
            ? {}
            : { notice_target: noticeTarget }),
        },
      ]),
    );
  }

  async publishPost(
    markdown: string,
    onStage: (stage: PublishStage) => void,
    replyTo: FeedItem | null = null,
    nonce?: Uint8Array,
  ): Promise<PublishResult> {
    onStage("encoding");
    const replyLocator = replyTo ? exactReplyLocator(replyTo) : null;
    const actionNonce = nonce?.slice() ?? randomBytes(16);
    onStage("publishing");
    const preparedResult = await this.#owner.postPrepare({
      body_markdown: markdown,
      nonce: actionNonce,
      reply_to: replyLocator,
    });
    let result = publishResultFromBridge(preparedResult);
    if (result.stage === "awaiting-proof") {
      const prepared = preparedActionFromBridge(
        preparedResult,
        "post",
        this.#nodeId,
      );
      if (!this.#ports.finalizePreparedAction) {
        throw new Error("The certified action finalizer is unavailable");
      }
      result = await this.#ports.finalizePreparedAction(prepared);
    }
    onStage(result.stage);
    return result;
  }

  async like(item: FeedItem): Promise<PublishResult> {
    if (item.verification !== "verified") {
      throw new Error("Wagyu only likes a locally verified original post");
    }
    const postId = parseHex32Bytes(item.postId, "post ID");
    const bodyHash = parseHex32Bytes(item.bodyDigest, "post body hash");
    const objectDigest = item.objectDigest
      ? parseHex32Bytes(item.objectDigest, "post object digest")
      : null;
    const preparedResult = await this.#owner.likePrepare({
      post_author: item.author.nodeId,
      post_id: postId,
      post_body_hash: bodyHash,
      post_object_digest: objectDigest,
      nonce: randomBytes(16),
    });
    let result = publishResultFromBridge(preparedResult);
    if (result.stage === "awaiting-proof") {
      if (!this.#ports.finalizePreparedAction) {
        throw new Error("The certified action finalizer is unavailable");
      }
      result = await this.#ports.finalizePreparedAction(
        preparedActionFromBridge(preparedResult, "like", this.#nodeId),
      );
    }
    return result;
  }

  async share(
    item: FeedItem,
    onStage: (stage: PublishStage) => void,
  ): Promise<PublishResult> {
    if (
      item.verification !== "verified" ||
      !item.originalPostRefBytes ||
      item.kind === "tombstone"
    ) {
      throw new Error("A share requires the exact verified original post reference");
    }
    onStage("encoding");
    const preparedResult = await this.#owner.sharePrepare({
      nonce: randomBytes(16),
      exact_original_post_ref_candid: item.originalPostRefBytes,
    });
    onStage("publishing");
    let result = publishResultFromBridge(preparedResult);
    if (result.stage === "awaiting-proof") {
      if (!this.#ports.finalizePreparedAction) {
        throw new Error("The certified action finalizer is unavailable");
      }
      result = await this.#ports.finalizePreparedAction(
        preparedActionFromBridge(preparedResult, "share", this.#nodeId),
      );
    }
    onStage(result.stage);
    return result;
  }

  async resumeAuthoredPost(
    item: AuthoredPost,
    onStage: (stage: PublishStage) => void,
  ): Promise<PublishResult> {
    return this.resumeAuthoredAction(item, onStage);
  }

  async resumeAuthoredAction(
    item: AuthoredItem,
    onStage: (stage: PublishStage) => void,
  ): Promise<PublishResult> {
    if (item.state !== "awaiting-proof") {
      throw new Error("Only a prepared action awaiting proof can be resumed");
    }
    if (!this.#ports.finalizePreparedAction) {
      throw new Error("The certified action finalizer is unavailable");
    }
    if (!this.#nodeId) {
      throw new Error("Reload Wagyu before resuming a prepared action");
    }
    return resumeAuthoredActionThroughFinalizer(
      item,
      this.#nodeId,
      this.#ports.finalizePreparedAction,
      onStage,
    );
  }

  async withdrawPost(
    item: AuthoredPost,
    onStage: (stage: PublishStage) => void,
    signal?: AbortSignal,
  ): Promise<PublishResult> {
    const postId = parseHex32Bytes(item.postId, "authored post ID");
    onStage("publishing");
    const preparedResult = await this.#owner.tombstonePrepare({
      post_id: postId,
      nonce: randomBytes(16),
    });
    let result = publishResultFromBridge(preparedResult);
    if (result.stage === "awaiting-proof") {
      if (!this.#ports.finalizePreparedAction) {
        throw new Error("The certified action finalizer is unavailable");
      }
      result = await this.#ports.finalizePreparedAction(
        preparedActionFromBridge(preparedResult, "tombstone", this.#nodeId),
      );
    }
    onStage(result.stage);
    if (
      result.stage === "certified-ref-ready" ||
      result.stage === "withdrawal-closing"
    ) {
      return this.advanceWithdrawal(item, onStage, signal);
    }
    return result;
  }

  async advanceWithdrawal(
    item: AuthoredPost,
    onStage: (stage: PublishStage) => void,
    signal?: AbortSignal,
  ): Promise<PublishResult> {
    const postId = parseHex32Bytes(item.postId, "authored post ID");
    return continueWithdrawalUntilComplete({
      ...(signal ? { signal } : {}),
      advance: async () => {
        onStage("withdrawal-closing");
        const result = publishResultFromBridge(
          await this.#owner.withdrawalAdvance({
            post_id: postId,
            nonce: randomBytes(16),
          }),
        );
        onStage(result.stage);
        return result;
      },
    });
  }

  async loadLikes(item: FeedItem): Promise<LikesDetail> {
    if (item.verification !== "verified") {
      throw new Error("Likes are available only for a verified original post");
    }
    if (this.#ports.loadLikes) {
      return filterLikesByExactBlockStatus(
        await this.#ports.loadLikes(item),
        this.#blockStatuses,
      );
    }
    // No backend total is used as a substitute. The certified HTTP verifier
    // port supplies packages when wired; an empty result means none verified.
    return { postId: item.postId, packages: [], awaitingBatch: [] };
  }

  async loadThreadReplies(item: FeedItem): Promise<FeedItem[]> {
    if (item.verification !== "verified") {
      throw new Error("Replies are available only for a verified post");
    }
    return filterFeedItemsByExactBlockStatus(
      await (this.#ports.loadThreadReplies?.(item) ?? []),
      this.#blockStatuses,
    );
  }

  async loadThreadReplyCount(item: FeedItem): Promise<number> {
    if (item.verification !== "verified") {
      throw new Error("Replies are available only for a verified post");
    }
    return this.#ports.loadThreadReplyCount?.(item) ?? 0;
  }

  async saveProfile(draft: ProfileDraft): Promise<WagyuProfile> {
    if (!this.#profile) {
      throw new Error("Reload the current profile before editing it");
    }
    const nextAvatar = draft.avatar
      ? await sanitizeAvatarUpload(draft.avatar)
      : draft.clearAvatar
        ? null
        : this.#profile.avatar;
    if (
      !draft.avatar &&
      !draft.clearAvatar &&
      this.#profile.avatarUrl &&
      !this.#profile.avatar
    ) {
      throw new Error(
        "The current avatar bytes are not loaded. Select that avatar again or explicitly remove it before saving.",
      );
    }
    const value = await this.#owner.profileEdit(
      {
        expected_profile_generation: this.#profile.profileGeneration,
        expected_revision: this.#profile.revision,
        display_name: draft.displayName,
        description: draft.description,
        avatar: nextAvatar
          ? {
              media_type: nextAvatar.mediaType,
              width: nextAvatar.width,
              height: nextAvatar.height,
              bytes: nextAvatar.bytes,
            }
          : null,
      },
    );
    assertBridgeProfileEditUpdated(value);
    const localProfile = parseProfile(
      await ownerQueryWith<SelfCallValue>(
        this.#ownerTransport,
        METHODS.profile,
        [{}],
      ),
    );
    const profile = this.#ports.loadProfile
      ? await this.#ports.loadProfile(localProfile.nodeId, localProfile)
      : localProfile;
    this.#profile = profile;
    return profile;
  }

  async enablePeerDelivery(): Promise<WagyuStatus> {
    let peerDeliveryEnabled = await readPeerDeliveryEnabled().catch(
      () => false,
    );
    if (!peerDeliveryEnabled) {
      peerDeliveryEnabled = parsePeerDeliveryEnabled(
        await requestBackendCallReservations({
          actions: [{
            kind: "reserve",
            scope: {
              kind: "method",
              method: WAGYU_PUBLIC_INGRESS_METHOD,
            },
          }],
        }),
      );
    }
    if (!peerDeliveryEnabled) {
      throw new Error("Wagyu peer delivery access was not saved");
    }
    const [statusValue, trustedRuntime] = await Promise.all([
      ownerQueryWith<SelfCallValue>(
        this.#ownerTransport,
        METHODS.status,
        [{}],
      ),
      this.#loadTrustedRuntime(),
    ]);
    const status = {
      ...parseStatus(statusValue),
      peerDeliveryEnabled,
    };
    assertInstalledNetwork(status, trustedRuntime.network.networkId);
    return status;
  }

  #loadTrustedRuntime(): Promise<TrustedRuntimeContext> {
    this.#trustedRuntime ??= this.#trustedRuntimeLoader();
    return this.#trustedRuntime;
  }
}

export interface ExactBlockStatusLookup {
  resolve(nodeIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
}

type CachedBlockStatus = Readonly<{
  revision: string;
  blocked: boolean;
}>;

const EXACT_BLOCK_STATUS_BATCH_LIMIT = 500;
const EXACT_BLOCK_STATUS_CACHE_LIMIT = 4_096;

export class ExactBlockStatusResolver implements ExactBlockStatusLookup {
  readonly #cache = new Map<string, CachedBlockStatus>();
  readonly #inflight = new Map<string, Promise<CachedBlockStatus>>();
  #revision: string | null = null;
  #epoch = 0;

  constructor(
    private readonly load: (
      nodeIds: readonly string[],
    ) => Promise<BlockStatusBatch>,
  ) {}

  observeRevision(revision: string): void {
    const canonical = canonicalRevision(revision);
    if (canonical === this.#revision) return;
    this.#revision = canonical;
    this.#cache.clear();
    this.#inflight.clear();
    this.#epoch += 1;
  }

  invalidate(): void {
    this.#revision = null;
    this.#cache.clear();
    this.#inflight.clear();
    this.#epoch += 1;
  }

  async resolve(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const unique = [...new Set(nodeIds.map(canonicalNodeId))];
    if (unique.length === 0) return new Map();

    const pending = new Map<string, Promise<CachedBlockStatus>>();
    const missing: string[] = [];
    for (const nodeId of unique) {
      const cached = this.#cache.get(nodeId);
      // A cached Block remains safe to enforce even if another tab has since
      // Unblocked the peer. An old unblocked answer could expose newly blocked
      // content, so re-query those identities for every new hydration.
      if (
        cached &&
        cached.revision === this.#revision &&
        cached.blocked
      ) {
        // Refresh insertion order so the bounded map behaves as an LRU.
        this.#cache.delete(nodeId);
        this.#cache.set(nodeId, cached);
        pending.set(nodeId, Promise.resolve(cached));
        continue;
      }
      const inflight = this.#inflight.get(nodeId);
      if (inflight) {
        pending.set(nodeId, inflight);
      } else {
        missing.push(nodeId);
      }
    }

    for (
      let offset = 0;
      offset < missing.length;
      offset += EXACT_BLOCK_STATUS_BATCH_LIMIT
    ) {
      const nodes = missing.slice(
        offset,
        offset + EXACT_BLOCK_STATUS_BATCH_LIMIT,
      );
      const epoch = this.#epoch;
      const batch = this.load(nodes).then((result) =>
        this.#acceptBatch(nodes, result, epoch)
      );
      for (const nodeId of nodes) {
        let one: Promise<CachedBlockStatus>;
        one = batch.then((statuses) => {
          const status = statuses.get(nodeId);
          if (!status) {
            throw new Error(
              "Exact Block status query omitted a requested node",
            );
          }
          return status;
        }).finally(() => {
          if (this.#inflight.get(nodeId) === one) {
            this.#inflight.delete(nodeId);
          }
        });
        this.#inflight.set(nodeId, one);
        pending.set(nodeId, one);
      }
    }

    const resolved = await Promise.all(
      unique.map(async (nodeId) => [
        nodeId,
        await pending.get(nodeId)!,
      ] as const),
    );
    const revisions = new Set(resolved.map(([, status]) => status.revision));
    if (
      revisions.size !== 1 ||
      !this.#revision ||
      !revisions.has(this.#revision)
    ) {
      throw new Error(
        "Exact Block status changed while hydrated identities were resolving",
      );
    }
    return new Map(
      resolved.map(([nodeId, status]) => [nodeId, status.blocked]),
    );
  }

  #acceptBatch(
    requested: readonly string[],
    result: BlockStatusBatch,
    epoch: number,
  ): ReadonlyMap<string, CachedBlockStatus> {
    if (epoch !== this.#epoch) {
      throw new Error(
        "Exact Block status became stale while the query was in flight",
      );
    }
    const revision = canonicalRevision(result.relationshipRevision);
    if (this.#revision !== null) {
      const comparison = compareRevisions(revision, this.#revision);
      if (comparison < 0) {
        throw new Error(
          "Exact Block status query returned a stale relationship revision",
        );
      }
      if (comparison > 0) {
        this.#revision = revision;
        this.#cache.clear();
      }
    } else {
      this.#revision = revision;
    }
    if (result.items.length !== requested.length) {
      throw new Error(
        "Exact Block status response length does not match its request",
      );
    }
    const statuses = new Map<string, CachedBlockStatus>();
    for (let index = 0; index < requested.length; index += 1) {
      const item = result.items[index]!;
      const nodeId = canonicalNodeId(item.nodeId);
      if (nodeId !== requested[index] || typeof item.blocked !== "boolean") {
        throw new Error(
          "Exact Block status response reordered or replaced a requested node",
        );
      }
      const status = Object.freeze({
        revision,
        blocked: item.blocked,
      });
      statuses.set(nodeId, status);
      if (status.blocked) {
        this.#cache.set(nodeId, status);
        while (this.#cache.size > EXACT_BLOCK_STATUS_CACHE_LIMIT) {
          const oldest = this.#cache.keys().next().value;
          if (oldest === undefined) break;
          this.#cache.delete(oldest);
        }
      } else {
        this.#cache.delete(nodeId);
      }
    }
    return statuses;
  }
}

async function loadExactBlockStatuses(
  owner: WagyuOwnerBridge,
  nodeIds: readonly string[],
): Promise<BlockStatusBatch> {
  const value = await owner.blockStatuses({ nodes: nodeIds });
  return {
    relationshipRevision: value.relationship_revision,
    items: value.items.map((item) => ({
      nodeId: item.node,
      blocked: item.blocked,
    })),
  };
}

export async function filterFeedItemsByExactBlockStatus(
  items: readonly FeedItem[],
  lookup: ExactBlockStatusLookup,
): Promise<FeedItem[]> {
  const nodeIds = items.flatMap((item) => [
    item.author.nodeId,
    item.immediateSender,
    ...(item.sharedBy ? [item.sharedBy.nodeId] : []),
    ...(item.replyTo ? [item.replyTo.authorNodeId] : []),
  ]);
  const statuses = await lookup.resolve(nodeIds);
  return items.filter((item) =>
    [
      item.author.nodeId,
      item.immediateSender,
      item.sharedBy?.nodeId,
      item.replyTo?.authorNodeId,
    ].every((nodeId) => !nodeId || statuses.get(nodeId) === false)
  );
}

export async function filterLikesByExactBlockStatus(
  detail: LikesDetail,
  lookup: ExactBlockStatusLookup,
): Promise<LikesDetail> {
  const actorNodeIds = [
    ...detail.packages.flatMap((group) =>
      group.receipts.map((receipt) => receipt.actorNodeId)
    ),
    ...detail.awaitingBatch.map((receipt) => receipt.actorNodeId),
  ];
  const statuses = await lookup.resolve(actorNodeIds);
  let removed = false;
  const packages = detail.packages.map((group) => {
    const receipts = group.receipts.filter((receipt) => {
      const visible = statuses.get(receipt.actorNodeId) === false;
      removed ||= !visible;
      return visible;
    });
    return receipts.length === group.receipts.length
      ? group
      : { ...group, receipts };
  });
  const awaitingBatch = detail.awaitingBatch.filter((receipt) => {
    const visible = statuses.get(receipt.actorNodeId) === false;
    removed ||= !visible;
    return visible;
  });
  const loadOlder = detail.loadOlder
    ? async () =>
      filterLikesByExactBlockStatus(await detail.loadOlder!(), lookup)
    : null;
  if (!removed) {
    return detail.loadOlder === loadOlder
      ? detail
      : { ...detail, loadOlder };
  }
  return {
    ...detail,
    packages,
    awaitingBatch,
    loadOlder,
  };
}

function canonicalNodeId(value: string): string {
  try {
    const principal = Principal.fromText(value);
    const canonical = principal.toText();
    if (canonical !== value) throw new Error("principal is not canonical");
    const bytes = principal.toUint8Array();
    if (bytes.byteLength === 0 || bytes.at(-1) !== 0x01) {
      throw new Error("principal is not a canister");
    }
    return canonical;
  } catch {
    throw new Error("Hydrated identity contains an invalid Node ID");
  }
}

function canonicalRevision(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Exact Block status revision is invalid");
  }
  return BigInt(value).toString(10);
}

function compareRevisions(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function publishResultFromBridge(value: PublishSelfResultV1): PublishResult {
  return {
    stage: publishStage(value.stage ?? "uncertain"),
    postId: value.post_id_hex,
    queuedRecipients: value.queued_recipient_count,
    queuedNotices: value.queued_notice_count,
    acceptedRecipients: value.accepted_recipient_count,
    failedRecipients: value.failed_recipient_count,
    message: value.message,
  };
}

function preparedActionFromBridge(
  value: PublishSelfResultV1,
  kind: PreparedAction["kind"],
  actor: string | null,
): PreparedAction {
  if (!actor) throw new Error("Reload Wagyu before publishing an action");
  if (!value.action_id_hex || !value.object_digest_hex) {
    throw new Error("Prepared action omitted its exact 32-byte identity");
  }
  return {
    actor,
    kind,
    actionId: parseHex32Bytes(value.action_id_hex, "action ID"),
    objectDigest: parseHex32Bytes(
      value.object_digest_hex,
      "object digest",
    ),
  };
}

export async function resumeAuthoredActionThroughFinalizer(
  item: AuthoredItem,
  actor: string,
  finalize: NonNullable<WagyuAdapterPorts["finalizePreparedAction"]>,
  onStage: (stage: PublishStage) => void,
): Promise<PublishResult> {
  if (item.state !== "awaiting-proof") {
    throw new Error("Only a prepared action awaiting proof can be resumed");
  }
  onStage("awaiting-proof");
  const result = await finalize({
    actor,
    kind: item.kind,
    actionId: parseHex32Bytes(item.actionId, `prepared ${item.kind} action ID`),
    objectDigest: parseHex32Bytes(
      item.objectDigest,
      `prepared ${item.kind} object digest`,
    ),
  });
  onStage(result.stage);
  return result;
}

async function finalizePreparedActionThroughBridge(
  owner: WagyuOwnerBridge,
  prepared: PreparedAction,
  exactProofCandid: Uint8Array,
): Promise<PublishResult> {
  const request = {
    action_id: prepared.actionId,
    object_digest: prepared.objectDigest,
    exact_proof_candid: exactProofCandid,
  };
  const local = await (prepared.kind === "post"
    ? owner.postFinalize(request)
    : prepared.kind === "share"
      ? owner.shareFinalize(request)
      : prepared.kind === "like"
        ? owner.likeFinalize(request)
        : owner.tombstoneFinalize(request));
  return publishResultFromBridge(local);
}

async function recordCandidateDispositionThroughBridge(
  owner: WagyuOwnerBridge,
  candidate: FeedItem,
  result: FeedItem,
): Promise<void> {
  if (result.verification === "verified") {
    await owner.feedPromote({
      candidate_id: candidate.id,
      verified_author: result.author.nodeId,
      verified_post_id: parseHex32Bytes(result.postId, "verified post ID"),
      verified_body_hash: parseHex32Bytes(
        result.bodyDigest,
        "verified post body hash",
      ),
      verified_object_digest: parseHex32Bytes(
        result.objectDigest,
        "verified post object digest",
      ),
    });
  } else if (
    result.verification === "invalid" ||
    result.verification === "unsupported"
  ) {
    await owner.feedReject({
      candidate_id: candidate.id,
      disposition: "invalid",
    });
  }
}

async function recordNotificationDispositionThroughBridge(
  owner: WagyuOwnerBridge,
  item: NotificationItem,
  result: NotificationItem,
): Promise<void> {
  if (result.verification === "verified") {
    const verifiedReply = result.kind === "reply"
      ? result.verifiedReply ?? null
      : null;
    if (result.kind === "reply" && verifiedReply === null) {
      throw new Error("Verified reply notification omitted its exact binding");
    }
    await owner.notificationPromote({
      local_sequence: item.localSequence,
      disposition: "verified",
      verified_reply: verifiedReply === null
        ? null
        : {
            author: verifiedReply.authorNodeId,
            post_id: verifiedReply.postId,
            body_hash: verifiedReply.bodyHash,
            body_length: verifiedReply.bodyLength,
            object_digest: verifiedReply.objectDigest,
            reply_to: {
              author: verifiedReply.replyTo.authorNodeId,
              post_id: verifiedReply.replyTo.postId,
              body_hash: verifiedReply.replyTo.bodyHash,
              body_length: verifiedReply.replyTo.bodyLength,
              object_digest: verifiedReply.replyTo.objectDigest,
            },
          },
    });
  } else if (result.verification === "invalid") {
    await owner.notificationPromote({
      local_sequence: item.localSequence,
      disposition: "invalid",
      verified_reply: null,
    });
  } else if (result.verification === "unavailable") {
    await owner.notificationPromote({
      local_sequence: item.localSequence,
      disposition: "unavailable",
      verified_reply: null,
    });
  }
}

function assertBridgeProfileEditUpdated(
  value: ProfileEditSelfResultV1,
): void {
  const outcome = value.outcome;
  if (outcome && "updated" in outcome) return;
  if (outcome && "conflict" in outcome) {
    throw new Error("Profile changed on another tile. Reload it before saving.");
  }
  if (outcome && "rejected" in outcome) {
    throw new Error(
      `Profile update was rejected: ${outcome.rejected.reason ?? "unknown"}`,
    );
  }
  throw new Error("Profile update returned an unsupported outcome");
}

async function ownerQueryWith<T extends SelfCallValue = JsonValue>(
  transport: WagyuOwnerSelfCallTransport,
  method: string,
  args: SelfCallValue[] = [null],
  timeout = 30,
): Promise<T> {
  return transport.query<T>(method, args, timeout);
}

async function ownerUpdateWith(
  transport: WagyuOwnerSelfCallTransport,
  method: string,
  args: SelfCallValue[] = [null],
  timeout = 60,
): Promise<JsonValue> {
  return transport.update<JsonValue>(method, args, timeout);
}

function followError(reason: unknown): Error {
  const code =
    typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      typeof reason.code === "string"
      ? reason.code
      : null;
  switch (code) {
    case "not_configured":
      return new Error(
        "Wagyu is not bound to this IC network. Complete network setup before following a node.",
        { cause: reason },
      );
    case "invalid":
      return new Error(
        "Wagyu rejected this target as invalid. Use another Neutron node’s canonical Node ID; a node cannot follow itself.",
        { cause: reason },
      );
    case "conflict":
      return new Error(
        "This relationship conflicts with the current block or follow state. Refresh People & relationships and review the node.",
        { cause: reason },
      );
    case "full":
      return new Error(
        "Wagyu cannot queue another follow operation because its relationship or outbox capacity is full.",
        { cause: reason },
      );
    case "unsupported":
      return new Error(
        "Wagyu peer delivery access is unavailable. Reopen network setup and approve peer access.",
        { cause: reason },
      );
    case "busy":
      return new Error(
        "Wagyu is busy updating relationships. Refresh and try again.",
        { cause: reason },
      );
    default:
      return reason instanceof Error
        ? reason
        : new Error(`Wagyu could not follow this node: ${String(reason)}`);
  }
}

export interface TrustedRuntimeContext {
  readonly network: TrustedNetwork;
  readonly networkIdBytes: Uint8Array;
  readonly rootKey: Uint8Array;
  readonly gatewayOrigin: string;
  readonly allowInsecureLocalhost: boolean;
  readonly queryAgent: HttpAgent;
}

export async function loadTrustedRuntime(): Promise<TrustedRuntimeContext> {
  const configUrl = new URL(KERNEL_RUNTIME_CONFIG_PATH, globalThis.location.href);
  const response = await fetch(configUrl.href, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    method: "GET",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (
    !response.ok ||
    response.redirected ||
    response.type === "opaque" ||
    response.type === "opaqueredirect"
  ) {
    throw new Error(
      `Trusted runtime configuration is unavailable (HTTP ${response.status})`,
    );
  }
  if (response.url !== configUrl.href) {
    throw new Error("Trusted runtime configuration changed origin");
  }
  const bytes = await readTrustedRuntimeConfigBytes(response);
  const config = parseKernelRuntimeConfig(bytes);
  const canisterId = await loadNeutronCanisterId();
  if (config.canister_id !== canisterId) {
    throw new Error("Trusted runtime configuration belongs to another Neutron");
  }

  // Keep local root-key discovery on this browser origin. Dedicated resident
  // hostnames and the main canister hostname are both PocketIC gateway
  // aliases, while a request from either alias to bare localhost is subject to
  // Chromium Private Network Access blocking.
  const agentHost =
    config.target === "pocketic"
      ? globalThis.location.origin
      : config.gateway;
  const agent = new HttpAgent({
    host: agentHost,
    shouldFetchRootKey: config.root_key_policy === "fetch",
    verifyQuerySignatures: config.root_key_policy !== "fetch",
  });
  if (config.root_key_policy === "fetch") {
    await agent.fetchRootKey();
  }
  if (!agent.rootKey || agent.rootKey.byteLength === 0) {
    throw new Error("The configured IC root key is unavailable");
  }
  const rootKey = agent.rootKey.slice();
  const networkIdBytes = deriveNetworkId(rootKey).slice();
  const networkId = lowerHex(networkIdBytes);
  return {
    network: {
      networkId,
      target: config.target,
      rootKeyPolicy: config.root_key_policy,
      source:
        config.root_key_policy === "mainnet"
          ? "Compiled IC mainnet root key"
          : "Root key fetched under the certified local runtime policy",
    },
    networkIdBytes,
    rootKey,
    gatewayOrigin:
      config.target === "ic" ? "https://icp0.io" : config.gateway,
    allowInsecureLocalhost: config.target === "pocketic",
    queryAgent: agent,
  };
}

export function parseStatus(value: SelfCallValue): WagyuStatus {
  const record = exactObject(
    value,
    "Wagyu status",
    [
      "node",
      "network_id",
      "protocol",
      "profile_generation",
      "profile_revision",
      "state_revision",
      "feed_revision",
      "notification_revision",
      "relationship_revision",
      "unread_feed_count",
      "unread_notification_count",
      "outbound_work_pending",
      "outbox_queued_count",
      "outbox_error_count",
      "outbox_paused",
      "certified_assets_ready",
    ],
    ["pause_reason", "release_gate_message"],
  );
  const configuredNetworkId = exactHex32Text(
    record.network_id,
    "Wagyu status network ID",
  );
  exactNat64(record.profile_generation, "Wagyu profile generation");
  exactNat64(record.profile_revision, "Wagyu profile revision");
  exactNat64(record.state_revision, "Wagyu state revision");
  exactNat64(record.feed_revision, "Wagyu feed revision");
  exactNat64(
    record.notification_revision,
    "Wagyu notification revision",
  );
  exactNat64(
    record.relationship_revision,
    "Wagyu relationship revision",
  );
  exactBoolean(
    record.outbound_work_pending,
    "Wagyu outbound work status",
  );
  exactNatCount(
    record.outbox_queued_count,
    "Wagyu queued outbox count",
  );
  if (record.pause_reason !== undefined) {
    exactVariant(
      record.pause_reason,
      [
        "low_cycles",
        "revoked",
        "rate_limited",
        "incompatible",
        "handler_failure",
        "maintenance",
      ],
      "Wagyu pause reason",
    );
  }
  return {
    nodeId: exactPrincipalText(
      record.node,
      "Wagyu status node",
    ),
    configuredNetworkId:
      configuredNetworkId === ZERO_NETWORK_ID ? null : configuredNetworkId,
    networkConfigured: configuredNetworkId !== ZERO_NETWORK_ID,
    peerDeliveryEnabled: false,
    protocolVersion: exactText(record.protocol, "Wagyu status protocol"),
    unreadFeed: exactNatCount(
      record.unread_feed_count,
      "Wagyu unread feed count",
    ),
    unreadNotifications: exactNatCount(
      record.unread_notification_count,
      "Wagyu unread notification count",
    ),
    outboxErrors: exactNatCount(
      record.outbox_error_count,
      "Wagyu outbox error count",
    ),
    outboxPaused: exactBoolean(
      record.outbox_paused,
      "Wagyu outbox pause status",
    ),
    certifiedStoreReady: exactBoolean(
      record.certified_assets_ready,
      "Wagyu certified asset status",
    ),
    releaseGateMessage: optionalExactText(
      record.release_gate_message,
      "Wagyu release gate message",
    ),
    preview: false,
  };
}

function assertInstalledNetwork(
  status: WagyuStatus,
  trustedNetworkId: string,
): void {
  if (
    !status.networkConfigured ||
    status.configuredNetworkId === null ||
    status.configuredNetworkId !== trustedNetworkId
  ) {
    throw new Error(
      "Wagyu installation integrity failed: the backend network ID does not match the trusted runtime",
    );
  }
}

async function readPeerDeliveryEnabled(): Promise<boolean> {
  return parsePeerDeliveryEnabled(await listBackendCallReservations());
}

export function parsePeerDeliveryEnabled(value: JsonValue): boolean {
  const response = object(value, "Wagyu peer delivery reservations");
  if (!Array.isArray(response.reservations)) {
    throw new Error("Wagyu peer delivery reservations are invalid");
  }
  let matches = 0;
  for (const candidate of response.reservations) {
    const reservation = object(
      candidate,
      "Wagyu peer delivery reservation",
    );
    if (reservation.appId !== "wagyu") {
      throw new Error("Wagyu peer delivery reservation owner is invalid");
    }
    if (
      reservation.scopeKind === "method" &&
      reservation.method === WAGYU_PUBLIC_INGRESS_METHOD
    ) {
      if (reservation.principal !== null) {
        throw new Error("Wagyu peer delivery reservation scope is invalid");
      }
      matches += 1;
    }
  }
  if (matches > 1) {
    throw new Error("Wagyu peer delivery reservation is duplicated");
  }
  return matches === 1;
}

export function parseProfile(value: SelfCallValue): WagyuProfile {
  const profile = exactObject(
    value,
    "Wagyu profile",
    [
      "node",
      "network_id",
      "profile_generation",
      "revision",
      "updated_at_ns",
      "display_name",
      "description",
      "avatar_present",
      "protocol",
      "compatible",
    ],
    ["avatar_media_type", "avatar_width", "avatar_height"],
  );
  exactHex32Text(profile.network_id, "Wagyu profile network ID");
  const avatarPresent = exactBoolean(
    profile.avatar_present,
    "Wagyu profile avatar presence",
  );
  const avatarMediaType = optionalExactVariant(
    profile.avatar_media_type,
    ["jpeg", "png", "webp"],
    "Wagyu profile avatar media type",
  );
  const avatarWidth = optionalExactNatNumber(
    profile.avatar_width,
    0xffff,
    "Wagyu profile avatar width",
  );
  const avatarHeight = optionalExactNatNumber(
    profile.avatar_height,
    0xffff,
    "Wagyu profile avatar height",
  );
  if (
    avatarPresent !==
      (
        avatarMediaType !== null &&
        avatarWidth !== null &&
        avatarHeight !== null
      )
  ) {
    throw new Error("Wagyu profile avatar metadata is inconsistent");
  }
  return {
    nodeId: exactPrincipalText(profile.node, "Wagyu profile node"),
    profileGeneration: exactNat64(
      profile.profile_generation,
      "Wagyu profile generation",
    ),
    revision: exactNat64(profile.revision, "Wagyu profile revision"),
    displayName: exactText(
      profile.display_name,
      "Wagyu profile display name",
    ),
    description: exactText(
      profile.description,
      "Wagyu profile description",
    ),
    // ProfileViewV1 exposes only avatar metadata. The exact avatar bytes and
    // their presentation URL come from the independently certified profile.
    avatarUrl: null,
    avatar: null,
    proofState: "fresh",
    protocolVersion: exactText(profile.protocol, "Wagyu profile protocol"),
    compatible: exactBoolean(
      profile.compatible,
      "Wagyu profile compatibility",
    ),
    updatedAt: exactNanosecondsDate(
      profile.updated_at_ns,
      "Wagyu profile update time",
    ),
  };
}

function parseBridgeFeedPage(value: FeedPageV1): FeedPage {
  return {
    revision: value.revision.toString(),
    items: value.items.map((item) => {
      const disposition = candidVariantLabel(item.verification);
      const verification: VerificationState =
        disposition === "invalid"
          ? "invalid"
          : disposition === "unavailable"
            ? "unavailable"
            : "candidate";
      return {
        id: lowerHex(item.candidate_id),
        localSequence: item.local_sequence.toString(),
        receivedAt:
          nanosecondsToIso(item.received_at_ns.toString()) ??
          new Date(0).toISOString(),
        immediateSender: item.immediate_sender.toText(),
        kind: bridgeFeedKind(candidVariantLabel(item.event_kind)),
        verification,
        promotion:
          disposition === "verified" ? "committed" : "pending",
        author: {
          nodeId: item.claimed_author.toText(),
          displayName: null,
          avatarUrl: null,
          profileProof: "loading",
        },
        postId: lowerHex(item.claimed_post_id),
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
        opaqueEventBytes: item.exact_event_candid.slice(),
        originalPostRefBytes: null,
      };
    }),
    nextCursor: value.next_before_sequence[0]?.toString() ?? null,
  };
}

function bridgeFeedKind(value: string): FeedItem["kind"] {
  return value === "original" || value === "share" || value === "tombstone"
    ? value
    : "unsupported";
}

function parseBridgeNotificationPage(value: NotificationPageV1): NotificationPage {
  return {
    revision: value.revision.toString(),
    items: value.items.map((item) => {
      const kindValue = item.kind[0] ?? null;
      const kindLabel = candidVariantLabel(item.kind);
      const directed =
        kindValue &&
        ("like" in kindValue || "reply" in kindValue || "share" in kindValue)
          ? "like" in kindValue
            ? kindValue.like
            : "reply" in kindValue
              ? kindValue.reply
              : kindValue.share
          : null;
      const verification = bridgeNotificationVerification(
        candidVariantLabel(item.verification),
      );
      return {
        id: `notification-${item.local_sequence.toString()}`,
        localSequence: item.local_sequence.toString(),
        receivedAt:
          nanosecondsToIso(item.received_at_ns.toString()) ??
          new Date(0).toISOString(),
        actorNodeId: item.actor.toText(),
        actorDisplayName: null,
        actorAvatarUrl: null,
        actorProfileProof: "loading",
        kind: bridgeNotificationKind(kindLabel),
        verification,
        read: item.read,
        targetPostId: directed ? lowerHex(directed.target_post_id) : null,
        targetBodyHash: directed ? lowerHex(directed.target_body_hash) : null,
        actionId: directed ? lowerHex(directed.action_id) : null,
        objectDigest: directed ? lowerHex(directed.object_digest) : null,
        objectLength: directed?.object_length ?? null,
        verifiedReply: null,
      };
    }),
    nextCursor: value.next_before_sequence[0]?.toString() ?? null,
  };
}

function bridgeNotificationKind(value: string): NotificationItem["kind"] {
  if (value === "new-follower") return "follow";
  if (value === "like" || value === "reply" || value === "share") return value;
  return "unsupported";
}

function bridgeNotificationVerification(
  value: string,
): NotificationVerification {
  switch (value) {
    case "transport-authenticated":
    case "pending":
    case "verified":
    case "invalid":
    case "unavailable":
      return value;
    default:
      return "unsupported";
  }
}

function parseBridgeLikeNotificationEvidence(
  value: NotificationEvidenceV1,
  expectedSequence: string,
): Uint8Array | null {
  if (value.local_sequence.toString() !== expectedSequence) {
    throw new Error("Notification evidence sequence does not match its summary");
  }
  if (!value.found) return null;
  const evidence = value.evidence[0];
  if (!evidence || !("like" in evidence)) {
    throw new Error("Like notification evidence omitted its exact receipt");
  }
  return evidence.like.certified_like_receipt_candid.slice();
}

function candidVariantLabel(value: unknown): string {
  const unwrapped =
    Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!unwrapped || typeof unwrapped !== "object") return "unknown";
  return (Object.keys(unwrapped)[0] ?? "unknown")
    .replaceAll("_", "-")
    .toLowerCase();
}

export function parseAuthoredPage(value: JsonValue): AuthoredPage {
  const record = exactObject(
    value,
    "Wagyu authored page",
    ["revision", "items"],
    ["next_before_sequence"],
  );
  const revision = exactNat64(
    record.revision,
    "Wagyu authored page revision",
  );
  const values = exactVector(record.items, "Wagyu authored page items");
  if (values.length > RELATIONSHIP_PAGE_LIMIT) {
    throw new Error("The Wagyu authored page exceeded 50 rows");
  }
  return {
    revision,
    items: values.flatMap<AuthoredItem>((item) => {
      const authored = exactObject(
        item,
        "Wagyu authored item",
        [
          "sequence",
          "action_id",
          "object_digest",
          "state",
          "created_at_ns",
        ],
        [
          "action_kind",
          "body_markdown",
          "body_length",
          "reply_to",
          "target_post_id",
          "local_like_view",
        ],
      );
      const kind = authoredItemKind(authored.action_kind);
      if (!kind) return [];
      const actionId = exactHex32Text(
        authored.action_id,
        "Wagyu authored action ID",
      );
      const common = {
        sequence: exactNat64(
          authored.sequence,
          "Wagyu authored sequence",
        ),
        actionId,
        objectDigest: exactHex32Text(
          authored.object_digest,
          "Wagyu authored object digest",
        ),
        createdAt: exactNanosecondsDate(
          authored.created_at_ns,
          "Wagyu authored creation time",
        ),
      };
      const replyTo = optionalExactObject(
        authored.reply_to,
        "Wagyu authored reply locator",
        ["author", "post_id"],
      );
      const bodyLength = optionalExactNatNumber(
        authored.body_length,
        0xffff_ffff,
        "Wagyu authored body length",
      );
      return kind === "post"
        ? [{
            ...common,
            kind,
            postId: actionId,
            state: authoredPostState(authored.state),
            bodyMarkdown: optionalExactText(
              authored.body_markdown,
              "Wagyu authored body",
            ),
            bodyLength,
            replyTo: replyTo
              ? {
                  authorNodeId: exactPrincipalText(
                    replyTo.author,
                    "Wagyu authored reply author",
                  ),
                  postId: exactHex32Text(
                    replyTo.post_id,
                    "Wagyu authored reply post ID",
                  ),
                }
              : null,
            localLikeView: authoredLocalLikeView(
              authored.local_like_view,
              revision,
            ),
          }]
        : [{
            ...common,
            kind,
            state: authoredProtocolActionState(authored.state),
            targetPostId: optionalExactHex32Text(
              authored.target_post_id,
              "Wagyu authored target post ID",
            ),
          }];
    }),
    nextCursor: optionalExactNat64(
      record.next_before_sequence,
      "Wagyu authored continuation",
    ),
  };
}

function authoredLocalLikeView(
  value: JsonValue | undefined,
  revision: string,
): NonNullable<AuthoredPost["localLikeView"]> | null {
  const record = optionalExactObject(
    value,
    "Wagyu authored local Like accounting",
    [
      "post_body_hash_hex",
      "unsealed_receipt_count",
      "unsealed_liker_ids",
    ],
  );
  if (!record) return null;
  const postBodyHash = exactHex32Text(
    record.post_body_hash_hex,
    "Wagyu authored Like body hash",
  );
  const unsealedReceiptCount = exactNatNumber(
    record.unsealed_receipt_count,
    0xffff,
    "Wagyu authored unsealed Like count",
  );
  const unsealedLikerIds = exactVector(
    record.unsealed_liker_ids,
    "Wagyu authored unsealed liker IDs",
  ).map(
    (value) => exactPrincipalText(value, "Wagyu authored unsealed liker"),
  );
  if (
    unsealedReceiptCount > 299 ||
    new Set(unsealedLikerIds).size !== unsealedLikerIds.length ||
    unsealedLikerIds.length !== unsealedReceiptCount
  ) {
    throw new Error("Authored local Like accounting is malformed");
  }
  return {
    postBodyHash,
    unsealedReceiptCount,
    unsealedLikerIds,
    revision,
  };
}

function authoredItemKind(
  value: JsonValue | undefined,
): AuthoredItem["kind"] | null {
  if (value === undefined) return null;
  switch (
    exactVariant(
      value,
      ["post", "share", "like", "tombstone"],
      "Wagyu authored action kind",
    )
  ) {
    case "post":
      return "post";
    case "share":
      return "share";
    case "like":
      return "like";
    case "tombstone":
      return "tombstone";
    default:
      return null;
  }
}

function authoredPostState(value: JsonValue | undefined): AuthoredPost["state"] {
  const normalized = exactText(value, "Wagyu authored post state")
    .replaceAll("_", "-")
    .toLowerCase();
  switch (normalized) {
    case "awaiting-proof":
    case "live":
    case "withdrawal-awaiting-proof":
    case "withdrawal-closing":
    case "withdrawn":
      return normalized;
    default:
      return "unknown";
  }
}

function authoredProtocolActionState(
  value: JsonValue | undefined,
): Exclude<AuthoredItem, AuthoredPost>["state"] {
  const normalized = exactText(value, "Wagyu authored action state")
    .replaceAll("_", "-")
    .toLowerCase();
  switch (normalized) {
    case "awaiting-publication":
    case "awaiting-proof":
    case "certified":
    case "uncertain":
    case "failed":
      return normalized;
    default:
      return "unknown";
  }
}

export function parseRelationshipPage(value: JsonValue): RelationshipPage {
  const record = exactObject(
    value,
    "Wagyu relationship page",
    ["revision", "items"],
    ["next_before_node"],
  );
  const values = exactVector(
    record.items,
    "Wagyu relationship page items",
  );
  if (values.length > RELATIONSHIP_PAGE_LIMIT) {
    throw new Error("The Wagyu relationship page exceeded 50 rows");
  }
  const items = values.map(parseRelationship);
  const seen = new Set<string>();
  const principals: Principal[] = [];
  for (const item of items) {
    let principal: Principal;
    try {
      principal = Principal.fromText(item.nodeId);
    } catch {
      throw new Error("The Wagyu relationship page contains an invalid Node ID");
    }
    if (
      principal.toText() !== item.nodeId ||
      principal.toUint8Array().at(-1) !== 0x01 ||
      seen.has(item.nodeId)
    ) {
      throw new Error("The Wagyu relationship page contains an invalid Node ID");
    }
    seen.add(item.nodeId);
    principals.push(principal);
  }
  for (let index = 1; index < principals.length; index += 1) {
    if (principals[index - 1]!.compareTo(principals[index]!) !== "gt") {
      throw new Error("The Wagyu relationship page order is invalid");
    }
  }
  const nextCursor = optionalExactPrincipalText(
    record.next_before_node,
    "Wagyu relationship page continuation",
  );
  if (
    nextCursor !== null &&
    items.at(-1)?.nodeId !== nextCursor
  ) {
    throw new Error("The Wagyu relationship page cursor is invalid");
  }
  const revision = exactNat64(
    record.revision,
    "Wagyu relationship page revision",
  );
  return {
    revision,
    items,
    nextCursor,
  };
}

export function parseRelationship(value: JsonValue): Relationship {
  const record = exactObject(
    value,
    "Wagyu relationship",
    [
      "node",
      "following",
      "follower",
      "follower_delivery_credits",
      "following_renewal_requested",
      "following_auto_renew_due",
      "blocked",
      "bond_cycles",
      "protocol",
      "compatible",
    ],
    [
      "following_state",
      "follower_state",
      "follower_lease_expires_ns",
    ],
  );
  const followingState = optionalRelationshipState(
    record.following_state,
  );
  const followerState = optionalRelationshipState(
    record.follower_state,
  );
  const blocked = exactBoolean(
    record.blocked,
    "Wagyu relationship Block status",
  );
  exactBoolean(
    record.following_auto_renew_due,
    "Wagyu relationship automatic renewal status",
  );
  return {
    nodeId: exactPrincipalText(record.node, "Wagyu relationship node"),
    // Relationship summaries are authoritative only for graph state. Profile
    // presentation is loaded independently through certified HTTP.
    displayName: null,
    avatarUrl: null,
    profileProof: "loading",
    youFollow: exactBoolean(
      record.following,
      "Wagyu relationship following status",
    ),
    followsYou: exactBoolean(
      record.follower,
      "Wagyu relationship follower status",
    ),
    followingState,
    followerState,
    followerCredits: exactNatNumber(
      record.follower_delivery_credits,
      0xffff,
      "Wagyu follower delivery credits",
    ),
    followerLeaseExpiresAt: optionalExactNanosecondsDate(
      record.follower_lease_expires_ns,
      "Wagyu follower lease expiry",
    ),
    followingRenewalRequested: exactBoolean(
      record.following_renewal_requested,
      "Wagyu following renewal request",
    ),
    renewalCostCycles: exactNat(
      record.bond_cycles,
      "Wagyu relationship bond cycles",
    ),
    protocolVersion: exactText(
      record.protocol,
      "Wagyu relationship protocol",
    ),
    compatible: exactBoolean(
      record.compatible,
      "Wagyu relationship compatibility",
    ),
    blocked,
  };
}

function relationshipProfileFallback(nodeId: string): WagyuProfile {
  return {
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
}

function emptyFeedPage(): FeedPage {
  return { revision: "0", items: [], nextCursor: null };
}

function emptyAuthoredPage(): AuthoredPage {
  return { revision: "0", items: [], nextCursor: null };
}

function emptyNotificationPage(): NotificationPage {
  return { revision: "0", items: [], nextCursor: null };
}

function emptyRelationshipPage(): RelationshipPage {
  return { revision: "0", items: [], nextCursor: null };
}

export async function hydrateRelationshipProfileWithLoader(
  relationship: Relationship,
  loadProfile: WagyuAdapterPorts["loadProfile"],
): Promise<Relationship> {
  if (!loadProfile) {
    return {
      ...relationship,
      displayName: null,
      avatarUrl: null,
      profileProof: "unavailable",
    };
  }
  const profile = await loadProfile(
    relationship.nodeId,
    relationshipProfileFallback(relationship.nodeId),
  );
  if (profile.nodeId !== relationship.nodeId) {
    throw new Error(
      "Certified profile loader returned another relationship Node ID",
    );
  }
  const mayRender =
    profile.proofState === "fresh" || profile.proofState === "stale";
  return {
    ...relationship,
    displayName: mayRender ? profile.displayName || null : null,
    avatarUrl: mayRender ? profile.avatarUrl : null,
    profileProof: profile.proofState,
  };
}

export function parseSendQuote(value: JsonValue): SendQuote {
  const record = exactObject(
    value,
    "Wagyu send quote",
    [
      "follower_revision",
      "registered_follower_count",
      "eligible_delivery_count",
      "ineligible_follower_count",
      "eligible_recipient_preview",
      "receiver_floor_cycles",
      "author_notice_floor_cycles",
      "estimated_call_and_byte_cycles",
      "estimated_local_publication_cycles",
      "estimated_total_cycles",
    ],
  );
  const eligibleRecipients = exactNatNumber(
    record.eligible_delivery_count,
    0xffff_ffff,
    "Wagyu eligible delivery count",
  );
  const recipientPreview = parseEligibleRecipientPreview(
    record.eligible_recipient_preview,
  );
  if (recipientPreview.length > eligibleRecipients) {
    throw new Error(
      "The Wagyu recipient preview exceeded the eligible recipient count",
    );
  }
  return {
    followerRevision: exactNat64(
      record.follower_revision,
      "Wagyu follower revision",
    ),
    registeredFollowers: exactNatNumber(
      record.registered_follower_count,
      0xffff_ffff,
      "Wagyu registered follower count",
    ),
    eligibleRecipients,
    ineligibleFollowers: exactNatNumber(
      record.ineligible_follower_count,
      0xffff_ffff,
      "Wagyu ineligible follower count",
    ),
    recipientPreview,
    receiverFloorCycles: BigInt(
      exactNat(record.receiver_floor_cycles, "Wagyu receiver floor cycles"),
    ),
    authorNoticeFloorCycles: BigInt(
      exactNat(
        record.author_notice_floor_cycles,
        "Wagyu author notice floor cycles",
      ),
    ),
    callAndByteCycles: BigInt(
      exactNat(
        record.estimated_call_and_byte_cycles,
        "Wagyu call and byte cycles",
      ),
    ),
    localPublicationCycles: BigInt(
      exactNat(
        record.estimated_local_publication_cycles,
        "Wagyu local publication cycles",
      ),
    ),
    totalCycles: BigInt(
      exactNat(record.estimated_total_cycles, "Wagyu total cycles"),
    ),
    limitWarning: null,
  };
}

function parseEligibleRecipientPreview(
  value: JsonValue | undefined,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error("The Wagyu recipient preview is invalid");
  }
  if (value.length > SEND_QUOTE_RECIPIENT_PREVIEW_LIMIT) {
    throw new Error("The Wagyu recipient preview exceeded 8 nodes");
  }
  const principals = value.map((candidate) => {
    const text = exactPrincipalText(
      candidate,
      "Wagyu recipient preview Node ID",
    );
    try {
      const principal = Principal.fromText(text);
      if (
        principal.toText() !== text ||
        principal.toUint8Array().at(-1) !== 0x01
      ) {
        throw new Error("not a canonical canister principal");
      }
      return principal;
    } catch {
      throw new Error("The Wagyu recipient preview contains an invalid Node ID");
    }
  });
  for (let index = 1; index < principals.length; index += 1) {
    if (principals[index - 1]!.compareTo(principals[index]!) !== "lt") {
      throw new Error(
        "The Wagyu recipient preview order is invalid",
      );
    }
  }
  return principals.map((principal) => principal.toText());
}

function pageRequest(cursor: string | null, limit: number): JsonObject {
  return {
    ...(cursor === null ? {} : { before_sequence: cursor }),
    limit,
  };
}

function relationshipPageRequest(
  cursor: string | null,
  expectedRevision: string | null,
  limit = RELATIONSHIP_PAGE_LIMIT,
): JsonObject {
  return {
    ...(cursor === null ? {} : { before_node: cursor }),
    ...(expectedRevision === null
      ? {}
      : { expected_revision: expectedRevision }),
    limit,
  };
}

function boundedPageLimit(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Wagyu ${label} page limit is invalid`);
  }
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} is not a record`);
  return value;
}

function exactObject(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  const record = object(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(`${label} omitted required field ${key}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unexpected field ${key}`);
    }
  }
  return record;
}

function optionalExactObject(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject | null {
  if (value === undefined) return null;
  return exactObject(value, label, required, optional);
}

function isObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  );
}

function exactVector(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not a vector`);
  }
  return value as JsonValue[];
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not text`);
  }
  return value;
}

function optionalExactText(
  value: unknown,
  label: string,
): string | null {
  return value === undefined ? null : exactText(value, label);
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is not a Boolean`);
  }
  return value;
}

function exactNat(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new Error(`${label} is not a canonical Nat`);
  }
  return value;
}

function exactNat64(value: unknown, label: string): string {
  const result = exactNat(value, label);
  if (BigInt(result) > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} exceeds Nat64`);
  }
  return result;
}

function optionalExactNat64(
  value: unknown,
  label: string,
): string | null {
  return value === undefined ? null : exactNat64(value, label);
}

function exactNatCount(value: unknown, label: string): number {
  const result = exactNat(value, label);
  const parsed = BigInt(result);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the UI count range`);
  }
  return Number(parsed);
}

function exactNatNumber(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${label} is not a bounded Nat number`);
  }
  return value;
}

function optionalExactNatNumber(
  value: unknown,
  maximum: number,
  label: string,
): number | null {
  return value === undefined ? null : exactNatNumber(value, maximum, label);
}

function exactPrincipalText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not principal text`);
  }
  try {
    if (Principal.fromText(value).toText() !== value) {
      throw new Error("principal is not canonical");
    }
    return value;
  } catch {
    throw new Error(`${label} is not a canonical principal`);
  }
}

function optionalExactPrincipalText(
  value: unknown,
  label: string,
): string | null {
  return value === undefined ? null : exactPrincipalText(value, label);
}

function exactHex32Text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value)
  ) {
    throw new Error(`${label} is not lowercase 32-byte hexadecimal text`);
  }
  return value;
}

function optionalExactHex32Text(
  value: unknown,
  label: string,
): string | null {
  return value === undefined ? null : exactHex32Text(value, label);
}

function exactVariant<const Tag extends string>(
  value: unknown,
  tags: readonly Tag[],
  label: string,
): Tag {
  if (!isObject(value)) {
    throw new Error(`${label} is not a variant`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    !tags.includes(keys[0] as Tag) ||
    value[keys[0]!] !== null
  ) {
    throw new Error(`${label} is not a current nullary variant`);
  }
  return keys[0] as Tag;
}

function optionalExactVariant<const Tag extends string>(
  value: unknown,
  tags: readonly Tag[],
  label: string,
): Tag | null {
  return value === undefined ? null : exactVariant(value, tags, label);
}

function exactNanosecondsDate(value: unknown, label: string): string {
  const result = nanosecondsToIso(exactNat64(value, label));
  if (result === null) {
    throw new Error(`${label} is outside the supported date range`);
  }
  return result;
}

function optionalExactNanosecondsDate(
  value: unknown,
  label: string,
): string | null {
  return value === undefined ? null : exactNanosecondsDate(value, label);
}

function optionalRelationshipState(
  value: JsonValue | undefined,
): RelationshipState | null {
  if (value === undefined) return null;
  const tag = exactVariant(
    value,
    [
      "registering",
      "active",
      "credit_low",
      "expired",
      "cleanup_pending",
      "incompatible",
      "blocked",
    ],
    "Wagyu relationship state",
  ).replaceAll("_", "-");
  switch (tag) {
    case "registering":
    case "active":
    case "credit-low":
    case "expired":
    case "cleanup-pending":
    case "incompatible":
    case "blocked":
      return tag;
    default:
      throw new Error("Wagyu relationship state is invalid");
  }
}

function publishStage(value: JsonValue | undefined): PublishStage {
  const tag =
    typeof value === "string"
      ? value.replaceAll("_", "-").toLowerCase()
      : "uncertain";
  switch (tag) {
    case "draft":
    case "encoding":
    case "publishing":
    case "awaiting-proof":
    case "certified-ref-ready":
    case "withdrawal-closing":
    case "fanout-queued":
    case "sending":
    case "complete":
    case "partial":
    case "failed":
    case "uncertain":
      return tag;
    default:
      return "uncertain";
  }
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("Trusted Wagyu network id is malformed");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseHex32Bytes(
  value: string | null,
  label: string,
): Uint8Array {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Verified ${label} is unavailable`);
  }
  return hexBytes(value);
}

function exactReplyLocator(item: FeedItem): {
  author: string;
  post_id: Uint8Array;
  body_hash: Uint8Array;
  body_length: number;
  object_digest: Uint8Array;
} {
  if (
    item.verification !== "verified" ||
    item.kind === "tombstone" ||
    item.bodyLength === null
  ) {
    throw new Error("A reply requires a verified live post");
  }
  return {
    author: item.author.nodeId,
    post_id: parseHex32Bytes(item.postId, "reply post ID"),
    body_hash: parseHex32Bytes(item.bodyDigest, "reply post body hash"),
    body_length: item.bodyLength,
    object_digest: parseHex32Bytes(
      item.objectDigest,
      "reply post object digest",
    ),
  };
}

function nanosecondsToIso(value: string): string | null {
  try {
    const milliseconds = BigInt(value) / 1_000_000n;
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return new Date(Number(milliseconds)).toISOString();
  } catch {
    return null;
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
