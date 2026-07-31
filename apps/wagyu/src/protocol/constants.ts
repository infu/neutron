export const WAGYU_APP_ID = "wagyu" as const;
export const WAGYU_PROTOCOL_ID = "wagyu_v1" as const;
export const WAGYU_PROTOCOL_MAJOR = 1 as const;

export const WAGYU_PUBLIC_INGRESS_METHOD =
  "app_wagyu__wagyu_v1_update" as const;

export const WAGYU_OWNER_METHODS = Object.freeze({
  getFeedPage: "wagyu_get_feed_page_v1",
  getNotificationPage: "wagyu_get_notification_page_v1",
  getNotificationEvidence: "wagyu_get_notification_evidence_v1",
  getSendQuote: "wagyu_get_send_quote_v1",
  profileEdit: "wagyu_profile_edit_v1",
});

export const WAGYU_ROUTES = Object.freeze({
  follow: "wagyu_v1:follow",
  unfollow: "wagyu_v1:unfollow",
  deliver: "wagyu_v1:deliver",
  like: "wagyu_v1:like",
  notice: "wagyu_v1:notice",
});

export type WagyuRouteId = (typeof WAGYU_ROUTES)[keyof typeof WAGYU_ROUTES];

export const WAGYU_ROUTE_CONTRACTS = Object.freeze({
  [WAGYU_ROUTES.follow]: Object.freeze({
    maximumRequestBytes: 1_024,
    maximumResponseBytes: 256,
    maximumPerHour: 120,
    requiredCycles: 7_000_000_000n,
  }),
  [WAGYU_ROUTES.unfollow]: Object.freeze({
    maximumRequestBytes: 512,
    maximumResponseBytes: 128,
    maximumPerHour: 240,
    requiredCycles: 50_000_000n,
  }),
  [WAGYU_ROUTES.deliver]: Object.freeze({
    maximumRequestBytes: 16 * 1_024,
    maximumResponseBytes: 512,
    maximumPerHour: 1_800,
    requiredCycles: 200_000_000n,
  }),
  [WAGYU_ROUTES.like]: Object.freeze({
    maximumRequestBytes: 8 * 1_024,
    maximumResponseBytes: 512,
    maximumPerHour: 1_080,
    requiredCycles: 250_000_000n,
  }),
  [WAGYU_ROUTES.notice]: Object.freeze({
    maximumRequestBytes: 1_024,
    maximumResponseBytes: 256,
    maximumPerHour: 360,
    requiredCycles: 100_000_000n,
  }),
});

export const WAGYU_HASH_DOMAINS = Object.freeze({
  networkId: "neutron.network-id.v1",
  postBody: "wagyu.post-body.v1",
  postId: "wagyu.post-id.v1",
  shareId: "wagyu.share-id.v1",
  likeId: "wagyu.like-id.v1",
  tombstoneId: "wagyu.tombstone-id.v1",
  feedCandidateId: "wagyu.feed-candidate-id.v1",
});

export const WAGYU_PROTOCOL_PATH_PREFIX =
  "/app/wagyu/_route/protocol/v1" as const;
export const WAGYU_PROFILE_PATH =
  "/app/wagyu/_route/protocol/v1/profile" as const;

export const WAGYU_ACTION_PATH_SEGMENTS = Object.freeze({
  post: "post",
  share: "share",
  tombstone: "tombstone",
  like: "like",
});

export type WagyuActionPathKind = keyof typeof WAGYU_ACTION_PATH_SEGMENTS;

export const WAGYU_LIMITS = Object.freeze({
  digestBytes: 32,
  nonceBytes: 16,
  networkIdBytes: 32,
  certificateVersion: 2,
  portableProofEncodedBytes: 5_500,
  certifiedLikeReceiptEncodedBytes: 6_000,
  bodyMarkdownUtf8Bytes: 8 * 1_024,
  profileDisplayNameUtf8Bytes: 80,
  profileDescriptionUtf8Bytes: 1_024,
  profileCapabilities: 32,
  profileCapabilityUtf8Bytes: 64,
  profileAvatarBytes: 256 * 1_024,
  profileAvatarDimension: 1_024,
  profileObjectBytes: 266_240,
  postObjectBytes: 1_044_480,
  genericActionObjectBytes: 1_048_576,
  likeBatchObjectBytes: 983_040,
  likeBatchProtocolBytes: 960 * 1_024,
  likeHeadObjectBytes: 4_096,
  replyIndexObjectBytes: 1_044_480,
  replyIndexEntries: 4_096,
  reactionReceiptCount: 100_000,
  likeBatchReceipts: 150,
  finalPartialLikeBatchReceipts: 149,
  feedPageItems: 25,
  feedPageExactEventBytes: 512 * 1_024,
  notificationPageItems: 50,
  fanoutBatchCalls: 20,
  followerCreditsPerBond: 32,
  followerCreditsMaximum: 128,
  followerRenewalMaximumExistingCredits: 96,
  renewalRequestedAtCredits: 8,
  retentionDays: 400,
});

export const WAGYU_CAPABILITY_TOKEN_PATTERN = /^[a-z0-9._:-]+$/u;
export const WAGYU_LOWER_HEX_32_PATTERN = /^[0-9a-f]{64}$/u;

export const WAGYU_FIXED_CONTENT_TYPE = "application/octet-stream" as const;
