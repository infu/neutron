import type {
  AppSnapshot,
  AuthoredItem,
  AuthoredPage,
  FeedItem,
  FeedPage,
  LikePackage,
  LikesDetail,
  NotificationPage,
  ProfileDraft,
  PublishResult,
  PublishStage,
  Relationship,
  SendQuote,
  WagyuProfile,
  WagyuService,
  WagyuStatus,
} from "./model.ts";
import { sanitizeAvatarUpload } from "./avatar_pipeline.ts";

const NOW = Date.now();
const ago = (milliseconds: number) =>
  new Date(NOW - milliseconds).toISOString();

const OWNER_NODE =
  "opq6c-yiaaa-aaaan-qm4va-cai";

const profiles = {
  mina: {
    nodeId: "qjdve-lqaaa-aaaan-qm5ka-cai",
    displayName: "Mina Seo",
    avatarUrl: null,
    profileProof: "fresh" as const,
  },
  theo: {
    nodeId: "x7krn-3yaaa-aaaan-qm6fa-cai",
    displayName: "Theo Imani",
    avatarUrl: null,
    profileProof: "fresh" as const,
  },
  ada: {
    nodeId: "2vxsx-fae",
    displayName: "Ada",
    avatarUrl: null,
    profileProof: "fresh" as const,
  },
};

const feedItems: FeedItem[] = [
  {
    id: "feed-104",
    localSequence: "104",
    receivedAt: ago(4 * 60_000),
    immediateSender: profiles.mina.nodeId,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: profiles.mina,
    postId: "75d3b4…8122",
    body:
      "The most useful property of a social graph is not scale. It is knowing who can change it.\n\nSmall, owned networks feel different.",
    bodyDigest: "ae84c7…9c11",
    objectDigest: "c383a0…f091",
    bodyLength: 196,
    createdAt: ago(6 * 60_000),
    sharedBy: null,
    replyTo: null,
    likedByOwner: false,
    likeSummary: {
      verified: 284,
      invalid: 2,
      unavailable: 1,
      awaitingBatch: 0,
    },
    localOrigin: false,
    opaqueEventBytes: null,
    originalPostRefBytes: new Uint8Array([68, 73, 68, 76]),
  },
  {
    id: "feed-103",
    localSequence: "103",
    receivedAt: ago(18 * 60_000),
    immediateSender: profiles.theo.nodeId,
    kind: "share",
    verification: "fetching",
    promotion: "pending",
    author: {
      nodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      displayName: null,
      avatarUrl: null,
      profileProof: "loading",
    },
    postId: "49fc20…a9e2",
    body: "This text is intentionally never rendered while verification is pending.",
    bodyDigest: null,
    objectDigest: null,
    bodyLength: null,
    createdAt: null,
    sharedBy: profiles.theo,
    replyTo: null,
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
  },
  {
    id: "feed-102",
    localSequence: "102",
    receivedAt: ago(43 * 60_000),
    immediateSender: profiles.ada.nodeId,
    kind: "original",
    verification: "unavailable",
    promotion: "pending",
    author: {
      ...profiles.ada,
      displayName: null,
      profileProof: "unavailable",
    },
    postId: "c1223a…aa07",
    body: "Untrusted unavailable text",
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
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  },
  {
    id: "feed-101",
    localSequence: "101",
    receivedAt: ago(2 * 3_600_000),
    immediateSender: "r7inp-6aaaa-aaaaa-aaabq-cai",
    kind: "original",
    verification: "invalid",
    promotion: "pending",
    author: {
      nodeId: "r7inp-6aaaa-aaaaa-aaabq-cai",
      displayName: null,
      avatarUrl: null,
      profileProof: "unverified",
    },
    postId: "4df590…41bc",
    body: "Hostile text that must stay quarantined.",
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
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  },
];

const relationships: Relationship[] = [
  {
    nodeId: profiles.mina.nodeId,
    displayName: profiles.mina.displayName,
    avatarUrl: null,
    profileProof: "fresh",
    youFollow: true,
    followsYou: true,
    followingState: "active",
    followerState: "active",
    followerCredits: 26,
    followerLeaseExpiresAt:
      new Date(NOW + 210 * 86_400_000).toISOString(),
    followingRenewalRequested: false,
    renewalCostCycles: "7000000000",
    protocolVersion: "wagyu_v1",
    compatible: true,
    blocked: false,
  },
  {
    nodeId: profiles.theo.nodeId,
    displayName: profiles.theo.displayName,
    avatarUrl: null,
    profileProof: "fresh",
    youFollow: true,
    followsYou: false,
    followingState: "active",
    followerState: null,
    followerCredits: 0,
    followerLeaseExpiresAt: null,
    followingRenewalRequested: true,
    renewalCostCycles: "7000000000",
    protocolVersion: "wagyu_v1",
    compatible: true,
    blocked: false,
  },
  {
    nodeId: profiles.ada.nodeId,
    displayName: null,
    avatarUrl: null,
    profileProof: "unavailable",
    youFollow: false,
    followsYou: true,
    followingState: null,
    followerState: "credit-low",
    followerCredits: 0,
    followerLeaseExpiresAt: new Date(
      NOW + 34 * 86_400_000,
    ).toISOString(),
    followingRenewalRequested: false,
    renewalCostCycles: "7000000000",
    protocolVersion: "wagyu_v1",
    compatible: true,
    blocked: false,
  },
];

