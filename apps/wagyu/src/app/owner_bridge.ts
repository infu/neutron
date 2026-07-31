import { Principal } from "@dfinity/principal";
import type {
  JsonObject,
  JsonValue,
  SelfCallObject,
  SelfCallValue,
} from "neutron-tools/app";
import {
  WAGYU_CODECS,
  type WagyuCandidCodec,
} from "../protocol/codecs.ts";
import {
  assertBoundedText,
  assertNat16,
  assertNat32,
  bytes16,
  bytes32,
  lowerHex,
  parseLowerHex32,
  WagyuProtocolError,
} from "../protocol/bytes.ts";
import { WAGYU_LIMITS } from "../protocol/constants.ts";
import type {
  CertifiedHttpProofV1,
  CertifiedPostRefV1,
  ExactDecodedCandidV1,
  FeedPageV1,
  NotificationEvidenceV1,
  NotificationPageV1,
} from "../protocol/types.ts";

export const WAGYU_OWNER_BRIDGE_METHODS = Object.freeze({
  feedPage: "wagyu_feed_page_self_v1",
  notificationPage: "wagyu_notification_page_self_v1",
  notificationEvidence: "wagyu_notification_evidence_self_v1",
  blockStatuses: "wagyu_block_statuses_self_v1",
  profileEdit: "wagyu_profile_edit_v1",
  follow: "wagyu_follow_self_v1",
  postPrepare: "wagyu_post_prepare_self_v1",
  sharePrepare: "wagyu_share_prepare_self_v1",
  likePrepare: "wagyu_like_prepare_self_v1",
  tombstonePrepare: "wagyu_tombstone_prepare_self_v1",
  postFinalize: "wagyu_post_finalize_self_v1",
  shareFinalize: "wagyu_share_finalize_self_v1",
  likeFinalize: "wagyu_like_finalize_self_v1",
  tombstoneFinalize: "wagyu_tombstone_finalize_self_v1",
  feedPromote: "wagyu_feed_promote_self_v1",
  feedReject: "wagyu_feed_reject_self_v1",
  notificationPromote: "wagyu_notification_promote_self_v1",
  likeSeal: "wagyu_like_seal_self_v1",
  withdrawalAdvance: "wagyu_withdrawal_advance_self_v1",
} as const);

export type WagyuOwnerBridgeMethod =
  (typeof WAGYU_OWNER_BRIDGE_METHODS)[keyof typeof WAGYU_OWNER_BRIDGE_METHODS];

export interface WagyuOwnerBridgeMethodContract {
  readonly mode: "query" | "update";
  readonly maxInputBlobBytes: number;
  readonly maxOutputBlobBytes: number;
}

function contract(
  mode: "query" | "update",
  maxInputBlobBytes = 0,
  maxOutputBlobBytes = 0,
): WagyuOwnerBridgeMethodContract {
  return Object.freeze({
    mode,
    maxInputBlobBytes,
    maxOutputBlobBytes,
  });
}

export const WAGYU_OWNER_BRIDGE_CONTRACTS = Object.freeze({
  [WAGYU_OWNER_BRIDGE_METHODS.feedPage]: contract("query", 0, 614_400),
  [WAGYU_OWNER_BRIDGE_METHODS.notificationPage]: contract(
    "query",
    0,
    131_072,
  ),
  [WAGYU_OWNER_BRIDGE_METHODS.notificationEvidence]: contract(
    "query",
    0,
    8_192,
  ),
  [WAGYU_OWNER_BRIDGE_METHODS.blockStatuses]: contract("query"),
  [WAGYU_OWNER_BRIDGE_METHODS.profileEdit]: contract(
    "update",
    WAGYU_LIMITS.profileAvatarBytes,
  ),
  [WAGYU_OWNER_BRIDGE_METHODS.follow]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.postPrepare]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.sharePrepare]: contract("update", 16_384),
  [WAGYU_OWNER_BRIDGE_METHODS.likePrepare]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.tombstonePrepare]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.postFinalize]: contract("update", 5_500),
  [WAGYU_OWNER_BRIDGE_METHODS.shareFinalize]: contract("update", 5_500),
  [WAGYU_OWNER_BRIDGE_METHODS.likeFinalize]: contract("update", 5_500),
  [WAGYU_OWNER_BRIDGE_METHODS.tombstoneFinalize]: contract("update", 5_500),
  [WAGYU_OWNER_BRIDGE_METHODS.feedPromote]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.feedReject]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.notificationPromote]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.likeSeal]: contract("update"),
  [WAGYU_OWNER_BRIDGE_METHODS.withdrawalAdvance]: contract("update"),
} satisfies Record<WagyuOwnerBridgeMethod, WagyuOwnerBridgeMethodContract>);

export type WagyuBridgeBytes =
  | Uint8Array
  | ArrayBuffer
  | string;
export type WagyuBridgePrincipal = Principal | string;
export type WagyuBridgeNat64 = bigint | string;
export type WagyuSelfUnitVariant<Tag extends string> =
  Tag extends unknown ? Readonly<Record<Tag, null>> : never;

export type FeedPageSelfRequestV1 = Readonly<{
  before_sequence?: string;
  limit: number;
}>;

export type NotificationPageSelfRequestV1 = Readonly<{
  before_sequence?: string;
  limit: number;
}>;

export type NotificationEvidenceSelfRequestV1 = Readonly<{
  local_sequence: string;
}>;

export type BlockStatusesSelfRequestV1 = Readonly<{
  nodes: readonly string[];
}>;

export type BlockStatusSelfV1 = Readonly<{
  node: string;
  blocked: boolean;
}>;

export type BlockStatusesSelfOutputV1 = Readonly<{
  relationship_revision: string;
  items: readonly BlockStatusSelfV1[];
}>;

export type ProfileEditAvatarSelfV1 = Readonly<{
  media_type?: WagyuSelfUnitVariant<"jpeg" | "png" | "webp">;
  width: number;
  height: number;
  bytes: Uint8Array;
}>;

export type ProfileEditSelfRequestV1 = Readonly<{
  expected_profile_generation: string;
  expected_revision: string;
  display_name: string;
  description: string;
  avatar?: ProfileEditAvatarSelfV1;
}>;

export type FollowSelfRequestV1 = Readonly<{
  node: string;
  subscription_id_hex: string;
}>;

export type ReplyLocatorSelfV1 = Readonly<{
  author: string;
  post_id_hex: string;
  body_hash_hex: string;
  body_length: number;
  object_digest_hex: string;
}>;

