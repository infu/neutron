import { IDL } from "@dfinity/candid";
import type { IDL as CandidIDL } from "@dfinity/candid";
import {
  assertBoundedText,
  assertCapabilities,
  assertNat16,
  assertNat32,
  bytes16,
  bytes32,
  exactCandidBytes,
  sha256Exact,
  WagyuProtocolError,
} from "./bytes.ts";
import { WAGYU_IDL } from "./idl.ts";
import { WAGYU_LIMITS } from "./constants.ts";
import { preflightSingleCandidArgument } from "./candid_preflight.ts";
import type {
  ActionHeaderV1,
  CertifiedActionRefV1,
  CertifiedHttpProofV1,
  CertifiedLikeReceiptV1,
  CertifiedPostRefV1,
  CertifiedShareDeliveryV1,
  CertifiedShareRefV1,
  CertifiedTombstoneV1,
  DeliverBodyV1,
  ExactDecodedCandidV1,
  FeedCandidateSummaryV1,
  FeedPageRequestV1,
  FeedPageV1,
  FollowBodyV1,
  FollowerHeadV1,
  LikeActionV1,
  LikeBatchV1,
  LikeBodyV1,
  LikeHeadV1,
  NoticeBodyV1,
  NotificationEvidenceRequestV1,
  NotificationEvidenceV1,
  NotificationPageRequestV1,
  NotificationPageV1,
  NotificationSummaryV1,
  PostBodyV1,
  ProfileAvatarV1,
  ProfileEditRequestV1,
  ProfileEditResultV1,
  ProfileV1,
  ReplyIndexV1,
  PublicIngressRequestV1,
  PublicIngressResultV1,
  SendQuoteRequestV1,
  SendQuoteV1,
  ShareActionV1,
  TombstoneActionV1,
  UnfollowBodyV1,
  WagyuIngressV1,
  WagyuExactCandidBytes,
  WagyuRouteResultV1,
} from "./types.ts";

export interface WagyuPackageTypeMap {
  ActionHeaderV1: ActionHeaderV1;
  PostBodyV1: PostBodyV1;
  ReplyIndexV1: ReplyIndexV1;
  CertifiedHttpProofV1: CertifiedHttpProofV1;
  CertifiedActionRefV1: CertifiedActionRefV1;
  CertifiedPostRefV1: CertifiedPostRefV1;
  ShareActionV1: ShareActionV1;
  CertifiedShareRefV1: CertifiedShareRefV1;
  CertifiedShareDeliveryV1: CertifiedShareDeliveryV1;
  LikeActionV1: LikeActionV1;
  CertifiedLikeReceiptV1: CertifiedLikeReceiptV1;
  ProfileV1: ProfileV1;
  TombstoneActionV1: TombstoneActionV1;
  CertifiedTombstoneV1: CertifiedTombstoneV1;
  LikeBatchV1: LikeBatchV1;
  LikeHeadV1: LikeHeadV1;
  PublicIngressRequestV1: PublicIngressRequestV1;
  PublicIngressResultV1: PublicIngressResultV1;
  WagyuIngressV1: WagyuIngressV1;
  FollowBodyV1: FollowBodyV1;
  UnfollowBodyV1: UnfollowBodyV1;
  DeliverBodyV1: DeliverBodyV1;
  LikeBodyV1: LikeBodyV1;
  NoticeBodyV1: NoticeBodyV1;
  FollowerHeadV1: FollowerHeadV1;
  WagyuRouteResultV1: WagyuRouteResultV1;
  FeedPageRequestV1: FeedPageRequestV1;
  FeedCandidateSummaryV1: FeedCandidateSummaryV1;
  FeedPageV1: FeedPageV1;
  NotificationSummaryV1: NotificationSummaryV1;
  NotificationPageRequestV1: NotificationPageRequestV1;
  NotificationPageV1: NotificationPageV1;
  NotificationEvidenceRequestV1: NotificationEvidenceRequestV1;
  NotificationEvidenceV1: NotificationEvidenceV1;
  SendQuoteRequestV1: SendQuoteRequestV1;
  SendQuoteV1: SendQuoteV1;
  ProfileEditRequestV1: ProfileEditRequestV1;
  ProfileEditResultV1: ProfileEditResultV1;
}

export type WagyuPackageName = keyof WagyuPackageTypeMap;

export interface WagyuCandidCodec<T> {
  readonly name: WagyuPackageName;
  readonly idl: CandidIDL.Type;
  readonly maximum_bytes: number;
  encode(value: T): WagyuExactCandidBytes;
  decode(
    exactMessage: Uint8Array | ArrayBuffer,
  ): ExactDecodedCandidV1<T>;
}

type Validator<T> = (value: T) => void;