const notifications: NotificationPage = {
  revision: "84",
  nextCursor: null,
  items: [
    {
      id: "notification-84",
      localSequence: "84",
      receivedAt: ago(7 * 60_000),
      actorNodeId: profiles.theo.nodeId,
      actorDisplayName: profiles.theo.displayName,
      actorAvatarUrl: null,
      actorProfileProof: "fresh",
      kind: "share",
      verification: "verified",
      read: false,
      targetPostId: "f83ea1…1c20",
      targetBodyHash: null,
      actionId: null,
      objectDigest: null,
      objectLength: null,
    },
    {
      id: "notification-83",
      localSequence: "83",
      receivedAt: ago(25 * 60_000),
      actorNodeId: "j2rt5-3aaaa-aaaan-qm7ha-cai",
      actorDisplayName: "Untrusted asserted name",
      actorAvatarUrl: null,
      actorProfileProof: "unverified",
      kind: "reply",
      verification: "pending",
      read: false,
      targetPostId: "f83ea1…1c20",
      targetBodyHash: null,
      actionId: null,
      objectDigest: null,
      objectLength: null,
    },
    {
      id: "notification-82",
      localSequence: "82",
      receivedAt: ago(58 * 60_000),
      actorNodeId: profiles.mina.nodeId,
      actorDisplayName: profiles.mina.displayName,
      actorAvatarUrl: null,
      actorProfileProof: "fresh",
      kind: "like",
      verification: "verified",
      read: true,
      targetPostId: "f83ea1…1c20",
      targetBodyHash: null,
      actionId: null,
      objectDigest: null,
      objectLength: null,
    },
    {
      id: "notification-81",
      localSequence: "81",
      receivedAt: ago(2 * 3_600_000),
      actorNodeId: profiles.ada.nodeId,
      actorDisplayName: profiles.ada.displayName,
      actorAvatarUrl: null,
      actorProfileProof: "fresh",
      kind: "follow",
      verification: "transport-authenticated",
      read: true,
      targetPostId: null,
      targetBodyHash: null,
      actionId: null,
      objectDigest: null,
      objectLength: null,
    },
  ],
};

let demoStatus: WagyuStatus = {
  nodeId: OWNER_NODE,
  configuredNetworkId:
    "7d8ebdf042e4fa1cf610bff299a6f247c74dbb2e36be348439eb68ce757545e1",
  networkConfigured: true,
  peerDeliveryEnabled: true,
  protocolVersion: "wagyu_v1",
  unreadFeed: 3,
  unreadNotifications: 2,
  outboxErrors: 1,
  outboxPaused: false,
  certifiedStoreReady: true,
  releaseGateMessage: null,
  preview: true,
};

let demoProfile: WagyuProfile = {
  nodeId: OWNER_NODE,
  profileGeneration: "1",
  revision: "7",
  displayName: "Your Wagyu node",
  description:
    "A small social space for posts, replies, likes, and people you choose to follow.",
  avatarUrl: null,
  avatar: null,
  proofState: "fresh",
  protocolVersion: "wagyu_v1",
  compatible: true,
  updatedAt: ago(5 * 86_400_000),
};

const feedPage = (): FeedPage => ({
  revision: "104",
  items: feedItems.map((item) => ({ ...item })),
  nextCursor: null,
});

const authoredPage = (): AuthoredPage => ({
  revision: "12",
  nextCursor: null,
  items: [
    {
      sequence: "12",
      kind: "post",
      postId:
        "f83ea1475dc65cd41c8b37f89575c02a2fd7b0dbc5abb78f5385e3a4c42d1c20",
      actionId:
        "f83ea1475dc65cd41c8b37f89575c02a2fd7b0dbc5abb78f5385e3a4c42d1c20",
      objectDigest:
        "5d36a70ad6337f1f50ed138c3fa24dd846e781759c5a6f2f14926787d6298351",
      state: "live",
      createdAt: ago(3 * 3_600_000),
    },
  ],
});