export type PostPrepareSelfRequestV1 = Readonly<{
  body_markdown: string;
  nonce_hex: string;
  reply_to?: ReplyLocatorSelfV1;
}>;

export type SharePrepareSelfRequestV1 = Readonly<{
  nonce_hex?: string;
  exact_original_post_ref_candid: Uint8Array;
}>;

export type LikePrepareSelfRequestV1 = Readonly<{
  post_author: string;
  post_id_hex: string;
  post_body_hash_hex: string;
  post_object_digest_hex?: string;
  nonce_hex: string;
}>;

export type TombstonePrepareSelfRequestV1 = Readonly<{
  post_id_hex: string;
  nonce_hex: string;
}>;

export type FinalizeSelfRequestV1 = Readonly<{
  action_id_hex: string;
  object_digest_hex: string;
  exact_proof_candid: Uint8Array;
}>;

export type FeedPromoteSelfRequestV1 = Readonly<{
  candidate_id_hex: string;
  verified_author: string;
  verified_post_id_hex: string;
  verified_body_hash_hex: string;
  verified_object_digest_hex: string;
}>;

export type FeedRejectDispositionV1 = "invalid" | "unavailable";

export type FeedRejectSelfRequestV1 = Readonly<{
  candidate_id_hex: string;
  disposition?: WagyuSelfUnitVariant<FeedRejectDispositionV1>;
}>;

export type NotificationDispositionV1 =
  | "verified"
  | "invalid"
  | "unavailable";

export type VerifiedReplySelfV1 = Readonly<{
  author: string;
  post_id_hex: string;
  body_hash_hex: string;
  body_length: number;
  object_digest_hex: string;
  reply_to: ReplyLocatorSelfV1;
}>;

export type NotificationPromoteSelfRequestV1 = Readonly<{
  local_sequence: string;
  disposition?: WagyuSelfUnitVariant<NotificationDispositionV1>;
  verified_reply?: VerifiedReplySelfV1;
}>;

export type LikeSealSelfRequestV1 = Readonly<{
  post_id_hex: string;
  final_partial: boolean;
}>;

export type WithdrawalAdvanceSelfRequestV1 = Readonly<{
  post_id_hex: string;
  nonce_hex: string;
}>;

export type FeedPageSelfValueV1 = Readonly<{
  revision: string;
  item_count: number;
  body_bytes: number;
  body_digest_hex: string;
}>;

export type NotificationPageSelfValueV1 = Readonly<{
  revision: string;
  item_count: number;
  body_bytes: number;
  body_digest_hex: string;
}>;

export type NotificationEvidenceSelfValueV1 = Readonly<{
  local_sequence: string;
  found: boolean;
  body_bytes: number;
  body_digest_hex: string;
}>;

export type FeedPageSelfResultV1 = Readonly<
  ExactDecodedCandidV1<FeedPageV1> & {
    metadata: FeedPageSelfValueV1;
  }
>;

export type NotificationPageSelfResultV1 = Readonly<
  ExactDecodedCandidV1<NotificationPageV1> & {
    metadata: NotificationPageSelfValueV1;
  }
>;

export type NotificationEvidenceSelfResultV1 = Readonly<
  ExactDecodedCandidV1<NotificationEvidenceV1> & {
    metadata: NotificationEvidenceSelfValueV1;
  }
>;

export type PublishStageSelfV1 =
  | "awaiting_proof"
  | "certified_ref_ready"
  | "fanout_queued"
  | "complete"
  | "partial"
  | "failed"
  | "uncertain";

export type PublishSelfResultV1 = Readonly<{
  stage: PublishStageSelfV1 | null;
  post_id_hex: string | null;
  action_id_hex: string | null;
  object_digest_hex: string | null;
  queued_recipient_count: number;
  queued_notice_count: number;
  accepted_recipient_count: number;
  failed_recipient_count: number;
  message: string;
}>;

export type ProfileEditSelfResultV1 = Readonly<{
  outcome:
    | Readonly<{
        updated: {
          profile_generation: string;
          revision: string;
          body_digest: Uint8Array;
        };
      }>
    | Readonly<{
        conflict: {
          current_generation: string;
          current_revision: string;
        };
      }>
    | Readonly<{
        rejected: {
          reason: "invalid" | "full" | "low_cycles" | null;
        };
      }>
    | null;
}>;

export interface WagyuOwnerSelfCallTransport {
  query<T extends SelfCallValue = SelfCallValue>(
    method: string,
    args: SelfCallValue[],
    timeoutSeconds: number,
  ): Promise<T>;
  update<T extends SelfCallValue = SelfCallValue>(
    method: string,
    args: SelfCallValue[],
    timeoutSeconds: number,
  ): Promise<T>;
}

export class WagyuOwnerBridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WagyuOwnerBridgeError";
  }
}

export function buildFeedPageSelfRequest(
  request: Readonly<{
    before_sequence: WagyuBridgeNat64 | null;
    limit: number;
  }>,
): FeedPageSelfRequestV1 {
  return Object.freeze({
    ...(request.before_sequence === null
      ? {}
      : {
          before_sequence: canonicalNat64(
            request.before_sequence,
            "before_sequence",
          ),
        }),
    limit: boundedNat16(request.limit, 1, WAGYU_LIMITS.feedPageItems, "limit"),
  });
}

export function buildNotificationPageSelfRequest(
  request: Readonly<{
    before_sequence: WagyuBridgeNat64 | null;
    limit: number;
  }>,
): NotificationPageSelfRequestV1 {
  return Object.freeze({
    ...(request.before_sequence === null
      ? {}
      : {
          before_sequence: canonicalNat64(
            request.before_sequence,
            "before_sequence",
          ),
        }),
    limit: boundedNat16(
      request.limit,
      1,
      WAGYU_LIMITS.notificationPageItems,
      "limit",
    ),
  });
}

export function buildNotificationEvidenceSelfRequest(
  request: Readonly<{ local_sequence: WagyuBridgeNat64 }>,
): NotificationEvidenceSelfRequestV1 {
  return Object.freeze({
    local_sequence: canonicalNat64(request.local_sequence, "local_sequence"),
  });
}