function makeCodec<K extends WagyuPackageName>(
  name: K,
  maximumBytes: number,
  validate: Validator<WagyuPackageTypeMap[K]> = noop,
  validateForEncoding: Validator<WagyuPackageTypeMap[K]> = validate,
): WagyuCandidCodec<WagyuPackageTypeMap[K]> {
  const type = WAGYU_IDL[name] as CandidIDL.Type;
  return Object.freeze({
    name,
    idl: type,
    maximum_bytes: maximumBytes,
    encode(value: WagyuPackageTypeMap[K]): WagyuExactCandidBytes {
      validateForEncoding(value);
      const encoded = IDL.encode([type], [value]);
      if (encoded.byteLength > maximumBytes) {
        throw new WagyuProtocolError(
          "WAGYU_CANDID_TOO_LARGE",
          `${name} exceeds ${maximumBytes} encoded bytes`,
        );
      }
      return encoded as WagyuExactCandidBytes;
    },
    decode(
      exactMessage: Uint8Array | ArrayBuffer,
    ): ExactDecodedCandidV1<WagyuPackageTypeMap[K]> {
      // Copy and hash before decoding. This is the only hash preimage returned.
      const exact = exactCandidBytes(exactMessage, maximumBytes, name);
      const objectDigest = sha256Exact(exact);
      let decoded: unknown;
      try {
        preflightSingleCandidArgument(exact);
        const values = IDL.decode([type], exact);
        if (values.length !== 1) {
          throw new Error("wrong Candid result arity");
        }
        decoded = values[0];
      } catch (cause) {
        throw new WagyuProtocolError(
          "WAGYU_INVALID_CANDID",
          `${name} is not valid Candid for its frozen V1 type: ${errorMessage(cause)}`,
        );
      }
      const value = decoded as WagyuPackageTypeMap[K];
      validate(value);
      return Object.freeze({
        exact_bytes: exact,
        object_digest: objectDigest,
        value,
      });
    },
  });
}

const ACTION_MAX = WAGYU_LIMITS.genericActionObjectBytes;
const SMALL_PACKAGE_MAX = 16 * 1_024;
const PAGE_MAX = WAGYU_LIMITS.feedPageExactEventBytes + 16 * 1_024;

