import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { onAppStateChange } from "neutron-tools/app";
import {
  IoArrowRedoOutline,
  IoCheckmarkCircleOutline,
  IoCloseOutline,
  IoCloudOfflineOutline,
  IoCreateOutline,
  IoGlobeOutline,
  IoHomeOutline,
  IoNotificationsOutline,
  IoPeopleOutline,
  IoPersonOutline,
  IoRefreshOutline,
  IoTrashBinOutline,
  IoWarningOutline,
} from "react-icons/io5";
import type {
  AppSnapshot,
  AuthoredItem,
  AuthoredPost,
  FeedAuthor,
  FeedItem,
  LikesDetail,
  NotificationItem,
  ProfileDraft,
  PublishStage,
  Relationship,
  RelationshipAction,
  RelationshipBusy,
  SendQuote,
  VerificationIssueCode,
  ViewId,
  WagyuProfile,
  WagyuService,
} from "./model.ts";
import { WAGYU_LIMITS } from "../protocol/constants.ts";
import { WAGYU_RESIDENT_TOPICS } from "../resident/contracts.ts";
import {
  appendAuthoredPage,
  appendFeedPage,
  appendNotificationPage,
  mergeFeedPageHydration,
} from "./feed_state.ts";
import { FeedUnavailableRetryController } from "./feed_retry.ts";
import {
  appendLikesPage,
  withLocalAwaitingLikes,
} from "./likes_state.ts";
import {
  applyRelationshipProfileHydration,
  appendRelationshipPage,
  invalidateRelationshipContinuation,
  markRelationshipProfileUnavailable,
} from "./relationship_state.ts";
import {
  profileMayRenderRemoteText,
  publishStageIsDurableHandoff,
  shortenNodeId,
} from "./presentation.ts";
import { closingWithdrawalPosts } from "./withdrawal_progress.ts";
import { Avatar } from "./components/Avatar.tsx";
import { Composer } from "./components/Composer.tsx";
import {
  AuthoredPostsPanel,
  FeedView,
  notificationThreadTarget,
  verificationIssueCopy,
} from "./components/FeedView.tsx";
import { LikesDrawer } from "./components/LikesDrawer.tsx";
import { PeerDeliveryGate } from "./components/PeerDeliveryGate.tsx";
import { useDialogFocus } from "./components/dialog_focus.ts";
import {
  notificationNeedsAutomaticHydration,
  NotificationsView,
} from "./components/NotificationsView.tsx";
import {
  notificationEvidenceNeedsAutomaticHydration,
  progressOlderNotificationProofs,
} from "./notification_progress.ts";
import {
  ProfileView,
  UserProfileView,
} from "./components/ProfileView.tsx";
import { RelationshipsView } from "./components/RelationshipsView.tsx";
import { CopyIdButton } from "./components/Avatar.tsx";
import { WagyuResidentClient } from "../tray/client.ts";
import type { WagyuResidentSnapshot } from "../resident/orchestrator.ts";
import {
  ACTIVE_ENGAGEMENT_REFRESH_MS,
  activeEngagementKey,
  ActiveEngagementProvider,
} from "./active_engagement.tsx";
import {
  isMissingCertifiedReplyIndexError,
} from "./certified_runtime.ts";

const NAVIGATION = [
  { id: "feed", label: "Home", icon: IoHomeOutline },
  { id: "profile", label: "Profile", icon: IoPersonOutline },
  { id: "notifications", label: "Notifications", icon: IoNotificationsOutline },
  { id: "relationships", label: "People", icon: IoPeopleOutline },
] as const;
const MOBILE_NAVIGATION = [
  NAVIGATION[0],
  NAVIGATION[1],
  null,
  NAVIGATION[2],
  NAVIGATION[3],
] as const;

const RELATIONSHIP_PROFILE_HYDRATION_LIMIT = 6;
const NOTIFICATION_TARGET_LOOKUP_PAGES = 4;

type EconomicAction =
  | { kind: "share"; item: FeedItem }
  | { kind: "tombstone"; item: AuthoredPost };