export function buildBlockStatusesSelfRequest(
  request: Readonly<{ nodes: readonly WagyuBridgePrincipal[] }>,
): BlockStatusesSelfRequestV1 {
  if (request.nodes.length === 0 || request.nodes.length > 500) {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_BOUND",
      "nodes must contain between 1 and 500 principals",
    );
  }
  const seen = new Set<string>();
  const nodes = request.nodes.map((node, index) => {
    const canonical = canonicalPrincipal(node, `nodes[${index}]`);
    const principal = Principal.fromText(canonical);
    if (
      principal.toUint8Array().byteLength === 0 ||
      principal.toUint8Array().at(-1) !== 0x01
    ) {
      throw bridgeError(
        "WAGYU_OWNER_INVALID_PRINCIPAL",
        `nodes[${index}] must be a canister principal`,
      );
    }
    if (seen.has(canonical)) {
      throw bridgeError(
        "WAGYU_OWNER_DUPLICATE_NODE",
        "nodes must not contain duplicate principals",
      );
    }
    seen.add(canonical);
    return canonical;
  });
  return Object.freeze({ nodes: Object.freeze(nodes) });
}

export function buildProfileEditSelfRequest(
  request: Readonly<{
    expected_profile_generation: WagyuBridgeNat64;
    expected_revision: WagyuBridgeNat64;
    display_name: string;
    description: string;
    avatar:
      | Readonly<{
          media_type: "jpeg" | "png" | "webp" | null;
          width: number;
          height: number;
          bytes: Uint8Array | ArrayBuffer;
        }>
      | null;
  }>,
): ProfileEditSelfRequestV1 {
  const avatar = request.avatar === null
    ? undefined
    : Object.freeze({
        ...(request.avatar.media_type === null
          ? {}
          : {
              media_type: unitVariant(
                request.avatar.media_type,
                ["jpeg", "png", "webp"] as const,
                "avatar.media_type",
              ),
            }),
        width: boundedNat16(
          request.avatar.width,
          1,
          WAGYU_LIMITS.profileAvatarDimension,
          "avatar.width",
        ),
        height: boundedNat16(
          request.avatar.height,
          1,
          WAGYU_LIMITS.profileAvatarDimension,
          "avatar.height",
        ),
        bytes: boundedNonEmptyBinary(
          request.avatar.bytes,
          WAGYU_OWNER_BRIDGE_CONTRACTS[
            WAGYU_OWNER_BRIDGE_METHODS.profileEdit
          ].maxInputBlobBytes,
          "profile avatar bytes",
        ),
      });
  return Object.freeze({
    expected_profile_generation: canonicalNat64(
      request.expected_profile_generation,
      "expected_profile_generation",
    ),
    expected_revision: canonicalNat64(
      request.expected_revision,
      "expected_revision",
    ),
    display_name: assertBoundedText(
      request.display_name,
      WAGYU_LIMITS.profileDisplayNameUtf8Bytes,
      "display_name",
    ),
    description: assertBoundedText(
      request.description,
      WAGYU_LIMITS.profileDescriptionUtf8Bytes,
      "description",
    ),
    ...(avatar === undefined ? {} : { avatar }),
  });
}

export function buildFollowSelfRequest(
  request: Readonly<{
    node: WagyuBridgePrincipal;
    subscription_id: WagyuBridgeBytes;
  }>,
): FollowSelfRequestV1 {
  return Object.freeze({
    node: canonicalPrincipal(request.node, "node"),
    subscription_id_hex: fixedHex(
      request.subscription_id,
      16,
      "subscription_id",
    ),
  });
}

export function buildPostPrepareSelfRequest(
  request: Readonly<{
    body_markdown: string;
    nonce: WagyuBridgeBytes;
    reply_to:
      | Readonly<{
          author: WagyuBridgePrincipal;
          post_id: WagyuBridgeBytes;
          body_hash: WagyuBridgeBytes;
          body_length: number;
          object_digest: WagyuBridgeBytes;
        }>
      | null;
  }>,
): PostPrepareSelfRequestV1 {
  return Object.freeze({
    body_markdown: assertBoundedText(
      request.body_markdown,
      WAGYU_LIMITS.bodyMarkdownUtf8Bytes,
      "body_markdown",
    ),
    nonce_hex: fixedHex(request.nonce, 16, "nonce"),
    ...(request.reply_to === null
      ? {}
      : {
          reply_to: Object.freeze({
            author: canonicalPrincipal(
              request.reply_to.author,
              "reply_to.author",
            ),
            post_id_hex: fixedHex(
              request.reply_to.post_id,
              32,
              "reply_to.post_id",
            ),
            body_hash_hex: fixedHex(
              request.reply_to.body_hash,
              32,
              "reply_to.body_hash",
            ),
            body_length: assertNat32(
              request.reply_to.body_length,
              "reply_to.body_length",
            ),
            object_digest_hex: fixedHex(
              request.reply_to.object_digest,
              32,
              "reply_to.object_digest",
            ),
          }),
        }),
  });
}

export function buildSharePrepareSelfRequest(
  request: Readonly<{
    nonce: WagyuBridgeBytes | null;
    exact_original_post_ref_candid: Uint8Array | ArrayBuffer;
  }>,
): Readonly<{
  request: SharePrepareSelfRequestV1;
  decoded: ExactDecodedCandidV1<CertifiedPostRefV1>;
}> {
  const decoded = validatedExactCandidBinary(
    WAGYU_CODECS.CertifiedPostRefV1,
    request.exact_original_post_ref_candid,
    WAGYU_OWNER_BRIDGE_CONTRACTS[
      WAGYU_OWNER_BRIDGE_METHODS.sharePrepare
    ].maxInputBlobBytes,
    "exact_original_post_ref_candid",
  );
  return Object.freeze({
    request: Object.freeze({
      ...(request.nonce === null
        ? {}
        : { nonce_hex: fixedHex(request.nonce, 16, "nonce") }),
      exact_original_post_ref_candid: copyBinary(decoded.exact_bytes),
    }),
    decoded,
  });
}

export function buildLikePrepareSelfRequest(
  request: Readonly<{
    post_author: WagyuBridgePrincipal;
    post_id: WagyuBridgeBytes;
    post_body_hash: WagyuBridgeBytes;
    post_object_digest: WagyuBridgeBytes | null;
    nonce: WagyuBridgeBytes;
  }>,
): LikePrepareSelfRequestV1 {
  return Object.freeze({
    post_author: canonicalPrincipal(request.post_author, "post_author"),
    post_id_hex: fixedHex(request.post_id, 32, "post_id"),
    post_body_hash_hex: fixedHex(
      request.post_body_hash,
      32,
      "post_body_hash",
    ),
    ...(request.post_object_digest === null
      ? {}
      : {
          post_object_digest_hex: fixedHex(
            request.post_object_digest,
            32,
            "post_object_digest",
          ),
        }),
    nonce_hex: fixedHex(request.nonce, 16, "nonce"),
  });
}