export const WAGYU_CODECS = Object.freeze({
  ActionHeaderV1: makeCodec(
    "ActionHeaderV1",
    1_024,
    validateActionHeader,
    validateCurrentActionHeader,
  ),
  PostBodyV1: makeCodec(
    "PostBodyV1",
    WAGYU_LIMITS.postObjectBytes,
    validatePostBody,
    validateCurrentPostBody,
  ),
  ReplyIndexV1: makeCodec(
    "ReplyIndexV1",
    WAGYU_LIMITS.replyIndexObjectBytes,
    validateReplyIndex,
  ),
  CertifiedHttpProofV1: makeCodec(
    "CertifiedHttpProofV1",
    WAGYU_LIMITS.portableProofEncodedBytes,
    validateProof,
  ),
  CertifiedActionRefV1: makeCodec(
    "CertifiedActionRefV1",
    WAGYU_LIMITS.certifiedLikeReceiptEncodedBytes,
    validateActionRef,
    validateCurrentActionRef,
  ),
  CertifiedPostRefV1: makeCodec(
    "CertifiedPostRefV1",
    SMALL_PACKAGE_MAX,
    validatePostRef,
  ),
  ShareActionV1: makeCodec(
    "ShareActionV1",
    ACTION_MAX,
    validateShareAction,
    validateCurrentShareAction,
  ),
  CertifiedShareRefV1: makeCodec(
    "CertifiedShareRefV1",
    SMALL_PACKAGE_MAX,
    validateShareRef,
  ),
  CertifiedShareDeliveryV1: makeCodec(
    "CertifiedShareDeliveryV1",
    SMALL_PACKAGE_MAX,
    validateShareDelivery,
  ),
  LikeActionV1: makeCodec(
    "LikeActionV1",
    ACTION_MAX,
    validateLikeAction,
    validateCurrentLikeAction,
  ),
  CertifiedLikeReceiptV1: makeCodec(
    "CertifiedLikeReceiptV1",
    WAGYU_LIMITS.certifiedLikeReceiptEncodedBytes,
    validateLikeReceipt,
    validateCurrentLikeReceipt,
  ),
  ProfileV1: makeCodec(
    "ProfileV1",
    WAGYU_LIMITS.profileObjectBytes,
    validateProfile,
    validateCurrentProfile,
  ),
  TombstoneActionV1: makeCodec(
    "TombstoneActionV1",
    ACTION_MAX,
    validateTombstoneAction,
    validateCurrentTombstoneAction,
  ),
  CertifiedTombstoneV1: makeCodec(
    "CertifiedTombstoneV1",
    SMALL_PACKAGE_MAX,
    validateCertifiedTombstone,
    validateCurrentCertifiedTombstone,
  ),
  LikeBatchV1: makeCodec(
    "LikeBatchV1",
    WAGYU_LIMITS.likeBatchProtocolBytes,
    validateLikeBatch,
    validateCurrentLikeBatch,
  ),
  LikeHeadV1: makeCodec(
    "LikeHeadV1",
    WAGYU_LIMITS.likeHeadObjectBytes,
    validateLikeHead,
  ),
  PublicIngressRequestV1: makeCodec(
    "PublicIngressRequestV1",
    SMALL_PACKAGE_MAX + 1_024,
  ),
  PublicIngressResultV1: makeCodec("PublicIngressResultV1", 1_024),
  WagyuIngressV1: makeCodec(
    "WagyuIngressV1",
    SMALL_PACKAGE_MAX,
    validateIngress,
  ),
  FollowBodyV1: makeCodec("FollowBodyV1", 1_024, validateFollowBody),
  UnfollowBodyV1: makeCodec("UnfollowBodyV1", 512, validateUnfollowBody),
  DeliverBodyV1: makeCodec(
    "DeliverBodyV1",
    SMALL_PACKAGE_MAX,
    validateDeliverBody,
    validateCurrentDeliverBody,
  ),
  LikeBodyV1: makeCodec("LikeBodyV1", 8 * 1_024, validateLikeBody),
  NoticeBodyV1: makeCodec(
    "NoticeBodyV1",
    1_024,
    validateNoticeBody,
    validateCurrentNoticeBody,
  ),
  FollowerHeadV1: makeCodec("FollowerHeadV1", 512, validateFollowerHead),
  WagyuRouteResultV1: makeCodec(
    "WagyuRouteResultV1",
    512,
    noop,
    validateCurrentRouteResult,
  ),
  FeedPageRequestV1: makeCodec("FeedPageRequestV1", 128, validateFeedRequest),
  FeedCandidateSummaryV1: makeCodec(
    "FeedCandidateSummaryV1",
    PAGE_MAX,
    validateFeedSummary,
  ),
  FeedPageV1: makeCodec("FeedPageV1", PAGE_MAX, validateFeedPage),
  NotificationSummaryV1: makeCodec(
    "NotificationSummaryV1",
    2_048,
    validateNotificationSummary,
  ),
  NotificationPageRequestV1: makeCodec(
    "NotificationPageRequestV1",
    128,
    validateNotificationRequest,
  ),
  NotificationPageV1: makeCodec(
    "NotificationPageV1",
    128 * 1_024,
    validateNotificationPage,
  ),
  NotificationEvidenceRequestV1: makeCodec(
    "NotificationEvidenceRequestV1",
    128,
  ),
  NotificationEvidenceV1: makeCodec(
    "NotificationEvidenceV1",
    8 * 1_024,
    validateNotificationEvidence,
  ),
  SendQuoteRequestV1: makeCodec(
    "SendQuoteRequestV1",
    512,
    validateSendQuoteRequest,
  ),
  SendQuoteV1: makeCodec("SendQuoteV1", 1_024, validateSendQuote),
  ProfileEditRequestV1: makeCodec(
    "ProfileEditRequestV1",
    WAGYU_LIMITS.profileObjectBytes,
    validateProfileEditRequest,
    validateCurrentProfileEditRequest,
  ),
  ProfileEditResultV1: makeCodec(
    "ProfileEditResultV1",
    512,
    validateProfileEditResult,
    validateCurrentProfileEditResult,
  ),
} satisfies {
  [K in WagyuPackageName]: WagyuCandidCodec<WagyuPackageTypeMap[K]>;
});

export function encodeWagyuPackage<K extends WagyuPackageName>(
  name: K,
  value: WagyuPackageTypeMap[K],
): WagyuExactCandidBytes {
  return (WAGYU_CODECS[name] as WagyuCandidCodec<WagyuPackageTypeMap[K]>)
    .encode(value);
}

export function decodeWagyuPackage<K extends WagyuPackageName>(
  name: K,
  exactMessage: Uint8Array | ArrayBuffer,
): ExactDecodedCandidV1<WagyuPackageTypeMap[K]> {
  return (WAGYU_CODECS[name] as WagyuCandidCodec<WagyuPackageTypeMap[K]>)
    .decode(exactMessage);
}

export const encodePostBodyV1 = WAGYU_CODECS.PostBodyV1.encode;
export const decodePostBodyV1 = WAGYU_CODECS.PostBodyV1.decode;
export const encodeReplyIndexV1 = WAGYU_CODECS.ReplyIndexV1.encode;
export const decodeReplyIndexV1 = WAGYU_CODECS.ReplyIndexV1.decode;
export const encodeCertifiedPostRefV1 =
  WAGYU_CODECS.CertifiedPostRefV1.encode;
export const decodeCertifiedPostRefV1 =
  WAGYU_CODECS.CertifiedPostRefV1.decode;