function snapshot(): AppSnapshot {
  return {
    status: { ...demoStatus },
    trustedNetwork: {
      networkId:
        "7d8ebdf042e4fa1cf610bff299a6f247c74dbb2e36be348439eb68ce757545e1",
      target: "preview",
      rootKeyPolicy: "preview",
      source: "Local preview fixture — not canister data",
    },
    profile: { ...demoProfile },
    feed: feedPage(),
    authored: authoredPage(),
    notifications: {
      ...notifications,
      items: notifications.items.map((item) => ({ ...item })),
    },
    relationships: {
      revision: "1",
      items: relationships.map((relationship) => ({ ...relationship })),
      nextCursor: null,
    },
    degradedSlices: [],
  };
}

export function createPreviewWagyuService(): WagyuService {
  return {
    async loadOwner() {
      return {
        status: { ...demoStatus },
        profile: { ...demoProfile },
      };
    },
    async loadSnapshot() {
      return snapshot();
    },
    async loadFeed() {
      return feedPage();
    },
    async hydrateCandidate(item) {
      if (item.verification === "fetching" || item.verification === "candidate") {
        await Promise.resolve();
      }
      return { ...item };
    },
    async loadThreadReplies() {
      return [];
    },
    async loadThreadReplyCount() {
      return 0;
    },
    async loadNotifications() {
      return {
        ...notifications,
        items: notifications.items.map((item) => ({ ...item })),
      };
    },
    async hydrateNotification(item) {
      return { ...item };
    },
    async markNotificationsRead() {
      return;
    },
    async loadAuthored() {
      return authoredPage();
    },
    async loadRelationships() {
      return {
        revision: "1",
        items: relationships.map((relationship) => ({ ...relationship })),
        nextCursor: null,
      };
    },
    async hydrateRelationshipProfile(relationship) {
      await Promise.resolve();
      return { ...relationship };
    },
    async loadUserProfile(nodeId) {
      const known = Object.values(profiles).find(
        (profile) => profile.nodeId === nodeId,
      );
      return {
        nodeId,
        profileGeneration: "1",
        revision: "1",
        displayName: known?.displayName ?? "",
        description: known
          ? `A verified Wagyu profile for ${known.displayName}.`
          : "",
        avatarUrl: known?.avatarUrl ?? null,
        avatar: null,
        proofState: known?.profileProof ?? "unavailable",
        protocolVersion: "wagyu_v1",
        compatible: true,
        updatedAt: ago(60_000),
      };
    },
    async follow(nodeId) {
      return {
        nodeId,
        displayName: null,
        avatarUrl: null,
        profileProof: "loading",
        youFollow: true,
        followsYou: false,
        followingState: "registering",
        followerState: null,
        followerCredits: 0,
        followerLeaseExpiresAt: null,
        followingRenewalRequested: false,
        renewalCostCycles: "7000000000",
        protocolVersion: "wagyu_v1",
        compatible: true,
        blocked: false,
      };
    },
    async unfollow() {
      return;
    },
    async setBlocked() {
      return;
    },
    async getSendQuote(
      estimatedObjectBytes,
      noticeTarget,
    ): Promise<SendQuote> {
      const base = BigInt(
        40_000_000 + estimatedObjectBytes * 12_000,
      );
      const noticeFloor = noticeTarget ? 100_000_000n : 0n;
      return {
        followerRevision: "18",
        registeredFollowers: 4,
        eligibleRecipients: 3,
        ineligibleFollowers: 1,
        recipientPreview: [profiles.mina.nodeId],
        receiverFloorCycles: 600_000_000n,
        authorNoticeFloorCycles: noticeFloor,
        callAndByteCycles: base,
        localPublicationCycles: 30_000_000n,
        totalCycles: 630_000_000n + noticeFloor + base,
        limitWarning:
          "1 follower is ineligible because its delivery credit is exhausted.",
      };
    },
    async publishPost(
      _markdown: string,
      onStage: (stage: PublishStage) => void,
      replyTo: FeedItem | null = null,
    ): Promise<PublishResult> {
      const stages: PublishStage[] = [
        "encoding",
        "publishing",
        "awaiting-proof",
        "certified-ref-ready",
        "fanout-queued",
        "sending",
      ];
      for (const stage of stages) {
        onStage(stage);
        await Promise.resolve();
      }
      return {
        stage: "complete",
        postId: "0f84da…2249",
        queuedRecipients: 3,
        queuedNotices: replyTo ? 1 : 0,
        acceptedRecipients: 3,
        failedRecipients: 0,
        message: replyTo
          ? "Certified locally. The remote author notice and every eligible follower delivery are queued."
          : "Certified locally and queued to every eligible follower.",
      };
    },
    async like() {
      return {
        stage: "complete",
        postId: null,
        queuedRecipients: 0,
        queuedNotices: 1,
        acceptedRecipients: 0,
        failedRecipients: 0,
        message: "The certified Like notice is queued for the post home.",
      };
    },
    async share(_item, onStage) {
      onStage("publishing");
      await Promise.resolve();
      onStage("complete");
      return {
        stage: "complete",
        postId: null,
        queuedRecipients: 3,
        queuedNotices: 1,
        acceptedRecipients: 0,
        failedRecipients: 0,
        message: "The certified share delivery is queued.",
      };
    },
    async resumeAuthoredAction(item, onStage) {
      return previewResumeAuthoredAction(item, onStage);
    },
    async resumeAuthoredPost(item, onStage) {
      return previewResumeAuthoredAction(item, onStage);
    },
    async withdrawPost(item, onStage) {
      onStage("publishing");
      await Promise.resolve();
      onStage("withdrawal-closing");
      return {
        stage: "withdrawal-closing",
        postId: item.postId,
        queuedRecipients: 0,
        queuedNotices: 0,
        acceptedRecipients: 0,
        failedRecipients: 0,
        message: "Like archival is finishing before deletion is sent.",
      };
    },
    async advanceWithdrawal(item, onStage) {
      onStage("withdrawal-closing");
      await Promise.resolve();
      onStage("complete");
      return {
        stage: "complete",
        postId: item.postId,
        queuedRecipients: 3,
        queuedNotices: 0,
        acceptedRecipients: 0,
        failedRecipients: 0,
        message: "The certified deletion is complete and fanout is queued.",
      };
    },
    async loadLikes(item): Promise<LikesDetail> {
      const packages: LikePackage[] = [
        {
          id: "batch-2",
          batchNumber: "2",
          state: "verified",
          receipts: [
            {
              id: "like-1",
              actorNodeId: profiles.theo.nodeId,
              actorDisplayName: profiles.theo.displayName,
              state: "verified",
            },
            {
              id: "like-2",
              actorNodeId: profiles.ada.nodeId,
              actorDisplayName: profiles.ada.displayName,
              state: "verified",
            },
            {
              id: "like-3",
              actorNodeId: "3e3x2-xyaaa-aaaan-qm8na-cai",
              actorDisplayName: null,
              state: "invalid",
            },
          ],
        },
        {
          id: "batch-1",
          batchNumber: "1",
          state: "unavailable",
          receipts: [],
        },
      ];
      return {
        postId: item.postId,
        packages,
        awaitingBatch: item.localOrigin
          ? [
              {
                id: "like-awaiting",
                actorNodeId: profiles.mina.nodeId,
                actorDisplayName: profiles.mina.displayName,
                state: "awaiting-batch",
              },
            ]
          : [],
      };
    },
    async saveProfile(draft: ProfileDraft) {
      const selectedAvatar =
        draft.avatar && !draft.clearAvatar
          ? await sanitizeAvatarUpload(draft.avatar)
          : null;
      demoProfile = {
        ...demoProfile,
        revision: String(BigInt(demoProfile.revision) + 1n),
        displayName: draft.displayName,
        description: draft.description,
        avatarUrl:
          selectedAvatar
            ? URL.createObjectURL(
                new Blob([Uint8Array.from(selectedAvatar.bytes)], {
                  type: "image/jpeg",
                }),
              )
            : draft.clearAvatar
              ? null
              : demoProfile.avatarUrl,
        avatar: selectedAvatar ??
          (draft.clearAvatar ? null : demoProfile.avatar),
        updatedAt: new Date().toISOString(),
      };
      return { ...demoProfile };
    },
    async enablePeerDelivery() {
      demoStatus = {
        ...demoStatus,
        peerDeliveryEnabled: true,
      };
      return { ...demoStatus };
    },
  };
}

async function previewResumeAuthoredAction(
  item: AuthoredItem,
  onStage: (stage: PublishStage) => void,
): Promise<PublishResult> {
  onStage("awaiting-proof");
  await Promise.resolve();
  onStage("fanout-queued");
  return {
    stage: "fanout-queued",
    postId: item.kind === "post" ? item.postId : null,
    queuedRecipients: item.kind === "like" ? 1 : 3,
    queuedNotices: item.kind === "share" ? 1 : 0,
    acceptedRecipients: 0,
    failedRecipients: 0,
    message: `The prepared ${item.kind} proof was captured and dispatch is queued.`,
  };
}