export function buildTombstonePrepareSelfRequest(
  request: Readonly<{
    post_id: WagyuBridgeBytes;
    nonce: WagyuBridgeBytes;
  }>,
): TombstonePrepareSelfRequestV1 {
  return Object.freeze({
    post_id_hex: fixedHex(request.post_id, 32, "post_id"),
    nonce_hex: fixedHex(request.nonce, 16, "nonce"),
  });
}

export function buildFinalizeSelfRequest(
  request: Readonly<{
    action_id: WagyuBridgeBytes;
    object_digest: WagyuBridgeBytes;
    exact_proof_candid: Uint8Array | ArrayBuffer;
  }>,
): Readonly<{
  request: FinalizeSelfRequestV1;
  decoded: ExactDecodedCandidV1<CertifiedHttpProofV1>;
}> {
  const decoded = validatedExactCandidBinary(
    WAGYU_CODECS.CertifiedHttpProofV1,
    request.exact_proof_candid,
    WAGYU_OWNER_BRIDGE_CONTRACTS[
      WAGYU_OWNER_BRIDGE_METHODS.postFinalize
    ].maxInputBlobBytes,
    "exact_proof_candid",
  );
  return Object.freeze({
    request: Object.freeze({
      action_id_hex: fixedHex(request.action_id, 32, "action_id"),
      object_digest_hex: fixedHex(
        request.object_digest,
        32,
        "object_digest",
      ),
      exact_proof_candid: copyBinary(decoded.exact_bytes),
    }),
    decoded,
  });
}

export function buildFeedPromoteSelfRequest(
  request: Readonly<{
    candidate_id: WagyuBridgeBytes;
    verified_author: WagyuBridgePrincipal;
    verified_post_id: WagyuBridgeBytes;
    verified_body_hash: WagyuBridgeBytes;
    verified_object_digest: WagyuBridgeBytes;
  }>,
): FeedPromoteSelfRequestV1 {
  return Object.freeze({
    candidate_id_hex: fixedHex(request.candidate_id, 32, "candidate_id"),
    verified_author: canonicalPrincipal(
      request.verified_author,
      "verified_author",
    ),
    verified_post_id_hex: fixedHex(
      request.verified_post_id,
      32,
      "verified_post_id",
    ),
    verified_body_hash_hex: fixedHex(
      request.verified_body_hash,
      32,
      "verified_body_hash",
    ),
    verified_object_digest_hex: fixedHex(
      request.verified_object_digest,
      32,
      "verified_object_digest",
    ),
  });
}

export function buildFeedRejectSelfRequest(
  request: Readonly<{
    candidate_id: WagyuBridgeBytes;
    disposition: FeedRejectDispositionV1 | null;
  }>,
): FeedRejectSelfRequestV1 {
  return Object.freeze({
    candidate_id_hex: fixedHex(request.candidate_id, 32, "candidate_id"),
    ...(request.disposition === null
      ? {}
      : {
          disposition: unitVariant(
            request.disposition,
            ["invalid", "unavailable"] as const,
            "disposition",
          ),
        }),
  });
}

export function buildNotificationPromoteSelfRequest(
  request: Readonly<{
    local_sequence: WagyuBridgeNat64;
    disposition: NotificationDispositionV1 | null;
    verified_reply?:
      | Readonly<{
          author: WagyuBridgePrincipal;
          post_id: WagyuBridgeBytes;
          body_hash: WagyuBridgeBytes;
          body_length: number;
          object_digest: WagyuBridgeBytes;
          reply_to: Readonly<{
            author: WagyuBridgePrincipal;
            post_id: WagyuBridgeBytes;
            body_hash: WagyuBridgeBytes;
            body_length: number;
            object_digest: WagyuBridgeBytes;
          }>;
        }>
      | null;
  }>,
): NotificationPromoteSelfRequestV1 {
  return Object.freeze({
    local_sequence: canonicalNat64(
      request.local_sequence,
      "local_sequence",
    ),
    ...(request.disposition === null
      ? {}
      : {
          disposition: unitVariant(
            request.disposition,
            ["verified", "invalid", "unavailable"] as const,
            "disposition",
          ),
        }),
    ...(request.verified_reply == null
      ? {}
      : {
          verified_reply: Object.freeze({
            author: canonicalPrincipal(
              request.verified_reply.author,
              "verified_reply.author",
            ),
            post_id_hex: fixedHex(
              request.verified_reply.post_id,
              32,
              "verified_reply.post_id",
            ),
            body_hash_hex: fixedHex(
              request.verified_reply.body_hash,
              32,
              "verified_reply.body_hash",
            ),
            body_length: assertNat32(
              request.verified_reply.body_length,
              "verified_reply.body_length",
            ),
            object_digest_hex: fixedHex(
              request.verified_reply.object_digest,
              32,
              "verified_reply.object_digest",
            ),
            reply_to: Object.freeze({
              author: canonicalPrincipal(
                request.verified_reply.reply_to.author,
                "verified_reply.reply_to.author",
              ),
              post_id_hex: fixedHex(
                request.verified_reply.reply_to.post_id,
                32,
                "verified_reply.reply_to.post_id",
              ),
              body_hash_hex: fixedHex(
                request.verified_reply.reply_to.body_hash,
                32,
                "verified_reply.reply_to.body_hash",
              ),
              body_length: assertNat32(
                request.verified_reply.reply_to.body_length,
                "verified_reply.reply_to.body_length",
              ),
              object_digest_hex: fixedHex(
                request.verified_reply.reply_to.object_digest,
                32,
                "verified_reply.reply_to.object_digest",
              ),
            }),
          }),
        }),
  });
}

export function buildLikeSealSelfRequest(
  request: Readonly<{
    post_id: WagyuBridgeBytes;
    final_partial: boolean;
  }>,
): LikeSealSelfRequestV1 {
  if (typeof request.final_partial !== "boolean") {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_BOOLEAN",
      "final_partial must be boolean",
    );
  }
  return Object.freeze({
    post_id_hex: fixedHex(request.post_id, 32, "post_id"),
    final_partial: request.final_partial,
  });
}

export function buildWithdrawalAdvanceSelfRequest(
  request: Readonly<{
    post_id: WagyuBridgeBytes;
    nonce: WagyuBridgeBytes;
  }>,
): WithdrawalAdvanceSelfRequestV1 {
  return Object.freeze({
    post_id_hex: fixedHex(request.post_id, 32, "post_id"),
    nonce_hex: fixedHex(request.nonce, 16, "nonce"),
  });
}