export const encodeShareActionV1 = WAGYU_CODECS.ShareActionV1.encode;
export const decodeShareActionV1 = WAGYU_CODECS.ShareActionV1.decode;
export const encodeCertifiedShareRefV1 =
  WAGYU_CODECS.CertifiedShareRefV1.encode;
export const decodeCertifiedShareRefV1 =
  WAGYU_CODECS.CertifiedShareRefV1.decode;
export const encodeCertifiedShareDeliveryV1 =
  WAGYU_CODECS.CertifiedShareDeliveryV1.encode;
export const decodeCertifiedShareDeliveryV1 =
  WAGYU_CODECS.CertifiedShareDeliveryV1.decode;
export const encodeLikeActionV1 = WAGYU_CODECS.LikeActionV1.encode;
export const decodeLikeActionV1 = WAGYU_CODECS.LikeActionV1.decode;
export const encodeCertifiedActionRefV1 =
  WAGYU_CODECS.CertifiedActionRefV1.encode;
export const decodeCertifiedActionRefV1 =
  WAGYU_CODECS.CertifiedActionRefV1.decode;
export const encodeCertifiedLikeReceiptV1 =
  WAGYU_CODECS.CertifiedLikeReceiptV1.encode;
export const decodeCertifiedLikeReceiptV1 =
  WAGYU_CODECS.CertifiedLikeReceiptV1.decode;
export const encodeTombstoneActionV1 =
  WAGYU_CODECS.TombstoneActionV1.encode;
export const decodeTombstoneActionV1 =
  WAGYU_CODECS.TombstoneActionV1.decode;
export const encodeCertifiedTombstoneV1 =
  WAGYU_CODECS.CertifiedTombstoneV1.encode;
export const decodeCertifiedTombstoneV1 =
  WAGYU_CODECS.CertifiedTombstoneV1.decode;
export const encodeProfileV1 = WAGYU_CODECS.ProfileV1.encode;
export const decodeProfileV1 = WAGYU_CODECS.ProfileV1.decode;
export const encodeLikeBatchV1 = WAGYU_CODECS.LikeBatchV1.encode;
export const decodeLikeBatchV1 = WAGYU_CODECS.LikeBatchV1.decode;
export const encodeLikeHeadV1 = WAGYU_CODECS.LikeHeadV1.encode;
export const decodeLikeHeadV1 = WAGYU_CODECS.LikeHeadV1.decode;

function validateActionHeader(value: ActionHeaderV1): void {
  bytes32(value.network_id, "header.network_id");
}

function validateCurrentActionHeader(value: ActionHeaderV1): void {
  validateActionHeader(value);
  requireCurrentVariant(
    value.action_kind,
    ["post", "share", "tombstone", "like"],
    "header.action_kind",
  );
}

function validatePostBody(value: PostBodyV1): void {
  validateActionHeader(value.header);
  bytes16(value.nonce, "post.nonce");
  assertBoundedText(
    value.body_markdown,
    WAGYU_LIMITS.bodyMarkdownUtf8Bytes,
    "post.body_markdown",
  );
  for (const reply of value.reply_to) {
    bytes32(reply.post_id, "reply_to.post_id");
    bytes32(reply.body_hash, "reply_to.body_hash");
    assertNat32(reply.body_length, "reply_to.body_length");
    bytes32(reply.object_digest, "reply_to.object_digest");
  }
}

function validateCurrentPostBody(value: PostBodyV1): void {
  validatePostBody(value);
  requireCurrentVariant(value.header.action_kind, ["post"], "header.action_kind");
}

function validateProof(value: CertifiedHttpProofV1): void {
  if (value.certificate_version !== WAGYU_LIMITS.certificateVersion) {
    throw new WagyuProtocolError(
      "WAGYU_UNSUPPORTED_CERTIFICATE_VERSION",
      `Expected certificate version ${WAGYU_LIMITS.certificateVersion}`,
    );
  }
}

function validateActionRef(value: CertifiedActionRefV1): void {
  bytes32(value.object_digest, "action_ref.object_digest");
  assertNat32(value.body_length, "action_ref.body_length");
  validateProof(value.proof_snapshot);
}

function validateCurrentActionRef(value: CertifiedActionRefV1): void {
  validateActionRef(value);
  requireCurrentVariant(
    value.action_kind,
    ["post", "share", "tombstone", "like"],
    "action_ref.action_kind",
  );
}

function validatePostRef(value: CertifiedPostRefV1): void {
  bytes32(value.post_id, "post_ref.post_id");
  bytes32(value.body_hash, "post_ref.body_hash");
  assertNat32(value.body_length, "post_ref.body_length");
  bytes32(value.object_digest, "post_ref.object_digest");
  validateProof(value.proof);
}

function validateShareAction(value: ShareActionV1): void {
  validateActionHeader(value.header);
  bytes32(value.share_id, "share.share_id");
  bytes32(value.original_post_id, "share.original_post_id");
  bytes32(value.original_body_hash, "share.original_body_hash");
  bytes32(value.post_ref_digest, "share.post_ref_digest");
}