export function WagyuApp({ service }: { service: WagyuService }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [view, setView] = useState<ViewId>("feed");
  const [loading, setLoading] = useState(true);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [verifyingNotificationIds, setVerifyingNotificationIds] = useState<Set<string>>(new Set());
  const [likingIds, setLikingIds] = useState<Set<string>>(new Set());
  const [optimisticLikeFloors, setOptimisticLikeFloors] =
    useState<ReadonlyMap<string, number>>(new Map());
  const [actionStages, setActionStages] = useState<Map<string, PublishStage>>(new Map());
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreAuthored, setLoadingMoreAuthored] = useState(false);
  const [loadingMoreNotifications, setLoadingMoreNotifications] =
    useState(false);
  const [loadingMoreRelationships, setLoadingMoreRelationships] =
    useState(false);
  const [relationshipBusy, setRelationshipBusy] =
    useState<RelationshipBusy | null>(null);
  const [relationshipError, setRelationshipError] =
    useState<string | null>(null);
  const [peerDeliveryBusy, setPeerDeliveryBusy] = useState(false);
  const [peerDeliveryError, setPeerDeliveryError] =
    useState<string | null>(null);
  const [
    hydratingRelationshipProfiles,
    setHydratingRelationshipProfiles,
  ] = useState<Set<string>>(new Set());
  const [
    visibleRelationshipProfiles,
    setVisibleRelationshipProfiles,
  ] = useState<Set<string>>(new Set());
  const [profileSaving, setProfileSaving] = useState(false);
  const [likesItem, setLikesItem] = useState<FeedItem | null>(null);
  const [likesDetail, setLikesDetail] = useState<LikesDetail | null>(null);
  const [likesLoading, setLikesLoading] = useState(false);
  const [likesError, setLikesError] = useState<string | null>(null);
  const [likesContinuing, setLikesContinuing] = useState(false);
  const [likesContinuationError, setLikesContinuationError] =
    useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [threadReplyDraft, setThreadReplyDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [threadItem, setThreadItem] = useState<FeedItem | null>(null);
  const [indexedThreadReplies, setIndexedThreadReplies] =
    useState<FeedItem[]>([]);
  const [threadRefreshNonce, setThreadRefreshNonce] = useState(0);
  const [replyCountRefreshNonce, setReplyCountRefreshNonce] = useState(0);
  const [profileTab, setProfileTab] =
    useState<"posts" | "replies">("posts");
  const [feedTimelineWindowStart, setFeedTimelineWindowStart] = useState(0);
  const [authoredTimelineWindowStart, setAuthoredTimelineWindowStart] =
    useState(0);
  const [
    notificationTimelineWindowStart,
    setNotificationTimelineWindowStart,
  ] = useState(0);
  const [selectedUserProfile, setSelectedUserProfile] =
    useState<WagyuProfile | null>(null);
  const [userProfileTab, setUserProfileTab] =
    useState<"posts" | "replies">("posts");
  const [userProfileLoading, setUserProfileLoading] = useState(false);
  const [userProfileError, setUserProfileError] = useState<string | null>(null);
  const [userProfileReturnView, setUserProfileReturnView] =
    useState<Exclude<ViewId, "user-profile">>("feed");
  const [economicAction, setEconomicAction] =
    useState<EconomicAction | null>(null);
  const snapshotLoadRef = useRef<Promise<void> | null>(null);
  const snapshotLoadPendingRef = useRef(false);
  const snapshotForegroundPendingRef = useRef(false);
  const feedRequestSequence = useRef(0);
  const authoredRequestSequence = useRef(0);
  const notificationRequestSequence = useRef(0);
  const notificationTargetRequestSequence = useRef(0);
  const relationshipRequestSequence = useRef(0);
  const feedLoadMoreRef = useRef(false);
  const authoredLoadMoreRef = useRef(false);
  const notificationLoadMoreRef = useRef(false);
  const relationshipOperationRef = useRef(false);
  const peerDeliveryOperationRef = useRef(false);
  const relationshipProfileRevisionRef = useRef<string | null>(null);
  const relationshipProfileEpochRef = useRef(0);
  const attemptedRelationshipProfiles = useRef<Set<string>>(new Set());
  const inflightRelationshipProfiles = useRef<Map<string, number>>(new Map());
  const markingReadRef = useRef(false);
  const likesRequestSequence = useRef(0);
  const likesContinuationSequence = useRef<number | null>(null);
  const verifyingFeedRef = useRef<Set<string>>(new Set());
  const automaticallyHydratedFeed = useRef<Set<string>>(new Set());
  const feedRetryControllerRef =
    useRef<FeedUnavailableRetryController | null>(null);
  const latestFeedItemsRef = useRef<Map<string, FeedItem>>(new Map());
  const latestNotificationsRef = useRef<readonly NotificationItem[]>([]);
  const componentMountedRef = useRef(false);
  const optimisticLikeFloorsRef =
    useRef<ReadonlyMap<string, number>>(optimisticLikeFloors);
  const verifyingNotificationRef = useRef<Set<string>>(new Set());
  const automaticallyHydratedNotifications = useRef<Set<string>>(new Set());
  const notificationRevisionRef = useRef<string | null>(null);
  const notificationProofProgressTailRef = useRef<Promise<void>>(
    Promise.resolve(),
  );
  const notificationProofProgressGenerationRef = useRef(0);
  const globalRefreshRef = useRef(false);
  const userProfileRequestSequence = useRef(0);
  const threadReplyRequestSequence = useRef(0);
  const replyCountRequestSequence = useRef(0);
  const withdrawalControllersRef =
    useRef<Map<string, AbortController>>(new Map());
  const automaticallyResumedWithdrawalsRef = useRef<Set<string>>(new Set());
  const residentClientRef = useRef<WagyuResidentClient | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  latestFeedItemsRef.current = new Map(
    snapshot?.feed.items.map((item) => [item.id, item]) ?? [],
  );
  latestNotificationsRef.current = snapshot?.notifications.items ?? [];
  optimisticLikeFloorsRef.current = optimisticLikeFloors;
  const unreadNotificationSignature =
    snapshot?.notifications.items
      .filter((item) => !item.read)
      .map((item) => item.localSequence)
      .join(",") ?? "";
  const navigationStateKey =
    view === "feed"
      ? threadItem
        ? `feed:post:${threadItem.author.nodeId}:${threadItem.postId}`
        : "feed"
      : view === "profile"
        ? `profile:${profileTab}`
        : view === "user-profile"
          ? `user:${selectedUserProfile?.nodeId ?? "loading"}:${userProfileTab}`
          : view;

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = scrollPositionsRef.current.get(navigationStateKey) ?? 0;
    return () => {
      scrollPositionsRef.current.set(navigationStateKey, main.scrollTop);
    };
  }, [navigationStateKey, snapshot !== null]);

  useEffect(() => {
    if (
      view !== "notifications" ||
      unreadNotificationSignature.length === 0 ||
      markingReadRef.current
    ) return;
    const unread = latestNotificationsRef.current
      .filter((item) => !item.read)
      .map((item) => item.localSequence);
    if (unread.length === 0) return;

    markingReadRef.current = true;
    const sequence = ++notificationRequestSequence.current;
    setActionError(null);
    void service.markNotificationsRead(unread).then(async () => {
      // Mark-read changes the notification revision. Drop the old
      // continuation before replacing the page from the authoritative query.
      setSnapshot((current) =>
        current
          ? {
              ...current,
              notifications: {
                ...current.notifications,
                nextCursor: null,
              },
            }
          : current
      );
      const [notificationsResult, residentResult] =
        await Promise.allSettled([
          service.loadNotifications(null),
          (residentClientRef.current ??= new WagyuResidentClient()).refresh(),
        ]);
      if (
        notificationsResult.status === "fulfilled" &&
        sequence === notificationRequestSequence.current
      ) {
        const notifications = notificationsResult.value;
        setSnapshot((current) =>
          current &&
          revisionAfter(
            notifications.revision,
            current.notifications.revision,
          )
            ? { ...current, notifications }
            : current
        );
      }
      if (residentResult.status === "fulfilled") {
        setSnapshot((current) =>
          current
            ? reconcileUnreadNotificationsFromResident(
                current,
                residentResult.value,
              )
            : current
        );
      }
      const refreshErrors: string[] = [];
      if (notificationsResult.status === "rejected") {
        refreshErrors.push(
          `the local page could not refresh: ${
            errorMessage(notificationsResult.reason)
          }`,
        );
      }
      if (
        residentResult.status === "rejected" ||
        !residentHasFreshStatus(residentResult.value)
      ) {
        refreshErrors.push("the unread badge could not refresh");
      }
      if (refreshErrors.length > 0) {
        setActionError(
          `Notifications were marked read, but ${
            refreshErrors.join(" and ")
          } and may be stale.`,
        );
      }
    }).catch((reason: unknown) => {
      setActionError(errorMessage(reason));
    }).finally(() => {
      markingReadRef.current = false;
    });
  }, [service, unreadNotificationSignature, view]);

  useEffect(() => {
    setThreadReplyDraft("");
  }, [threadItem?.id]);

  useEffect(() => {
    const sequence = ++threadReplyRequestSequence.current;
    if (!threadItem) {
      setIndexedThreadReplies([]);
      return;
    }
    if (
      threadItem.verification !== "verified" ||
      threadItem.kind === "tombstone"
    ) return;
    void service.loadThreadReplies(threadItem).then((replies) => {
      if (
        sequence !== threadReplyRequestSequence.current ||
        !componentMountedRef.current
      ) return;
      setIndexedThreadReplies((current) => {
        const merged = new Map(
          current.map((item) => [
            `${item.author.nodeId}:${item.postId}`,
            item,
          ]),
        );
        for (const reply of replies) {
          merged.set(`${reply.author.nodeId}:${reply.postId}`, reply);
        }
        return [...merged.values()];
      });
    }).catch((reason: unknown) => {
      if (
        sequence === threadReplyRequestSequence.current &&
        componentMountedRef.current
      ) {
        if (isMissingCertifiedReplyIndexError(reason)) {
          setIndexedThreadReplies([]);
          return;
        }
        setActionError(`Replies couldn't load: ${errorMessage(reason)}`);
      }
    });
  }, [service, threadItem, threadRefreshNonce]);

  useEffect(() => {
    if (
      !threadItem ||
      !snapshot?.status.networkConfigured ||
      threadItem.verification !== "verified" ||
      threadItem.kind === "tombstone"
    ) return;
    const timer = window.setInterval(
      () => setThreadRefreshNonce((current) => current + 1),
      ACTIVE_ENGAGEMENT_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [
    snapshot?.status.networkConfigured,
    threadItem?.author.nodeId,
    threadItem?.kind,
    threadItem?.postId,
    threadItem?.verification,
  ]);

  const navigate = useCallback((nextView: ViewId) => {
    userProfileRequestSequence.current += 1;
    setSelectedUserProfile(null);
    setThreadItem(null);
    setView(nextView);
  }, []);

  const openUserProfile = useCallback((author: FeedAuthor) => {
    if (author.nodeId === snapshot?.status.nodeId) {
      userProfileRequestSequence.current += 1;
      setSelectedUserProfile(null);
      setProfileTab("posts");
      setThreadItem(null);
      setView("profile");
      return;
    }
    const sequence = ++userProfileRequestSequence.current;
    if (view !== "user-profile") {
      setUserProfileReturnView(view);
    }
    setSelectedUserProfile(userProfileFallback(author));
    setUserProfileTab("posts");
    setUserProfileError(null);
    setRelationshipError(null);
    setUserProfileLoading(true);
    setView("user-profile");
    void service.loadUserProfile(author.nodeId)
      .then((profile) => {
        if (sequence !== userProfileRequestSequence.current) return;
        setSelectedUserProfile(presentationSafeUserProfile(profile));
        setUserProfileError(null);
      })
      .catch((reason: unknown) => {
        if (sequence !== userProfileRequestSequence.current) return;
        setUserProfileError(errorMessage(reason));
      })
      .finally(() => {
        if (sequence === userProfileRequestSequence.current) {
          setUserProfileLoading(false);
        }
      });
  }, [service, snapshot?.status.nodeId, view]);

  const wakeOutboundDelivery = useCallback(async (): Promise<boolean> => {
    try {
      residentClientRef.current ??= new WagyuResidentClient();
      await residentClientRef.current.wake();
      return true;
    } catch {
      // Every outbound action is already durable in the backend before this
      // best-effort wake. The resident and kernel schedulers remain the
      // bounded crash/reconnect recovery path.
      return false;
    }
  }, []);

  const load = useCallback((foreground = true): Promise<void> => {
    snapshotLoadPendingRef.current = true;
    snapshotForegroundPendingRef.current ||= foreground;
    if (foreground) setLoading(true);
    if (snapshotLoadRef.current !== null) return snapshotLoadRef.current;

    let task: Promise<void>;
    task = (async () => {
      do {
        snapshotLoadPendingRef.current = false;
        try {
          const next = await service.loadSnapshot();
          setSnapshot((current) =>
            current ? mergeSnapshot(current, next) : next
          );
          setLoadError(null);
        } catch (reason) {
          setLoadError(errorMessage(reason));
        }
      } while (snapshotLoadPendingRef.current);
    })().finally(() => {
      if (snapshotLoadRef.current === task) snapshotLoadRef.current = null;
      if (snapshotForegroundPendingRef.current) {
        snapshotForegroundPendingRef.current = false;
        setLoading(false);
      }
    });
    snapshotLoadRef.current = task;
    return task;
  }, [service]);

  const refreshAll = useCallback(async () => {
    if (globalRefreshRef.current) return;
    globalRefreshRef.current = true;
    setRefreshingAll(true);
    setActionError(null);
    attemptedRelationshipProfiles.current.clear();
    automaticallyHydratedFeed.current.clear();
    feedRetryControllerRef.current?.pauseAll();
    automaticallyHydratedNotifications.current.clear();
    try {
      await Promise.all([
        wakeOutboundDelivery(),
        load(false),
      ]);
      setThreadRefreshNonce((current) => current + 1);
      setReplyCountRefreshNonce((current) => current + 1);
    } finally {
      globalRefreshRef.current = false;
      setRefreshingAll(false);
    }
  }, [load, wakeOutboundDelivery]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    componentMountedRef.current = true;
    const controller = new FeedUnavailableRetryController();
    feedRetryControllerRef.current = controller;
    return () => {
      componentMountedRef.current = false;
      controller.dispose();
      for (const pending of withdrawalControllersRef.current.values()) {
        pending.abort();
      }
      withdrawalControllersRef.current.clear();
      if (feedRetryControllerRef.current === controller) {
        feedRetryControllerRef.current = null;
      }
    };
  }, []);

  const replyCountCandidateSignature =
    replyCountBatch(snapshot?.feed.items ?? [])
      .map(replyCountBinding)
      .sort()
      .join("|");

  useEffect(() => {
    if (!snapshot?.status.networkConfigured) return;
    const candidates = replyCountBatch(snapshot.feed.items);
    if (candidates.length === 0) return;
    const sequence = ++replyCountRequestSequence.current;
    const counts = new Map<string, number>();
    void forEachConcurrent(candidates, 4, async (item) => {
      try {
        counts.set(
          replyCountBinding(item),
          await service.loadThreadReplyCount(item),
        );
      } catch {
        return;
      }
    }).then(() => {
      if (
        sequence !== replyCountRequestSequence.current ||
        !componentMountedRef.current
      ) return;
      setSnapshot((current) => {
        if (!current) return current;
        let changed = false;
        const items = current.feed.items.map((candidate) => {
          const count = counts.get(replyCountBinding(candidate));
          if (
            count === undefined ||
            candidate.verifiedReplyCount === count
          ) return candidate;
          changed = true;
          return { ...candidate, verifiedReplyCount: count };
        });
        return changed
          ? { ...current, feed: { ...current.feed, items } }
          : current;
      });
      setThreadItem((current) =>
        current
          ? (() => {
              const count = counts.get(replyCountBinding(current));
              return count !== undefined &&
                  current.verifiedReplyCount !== count
                ? { ...current, verifiedReplyCount: count }
                : current;
            })()
          : current
      );
    });
  }, [
    replyCountCandidateSignature,
    replyCountRefreshNonce,
    service,
    snapshot?.status.networkConfigured,
  ]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    let pending = false;
    const refresh = async () => {
      if (refreshing) {
        pending = true;
        return;
      }
      do {
        pending = false;
        refreshing = true;
        await load(false);
        setReplyCountRefreshNonce((current) => current + 1);
        refreshing = false;
      } while (active && pending);
    };
    const subscriptions = Object.values(WAGYU_RESIDENT_TOPICS).map((topic) =>
      onAppStateChange(topic, () => {
        if (active) void refresh();
      })
    );
    return () => {
      active = false;
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updateFeedItem = useCallback((id: string, update: (item: FeedItem) => FeedItem) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            feed: {
              ...current.feed,
              items: current.feed.items.map((item) =>
                item.id === id ? update(item) : item,
              ),
            },
          }
        : current,
    );
  }, []);

  const removeFeedItem = useCallback((id: string) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            feed: {
              ...current.feed,
              items: current.feed.items.filter((item) => item.id !== id),
            },
          }
        : current,
    );
  }, []);

  const updateNotification = useCallback((
    id: string,
    update: (item: NotificationItem) => NotificationItem,
  ) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            notifications: {
              ...current.notifications,
              items: current.notifications.items.map((item) =>
                item.id === id ? update(item) : item,
              ),
            },
          }
        : current,
    );
  }, []);

  const setActionStage = useCallback((
    key: string,
    stage: PublishStage | null,
  ) => {
    setActionStages((current) => {
      const next = new Map(current);
      if (stage) next.set(key, stage);
      else next.delete(key);
      return next;
    });
  }, []);

  const verify = useCallback(async (
    item: FeedItem,
    signal?: AbortSignal,
  ): Promise<FeedItem["verification"] | null> => {
    if (signal?.aborted) return null;
    feedRetryControllerRef.current?.beginNow(item.id);
    if (verifyingFeedRef.current.has(item.id)) return null;
    verifyingFeedRef.current.add(item.id);
    setVerifyingIds((current) => new Set(current).add(item.id));
    setActionError(null);
    updateFeedItem(item.id, (current) => ({
      ...current,
      verification: "fetching",
      verificationIssue: null,
    }));
    try {
      const verified = await service.hydrateCandidate(item, signal);
      if (signal?.aborted || !componentMountedRef.current) return null;
      if (
        verified.verification === "invalid" ||
        verified.verification === "unsupported"
      ) {
        removeFeedItem(item.id);
        return verified.verification;
      }
      updateFeedItem(item.id, () => verified);
      if (
        verified.promotion === "committed" &&
        item.promotion !== "committed"
      ) {
        try {
          const feed = await service.loadFeed(null);
          if (signal?.aborted || !componentMountedRef.current) return null;
          setSnapshot((current) =>
            current && revisionAfter(feed.revision, current.feed.revision)
              ? {
                  ...current,
                  feed: mergeFeedPageHydration(current.feed, feed),
                }
              : current,
          );
        } catch (reason) {
          if (!signal?.aborted && componentMountedRef.current) {
            setActionError(
              `The post loaded, but your feed could not refresh: ${errorMessage(reason)}`,
            );
          }
        }
      }
      return verified.verification;
    } catch (reason) {
      if (signal?.aborted || !componentMountedRef.current) return null;
      const issue = verificationIssueFromError(reason);
      const verification = verificationStateForIssue(issue);
      updateFeedItem(item.id, (current) => ({
        ...current,
        verification,
        verificationIssue: issue,
      }));
      setActionError(
        verificationIssueCopy(issue) ??
          "This post couldn't be loaded.",
      );
      return verification;
    } finally {
      verifyingFeedRef.current.delete(item.id);
      if (componentMountedRef.current) {
        setVerifyingIds((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    }
  }, [removeFeedItem, service, updateFeedItem]);

  const feedCandidateSignature =
    snapshot?.feed.items
      .filter((item) => item.verification === "candidate")
      .map((item) => item.id)
      .join("|") ?? "";

  useEffect(() => {
    if (!snapshot?.status.networkConfigured || refreshingAll) return;
    const available = Math.max(0, 6 - verifyingFeedRef.current.size);
    const visibleUnknown = snapshot.feed.items
      .filter(
        (item) =>
          item.verification === "candidate" &&
          !verifyingFeedRef.current.has(item.id) &&
          !automaticallyHydratedFeed.current.has(item.id),
      )
      .slice(0, available);
    for (const item of visibleUnknown) {
      automaticallyHydratedFeed.current.add(item.id);
      void verify(item);
    }
    // A feed revision is a bounded local snapshot. Each candidate is attempted
    // immediately once when that page becomes visible. Transient unavailable
    // results move to the separate bounded backoff controller below.
  }, [
    feedCandidateSignature,
    refreshingAll,
    snapshot?.feed.revision,
    snapshot?.status.networkConfigured,
    verify,
    verifyingIds,
  ]);

  const feedRetrySignature =
    snapshot?.feed.items
      .map((item) => `${item.id}:${item.verification}`)
      .join("|") ?? "";

  useEffect(() => {
    const controller = feedRetryControllerRef.current;
    if (!controller) return;
    if (!snapshot?.status.networkConfigured || refreshingAll) {
      controller.pauseAll();
      return;
    }
    controller.observe(snapshot.feed.items, async (id, signal) => {
      const item = latestFeedItemsRef.current.get(id);
      if (
        !item ||
        (
          item.verification !== "unavailable" &&
          item.verification !== "candidate"
        )
      ) {
        return false;
      }
      return (await verify(item, signal)) === "unavailable";
    });
  }, [
    feedRetrySignature,
    refreshingAll,
    snapshot?.status.networkConfigured,
    verify,
  ]);

  const verifyNotification = useCallback(async (
    item: NotificationItem,
    automatic = false,
    signal?: AbortSignal,
    rememberAutomaticAttempt = automatic,
  ) => {
    if (signal?.aborted) return;
    if (verifyingNotificationRef.current.has(item.id)) return;
    if (rememberAutomaticAttempt) {
      if (automaticallyHydratedNotifications.current.has(item.id)) return;
      automaticallyHydratedNotifications.current.add(item.id);
    }
    verifyingNotificationRef.current.add(item.id);
    setVerifyingNotificationIds((current) => new Set(current).add(item.id));
    if (!automatic) setActionError(null);
    try {
      const verified = await service.hydrateNotification(item);
      if (signal?.aborted || !componentMountedRef.current) return;
      updateNotification(item.id, () => verified);
    } catch (reason) {
      if (signal?.aborted || !componentMountedRef.current) return;
      const eventAlreadyAuthenticated =
        item.verification === "verified" ||
        item.verification === "transport-authenticated";
      updateNotification(item.id, (current) => ({
        ...current,
        verification: eventAlreadyAuthenticated
          ? current.verification
          : "unavailable",
        actorDisplayName: null,
        actorAvatarUrl: null,
        actorProfileProof: eventAlreadyAuthenticated
          ? "unavailable"
          : current.actorProfileProof,
      }));
      if (!automatic) setActionError(errorMessage(reason));
    } finally {
      verifyingNotificationRef.current.delete(item.id);
      if (componentMountedRef.current) {
        setVerifyingNotificationIds((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    }
  }, [service, updateNotification]);

  const pendingNotificationSignature =
    snapshot?.notifications.items
      .filter(notificationNeedsAutomaticHydration)
      .map((item) => item.id)
      .join("|") ?? "";
  const pendingNotificationEvidenceSignature =
    snapshot?.notifications.items
      .filter(notificationEvidenceNeedsAutomaticHydration)
      .map((item) => item.id)
      .join("|") ?? "";

  useEffect(() => {
    const revision = snapshot?.notifications.revision ?? null;
    if (notificationRevisionRef.current === revision) return;
    notificationRevisionRef.current = revision;
    automaticallyHydratedNotifications.current.clear();
  }, [snapshot?.notifications.revision]);

  useEffect(() => {
    if (
      !snapshot?.status.networkConfigured
    ) return;
    const available = Math.max(
      0,
      8 - verifyingNotificationRef.current.size,
    );
    const visibleUnknown = snapshot.notifications.items
      .filter(
        (item) =>
          (
            notificationEvidenceNeedsAutomaticHydration(item) ||
            (
              (view === "notifications" ||
                (view === "feed" && item.kind === "reply")) &&
              notificationNeedsAutomaticHydration(item)
            )
          ) &&
          !verifyingNotificationRef.current.has(item.id) &&
          !automaticallyHydratedNotifications.current.has(item.id) &&
          notificationNeedsAutomaticHydration(item),
      )
      .slice(0, available);
    for (const item of visibleUnknown) void verifyNotification(item, true);
  }, [
    pendingNotificationSignature,
    snapshot?.notifications.revision,
    snapshot?.status.networkConfigured,
    verifyNotification,
    verifyingNotificationIds,
    view,
  ]);

  useEffect(() => {
    const generation = ++notificationProofProgressGenerationRef.current;
    const controller = new AbortController();
    const cursor = snapshot?.notifications.nextCursor ?? null;
    if (
      !cursor ||
      !snapshot?.status.networkConfigured ||
      refreshingAll ||
      pendingNotificationEvidenceSignature.length > 0
    ) {
      return () => controller.abort();
    }

    const run = notificationProofProgressTailRef.current
      .catch(() => undefined)
      .then(async () => {
        if (
          controller.signal.aborted ||
          generation !== notificationProofProgressGenerationRef.current
        ) return;
        await progressOlderNotificationProofs({
          initialCursor: cursor,
          signal: controller.signal,
          loadPage: (nextCursor) =>
            service.loadNotifications(nextCursor),
          hydrate: (item, signal) =>
            verifyNotification(item, true, signal, false),
        });
      })
      .catch(() => undefined);
    notificationProofProgressTailRef.current = run;
    return () => controller.abort();
  }, [
    pendingNotificationEvidenceSignature,
    refreshingAll,
    service,
    snapshot?.notifications.nextCursor,
    snapshot?.notifications.revision,
    snapshot?.status.networkConfigured,
    verifyNotification,
  ]);

  const hydrateRelationshipProfile = useCallback(async (
    relationship: Relationship,
    revision: string,
    epoch: number,
  ) => {
    if (inflightRelationshipProfiles.current.has(relationship.nodeId)) return;
    inflightRelationshipProfiles.current.set(relationship.nodeId, epoch);
    setHydratingRelationshipProfiles((current) =>
      new Set(current).add(relationship.nodeId)
    );
    try {
      const hydrated = await service.hydrateRelationshipProfile(relationship);
      if (hydrated.nodeId !== relationship.nodeId) {
        throw new Error(
          "Certified profile loader returned another relationship Node ID",
        );
      }
      if (epoch !== relationshipProfileEpochRef.current) return;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              relationships: applyRelationshipProfileHydration(
                current.relationships,
                revision,
                relationship.nodeId,
                {
                  displayName: hydrated.displayName,
                  avatarUrl: hydrated.avatarUrl,
                  profileProof: hydrated.profileProof,
                },
              ),
            }
          : current
      );
    } catch {
      if (epoch !== relationshipProfileEpochRef.current) return;
      // Profile presentation is independent of the authoritative relationship
      // row. A fetch/proof failure hides only that row's optional profile.
      setSnapshot((current) =>
        current
          ? {
              ...current,
              relationships: markRelationshipProfileUnavailable(
                current.relationships,
                revision,
                relationship.nodeId,
              ),
            }
          : current
      );
    } finally {
      let released = false;
      if (
        inflightRelationshipProfiles.current.get(relationship.nodeId) ===
          epoch
      ) {
        inflightRelationshipProfiles.current.delete(relationship.nodeId);
        released = true;
      }
      if (released) {
        setHydratingRelationshipProfiles((current) => {
          const next = new Set(current);
          next.delete(relationship.nodeId);
          return next;
        });
      }
    }
  }, [service]);

  const relationshipProfileSignature =
    snapshot?.relationships.items
      .map((item) => `${item.nodeId}:${item.profileProof}`)
      .join("|") ?? "";

  useEffect(() => {
    const revision = snapshot?.relationships.revision ?? null;
    if (relationshipProfileRevisionRef.current === revision) return;
    relationshipProfileRevisionRef.current = revision;
    relationshipProfileEpochRef.current += 1;
    attemptedRelationshipProfiles.current.clear();
    setHydratingRelationshipProfiles(new Set());
  }, [snapshot?.relationships.revision]);

  useEffect(() => {
    if (
      view !== "relationships" ||
      !snapshot?.status.networkConfigured
    ) {
      return;
    }
    const available = Math.max(
      0,
      RELATIONSHIP_PROFILE_HYDRATION_LIMIT -
        inflightRelationshipProfiles.current.size,
    );
    const revision = snapshot.relationships.revision;
    const epoch = relationshipProfileEpochRef.current;
    const candidates = snapshot.relationships.items
      .filter(
        (relationship) =>
          visibleRelationshipProfiles.has(relationship.nodeId) &&
          relationship.profileProof !== "fresh" &&
          relationship.profileProof !== "stale" &&
          !attemptedRelationshipProfiles.current.has(relationship.nodeId) &&
          !inflightRelationshipProfiles.current.has(relationship.nodeId),
      )
      .slice(0, available);
    for (const relationship of candidates) {
      attemptedRelationshipProfiles.current.add(relationship.nodeId);
      void hydrateRelationshipProfile(relationship, revision, epoch);
    }
  }, [
    hydrateRelationshipProfile,
    hydratingRelationshipProfiles,
    relationshipProfileSignature,
    snapshot?.relationships.revision,
    snapshot?.status.networkConfigured,
    visibleRelationshipProfiles,
    view,
  ]);

  const markRelationshipProfileVisible = useCallback(
    (relationship: Relationship) => {
      if (
        relationship.profileProof === "fresh" ||
        relationship.profileProof === "stale"
      ) return;
      setVisibleRelationshipProfiles((current) => {
        if (current.has(relationship.nodeId)) return current;
        const next = new Set(current);
        next.add(relationship.nodeId);
        return next;
      });
    },
    [],
  );

  const like = useCallback(async (item: FeedItem) => {
    if (!snapshot?.status.peerDeliveryEnabled) {
      setActionError(
        "Enable peer delivery before liking another user's post.",
      );
      return;
    }
    const engagementKey = activeEngagementKey(item);
    const previousOptimisticFloor =
      optimisticLikeFloorsRef.current.get(engagementKey);
    const optimisticFloor =
      previousOptimisticFloor ??
        item.likeSummary.verified + 1;
    if (previousOptimisticFloor === undefined) {
      const next = new Map(optimisticLikeFloorsRef.current);
      next.set(engagementKey, optimisticFloor);
      optimisticLikeFloorsRef.current = next;
      setOptimisticLikeFloors(next);
    }
    const rollbackOptimisticLike = () => {
      if (
        previousOptimisticFloor !== undefined ||
        optimisticLikeFloorsRef.current.get(engagementKey) !==
          optimisticFloor
      ) return;
      const next = new Map(optimisticLikeFloorsRef.current);
      next.delete(engagementKey);
      optimisticLikeFloorsRef.current = next;
      setOptimisticLikeFloors(next);
    };
    setLikingIds((current) => new Set(current).add(item.id));
    setActionError(null);
    try {
      const result = await service.like(item);
      if (!publishStageIsDurableHandoff(result.stage)) {
        rollbackOptimisticLike();
        setActionError(
          "The like couldn't be sent. Try again.",
        );
        return;
      }
      updateFeedItem(item.id, (current) => ({
        ...current,
        likedByOwner: true,
      }));
      void wakeOutboundDelivery();
      setNotice("Liked.");
    } catch (reason) {
      rollbackOptimisticLike();
      setActionError(errorMessage(reason));
    } finally {
      setLikingIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }, [
    service,
    snapshot?.status.peerDeliveryEnabled,
    updateFeedItem,
    wakeOutboundDelivery,
  ]);

  const openLikes = useCallback(async (item: FeedItem) => {
    const localPost = snapshot?.authored.items.find(
      (authored): authored is AuthoredPost =>
        authored.kind === "post" && authored.postId === item.postId,
    );
    const localLikeView = localPost?.localLikeView ?? null;
    const displayedItem = localLikeView
      ? {
          ...item,
          localOrigin: true,
          likeSummary: {
            ...item.likeSummary,
            awaitingBatch: localLikeView.unsealedReceiptCount,
          },
        }
      : item;
    const sequence = ++likesRequestSequence.current;
    setLikesItem(displayedItem);
    setLikesDetail(null);
    setLikesError(null);
    setLikesContinuationError(null);
    setLikesContinuing(false);
    setLikesLoading(true);
    try {
      const detail = withLocalAwaitingLikes(
        await service.loadLikes(displayedItem),
        displayedItem,
        latestNotificationsRef.current,
        localLikeView?.unsealedLikerIds,
      );
      if (sequence === likesRequestSequence.current) {
        setLikesDetail(detail);
      }
    } catch (reason) {
      if (sequence === likesRequestSequence.current) {
        setLikesError(errorMessage(reason));
      }
    } finally {
      if (sequence === likesRequestSequence.current) {
        setLikesLoading(false);
      }
    }
  }, [service, snapshot?.authored.items]);

  const openAuthoredLikes = useCallback((item: AuthoredPost) => {
    const postBodyHash = item.localLikeView?.postBodyHash;
    if (!snapshot || !postBodyHash) {
      setActionError("This authored post is missing its local Like-head identity.");
      return;
    }
    void openLikes({
      id: `authored:${item.postId}`,
      localSequence: item.sequence,
      receivedAt: item.createdAt ?? new Date(0).toISOString(),
      immediateSender: snapshot.status.nodeId,
      kind: "original",
      verification: "verified",
      promotion: "committed",
      author: {
        nodeId: snapshot.status.nodeId,
        displayName: snapshot.profile.displayName,
        avatarUrl: snapshot.profile.avatarUrl,
        profileProof: snapshot.profile.proofState,
      },
      postId: item.postId,
      body: item.bodyMarkdown ?? null,
      bodyDigest: postBodyHash,
      objectDigest: item.objectDigest,
      bodyLength: item.bodyMarkdown
        ? new TextEncoder().encode(item.bodyMarkdown).byteLength
        : null,
      createdAt: item.createdAt,
      sharedBy: null,
      replyTo: item.replyTo
        ? {
            authorNodeId: item.replyTo.authorNodeId,
            author: null,
            postId: item.replyTo.postId,
            body: null,
            verified: true,
          }
        : null,
      likedByOwner: false,
      likeSummary: {
        verified: 0,
        invalid: 0,
        unavailable: 0,
        awaitingBatch: item.localLikeView?.unsealedReceiptCount ?? 0,
      },
      localOrigin: true,
      opaqueEventBytes: null,
      originalPostRefBytes: null,
    });
  }, [openLikes, snapshot]);

  const loadOlderLikes = useCallback(async () => {
    const current = likesDetail;
    const loadOlder = current?.loadOlder;
    const sequence = likesRequestSequence.current;
    if (!current || !loadOlder || likesContinuationSequence.current === sequence) {
      return;
    }
    likesContinuationSequence.current = sequence;
    setLikesContinuing(true);
    setLikesContinuationError(null);
    try {
      const older = await loadOlder();
      if (sequence !== likesRequestSequence.current) return;
      const merged = appendLikesPage(current, older);
      setLikesDetail((latest) => latest === current ? merged : latest);
    } catch (reason) {
      if (sequence === likesRequestSequence.current) {
        setLikesContinuationError(errorMessage(reason));
      }
    } finally {
      if (likesContinuationSequence.current === sequence) {
        likesContinuationSequence.current = null;
      }
      if (sequence === likesRequestSequence.current) {
        setLikesContinuing(false);
      }
    }
  }, [likesDetail]);

  const closeLikes = useCallback(() => {
    likesRequestSequence.current += 1;
    likesContinuationSequence.current = null;
    setLikesItem(null);
    setLikesDetail(null);
    setLikesError(null);
    setLikesContinuationError(null);
    setLikesContinuing(false);
  }, []);

  const runShare = useCallback(async (item: FeedItem) => {
    if (!snapshot?.status.peerDeliveryEnabled) {
      setActionError(
        "Enable peer delivery before sharing a post.",
      );
      return;
    }
    const key = `share:${item.id}`;
    setActionError(null);
    try {
      await service.share(
        item,
        (stage) => setActionStage(key, stage),
      );
      void wakeOutboundDelivery();
      setNotice("Post shared.");
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionStage(key, null);
    }
  }, [
    service,
    setActionStage,
    snapshot?.status.peerDeliveryEnabled,
    wakeOutboundDelivery,
  ]);

  const refreshAuthored = useCallback(async () => {
    const sequence = ++authoredRequestSequence.current;
    try {
      const authored = await service.loadAuthored(null);
      if (sequence !== authoredRequestSequence.current) return;
      setSnapshot((current) =>
        current && revisionAfter(authored.revision, current.authored.revision)
          ? { ...current, authored }
          : current
      );
    } catch (reason) {
      if (sequence === authoredRequestSequence.current) throw reason;
    }
  }, [service]);

  const resumeAuthoredPost = useCallback(async (item: AuthoredPost) => {
    if (!snapshot?.status.peerDeliveryEnabled) {
      setActionError(
        "Enable peer delivery before finalizing this outbound post.",
      );
      return;
    }
    const key = `resume:${item.postId}`;
    setActionError(null);
    try {
      await service.resumeAuthoredPost(
        item,
        (stage) => setActionStage(key, stage),
      );
      void wakeOutboundDelivery();
      setNotice("Post sent.");
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionStage(key, null);
      void refreshAuthored().catch((reason: unknown) =>
        setActionError(errorMessage(reason)),
      );
    }
  }, [
    refreshAuthored,
    service,
    setActionStage,
    snapshot?.status.peerDeliveryEnabled,
    wakeOutboundDelivery,
  ]);

  const resumeAuthoredAction = useCallback(async (item: AuthoredItem) => {
    if (
      item.kind !== "tombstone" &&
      !snapshot?.status.peerDeliveryEnabled
    ) {
      setActionError(
        "Enable peer delivery before finalizing this outbound action.",
      );
      return;
    }
    const key = `resume:${item.kind}:${item.actionId}`;
    setActionError(null);
    try {
      await service.resumeAuthoredAction(
        item,
        (stage) => setActionStage(key, stage),
      );
      void wakeOutboundDelivery();
      setNotice(
        item.kind === "share"
          ? "Post shared."
          : item.kind === "like"
            ? "Liked."
            : item.kind === "tombstone"
              ? "Post deleted."
              : "Post sent.",
      );
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionStage(key, null);
      void refreshAuthored().catch((reason: unknown) =>
        setActionError(errorMessage(reason)),
      );
    }
  }, [
    refreshAuthored,
    service,
    setActionStage,
    snapshot?.status.peerDeliveryEnabled,
    wakeOutboundDelivery,
  ]);

  const runWithdrawal = useCallback(async (
    item: AuthoredPost,
    advanceOnly: boolean,
  ) => {
    const key = `withdraw:${item.postId}`;
    if (withdrawalControllersRef.current.has(item.postId)) return;
    const controller = new AbortController();
    withdrawalControllersRef.current.set(item.postId, controller);
    setActionError(null);
    try {
      const operation = advanceOnly
        ? service.advanceWithdrawal.bind(service)
        : service.withdrawPost.bind(service);
      await operation(
        item,
        (stage) => {
          if (
            !controller.signal.aborted &&
            componentMountedRef.current
          ) setActionStage(key, stage);
        },
        controller.signal,
      );
      void wakeOutboundDelivery();
      setNotice("Post deleted.");
    } catch (reason) {
      if (!controller.signal.aborted) {
        setActionError(errorMessage(reason));
      }
    } finally {
      if (
        withdrawalControllersRef.current.get(item.postId) === controller
      ) {
        withdrawalControllersRef.current.delete(item.postId);
        if (componentMountedRef.current) {
          setActionStage(key, null);
          void refreshAuthored().catch((reason: unknown) =>
            setActionError(errorMessage(reason)),
          );
        }
      }
    }
  }, [refreshAuthored, service, setActionStage, wakeOutboundDelivery]);

  useEffect(() => {
    const unfinished = closingWithdrawalPosts(
      snapshot?.authored.items ?? [],
    );
    const visible = new Set(unfinished.map((item) => item.postId));
    for (const postId of automaticallyResumedWithdrawalsRef.current) {
      if (!visible.has(postId)) {
        automaticallyResumedWithdrawalsRef.current.delete(postId);
      }
    }
    for (const item of unfinished) {
      if (automaticallyResumedWithdrawalsRef.current.has(item.postId)) {
        continue;
      }
      automaticallyResumedWithdrawalsRef.current.add(item.postId);
      void runWithdrawal(item, true);
    }
  }, [runWithdrawal, snapshot?.authored.items]);

  if (loading && !snapshot) return <LoadingScreen />;
  if (!snapshot) {
    const integrityFailure = isInstallationIntegrityFailure(loadError);
    return (
      <ErrorScreen
        error={loadError ?? "Wagyu did not return a local snapshot."}
        onRetry={() => void load()}
        showPreviewHint={!integrityFailure}
        {...(integrityFailure
          ? {
              eyebrow: "Provisioning required",
              retryLabel: "Retry after reinstall",
              title: "Wagyu installation integrity failed",
            }
          : {})}
      />
    );
  }
  const networkMismatch =
    snapshot.status.networkConfigured &&
    snapshot.status.configuredNetworkId !== snapshot.trustedNetwork.networkId;
  if (!snapshot.status.networkConfigured || networkMismatch) {
    return (
      <ErrorScreen
        error={
          networkMismatch
            ? "The installer-seeded backend network ID does not match the trusted runtime. Wagyu will not override either identity. Reinstall this app with the trusted provisioning system before continuing."
            : "This Wagyu backend was installed without its network identity. The UI cannot create or repair installer-owned configuration. Reinstall this app with the trusted provisioning system before continuing."
        }
        eyebrow="Provisioning required"
        onRetry={() => void load()}
        retryLabel="Retry after reinstall"
        showPreviewHint={false}
        title="Wagyu installation integrity failed"
      />
    );
  }

  const enablePeerDelivery = async (): Promise<void> => {
    if (
      peerDeliveryOperationRef.current ||
      snapshot.status.peerDeliveryEnabled
    ) {
      return;
    }
    peerDeliveryOperationRef.current = true;
    setPeerDeliveryBusy(true);
    setPeerDeliveryError(null);
    try {
      const status = await service.enablePeerDelivery();
      if (!status.peerDeliveryEnabled) {
        throw new Error(
          "Peer delivery permission was not present after approval.",
        );
      }
      if (
        !status.networkConfigured ||
        status.configuredNetworkId !== snapshot.trustedNetwork.networkId
      ) {
        throw new Error(
          "Wagyu installation integrity failed after peer delivery approval.",
        );
      }
      // Finish any older snapshot request before committing the returned
      // permission state, so a pre-approval response cannot restore the gate.
      await load(false);
      setSnapshot((current) =>
        current ? { ...current, status } : current
      );
      setNotice("Peer delivery enabled.");
    } catch (reason) {
      setPeerDeliveryError(errorMessage(reason));
    } finally {
      peerDeliveryOperationRef.current = false;
      setPeerDeliveryBusy(false);
    }
  };

  const blockedNodeIds = new Set(
    snapshot.relationships.items
      .filter((relationship) => relationship.blocked)
      .map((relationship) => relationship.nodeId),
  );
  const visibleNotifications = {
    ...snapshot.notifications,
    items: snapshot.notifications.items.filter(
      (item) => !blockedNodeIds.has(item.actorNodeId),
    ),
  };
  const visibleIndexedThreadReplies = indexedThreadReplies.filter(
    (item) =>
      !blockedNodeIds.has(item.author.nodeId) &&
      !blockedNodeIds.has(item.immediateSender),
  );
  const visibleLikesDetail = filterBlockedLikes(likesDetail, blockedNodeIds);
  const visibleLikesItem = likesItem && visibleLikesDetail
    ? {
        ...likesItem,
        likeSummary: {
          ...likesItem.likeSummary,
          awaitingBatch: visibleLikesDetail.awaitingBatch.length,
        },
      }
    : likesItem;

  const refreshFeed = async () => {
    const feedSequence = ++feedRequestSequence.current;
    const authoredSequence = ++authoredRequestSequence.current;
    setActionError(null);
    const [feedResult, authoredResult] = await Promise.allSettled([
      service.loadFeed(null),
      service.loadAuthored(null),
    ]);
    if (
      feedResult.status === "fulfilled" &&
      feedSequence === feedRequestSequence.current
    ) {
      setSnapshot((current) =>
        current &&
        revisionAfter(feedResult.value.revision, current.feed.revision)
          ? { ...current, feed: feedResult.value }
          : current
      );
    }
    if (
      authoredResult.status === "fulfilled" &&
      authoredSequence === authoredRequestSequence.current
    ) {
      setSnapshot((current) =>
        current &&
        revisionAfter(
          authoredResult.value.revision,
          current.authored.revision,
        )
          ? { ...current, authored: authoredResult.value }
          : current
      );
    }
    const failures: string[] = [];
    if (
      feedResult.status === "rejected" &&
      feedSequence === feedRequestSequence.current
    ) {
      failures.push(errorMessage(feedResult.reason));
    }
    if (
      authoredResult.status === "rejected" &&
      authoredSequence === authoredRequestSequence.current
    ) {
      failures.push(errorMessage(authoredResult.reason));
    }
    if (failures.length > 0) {
      setActionError(failures.join(" · "));
    }
  };
  const loadMoreFeed = async () => {
    const cursor = snapshot.feed.nextCursor;
    if (!cursor || feedLoadMoreRef.current) return;
    const sequence = feedRequestSequence.current;
    feedLoadMoreRef.current = true;
    setLoadingMore(true);
    try {
      const older = await service.loadFeed(cursor);
      if (sequence !== feedRequestSequence.current) return;
      setSnapshot((current) =>
        current &&
        current.feed.revision === snapshot.feed.revision &&
        current.feed.nextCursor === cursor
          ? {
              ...current,
              feed: appendFeedPage(current.feed, older, cursor),
            }
          : current,
      );
    } catch (reason) {
      if (sequence === feedRequestSequence.current) {
        setActionError(errorMessage(reason));
      }
    } finally {
      feedLoadMoreRef.current = false;
      setLoadingMore(false);
    }
  };
  const loadMoreAuthoredPage = async () => {
    const cursor = snapshot.authored.nextCursor;
    if (!cursor || authoredLoadMoreRef.current) return;
    const sequence = authoredRequestSequence.current;
    authoredLoadMoreRef.current = true;
    setLoadingMoreAuthored(true);
    try {
      const older = await service.loadAuthored(cursor);
      if (sequence !== authoredRequestSequence.current) return;
      setSnapshot((current) =>
        current &&
        current.authored.revision === snapshot.authored.revision &&
        current.authored.nextCursor === cursor
          ? {
              ...current,
              authored: appendAuthoredPage(
                current.authored,
                older,
                cursor,
              ),
            }
          : current,
      );
    } catch (reason) {
      if (sequence === authoredRequestSequence.current) {
        setActionError(errorMessage(reason));
      }
    } finally {
      authoredLoadMoreRef.current = false;
      setLoadingMoreAuthored(false);
    }
  };
  const loadMoreNotificationsPage = async () => {
    const cursor = snapshot.notifications.nextCursor;
    if (!cursor || notificationLoadMoreRef.current) return;
    const sequence = notificationRequestSequence.current;
    notificationLoadMoreRef.current = true;
    setLoadingMoreNotifications(true);
    try {
      const older = await service.loadNotifications(cursor);
      if (sequence !== notificationRequestSequence.current) return;
      setSnapshot((current) =>
        current &&
        current.notifications.revision === snapshot.notifications.revision &&
        current.notifications.nextCursor === cursor
          ? {
              ...current,
              notifications: appendNotificationPage(
                current.notifications,
                older,
                cursor,
              ),
            }
          : current,
      );
    } catch (reason) {
      if (sequence === notificationRequestSequence.current) {
        setActionError(errorMessage(reason));
      }
    } finally {
      notificationLoadMoreRef.current = false;
      setLoadingMoreNotifications(false);
    }
  };
  const loadMoreRelationshipsPage = async () => {
    const cursor = snapshot.relationships.nextCursor;
    if (!cursor || relationshipOperationRef.current) return;
    relationshipOperationRef.current = true;
    const sequence = relationshipRequestSequence.current;
    const currentPage = snapshot.relationships;
    setRelationshipError(null);
    setLoadingMoreRelationships(true);
    try {
      const older = await service.loadRelationships(
        cursor,
        currentPage.revision,
      );
      if (sequence !== relationshipRequestSequence.current) return;
      const relationships = appendRelationshipPage(
        currentPage,
        older,
        cursor,
      );
      setSnapshot((current) =>
        current &&
        current.relationships.revision === currentPage.revision &&
        current.relationships.nextCursor === cursor
          ? {
              ...current,
              relationships,
            }
          : current,
      );
    } catch (reason) {
      setRelationshipError(errorMessage(reason));
    } finally {
      relationshipOperationRef.current = false;
      setLoadingMoreRelationships(false);
    }
  };

  const runRelationshipMutation = async (
    nodeId: string,
    action: RelationshipAction,
    operation: () => Promise<unknown>,
    successMessage: string,
  ): Promise<void> => {
    if (relationshipOperationRef.current) {
      const reason = new Error(
        "Another relationship action is still running. Wait for it to finish.",
      );
      setRelationshipError(reason.message);
      throw reason;
    }
    relationshipOperationRef.current = true;
    const sequence = ++relationshipRequestSequence.current;
    setRelationshipBusy({ nodeId, action });
    setRelationshipError(null);
    try {
      await operation();
      // Following is durable once the local row/outbox mutation succeeds.
      // Let the resident finish the remote call without holding the UI open;
      // its revision topic refreshes the relationship when it becomes active.
      void wakeOutboundDelivery();
      // The successful mutation advances the relationship revision. Never use
      // its old cursor, and never invent what an unblock/unfollow row now is.
      setSnapshot((current) =>
        current
          ? {
              ...current,
              relationships: invalidateRelationshipContinuation(
                current.relationships,
              ),
            }
          : current
      );
      try {
        const relationships = await service.loadRelationships(null);
        if (sequence === relationshipRequestSequence.current) {
          setSnapshot((current) =>
            current &&
            revisionAfter(
              relationships.revision,
              current.relationships.revision,
            )
              ? { ...current, relationships }
              : current
          );
        }
      } catch (reason) {
        setRelationshipError(
          `${successMessage} The local relationship page could not refresh, so its displayed rows may be stale: ${errorMessage(reason)}`,
        );
      }
      setNotice(successMessage);
    } catch (reason) {
      setRelationshipError(errorMessage(reason));
      throw reason;
    } finally {
      relationshipOperationRef.current = false;
      setRelationshipBusy(null);
    }
  };

  const followRelationship = async (nodeId: string): Promise<void> => {
    if (!snapshot.status.peerDeliveryEnabled) {
      const reason = new Error(
        "Enable peer delivery before following a user.",
      );
      setRelationshipError(reason.message);
      throw reason;
    }
    const current = snapshot.relationships.items.find(
      (item) => item.nodeId === nodeId,
    );
    if (current?.blocked) {
      const reason = new Error("Unblock this user before following them.");
      setRelationshipError(reason.message);
      throw reason;
    }
    if (current && !current.compatible) {
      const reason = new Error(
        "This user cannot connect to this version of Wagyu.",
      );
      setRelationshipError(reason.message);
      throw reason;
    }
    const renewing = current?.youFollow === true;
    await runRelationshipMutation(
      nodeId,
      renewing ? "renew" : "follow",
      () => service.follow(nodeId),
      renewing
        ? `Reconnecting with ${shortenNodeId(nodeId)}…`
        : `Following ${shortenNodeId(nodeId)}.`,
    );
  };

  const unfollowRelationship = (nodeId: string): Promise<void> =>
    runRelationshipMutation(
      nodeId,
      "unfollow",
      () => service.unfollow(nodeId),
      `You unfollowed ${shortenNodeId(nodeId)}.`,
    );

  const setRelationshipBlocked = (
    nodeId: string,
    blocked: boolean,
  ): Promise<void> =>
    runRelationshipMutation(
      nodeId,
      blocked ? "block" : "unblock",
      () => service.setBlocked(nodeId, blocked),
      blocked
        ? `${shortenNodeId(nodeId)} is blocked.`
        : `${shortenNodeId(nodeId)} is unblocked.`,
    );

  const handlePublished = (publishedReplyTarget: FeedItem | null) => {
    if (!publishedReplyTarget) {
      setThreadItem(null);
      setProfileTab("posts");
      setView("profile");
    }
    void wakeOutboundDelivery();
    void refreshFeed();
    void refreshAuthored().catch((reason: unknown) =>
      setActionError(errorMessage(reason))
    );
  };

  const openInlineReply = (item: FeedItem) => {
    setComposerOpen(false);
    setThreadItem(item);
    setView("feed");
  };

  const openNotificationPost = async (item: NotificationItem) => {
    const sequence = ++notificationTargetRequestSequence.current;
    let authored = snapshot.authored;
    let target = notificationThreadTarget(
      item,
      authored.items,
      snapshot.profile,
      snapshot.feed.items,
    );
    setActionError(null);
    if (!target) {
      setVerifyingNotificationIds((current) => new Set(current).add(item.id));
      try {
        for (
          let page = 0;
          page < NOTIFICATION_TARGET_LOOKUP_PAGES && authored.nextCursor;
          page += 1
        ) {
          const cursor = authored.nextCursor;
          const older = await service.loadAuthored(cursor);
          if (sequence !== notificationTargetRequestSequence.current) return;
          const next = appendAuthoredPage(authored, older, cursor);
          if (next === authored) break;
          authored = next;
          target = notificationThreadTarget(
            item,
            authored.items,
            snapshot.profile,
            snapshot.feed.items,
          );
          if (target) break;
        }
        if (
          sequence === notificationTargetRequestSequence.current &&
          authored !== snapshot.authored
        ) {
          setSnapshot((current) =>
            current &&
              current.authored.revision === snapshot.authored.revision
              ? { ...current, authored }
              : current
          );
        }
      } catch (reason) {
        if (sequence === notificationTargetRequestSequence.current) {
          setActionError(
            `This post could not be looked up: ${errorMessage(reason)}`,
          );
        }
        return;
      } finally {
        if (sequence === notificationTargetRequestSequence.current) {
          setVerifyingNotificationIds((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
        }
      }
    }
    if (!target) {
      setActionError(
        authored.nextCursor
          ? "This post is older than the bounded local lookup window."
          : "This post is no longer available on this Wagyu.",
      );
      return;
    }
    setThreadItem(target);
    setView("feed");
  };

  const selectedUserFeed = selectedUserProfile
    ? {
        revision: snapshot.feed.revision,
        items: snapshot.feed.items.filter(
          (item) =>
            item.verification === "verified" &&
            item.promotion === "committed" &&
            item.kind !== "tombstone" &&
            item.author.nodeId === selectedUserProfile.nodeId &&
            (userProfileTab === "posts"
              ? !item.replyTo
              : Boolean(item.replyTo)),
        ),
        nextCursor: snapshot.feed.nextCursor,
      }
    : null;
  const selectedUserRelationship = selectedUserProfile
    ? snapshot.relationships.items.find(
        (relationship) =>
          relationship.nodeId === selectedUserProfile.nodeId,
      ) ?? null
    : null;
  const selectedUserFollowBusy =
    selectedUserProfile !== null &&
    relationshipBusy?.nodeId === selectedUserProfile.nodeId &&
    (relationshipBusy.action === "follow" ||
      relationshipBusy.action === "renew");
  const selectedUserFollowDisabledReason = !snapshot.status.peerDeliveryEnabled
    ? "Peer delivery must be enabled before following users"
    : relationshipBusy !== null && !selectedUserFollowBusy
      ? "Another relationship action is still running"
      : selectedUserRelationship?.blocked
        ? "Unblock this user before following them"
        : selectedUserRelationship && !selectedUserRelationship.compatible
          ? "This user cannot connect to this version of Wagyu"
          : null;

  return (
    <ActiveEngagementProvider
      enabled={snapshot.status.networkConfigured}
      optimisticLikeFloors={optimisticLikeFloors}
      service={service}
    >
    <div className="nt-app wg-app">
      <div className="wg-shell">
        <Sidebar
          onCompose={() => setComposerOpen(true)}
          onNavigate={navigate}
          snapshot={snapshot}
          view={view}
        />
        <div className="wg-workspace">
          <Topbar
            onRefresh={() => void refreshAll()}
            refreshing={refreshingAll}
            snapshot={snapshot}
            view={view}
          />
          <div className="wg-banner-stack">
            {snapshot.status.preview ? (
              <div className="wg-preview-banner" role="status">
                <IoWarningOutline aria-hidden="true" />
                <strong>Local protocol preview</strong>
                <span>Fixture content only — not canister data or verification evidence.</span>
              </div>
            ) : null}
            {snapshot.degradedSlices.length > 0 ? (
              <div className="wg-preview-banner" role="status">
                <IoCloudOfflineOutline aria-hidden="true" />
                <strong>Some sections could not refresh</strong>
                <span>
                  Showing the latest available local data for{" "}
                  {snapshot.degradedSlices.join(", ")}.
                </span>
              </div>
            ) : null}
            {!snapshot.status.peerDeliveryEnabled ? (
              <PeerDeliveryGate
                busy={peerDeliveryBusy}
                error={peerDeliveryError}
                onEnable={() => void enablePeerDelivery()}
              />
            ) : null}
            {actionError ? (
              <div className="wg-action-error" role="alert">
                <IoWarningOutline aria-hidden="true" />
                <span>{actionError}</span>
                <button aria-label="Dismiss error" onClick={() => setActionError(null)} type="button">×</button>
              </div>
            ) : null}
          </div>
          <main
            className="wg-main"
            data-dialog-focus-fallback
            id="wagyu-main"
            ref={mainRef}
            tabIndex={-1}
          >
            {view === "feed" ? (
              <FeedView
                actionStages={actionStages}
                authored={snapshot.authored}
                authoredLoadingMore={loadingMoreAuthored}
                authoredTimelineWindowStart={authoredTimelineWindowStart}
                blockedNodeIds={blockedNodeIds}
                timelineWindowStart={feedTimelineWindowStart}
                likingIds={likingIds}
                loadingMore={loadingMore}
                onLike={(item) => void like(item)}
                onLoadMore={() => void loadMoreFeed()}
                onLoadMoreAuthored={() => void loadMoreAuthoredPage()}
                onOpenAuthoredLikes={openAuthoredLikes}
                onOpenLikes={(item) => void openLikes(item)}
                onOpenUser={openUserProfile}
                onAuthoredTimelineWindowChange={
                  setAuthoredTimelineWindowStart
                }
                onReply={openInlineReply}
                onResumeAction={(item) => void resumeAuthoredAction(item)}
                onResumePost={(item) => void resumeAuthoredPost(item)}
                onShare={(item) => setEconomicAction({ kind: "share", item })}
                onVerify={(item) => void verify(item)}
                onAdvanceWithdrawal={(item) =>
                  void runWithdrawal(item, true)}
                onWithdraw={(item) => {
                  if (item.state === "live") {
                    setEconomicAction({ kind: "tombstone", item });
                  } else {
                    void runWithdrawal(item, false);
                  }
                }}
                page={snapshot.feed}
                peerDeliveryEnabled={
                  snapshot.status.peerDeliveryEnabled
                }
                profile={snapshot.profile}
                replies={visibleNotifications.items}
                indexedReplies={visibleIndexedThreadReplies}
                renderThreadReplyComposer={(parent) => (
                  <Composer
                    disabled={
                      !snapshot.status.certifiedStoreReady ||
                      !snapshot.status.peerDeliveryEnabled
                    }
                    disabledReason={
                      !snapshot.status.peerDeliveryEnabled
                        ? "Enable peer delivery before replying."
                        : !snapshot.status.certifiedStoreReady
                          ? "Replying is temporarily unavailable."
                          : "Replying is currently unavailable."
                    }
                    markdown={threadReplyDraft}
                    onClearReply={() => undefined}
                    onClose={() => undefined}
                    onMarkdownChange={setThreadReplyDraft}
                    onPublished={handlePublished}
                    profile={snapshot.profile}
                    replyTarget={parent}
                    service={service}
                    variant="inline"
                  />
                )}
                showRootPostsOnly
                threadItem={threadItem}
                onThreadChange={setThreadItem}
                onTimelineWindowChange={setFeedTimelineWindowStart}
                verifyingIds={verifyingIds}
              />
            ) : null}
            {view === "notifications" ? (
              <NotificationsView
                loadingMore={loadingMoreNotifications}
                onLoadMore={() => void loadMoreNotificationsPage()}
                verifyingIds={verifyingNotificationIds}
                onOpenPost={openNotificationPost}
                onWindowChange={setNotificationTimelineWindowStart}
                onVerify={(item) => void verifyNotification(item)}
                page={visibleNotifications}
                windowStart={notificationTimelineWindowStart}
              />
            ) : null}
            {view === "relationships" ? (
              <RelationshipsView
                busy={relationshipBusy}
                error={relationshipError}
                hydratingProfileIds={hydratingRelationshipProfiles}
                ownNodeId={snapshot.status.nodeId}
                onFollow={followRelationship}
                onSetBlocked={setRelationshipBlocked}
                onUnfollow={unfollowRelationship}
                hasMore={snapshot.relationships.nextCursor !== null}
                loadingMore={loadingMoreRelationships}
                onLoadMore={() => void loadMoreRelationshipsPage()}
                onOpenUser={openUserProfile}
                onProfileVisible={markRelationshipProfileVisible}
                peerDeliveryEnabled={
                  snapshot.status.peerDeliveryEnabled
                }
                relationships={snapshot.relationships.items}
              />
            ) : null}
            {view === "profile" ? (
              <ProfileView
                error={null}
                onSave={async (draft: ProfileDraft) => {
                  setProfileSaving(true);
                  setActionError(null);
                  try {
                    const profile = await service.saveProfile(draft);
                    setSnapshot((current) =>
                      current ? { ...current, profile } : current
                    );
                    setNotice(
                      "Profile saved.",
                    );
                  } catch (reason) {
                    setActionError(errorMessage(reason));
                    throw reason;
                  } finally {
                    setProfileSaving(false);
                  }
                }}
                profile={snapshot.profile}
                saving={profileSaving}
              >
                <div
                  aria-label="Profile content"
                  className="wg-profile-tabs"
                  role="tablist"
                >
                  <button
                    aria-selected={profileTab === "posts"}
                    onClick={() => setProfileTab("posts")}
                    role="tab"
                    type="button"
                  >
                    Posts
                  </button>
                  <button
                    aria-selected={profileTab === "replies"}
                    onClick={() => setProfileTab("replies")}
                    role="tab"
                    type="button"
                  >
                    Replies
                  </button>
                </div>
                <AuthoredPostsPanel
                  actionStages={actionStages}
                  blockedNodeIds={blockedNodeIds}
                  timelineWindowStart={authoredTimelineWindowStart}
                  contentFilter={profileTab}
                  likingIds={likingIds}
                  loadingMore={loadingMoreAuthored}
                  onLike={(item) => void like(item)}
                  onAdvanceWithdrawal={(item) =>
                    void runWithdrawal(item, true)}
                  onLoadMore={() => void loadMoreAuthoredPage()}
                  onOpenFeedLikes={(item) => void openLikes(item)}
                  onOpenLikes={openAuthoredLikes}
                  onOpenUser={openUserProfile}
                  onTimelineWindowChange={setAuthoredTimelineWindowStart}
                  onOpenThread={(item) => {
                    setThreadItem(item);
                    setView("feed");
                  }}
                  onReply={openInlineReply}
                  onResumeAction={(item) => void resumeAuthoredAction(item)}
                  onResumePost={(item) => void resumeAuthoredPost(item)}
                  onShare={(item) =>
                    setEconomicAction({ kind: "share", item })}
                  onWithdraw={(item) => {
                    if (item.state === "live") {
                      setEconomicAction({ kind: "tombstone", item });
                    } else {
                      void runWithdrawal(item, false);
                    }
                  }}
                  page={snapshot.authored}
                  peerDeliveryEnabled={
                    snapshot.status.peerDeliveryEnabled
                  }
                  profile={snapshot.profile}
                  replies={visibleNotifications.items}
                  showEmptyState
                  threadParents={snapshot.feed.items}
                />
              </ProfileView>
            ) : null}
            {view === "user-profile" &&
            selectedUserProfile &&
            selectedUserFeed ? (
              <UserProfileView
                error={userProfileError}
                followBusy={selectedUserFollowBusy}
                followDisabledReason={selectedUserFollowDisabledReason}
                followError={relationshipError}
                following={selectedUserRelationship?.youFollow === true}
                loading={userProfileLoading}
                onBack={() => {
                  userProfileRequestSequence.current += 1;
                  setSelectedUserProfile(null);
                  setUserProfileLoading(false);
                  setUserProfileError(null);
                  setView(userProfileReturnView);
                }}
                onFollow={() => {
                  void followRelationship(
                    selectedUserProfile.nodeId,
                  ).catch(() => undefined);
                }}
                profile={selectedUserProfile}
              >
                <div
                  aria-label="User profile content"
                  className="wg-profile-tabs"
                  role="tablist"
                >
                  <button
                    aria-selected={userProfileTab === "posts"}
                    onClick={() => setUserProfileTab("posts")}
                    role="tab"
                    type="button"
                  >
                    Posts
                  </button>
                  <button
                    aria-selected={userProfileTab === "replies"}
                    onClick={() => setUserProfileTab("replies")}
                    role="tab"
                    type="button"
                  >
                    Replies
                  </button>
                </div>
                <FeedView
                  actionStages={actionStages}
                  blockedNodeIds={blockedNodeIds}
                  emptyStateBody={
                    userProfileTab === "posts"
                      ? "Posts from this user that reach your Home feed will appear here."
                      : "Replies from this user that reach your Home feed will appear here."
                  }
                  emptyStateTitle={
                    userProfileTab === "posts"
                      ? "No posts to show"
                      : "No replies to show"
                  }
                  likingIds={likingIds}
                  loadingMore={loadingMore}
                  onLike={(item) => void like(item)}
                  onLoadMore={() => void loadMoreFeed()}
                  onOpenLikes={(item) => void openLikes(item)}
                  onOpenUser={openUserProfile}
                  onReply={openInlineReply}
                  onShare={(item) =>
                    setEconomicAction({ kind: "share", item })}
                  onThreadChange={(item) => {
                    if (!item) return;
                    setThreadItem(item);
                    setView("feed");
                  }}
                  onVerify={(item) => void verify(item)}
                  page={selectedUserFeed}
                  peerDeliveryEnabled={
                    snapshot.status.peerDeliveryEnabled
                  }
                  showEndMarker={false}
                  threadItem={null}
                  verifyingIds={verifyingIds}
                />
              </UserProfileView>
            ) : null}
          </main>
          <MobileNavigation
            onCompose={() => setComposerOpen(true)}
            onNavigate={navigate}
            snapshot={snapshot}
            view={view}
          />
        </div>
        <aside aria-hidden="true" className="wg-context-rail" />
      </div>
      {notice ? (
        <div className="wg-toast" role="status">
          <IoCheckmarkCircleOutline aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}
      {composerOpen ? (
        <Composer
          disabled={
            !snapshot.status.certifiedStoreReady ||
            !snapshot.status.peerDeliveryEnabled
          }
          disabledReason={
            !snapshot.status.peerDeliveryEnabled
              ? "Enable peer delivery before creating a post or reply."
              : !snapshot.status.certifiedStoreReady
                ? "Posting is temporarily unavailable."
                : "Posting is currently unavailable."
          }
          markdown={composerDraft}
          onClearReply={() => undefined}
          onClose={() => setComposerOpen(false)}
          onMarkdownChange={setComposerDraft}
          onPublished={handlePublished}
          profile={snapshot.profile}
          replyTarget={null}
          service={service}
        />
      ) : null}
      {visibleLikesItem ? (
        <LikesDrawer
          continuing={likesContinuing}
          continuationError={likesContinuationError}
          detail={visibleLikesDetail}
          error={likesError}
          item={visibleLikesItem}
          loading={likesLoading}
          onClose={closeLikes}
          onLoadOlder={() => void loadOlderLikes()}
          onOpenUser={(like) => {
            closeLikes();
            openUserProfile({
              nodeId: like.actorNodeId,
              displayName: like.actorDisplayName,
              avatarUrl: null,
              profileProof: like.actorDisplayName ? "fresh" : "loading",
            });
          }}
        />
      ) : null}
      {economicAction ? (
        <EconomicActionDialog
          action={economicAction}
          onClose={() => setEconomicAction(null)}
          onConfirm={(action) => {
            setEconomicAction(null);
            if (action.kind === "share") {
              void runShare(action.item);
            } else {
              void runWithdrawal(action.item, false);
            }
          }}
          service={service}
        />
      ) : null}
    </div>
    </ActiveEngagementProvider>
  );
}

function EconomicActionDialog({
  action,
  service,
  onClose,
  onConfirm,
}: {
  action: EconomicAction;
  service: WagyuService;
  onClose: () => void;
  onConfirm: (action: EconomicAction) => void;
}) {
  const [quote, setQuote] = useState<SendQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialog, cancelButton, onClose);

  useEffect(() => {
    let active = true;
    setQuote(null);
    setError(null);
    const estimatedObjectBytes = economicActionBytes(action);
    const noticeTarget =
      action.kind === "share" ? action.item.author.nodeId : undefined;
    void service
      .getSendQuote(
        estimatedObjectBytes,
        noticeTarget,
        action.kind,
      )
      .then((next) => {
        if (active) setQuote(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [action, service]);

  const share = action.kind === "share";
  return (
    <div
      className="wg-economic-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        aria-labelledby="wg-economic-title"
        aria-modal="true"
        className="wg-economic-dialog"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <span className="wg-economic-dialog__icon" aria-hidden="true">
            {share ? <IoArrowRedoOutline /> : <IoTrashBinOutline />}
          </span>
          <div>
            <h2 id="wg-economic-title">
              {share ? "Share this post?" : "Delete this post?"}
            </h2>
          </div>
          <button
            aria-label="Close publication estimate"
            className="wg-icon-button"
            onClick={onClose}
            type="button"
          >
            <IoCloseOutline aria-hidden="true" />
          </button>
        </header>
        <p className="wg-economic-dialog__copy">
          {share
            ? "This post will be shared with your followers."
            : "This permanently removes the post from active feeds."}
        </p>
        {error ? (
          <div className="nt-alert nt-alert--danger" role="alert">
            Wagyu couldn't prepare this action. Try again.
          </div>
        ) : !quote ? (
          <p className="wg-economic-dialog__copy" role="status">
            Preparing…
          </p>
        ) : null}
        <footer>
          <button
            className="nt-button nt-button--secondary"
            onClick={onClose}
            ref={cancelButton}
            type="button"
          >
            Cancel
          </button>
          <button
            className={share
              ? "nt-button wg-primary-button"
              : "nt-button wg-danger-button"}
            disabled={!quote}
            onClick={() => onConfirm(action)}
            type="button"
          >
            {share ? <IoArrowRedoOutline aria-hidden="true" /> : <IoTrashBinOutline aria-hidden="true" />}
            {share ? "Share" : "Delete post"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function economicActionBytes(action: EconomicAction): number {
  if (action.kind === "tombstone") return 512;
  const originalRefBytes = action.item.originalPostRefBytes?.byteLength ?? 0;
  return Math.min(
    WAGYU_LIMITS.genericActionObjectBytes,
    Math.max(1, originalRefBytes + 1_024),
  );
}

function userProfileFallback(author: FeedAuthor): WagyuProfile {
  const mayRender = profileMayRenderRemoteText(author.profileProof);
  return {
    nodeId: author.nodeId,
    profileGeneration: "0",
    revision: "0",
    displayName: mayRender ? author.displayName ?? "" : "",
    description: "",
    avatarUrl: mayRender ? author.avatarUrl : null,
    avatar: null,
    proofState: author.profileProof,
    protocolVersion: "wagyu_v1",
    compatible: true,
    updatedAt: null,
  };
}

function presentationSafeUserProfile(profile: WagyuProfile): WagyuProfile {
  if (profileMayRenderRemoteText(profile.proofState)) return profile;
  return {
    ...profile,
    displayName: "",
    description: "",
    avatarUrl: null,
    avatar: null,
  };
}

export function Sidebar({
  snapshot,
  view,
  onCompose,
  onNavigate,
}: {
  snapshot: AppSnapshot;
  view: ViewId;
  onCompose: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  return (
    <aside className="wg-sidebar">
      <a className="wg-brand" href="#wagyu-main" aria-label="Wagyu home">
        <img alt="" src="./static/wagyu-steak-topdown-v2.png" />
        <span>
          <strong>Wagyu</strong>
        </span>
      </a>
      <nav aria-label="Wagyu views">
        {NAVIGATION.map(({ id, label, icon: Icon }) => {
          const count =
            id === "notifications"
              ? snapshot.status.unreadNotifications
              : id === "feed"
                ? snapshot.status.unreadFeed
                : 0;
          return (
            <button
              aria-label={label}
              aria-current={view === id ? "page" : undefined}
              className={view === id ? "is-active" : ""}
              key={id}
              onClick={() => onNavigate(id)}
              type="button"
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
              {count > 0 ? <em>{Math.min(count, 99)}</em> : null}
            </button>
          );
        })}
        <button
          aria-label="Post"
          className="wg-nav-compose"
          onClick={onCompose}
          type="button"
        >
          <IoCreateOutline aria-hidden="true" />
          <span>Post</span>
        </button>
      </nav>
      <div className="wg-sidebar__node">
        <Avatar
          imageUrl={snapshot.profile.avatarUrl}
          nodeId={snapshot.profile.nodeId}
          size="sm"
        />
        <span>
          <strong>{snapshot.profile.displayName || "You"}</strong>
          <small>Your id {shortenNodeId(snapshot.status.nodeId)}</small>
        </span>
        <CopyIdButton nodeId={snapshot.status.nodeId} />
      </div>
    </aside>
  );
}

function Topbar({
  snapshot,
  view,
  refreshing,
  onRefresh,
}: {
  snapshot: AppSnapshot;
  view: ViewId;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const title =
    view === "user-profile"
      ? "Profile"
      : NAVIGATION.find((item) => item.id === view)?.label ?? "Wagyu";
  return (
    <header className="wg-topbar">
      <strong className="wg-topbar__title">{title}</strong>
      {snapshot.status.outboxPaused ? (
        <span className="wg-topbar__warning">
          <IoCloudOfflineOutline aria-hidden="true" /> Sending paused
        </span>
      ) : snapshot.status.outboxErrors > 0 ? (
        <span className="wg-topbar__warning">
          <IoWarningOutline aria-hidden="true" />{" "}
          {snapshot.status.outboxErrors} message
          {snapshot.status.outboxErrors === 1 ? "" : "s"} need attention
        </span>
      ) : null}
      <button
        aria-label={refreshing ? "Refreshing Wagyu" : "Refresh Wagyu"}
        aria-busy={refreshing}
        className={`wg-icon-button wg-global-refresh${refreshing ? " is-refreshing" : ""}`}
        disabled={refreshing}
        onClick={onRefresh}
        title="Refresh"
        type="button"
      >
        <IoRefreshOutline aria-hidden="true" />
      </button>
    </header>
  );
}

export function MobileNavigation({
  snapshot,
  view,
  onCompose,
  onNavigate,
}: {
  snapshot: AppSnapshot;
  view: ViewId;
  onCompose: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  return (
    <nav aria-label="Wagyu mobile views" className="wg-mobile-nav">
      {MOBILE_NAVIGATION.map((item) => {
        if (item === null) {
          return (
            <button
              aria-label="Post"
              className="wg-mobile-nav__compose"
              key="compose"
              onClick={onCompose}
              type="button"
            >
              <span><IoCreateOutline aria-hidden="true" /></span>
              Post
            </button>
          );
        }
        const { id, label, icon: Icon } = item;
        const count =
          id === "notifications"
            ? snapshot.status.unreadNotifications
            : id === "feed"
              ? snapshot.status.unreadFeed
              : 0;
        return (
          <button
            aria-label={label}
            aria-current={view === id ? "page" : undefined}
            className={view === id ? "is-active" : ""}
            key={id}
            onClick={() => onNavigate(id)}
            type="button"
          >
            <span>
              <Icon aria-hidden="true" />
              {count > 0 ? <em>{Math.min(count, 99)}</em> : null}
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function LoadingScreen() {
  return (
    <div className="nt-app wg-app wg-boot">
      <img alt="" src="./static/wagyu-steak-topdown-v2.png" />
      <div className="wg-boot__pulse" />
      <strong>Prepping your Wagyu</strong>
      <span>Getting everything ready…</span>
    </div>
  );
}

function ErrorScreen({
  error,
  onRetry,
  eyebrow = "Wagyu unavailable",
  retryLabel = "Try again",
  showPreviewHint = true,
  title = "Wagyu couldn't open",
}: {
  error: string;
  onRetry: () => void;
  eyebrow?: string;
  retryLabel?: string;
  showPreviewHint?: boolean;
  title?: string;
}) {
  return (
    <div className="nt-app wg-app wg-error-screen">
      <div className="wg-error-screen__card">
        <span className="wg-error-screen__icon"><IoGlobeOutline aria-hidden="true" /></span>
        <p className="nt-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{error}</p>
        <button className="nt-button wg-primary-button" onClick={onRetry} type="button">
          <IoRefreshOutline aria-hidden="true" /> {retryLabel}
        </button>
        {showPreviewHint &&
        globalThis.window &&
        globalThis.window.parent === globalThis.window ? (
          <small>
            Standalone visual development is opt-in: add <code>?preview=1</code>.
            Preview data is always labeled and is never verification evidence.
          </small>
        ) : null}
      </div>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isInstallationIntegrityFailure(error: string | null): boolean {
  return error?.toLowerCase().includes("installation integrity") ?? false;
}

function verificationIssueFromError(
  reason: unknown,
): VerificationIssueCode {
  const message = errorMessage(reason).toLowerCase();
  if (
    message.includes("content-digest") ||
    message.includes("content digest")
  ) {
    return "content-digest-mismatch";
  }
  if (
    message.includes("object digest") ||
    message.includes("object-digest")
  ) {
    return "object-digest-mismatch";
  }
  if (
    message.includes("certificate") ||
    message.includes("certification") ||
    message.includes("certified path")
  ) {
    return "certificate-invalid";
  }
  if (
    message.includes("not found") ||
    message.includes("404")
  ) {
    return "fetch-unavailable";
  }
  if (
    message.includes("candid") ||
    message.includes("decode") ||
    message.includes("encoding")
  ) {
    return "candid-invalid";
  }
  if (
    message.includes("author") ||
    message.includes("binding") ||
    message.includes("target") ||
    message.includes("path")
  ) {
    return "binding-invalid";
  }
  if (message.includes("promotion")) return "promotion-failed";
  if (message.includes("unsupported")) return "unsupported";
  if (
    message.includes("fetch") ||
    message.includes("network") ||
    message.includes("unavailable") ||
    message.includes("could not be loaded")
  ) {
    return "fetch-unavailable";
  }
  return "unknown";
}

function verificationStateForIssue(
  issue: VerificationIssueCode,
): FeedItem["verification"] {
  switch (issue) {
    case "fetch-unavailable":
    case "object-not-found":
      return "unavailable";
    case "unsupported":
      return "unsupported";
    case "unknown":
      return "unverified";
    case "promotion-failed":
      return "unverified";
    case "certificate-invalid":
    case "content-digest-mismatch":
    case "object-digest-mismatch":
    case "candid-invalid":
    case "binding-invalid":
      return "invalid";
  }
}

function revisionAtLeast(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) >= BigInt(current);
  } catch {
    return false;
  }
}

function revisionAfter(candidate: string, current: string): boolean {
  return candidate !== current && revisionAtLeast(candidate, current);
}

function residentHasFreshStatus(
  resident: WagyuResidentSnapshot,
): resident is WagyuResidentSnapshot & {
  source: "authoritative";
  status: NonNullable<WagyuResidentSnapshot["status"]>;
} {
  return (
    resident.source === "authoritative" &&
    resident.status !== null &&
    resident.lastError?.operation !== "status"
  );
}

export function reconcileUnreadNotificationsFromResident(
  current: AppSnapshot,
  resident: WagyuResidentSnapshot,
): AppSnapshot {
  if (
    !residentHasFreshStatus(resident) ||
    !revisionAtLeast(
      resident.status.notificationRevision,
      current.notifications.revision,
    ) ||
    resident.status.unreadNotificationCount ===
      current.status.unreadNotifications
  ) {
    return current;
  }
  return {
    ...current,
    status: {
      ...current.status,
      unreadNotifications: resident.status.unreadNotificationCount,
    },
  };
}

function mergeSnapshot(
  current: AppSnapshot,
  next: AppSnapshot,
): AppSnapshot {
  // Reinstall creates a fresh profile generation and resets every page
  // revision. Treat that as a new installation: preserving a numerically
  // higher page from the previous generation would leave ghost posts and
  // relationships visible forever.
  if (
    current.status.nodeId !== next.status.nodeId ||
    current.profile.profileGeneration !== next.profile.profileGeneration
  ) {
    return next;
  }
  return {
    ...next,
    profile:
      current.profile.profileGeneration === next.profile.profileGeneration &&
      current.profile.revision === next.profile.revision
        ? current.profile
        : next.profile,
    feed:
      !revisionAtLeast(next.feed.revision, current.feed.revision) ||
      current.feed.revision === next.feed.revision
        ? current.feed
        : mergeFeedPageHydration(current.feed, next.feed),
    authored:
      !revisionAtLeast(next.authored.revision, current.authored.revision) ||
      current.authored.revision === next.authored.revision
        ? current.authored
        : next.authored,
    notifications:
      !revisionAtLeast(
        next.notifications.revision,
        current.notifications.revision,
      ) ||
      current.notifications.revision === next.notifications.revision
        ? current.notifications
        : next.notifications,
    relationships:
      !revisionAtLeast(
        next.relationships.revision,
        current.relationships.revision,
      ) ||
      current.relationships.revision === next.relationships.revision
        ? current.relationships
        : next.relationships,
  };
}

function filterBlockedLikes(
  detail: LikesDetail | null,
  blockedNodeIds: ReadonlySet<string>,
): LikesDetail | null {
  if (!detail || blockedNodeIds.size === 0) return detail;
  let removed = false;
  const packages = detail.packages.map((group) => {
    const receipts = group.receipts.filter((receipt) => {
      const visible = !blockedNodeIds.has(receipt.actorNodeId);
      removed ||= !visible;
      return visible;
    });
    return receipts.length === group.receipts.length
      ? group
      : { ...group, receipts };
  });
  const awaitingBatch = detail.awaitingBatch.filter((receipt) => {
    const visible = !blockedNodeIds.has(receipt.actorNodeId);
    removed ||= !visible;
    return visible;
  });
  return removed
    ? {
        ...detail,
        packages,
        awaitingBatch,
      }
    : detail;
}

function replyCountCandidate(item: FeedItem): boolean {
  return (
    item.verification === "verified" &&
    item.promotion === "committed" &&
    item.kind !== "tombstone" &&
    item.bodyDigest !== null &&
    item.objectDigest !== null &&
    item.bodyLength !== null
  );
}

function replyCountBinding(item: FeedItem): string {
  return [
    item.author.nodeId,
    item.postId,
    item.bodyDigest ?? "",
    item.objectDigest ?? "",
    item.bodyLength?.toString() ?? "",
  ].join("\u0000");
}

function replyCountBatch(items: readonly FeedItem[]): FeedItem[] {
  const unique = new Map<string, FeedItem>();
  for (const item of items) {
    if (!replyCountCandidate(item)) continue;
    const binding = replyCountBinding(item);
    const current = unique.get(binding);
    if (
      !current ||
      (
        current.verifiedReplyCount !== undefined &&
        item.verifiedReplyCount === undefined
      )
    ) {
      unique.set(binding, item);
    }
  }
  const candidates = [...unique.values()];
  const missing = candidates.filter(
    (item) => item.verifiedReplyCount === undefined,
  );
  return (missing.length > 0 ? missing : candidates)
    .slice(0, WAGYU_LIMITS.feedPageItems);
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await visit(values[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
}