export function decodeFeedPageSelfResponse(
  value: SelfCallValue,
): FeedPageSelfResultV1 {
  const output = binaryOutput(value, "feed page");
  const metadataRecord = record(output.value, "feed page metadata");
  const metadata: FeedPageSelfValueV1 = Object.freeze({
    revision: canonicalNat64(metadataRecord.revision, "metadata.revision"),
    item_count: nat16(metadataRecord.item_count, "metadata.item_count"),
    body_bytes: nat32(metadataRecord.body_bytes, "metadata.body_bytes"),
    body_digest_hex: fixedHex(
      metadataRecord.body_digest_hex,
      32,
      "metadata.body_digest_hex",
    ),
  });
  const decoded = decodeOutputBinary(
    WAGYU_OWNER_BRIDGE_METHODS.feedPage,
    WAGYU_CODECS.FeedPageV1,
    output.body,
  );
  assertMetadataBodyBytes(metadata.body_bytes, output.body, "feed page");
  if (metadata.revision !== decoded.value.revision.toString(10)) {
    throw metadataMismatch("feed page revision");
  }
  if (metadata.item_count !== decoded.value.items.length) {
    throw metadataMismatch("feed page item count");
  }
  if (metadata.body_digest_hex !== lowerHex(decoded.object_digest)) {
    throw metadataMismatch("feed page body digest");
  }
  return Object.freeze({ ...decoded, metadata });
}

export function decodeNotificationPageSelfResponse(
  value: SelfCallValue,
): NotificationPageSelfResultV1 {
  const output = binaryOutput(value, "notification page");
  const metadataRecord = record(output.value, "notification page metadata");
  const metadata: NotificationPageSelfValueV1 = Object.freeze({
    revision: canonicalNat64(metadataRecord.revision, "metadata.revision"),
    item_count: nat16(metadataRecord.item_count, "metadata.item_count"),
    body_bytes: nat32(metadataRecord.body_bytes, "metadata.body_bytes"),
    body_digest_hex: fixedHex(
      metadataRecord.body_digest_hex,
      32,
      "metadata.body_digest_hex",
    ),
  });
  const decoded = decodeOutputBinary(
    WAGYU_OWNER_BRIDGE_METHODS.notificationPage,
    WAGYU_CODECS.NotificationPageV1,
    output.body,
  );
  assertMetadataBodyBytes(
    metadata.body_bytes,
    output.body,
    "notification page",
  );
  if (metadata.revision !== decoded.value.revision.toString(10)) {
    throw metadataMismatch("notification page revision");
  }
  if (metadata.item_count !== decoded.value.items.length) {
    throw metadataMismatch("notification page item count");
  }
  if (metadata.body_digest_hex !== lowerHex(decoded.object_digest)) {
    throw metadataMismatch("notification page body digest");
  }
  return Object.freeze({ ...decoded, metadata });
}

export function decodeNotificationEvidenceSelfResponse(
  request: NotificationEvidenceSelfRequestV1,
  value: SelfCallValue,
): NotificationEvidenceSelfResultV1 {
  const output = binaryOutput(value, "notification evidence");
  const metadataRecord = record(
    output.value,
    "notification evidence metadata",
  );
  const metadata: NotificationEvidenceSelfValueV1 = Object.freeze({
    local_sequence: canonicalNat64(
      metadataRecord.local_sequence,
      "metadata.local_sequence",
    ),
    found: boolean(metadataRecord.found, "metadata.found"),
    body_bytes: nat32(metadataRecord.body_bytes, "metadata.body_bytes"),
    body_digest_hex: fixedHex(
      metadataRecord.body_digest_hex,
      32,
      "metadata.body_digest_hex",
    ),
  });
  const decoded = decodeOutputBinary(
    WAGYU_OWNER_BRIDGE_METHODS.notificationEvidence,
    WAGYU_CODECS.NotificationEvidenceV1,
    output.body,
  );
  assertMetadataBodyBytes(
    metadata.body_bytes,
    output.body,
    "notification evidence",
  );
  if (
    metadata.local_sequence !== request.local_sequence ||
    metadata.local_sequence !== decoded.value.local_sequence.toString(10)
  ) {
    throw metadataMismatch("notification evidence local sequence");
  }
  if (metadata.found !== decoded.value.found) {
    throw metadataMismatch("notification evidence found flag");
  }
  if (metadata.body_digest_hex !== lowerHex(decoded.object_digest)) {
    throw metadataMismatch("notification evidence body digest");
  }
  return Object.freeze({ ...decoded, metadata });
}

export function parseBlockStatusesSelfResponse(
  request: BlockStatusesSelfRequestV1,
  value: SelfCallValue,
): BlockStatusesSelfOutputV1 {
  const output = selfCallRecord(value, "block statuses");
  if (!Array.isArray(output.items)) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      "block statuses items must be an array",
    );
  }
  if (output.items.length !== request.nodes.length) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      "block statuses response length does not match its request",
    );
  }
  const items = output.items.map((value, index) => {
    const item = selfCallRecord(value, `block statuses item ${index}`);
    const node = canonicalPrincipal(
      item.node as WagyuBridgePrincipal,
      `block statuses item ${index}.node`,
    );
    if (node !== request.nodes[index]) {
      throw bridgeError(
        "WAGYU_OWNER_RESPONSE_INVALID",
        "block statuses response reordered or replaced a requested node",
      );
    }
    return Object.freeze({
      node,
      blocked: boolean(
        item.blocked,
        `block statuses item ${index}.blocked`,
      ),
    });
  });
  return Object.freeze({
    relationship_revision: canonicalNat64(
      output.relationship_revision,
      "block statuses relationship_revision",
    ),
    items: Object.freeze(items),
  });
}

export function parsePublishSelfResult(
  value: JsonValue,
): PublishSelfResultV1 {
  const result = record(value, "publish result");
  const stageValue = parseSelfOpt(result.stage, "publish stage");
  const parsed: PublishSelfResultV1 = Object.freeze({
    stage:
      stageValue === null
        ? null
        : parseUnitVariant(
            stageValue,
            [
              "awaiting_proof",
              "certified_ref_ready",
              "fanout_queued",
              "complete",
              "partial",
              "failed",
              "uncertain",
            ] as const,
            "publish stage",
          ),
    post_id_hex: optionalFixedHex(
      parseSelfOpt(result.post_id_hex, "post_id_hex"),
      32,
      "post_id_hex",
    ),
    action_id_hex: optionalFixedHex(
      parseSelfOpt(result.action_id_hex, "action_id_hex"),
      32,
      "action_id_hex",
    ),
    object_digest_hex: optionalFixedHex(
      parseSelfOpt(result.object_digest_hex, "object_digest_hex"),
      32,
      "object_digest_hex",
    ),
    queued_recipient_count: nat32(
      result.queued_recipient_count,
      "queued_recipient_count",
    ),
    queued_notice_count: nat32(
      result.queued_notice_count,
      "queued_notice_count",
    ),
    accepted_recipient_count: nat32(
      result.accepted_recipient_count,
      "accepted_recipient_count",
    ),
    failed_recipient_count: nat32(
      result.failed_recipient_count,
      "failed_recipient_count",
    ),
    message: text(result.message, "message"),
  });
  return parsed;
}