function validateCurrentShareAction(value: ShareActionV1): void {
  validateShareAction(value);
  requireCurrentVariant(
    value.header.action_kind,
    ["share"],
    "header.action_kind",
  );
}

function validateShareRef(value: CertifiedShareRefV1): void {
  bytes32(value.share_id, "share_ref.share_id");
  assertNat32(value.body_length, "share_ref.body_length");
  bytes32(value.object_digest, "share_ref.object_digest");
  validateProof(value.proof);
}

function validateShareDelivery(value: CertifiedShareDeliveryV1): void {
  if (
    value.original_post_ref_candid.byteLength === 0 ||
    value.share_action_candid.byteLength === 0
  ) {
    throw new WagyuProtocolError(
      "WAGYU_EMPTY_NESTED_CANDID",
      "Share delivery nested Candid blobs must be non-empty",
    );
  }
  validateShareRef(value.share_ref);
}

function validateLikeAction(value: LikeActionV1): void {
  validateActionHeader(value.header);
  bytes32(value.like_id, "like.like_id");
  bytes32(value.post_id, "like.post_id");
  bytes32(value.post_body_hash, "like.post_body_hash");
}

function validateCurrentLikeAction(value: LikeActionV1): void {
  validateLikeAction(value);
  requireCurrentVariant(
    value.header.action_kind,
    ["like"],
    "header.action_kind",
  );
}

function validateLikeReceipt(value: CertifiedLikeReceiptV1): void {
  if (value.like_action_candid.byteLength === 0) {
    throw new WagyuProtocolError(
      "WAGYU_EMPTY_NESTED_CANDID",
      "Like receipt action Candid must be non-empty",
    );
  }
  validateActionRef(value.ref);
}

function validateCurrentLikeReceipt(value: CertifiedLikeReceiptV1): void {
  validateLikeReceipt(value);
  requireCurrentVariant(
    value.ref.action_kind,
    ["like"],
    "like_receipt.ref.action_kind",
  );
}

function validateProfile(value: ProfileV1): void {
  bytes32(value.network_id, "profile.network_id");
  for (const previous of value.previous_profile_digest) {
    bytes32(previous, "profile.previous_profile_digest");
  }
  assertBoundedText(
    value.display_name,
    WAGYU_LIMITS.profileDisplayNameUtf8Bytes,
    "profile.display_name",
  );
  assertBoundedText(
    value.description,
    WAGYU_LIMITS.profileDescriptionUtf8Bytes,
    "profile.description",
  );
  for (const capabilities of value.capabilities) {
    assertCapabilities(capabilities);
  }
  for (const avatar of value.avatar) validateAvatar(avatar);
}

function validateReplyIndex(value: ReplyIndexV1): void {
  bytes32(value.network_id, "reply_index.network_id");
  bytes32(value.post_id, "reply_index.post_id");
  bytes32(value.post_body_hash, "reply_index.post_body_hash");
  for (const digest of value.previous_index_hash) {
    bytes32(digest, "reply_index.previous_index_hash");
  }
  if (value.replies.length > WAGYU_LIMITS.replyIndexEntries) {
    throw new WagyuProtocolError(
      "WAGYU_REPLY_INDEX_TOO_LARGE",
      "Reply index exceeds its bounded entry count",
    );
  }
  const identities = new Set<string>();
  for (const reply of value.replies) {
    bytes32(reply.post_id, "reply_index.reply.post_id");
    bytes32(reply.object_digest, "reply_index.reply.object_digest");
    assertNat32(reply.object_length, "reply_index.reply.object_length");
    if (
      reply.object_length < 1 ||
      reply.object_length > WAGYU_LIMITS.postObjectBytes
    ) {
      throw new WagyuProtocolError(
        "WAGYU_REPLY_OBJECT_LENGTH",
        "Reply index entry has an invalid post object length",
      );
    }
    const identity = `${reply.author.toText()}:${Array.from(reply.post_id).join(",")}`;
    if (identities.has(identity)) {
      throw new WagyuProtocolError(
        "WAGYU_DUPLICATE_REPLY_INDEX_ENTRY",
        "Reply index contains a duplicate author/post identity",
      );
    }
    identities.add(identity);
  }
}

function validateCurrentProfile(value: ProfileV1): void {
  validateProfile(value);
  for (const avatar of value.avatar) {
    requireCurrentVariant(
      avatar.media_type,
      ["jpeg", "png", "webp"],
      "avatar.media_type",
    );
  }
}