export function parseProfileEditSelfResult(
  value: SelfCallValue,
): ProfileEditSelfResultV1 {
  const outer = selfCallRecord(value, "profile edit result");
  const outcomeValue = parseSelfOpt(
    outer.outcome,
    "profile edit outcome",
  );
  if (outcomeValue === null) return Object.freeze({ outcome: null });
  const outcome = selfCallRecord(outcomeValue, "profile edit outcome");
  const keys = Object.keys(outcome);
  if (keys.length !== 1) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      "profile edit outcome must contain exactly one variant",
    );
  }
  switch (keys[0]) {
    case "updated": {
      const updated = selfCallRecord(
        outcome.updated,
        "profile edit updated",
      );
      return Object.freeze({
        outcome: Object.freeze({
          updated: Object.freeze({
            profile_generation: canonicalNat64(
              updated.profile_generation,
              "profile_generation",
            ),
            revision: canonicalNat64(updated.revision, "revision"),
            body_digest: responseBytes32(
              updated.body_digest,
              "body_digest",
            ),
          }),
        }),
      });
    }
    case "conflict": {
      const conflict = selfCallRecord(
        outcome.conflict,
        "profile edit conflict",
      );
      return Object.freeze({
        outcome: Object.freeze({
          conflict: Object.freeze({
            current_generation: canonicalNat64(
              conflict.current_generation,
              "current_generation",
            ),
            current_revision: canonicalNat64(
              conflict.current_revision,
              "current_revision",
            ),
          }),
        }),
      });
    }
    case "rejected": {
      const rejected = selfCallRecord(
        outcome.rejected,
        "profile edit rejected",
      );
      return Object.freeze({
        outcome: Object.freeze({
          rejected: Object.freeze({
            reason: (() => {
              const reasonValue = parseSelfOpt(
                rejected.reason,
                "profile edit rejection reason",
              );
              return reasonValue === null
                ? null
                : parseUnitVariant(
                    reasonValue,
                    ["invalid", "full", "low_cycles"] as const,
                    "profile edit rejection reason",
                  );
            })(),
          }),
        }),
      });
    }
    default:
      throw bridgeError(
        "WAGYU_OWNER_RESPONSE_INVALID",
        "profile edit outcome contains an unsupported variant",
      );
  }
}

export interface WagyuOwnerBridgeOptions {
  readonly queryTimeoutSeconds?: number;
  readonly updateTimeoutSeconds?: number;
}

const DEFAULT_QUERY_TIMEOUT_SECONDS = 30;
const DEFAULT_UPDATE_TIMEOUT_SECONDS = 120;

export class WagyuOwnerBridge {
  readonly #queryTimeoutSeconds: number;
  readonly #updateTimeoutSeconds: number;

  constructor(
    private readonly transport: WagyuOwnerSelfCallTransport,
    options: WagyuOwnerBridgeOptions = {},
  ) {
    this.#queryTimeoutSeconds = timeout(
      options.queryTimeoutSeconds ?? DEFAULT_QUERY_TIMEOUT_SECONDS,
      "query timeout",
    );
    this.#updateTimeoutSeconds = timeout(
      options.updateTimeoutSeconds ?? DEFAULT_UPDATE_TIMEOUT_SECONDS,
      "update timeout",
    );
  }

  async feedPage(
    request: Parameters<typeof buildFeedPageSelfRequest>[0],
  ): Promise<FeedPageSelfResultV1> {
    const wire = buildFeedPageSelfRequest(request);
    const result = await this.query(
      WAGYU_OWNER_BRIDGE_METHODS.feedPage,
      wire,
    );
    return decodeFeedPageSelfResponse(result);
  }

  async notificationPage(
    request: Parameters<typeof buildNotificationPageSelfRequest>[0],
  ): Promise<NotificationPageSelfResultV1> {
    const wire = buildNotificationPageSelfRequest(request);
    const result = await this.query(
      WAGYU_OWNER_BRIDGE_METHODS.notificationPage,
      wire,
    );
    return decodeNotificationPageSelfResponse(result);
  }

  async notificationEvidence(
    request: Parameters<typeof buildNotificationEvidenceSelfRequest>[0],
  ): Promise<NotificationEvidenceSelfResultV1> {
    const wire = buildNotificationEvidenceSelfRequest(request);
    const result = await this.query(
      WAGYU_OWNER_BRIDGE_METHODS.notificationEvidence,
      wire,
    );
    return decodeNotificationEvidenceSelfResponse(wire, result);
  }

  async blockStatuses(
    request: Parameters<typeof buildBlockStatusesSelfRequest>[0],
  ): Promise<BlockStatusesSelfOutputV1> {
    const wire = buildBlockStatusesSelfRequest(request);
    const result = await this.query(
      WAGYU_OWNER_BRIDGE_METHODS.blockStatuses,
      wire,
    );
    return parseBlockStatusesSelfResponse(wire, result);
  }

  async profileEdit(
    request: Parameters<typeof buildProfileEditSelfRequest>[0],
  ): Promise<ProfileEditSelfResultV1> {
    const wire = buildProfileEditSelfRequest(request);
    const value = await this.update<SelfCallValue>(
      WAGYU_OWNER_BRIDGE_METHODS.profileEdit,
      wire,
    );
    return parseProfileEditSelfResult(value);
  }

  follow(
    request: Parameters<typeof buildFollowSelfRequest>[0],
  ): Promise<JsonValue> {
    return this.update(
      WAGYU_OWNER_BRIDGE_METHODS.follow,
      buildFollowSelfRequest(request),
    );
  }

  async postPrepare(
    request: Parameters<typeof buildPostPrepareSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return parsePublishSelfResult(
      await this.update(
        WAGYU_OWNER_BRIDGE_METHODS.postPrepare,
        buildPostPrepareSelfRequest(request),
      ),
    );
  }

  async sharePrepare(
    request: Parameters<typeof buildSharePrepareSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    const call = buildSharePrepareSelfRequest(request);
    return parsePublishSelfResult(
      await this.update(
        WAGYU_OWNER_BRIDGE_METHODS.sharePrepare,
        call.request,
      ),
    );
  }

  async likePrepare(
    request: Parameters<typeof buildLikePrepareSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return parsePublishSelfResult(
      await this.update(
        WAGYU_OWNER_BRIDGE_METHODS.likePrepare,
        buildLikePrepareSelfRequest(request),
      ),
    );
  }

  async tombstonePrepare(
    request: Parameters<typeof buildTombstonePrepareSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return parsePublishSelfResult(
      await this.update(
        WAGYU_OWNER_BRIDGE_METHODS.tombstonePrepare,
        buildTombstonePrepareSelfRequest(request),
      ),
    );
  }

  postFinalize(
    request: Parameters<typeof buildFinalizeSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return this.finalize(WAGYU_OWNER_BRIDGE_METHODS.postFinalize, request);
  }

  shareFinalize(
    request: Parameters<typeof buildFinalizeSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return this.finalize(WAGYU_OWNER_BRIDGE_METHODS.shareFinalize, request);
  }

  likeFinalize(
    request: Parameters<typeof buildFinalizeSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return this.finalize(WAGYU_OWNER_BRIDGE_METHODS.likeFinalize, request);
  }

  tombstoneFinalize(
    request: Parameters<typeof buildFinalizeSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return this.finalize(
      WAGYU_OWNER_BRIDGE_METHODS.tombstoneFinalize,
      request,
    );
  }

  feedPromote(
    request: Parameters<typeof buildFeedPromoteSelfRequest>[0],
  ): Promise<JsonValue> {
    return this.update(
      WAGYU_OWNER_BRIDGE_METHODS.feedPromote,
      buildFeedPromoteSelfRequest(request),
    );
  }

  feedReject(
    request: Parameters<typeof buildFeedRejectSelfRequest>[0],
  ): Promise<JsonValue> {
    return this.update(
      WAGYU_OWNER_BRIDGE_METHODS.feedReject,
      buildFeedRejectSelfRequest(request),
    );
  }

  notificationPromote(
    request: Parameters<typeof buildNotificationPromoteSelfRequest>[0],
  ): Promise<JsonValue> {
    return this.update(
      WAGYU_OWNER_BRIDGE_METHODS.notificationPromote,
      buildNotificationPromoteSelfRequest(request),
    );
  }

  async likeSeal(
    request: Parameters<typeof buildLikeSealSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return parsePublishSelfResult(
      await this.update(
        WAGYU_OWNER_BRIDGE_METHODS.likeSeal,
        buildLikeSealSelfRequest(request),
      ),
    );
  }

  async withdrawalAdvance(
    request: Parameters<typeof buildWithdrawalAdvanceSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    return parsePublishSelfResult(
      await this.update(
        WAGYU_OWNER_BRIDGE_METHODS.withdrawalAdvance,
        buildWithdrawalAdvanceSelfRequest(request),
      ),
    );
  }

  private query(
    method: WagyuOwnerBridgeMethod,
    request: object,
  ): Promise<SelfCallValue> {
    assertContract(method, "query");
    return this.transport.query(
      method,
      [request as SelfCallObject],
      this.#queryTimeoutSeconds,
    );
  }

  private update<T extends SelfCallValue = JsonValue>(
    method: WagyuOwnerBridgeMethod,
    request: object,
  ): Promise<T> {
    assertContract(method, "update");
    return this.transport.update<T>(
      method,
      [request as SelfCallObject],
      this.#updateTimeoutSeconds,
    );
  }

  private async finalize(
    method:
      | typeof WAGYU_OWNER_BRIDGE_METHODS.postFinalize
      | typeof WAGYU_OWNER_BRIDGE_METHODS.shareFinalize
      | typeof WAGYU_OWNER_BRIDGE_METHODS.likeFinalize
      | typeof WAGYU_OWNER_BRIDGE_METHODS.tombstoneFinalize,
    request: Parameters<typeof buildFinalizeSelfRequest>[0],
  ): Promise<PublishSelfResultV1> {
    const call = buildFinalizeSelfRequest(request);
    return parsePublishSelfResult(
      await this.update(method, call.request),
    );
  }
}

function decodeOutputBinary<T>(
  method: WagyuOwnerBridgeMethod,
  codec: WagyuCandidCodec<T>,
  body: Uint8Array,
): ExactDecodedCandidV1<T> {
  const cap =
    WAGYU_OWNER_BRIDGE_CONTRACTS[method].maxOutputBlobBytes;
  if (cap === 0 || body.byteLength > cap) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_TOO_LARGE",
      `${method} output blob exceeds ${cap} bytes`,
    );
  }
  return codec.decode(body);
}

function validatedExactCandidBinary<T>(
  codec: WagyuCandidCodec<T>,
  body: Uint8Array | ArrayBuffer,
  maximumBytes: number,
  label: string,
): ExactDecodedCandidV1<T> {
  if (
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer)
  ) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_INVALID",
      `${label} must be binary`,
    );
  }
  if (body.byteLength > maximumBytes) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_TOO_LARGE",
      `${label} exceeds ${maximumBytes} bytes`,
    );
  }
  // The codec copies and hashes before decoding. The copied exact bytes are
  // placed directly in the ordinary Candid request; a compatible value is
  // never re-encoded.
  return codec.decode(body);
}

function boundedBinary(
  body: Uint8Array | ArrayBuffer,
  maximumBytes: number,
  label: string,
): Uint8Array {
  if (
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer)
  ) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_INVALID",
      `${label} must be binary`,
    );
  }
  if (body.byteLength > maximumBytes) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_TOO_LARGE",
      `${label} exceeds ${maximumBytes} bytes`,
    );
  }
  return copyBinary(body);
}

function boundedNonEmptyBinary(
  body: Uint8Array | ArrayBuffer,
  maximumBytes: number,
  label: string,
): Uint8Array {
  const copy = boundedBinary(body, maximumBytes, label);
  if (copy.byteLength === 0) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_EMPTY",
      `${label} must not be empty`,
    );
  }
  return copy;
}

function copyBinary(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array
    ? Uint8Array.from(value)
    : new Uint8Array(value.slice(0));
}