function validateAvatar(value: ProfileAvatarV1): void {
  assertNat16(value.width, "avatar.width");
  assertNat16(value.height, "avatar.height");
  if (
    value.width < 1 ||
    value.height < 1 ||
    value.width > WAGYU_LIMITS.profileAvatarDimension ||
    value.height > WAGYU_LIMITS.profileAvatarDimension
  ) {
    throw new WagyuProtocolError(
      "WAGYU_AVATAR_DIMENSIONS",
      "Avatar dimensions exceed the Wagyu V1 limit",
    );
  }
  if (value.bytes.byteLength > WAGYU_LIMITS.profileAvatarBytes) {
    throw new WagyuProtocolError(
      "WAGYU_AVATAR_TOO_LARGE",
      "Avatar bytes exceed the Wagyu V1 limit",
    );
  }
}

function validateTombstoneAction(value: TombstoneActionV1): void {
  validateActionHeader(value.header);
  bytes32(value.tombstone_id, "tombstone.tombstone_id");
  bytes32(value.post_id, "tombstone.post_id");
  bytes32(value.post_body_hash, "tombstone.post_body_hash");
}

function validateCurrentTombstoneAction(value: TombstoneActionV1): void {
  validateTombstoneAction(value);
  requireCurrentVariant(
    value.header.action_kind,
    ["tombstone"],
    "header.action_kind",
  );
}

function validateCertifiedTombstone(value: CertifiedTombstoneV1): void {
  if (value.tombstone_action_candid.byteLength === 0) {
    throw new WagyuProtocolError(
      "WAGYU_EMPTY_NESTED_CANDID",
      "Tombstone action Candid must be non-empty",
    );
  }
  validateActionRef(value.ref);
}

function validateCurrentCertifiedTombstone(
  value: CertifiedTombstoneV1,
): void {
  validateCertifiedTombstone(value);
  requireCurrentVariant(
    value.ref.action_kind,
    ["tombstone"],
    "tombstone.ref.action_kind",
  );
}

function validateLikeBatch(value: LikeBatchV1): void {
  bytes32(value.network_id, "like_batch.network_id");
  bytes32(value.post_id, "like_batch.post_id");
  bytes32(value.post_body_hash, "like_batch.post_body_hash");
  for (const digest of value.previous_batch_digest) {
    bytes32(digest, "like_batch.previous_batch_digest");
  }
  const count = value.receipts.length;
  if (
    (!value.final_partial && count !== WAGYU_LIMITS.likeBatchReceipts) ||
    (value.final_partial &&
      (count < 1 || count > WAGYU_LIMITS.finalPartialLikeBatchReceipts))
  ) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_LIKE_BATCH_COUNT",
      "A normal batch has 150 receipts; a partial package has 1-149",
    );
  }
  for (const receipt of value.receipts) validateLikeReceipt(receipt);
}

function validateCurrentLikeBatch(value: LikeBatchV1): void {
  validateLikeBatch(value);
  for (const receipt of value.receipts) validateCurrentLikeReceipt(receipt);
}

function validateLikeHead(value: LikeHeadV1): void {
  bytes32(value.network_id, "like_head.network_id");
  bytes32(value.post_id, "like_head.post_id");
  bytes32(value.post_body_hash, "like_head.post_body_hash");
  for (const digest of value.previous_head_hash) {
    bytes32(digest, "like_head.previous_head_hash");
  }
  for (const digest of value.latest_batch_digest) {
    bytes32(digest, "like_head.latest_batch_digest");
  }
  if (
    value.latest_batch_number.length !== value.latest_batch_digest.length
  ) {
    throw new WagyuProtocolError(
      "WAGYU_INCOMPLETE_LIKE_HEAD",
      "Like head latest batch number and digest must both be null or present",
    );
  }
}

function validateIngress(value: WagyuIngressV1): void {
  bytes16(value.operation_id, "ingress.operation_id");
  if (value.body_candid.byteLength === 0) {
    throw new WagyuProtocolError(
      "WAGYU_EMPTY_NESTED_CANDID",
      "Ingress body_candid must be non-empty",
    );
  }
}

function validateFollowBody(value: FollowBodyV1): void {
  bytes16(value.subscription_id, "follow.subscription_id");
}

function validateUnfollowBody(value: UnfollowBodyV1): void {
  bytes16(value.subscription_id, "unfollow.subscription_id");
}

function validateDeliverBody(value: DeliverBodyV1): void {
  bytes16(value.subscription_id, "deliver.subscription_id");
  for (const event of value.event) {
    const blob =
      "original" in event
        ? event.original
        : "share" in event
          ? event.share
          : event.tombstone;
    if (blob.byteLength === 0) {
      throw new WagyuProtocolError(
        "WAGYU_EMPTY_NESTED_CANDID",
        "Delivery event Candid must be non-empty",
      );
    }
  }
}

function validateCurrentDeliverBody(value: DeliverBodyV1): void {
  validateDeliverBody(value);
  requireCurrentVariant(
    value.event,
    ["original", "share", "tombstone"],
    "deliver.event",
  );
}

function validateLikeBody(value: LikeBodyV1): void {
  if (value.certified_like_receipt_candid.byteLength === 0) {
    throw new WagyuProtocolError(
      "WAGYU_EMPTY_NESTED_CANDID",
      "Like body receipt Candid must be non-empty",
    );
  }
}

function validateNoticeBody(value: NoticeBodyV1): void {
  bytes32(value.target_post_id, "notice.target_post_id");
  bytes32(value.target_body_hash, "notice.target_body_hash");
  bytes32(value.actor_action_id, "notice.actor_action_id");
  bytes32(value.actor_object_digest, "notice.actor_object_digest");
  assertNat32(value.actor_object_length, "notice.actor_object_length");
}

function validateCurrentNoticeBody(value: NoticeBodyV1): void {
  validateNoticeBody(value);
  requireCurrentVariant(
    value.relation,
    ["reply", "share"],
    "notice.relation",
  );
}

function validateCurrentRouteResult(value: WagyuRouteResultV1): void {
  const outcome = requireCurrentVariant(
    value.outcome,
    ["accepted", "duplicate", "rejected"],
    "route_result.outcome",
  );
  if (outcome.tag === "rejected") {
    const rejected = outcome.value as {
      reason: [] | [Record<string, unknown>];
    };
    requireCurrentVariant(
      rejected.reason,
      [
        "invalid",
        "blocked",
        "not_following",
        "unknown_post",
        "expired",
        "full",
        "conflict",
        "incompatible",
      ],
      "route_result.rejected.reason",
    );
  }
}

function validateFollowerHead(value: FollowerHeadV1): void {
  for (const state of value.state) {
    if ("active" in state) {
      bytes16(state.active.subscription_id, "follower.subscription_id");
      assertNat16(state.active.delivery_credits, "follower.delivery_credits");
      if (state.active.delivery_credits > WAGYU_LIMITS.followerCreditsMaximum) {
        throw new WagyuProtocolError(
          "WAGYU_INVALID_CREDITS",
          "Follower delivery credits exceed 128",
        );
      }
    } else {
      bytes16(
        state.inactive.last_subscription_id,
        "follower.last_subscription_id",
      );
    }
  }
}

function validateFeedRequest(value: FeedPageRequestV1): void {
  assertNat16(value.limit, "feed.limit");
  if (value.limit < 1 || value.limit > WAGYU_LIMITS.feedPageItems) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_PAGE_LIMIT",
      `Feed limit must be 1-${WAGYU_LIMITS.feedPageItems}`,
    );
  }
}

function validateFeedSummary(value: FeedCandidateSummaryV1): void {
  bytes32(value.candidate_id, "feed.candidate_id");
  bytes32(value.claimed_post_id, "feed.claimed_post_id");
}

function validateFeedPage(value: FeedPageV1): void {
  if (value.items.length > WAGYU_LIMITS.feedPageItems) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_PAGE_SIZE",
      "Feed page contains too many items",
    );
  }
  let exactEventBytes = 0;
  for (const item of value.items) {
    validateFeedSummary(item);
    exactEventBytes += item.exact_event_candid.byteLength;
  }
  if (exactEventBytes > WAGYU_LIMITS.feedPageExactEventBytes) {
    throw new WagyuProtocolError(
      "WAGYU_FEED_PAGE_TOO_LARGE",
      "Feed page exact event bytes exceed the V1 bound",
    );
  }
}

function validateNotificationSummary(value: NotificationSummaryV1): void {
  for (const kind of value.kind) {
    if ("new_follower" in kind) continue;
    const directed =
      "like" in kind ? kind.like : "reply" in kind ? kind.reply : kind.share;
    bytes32(directed.target_post_id, "notification.target_post_id");
    bytes32(directed.target_body_hash, "notification.target_body_hash");
    bytes32(directed.action_id, "notification.action_id");
    bytes32(directed.object_digest, "notification.object_digest");
    assertNat32(directed.object_length, "notification.object_length");
  }
}

function validateNotificationRequest(
  value: NotificationPageRequestV1,
): void {
  assertNat16(value.limit, "notifications.limit");
  if (value.limit < 1 || value.limit > WAGYU_LIMITS.notificationPageItems) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_PAGE_LIMIT",
      `Notification limit must be 1-${WAGYU_LIMITS.notificationPageItems}`,
    );
  }
}

function validateNotificationPage(value: NotificationPageV1): void {
  if (value.items.length > WAGYU_LIMITS.notificationPageItems) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_PAGE_SIZE",
      "Notification page contains too many items",
    );
  }
  for (const item of value.items) validateNotificationSummary(item);
}

function validateNotificationEvidence(
  value: NotificationEvidenceV1,
): void {
  for (const evidence of value.evidence) {
    if (
      evidence.like.certified_like_receipt_candid.byteLength >
      WAGYU_LIMITS.certifiedLikeReceiptEncodedBytes
    ) {
      throw new WagyuProtocolError(
        "WAGYU_EVIDENCE_TOO_LARGE",
        "Like notification evidence exceeds 6,000 bytes",
      );
    }
  }
}