function responseBytes32(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be a Uint8Array containing exactly 32 bytes`,
    );
  }
  try {
    return bytes32(value, label);
  } catch (cause) {
    throw responseFromProtocolError(cause, label);
  }
}

function fixedHex(
  value: unknown,
  byteLength: 16 | 32,
  label: string,
): string {
  if (typeof value === "string") {
    const pattern =
      byteLength === 16
        ? /^[0-9a-f]{32}$/u
        : /^[0-9a-f]{64}$/u;
    if (!pattern.test(value)) {
      throw bridgeError(
        "WAGYU_OWNER_INVALID_FIXED_HEX",
        `${label} must contain exactly ${byteLength * 2} lowercase hexadecimal characters`,
      );
    }
    if (byteLength === 32) parseLowerHex32(value, label);
    return value;
  }
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_FIXED_HEX",
      `${label} must be fixed bytes or lowercase hexadecimal text`,
    );
  }
  return lowerHex(
    byteLength === 16
      ? bytes16(value, label)
      : bytes32(value, label),
  );
}

function optionalFixedHex(
  value: unknown,
  byteLength: 16 | 32,
  label: string,
): string | null {
  if (value === null) return null;
  return fixedHex(value, byteLength, label);
}

function parseSelfOpt(
  value: unknown,
  label: string,
): unknown | null {
  if (value === undefined) return null;
  if (value === null || Array.isArray(value)) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be omitted or contain one direct projected value`,
    );
  }
  return value;
}

function canonicalNat64(value: unknown, label: string): string {
  let textValue: string;
  if (typeof value === "bigint") {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw bridgeError(
        "WAGYU_OWNER_INVALID_NAT64",
        `${label} must be an unsigned nat64`,
      );
    }
    textValue = value.toString(10);
  } else if (typeof value === "string") {
    textValue = value;
  } else {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_NAT64",
      `${label} must be a canonical decimal nat64 string or bigint`,
    );
  }
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(textValue) ||
    BigInt(textValue) > 0xffff_ffff_ffff_ffffn
  ) {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_NAT64",
      `${label} must be a canonical decimal nat64`,
    );
  }
  return textValue;
}

function canonicalPrincipal(
  value: WagyuBridgePrincipal,
  label: string,
): string {
  try {
    if (typeof value !== "string") return value.toText();
    const canonical = Principal.fromText(value).toText();
    if (canonical !== value) {
      throw new Error("principal is not canonical");
    }
    return canonical;
  } catch {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_PRINCIPAL",
      `${label} must be a canonical principal`,
    );
  }
}

function boundedNat16(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  assertNat16(value, label);
  if (value < minimum || value > maximum) {
    throw bridgeError(
      "WAGYU_OWNER_INVALID_BOUND",
      `${label} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function nat16(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be a nat16`,
    );
  }
  try {
    return assertNat16(value, label);
  } catch (cause) {
    throw responseFromProtocolError(cause, label);
  }
}

function nat32(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be a nat32`,
    );
  }
  try {
    return assertNat32(value, label);
  } catch (cause) {
    throw responseFromProtocolError(cause, label);
  }
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be boolean`,
    );
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be text`,
    );
  }
  return value;
}

function record(value: unknown, label: string): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be a record`,
    );
  }
  return value as JsonObject;
}

function selfCallRecord(
  value: unknown,
  label: string,
): SelfCallObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must be a record`,
    );
  }
  return value as SelfCallObject;
}

function binaryOutput(
  value: SelfCallValue,
  label: string,
): Readonly<{ value: SelfCallValue; body: Uint8Array }> {
  const output = record(
    value,
    `${label} output`,
  ) as unknown as SelfCallObject;
  const keys = Object.keys(output).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "body" ||
    keys[1] !== "value"
  ) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} output must contain exactly value and body`,
    );
  }
  if (!(output.body instanceof Uint8Array)) {
    throw bridgeError(
      "WAGYU_OWNER_BINARY_INVALID",
      `${label} body must be a Uint8Array`,
    );
  }
  if (output.value === undefined) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} output value is missing`,
    );
  }
  return Object.freeze({
    value: output.value,
    body: copyBinary(output.body),
  });
}

function unitVariant<const Tag extends string>(
  tag: string,
  allowed: readonly Tag[],
  label: string,
): WagyuSelfUnitVariant<Tag> {
  if (!allowed.includes(tag as Tag)) {
    throw bridgeError(
      "WAGYU_OWNER_REQUEST_INVALID",
      `${label} contains an unsupported variant`,
    );
  }
  return Object.freeze({ [tag]: null }) as WagyuSelfUnitVariant<Tag>;
}

function parseUnitVariant<const Tag extends string>(
  value: unknown,
  allowed: readonly Tag[],
  label: string,
): Tag {
  const candidate = record(value, label);
  const keys = Object.keys(candidate);
  if (
    keys.length !== 1 ||
    candidate[keys[0]!] !== null ||
    !allowed.includes(keys[0] as Tag)
  ) {
    throw bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} must contain one known unit variant`,
    );
  }
  return keys[0] as Tag;
}

function assertMetadataBodyBytes(
  expected: number,
  body: Uint8Array,
  label: string,
): void {
  if (expected !== body.byteLength) {
    throw metadataMismatch(`${label} body length`);
  }
}

function metadataMismatch(label: string): WagyuOwnerBridgeError {
  return bridgeError(
    "WAGYU_OWNER_METADATA_MISMATCH",
    `${label} does not match the exact nested Candid bytes`,
  );
}

function timeout(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 300) {
    throw bridgeError(
      "WAGYU_OWNER_TIMEOUT_INVALID",
      `${label} must be an integer between 1 and 300 seconds`,
    );
  }
  return value;
}

function assertContract(
  method: WagyuOwnerBridgeMethod,
  mode: "query" | "update",
): void {
  const methodContract = WAGYU_OWNER_BRIDGE_CONTRACTS[method];
  if (methodContract.mode !== mode) {
    throw bridgeError(
      "WAGYU_OWNER_METHOD_CONTRACT_INVALID",
      `${method} has the wrong owner bridge call mode`,
    );
  }
}

function responseFromProtocolError(
  cause: unknown,
  label: string,
): WagyuOwnerBridgeError {
  if (cause instanceof WagyuProtocolError) {
    return bridgeError(
      "WAGYU_OWNER_RESPONSE_INVALID",
      `${label} is invalid: ${cause.message}`,
    );
  }
  return bridgeError(
    "WAGYU_OWNER_RESPONSE_INVALID",
    `${label} is invalid`,
  );
}

function bridgeError(
  code: string,
  message: string,
): WagyuOwnerBridgeError {
  return new WagyuOwnerBridgeError(code, message);
}