function validateSendQuoteRequest(value: SendQuoteRequestV1): void {
  assertNat32(value.estimated_object_bytes, "quote.estimated_object_bytes");
}

function validateSendQuote(value: SendQuoteV1): void {
  assertNat32(
    value.eligible_delivery_count,
    "quote.eligible_delivery_count",
  );
  if (
    value.eligible_recipient_preview.length > 8 ||
    value.eligible_recipient_preview.length >
      value.eligible_delivery_count
  ) {
    throw new WagyuProtocolError(
      "WAGYU_RECIPIENT_PREVIEW_INVALID",
      "Send quote recipient preview exceeds its authoritative bound",
    );
  }
  for (
    let index = 1;
    index < value.eligible_recipient_preview.length;
    index += 1
  ) {
    if (
      value.eligible_recipient_preview[index - 1]!.compareTo(
        value.eligible_recipient_preview[index]!,
      ) !== "lt"
    ) {
      throw new WagyuProtocolError(
        "WAGYU_RECIPIENT_PREVIEW_INVALID",
        "Send quote recipient preview must be unique and canonically ascending",
      );
    }
  }
}

function validateProfileEditRequest(value: ProfileEditRequestV1): void {
  assertBoundedText(
    value.display_name,
    WAGYU_LIMITS.profileDisplayNameUtf8Bytes,
    "profile_edit.display_name",
  );
  assertBoundedText(
    value.description,
    WAGYU_LIMITS.profileDescriptionUtf8Bytes,
    "profile_edit.description",
  );
  for (const avatar of value.avatar) {
    assertNat16(avatar.width, "profile_edit.avatar.width");
    assertNat16(avatar.height, "profile_edit.avatar.height");
    if (
      avatar.width < 1 ||
      avatar.height < 1 ||
      avatar.width > WAGYU_LIMITS.profileAvatarDimension ||
      avatar.height > WAGYU_LIMITS.profileAvatarDimension
    ) {
      throw new WagyuProtocolError(
        "WAGYU_AVATAR_DIMENSIONS",
        "Profile edit avatar dimensions exceed the V1 limit",
      );
    }
    if (!(avatar.bytes instanceof Uint8Array)) {
      throw new WagyuProtocolError(
        "WAGYU_AVATAR_BYTES_INVALID",
        "Profile edit avatar bytes must be a Uint8Array",
      );
    }
    if (avatar.bytes.byteLength === 0) {
      throw new WagyuProtocolError(
        "WAGYU_AVATAR_BYTES_EMPTY",
        "Profile edit avatar bytes must not be empty",
      );
    }
    if (avatar.bytes.byteLength > WAGYU_LIMITS.profileAvatarBytes) {
      throw new WagyuProtocolError(
        "WAGYU_AVATAR_TOO_LARGE",
        `Profile edit avatar bytes exceed ${WAGYU_LIMITS.profileAvatarBytes} bytes`,
      );
    }
  }
}

function validateCurrentProfileEditRequest(value: ProfileEditRequestV1): void {
  validateProfileEditRequest(value);
  for (const avatar of value.avatar) {
    requireCurrentVariant(
      avatar.media_type,
      ["jpeg", "png", "webp"],
      "profile_edit.avatar.media_type",
    );
  }
}

function validateProfileEditResult(value: ProfileEditResultV1): void {
  for (const outcome of value.outcome) {
    if ("updated" in outcome) {
      bytes32(outcome.updated.body_digest, "profile_edit.body_digest");
    }
  }
}

function validateCurrentProfileEditResult(value: ProfileEditResultV1): void {
  validateProfileEditResult(value);
  const outcome = requireCurrentVariant(
    value.outcome,
    ["updated", "conflict", "rejected"],
    "profile_edit.outcome",
  );
  if (outcome.tag === "rejected") {
    const rejected = outcome.value as {
      reason: [] | [Record<string, unknown>];
    };
    requireCurrentVariant(
      rejected.reason,
      ["invalid", "full", "low_cycles"],
      "profile_edit.rejected.reason",
    );
  }
}

function requireCurrentVariant(
  value: readonly [] | readonly [object],
  allowedTags: readonly string[],
  label: string,
): { tag: string; value: unknown } {
  if (value.length !== 1) {
    throw new WagyuProtocolError(
      "WAGYU_MISSING_CURRENT_VARIANT",
      `${label} must contain one known V1 tag`,
    );
  }
  const record = value[0] as Record<string, unknown>;
  const tags = Object.keys(record);
  if (tags.length !== 1 || !allowedTags.includes(tags[0]!)) {
    throw new WagyuProtocolError(
      "WAGYU_UNSUPPORTED_CURRENT_VARIANT",
      `${label} must contain one known V1 tag`,
    );
  }
  return { tag: tags[0]!, value: record[tags[0]!] };
}

function noop(): void {
  // The Candid library still enforces the complete frozen structural type.
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
