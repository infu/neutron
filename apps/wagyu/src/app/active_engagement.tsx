import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FeedItem,
  LikesDetail,
  WagyuService,
} from "./model.ts";

export const ACTIVE_ENGAGEMENT_REFRESH_MS = 10_000;
const ACTIVE_ENGAGEMENT_CONCURRENCY = 4;

export type ActiveEngagement = {
  likeCount: number;
  replyCount: number;
};

type ActiveEngagementContextValue = {
  summaries: ReadonlyMap<string, ActiveEngagement>;
  optimisticLikeFloors: ReadonlyMap<string, number>;
  setVisible(token: string, item: FeedItem | null): void;
};

const ActiveEngagementContext =
  createContext<ActiveEngagementContextValue | null>(null);

export function ActiveEngagementProvider({
  children,
  enabled,
  optimisticLikeFloors = EMPTY_OPTIMISTIC_LIKE_FLOORS,
  service,
}: {
  children: ReactNode;
  enabled: boolean;
  optimisticLikeFloors?: ReadonlyMap<string, number>;
  service: WagyuService;
}) {
  const [summaries, setSummaries] =
    useState<ReadonlyMap<string, ActiveEngagement>>(new Map());
  const visible = useRef<Map<string, FeedItem>>(new Map());
  const refreshTask = useRef<Promise<void> | null>(null);
  const refreshPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      visible.current.clear();
    };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (refreshTask.current) {
      refreshPending.current = true;
      return refreshTask.current;
    }
    const unique = uniqueActivePosts(visible.current.values());
    if (unique.length === 0) return Promise.resolve();

    let task: Promise<void>;
    task = mapConcurrent(
      unique,
      ACTIVE_ENGAGEMENT_CONCURRENCY,
      async (item) => {
        const [likes, replies] = await Promise.allSettled([
          service.loadLikes(item),
          service.loadThreadReplyCount(item),
        ]);
        if (!mounted.current) return;
        setSummaries((current) => {
          const key = activeEngagementKey(item);
          const previous = current.get(key);
          const loadedLikeCount =
            likes.status === "fulfilled"
              ? visibleLikeCount(likes.value, item)
              : item.likeSummary.verified +
                (item.localOrigin ? item.likeSummary.awaitingBatch : 0);
          const next: ActiveEngagement = {
            // The Worker intentionally releases at most two Like packages per
            // page. A later head may therefore move an older verified package
            // beyond this live-card window; Likes cannot be removed in V1, so
            // retain the largest verified lower bound this tile has observed.
            likeCount: Math.max(previous?.likeCount ?? 0, loadedLikeCount),
            replyCount:
              replies.status === "fulfilled"
                ? replies.value
                : previous?.replyCount ?? item.verifiedReplyCount ?? 0,
          };
          if (
            previous?.likeCount === next.likeCount &&
            previous.replyCount === next.replyCount
          ) return current;
          const updated = new Map(current);
          updated.set(key, next);
          return updated;
        });
      },
    ).finally(() => {
      if (refreshTask.current === task) {
        refreshTask.current = null;
        if (refreshPending.current) {
          refreshPending.current = false;
          void refresh();
        }
      }
    });
    refreshTask.current = task;
    return task;
  }, [enabled, service]);

  const setVisible = useCallback((
    token: string,
    item: FeedItem | null,
  ) => {
    if (item) {
      visible.current.set(token, item);
      void refresh();
    } else {
      const removed = visible.current.get(token);
      visible.current.delete(token);
      if (
        removed &&
        ![...visible.current.values()].some(
          (current) =>
            activeEngagementKey(current) === activeEngagementKey(removed),
        )
      ) {
        setSummaries((current) => {
          const key = activeEngagementKey(removed);
          if (!current.has(key)) return current;
          const updated = new Map(current);
          updated.delete(key);
          return updated;
        });
      }
    }
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      ACTIVE_ENGAGEMENT_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  const value = useMemo<ActiveEngagementContextValue>(
    () => ({ optimisticLikeFloors, summaries, setVisible }),
    [optimisticLikeFloors, setVisible, summaries],
  );
  return (
    <ActiveEngagementContext.Provider value={value}>
      {children}
    </ActiveEngagementContext.Provider>
  );
}

export function useActiveEngagement(item: FeedItem): {
  engagement: ActiveEngagement | null;
  optimisticLikeFloor: number | null;
  onVisibilityChange: (visible: boolean) => void;
} {
  const context = useContext(ActiveEngagementContext);
  const setVisible = context?.setVisible;
  const token = useId();
  const itemRef = useRef(item);
  const visibleRef = useRef(false);
  itemRef.current = item;
  const binding = activeEngagementKey(item);
  const localAwaitingSignature =
    item.localAwaitingLikerIds?.join("\u0000") ?? "";

  const onVisibilityChange = useCallback((nextVisible: boolean) => {
    visibleRef.current = nextVisible;
    setVisible?.(token, nextVisible ? itemRef.current : null);
  }, [setVisible, token]);

  useEffect(() => {
    if (visibleRef.current) setVisible?.(token, itemRef.current);
    return () => setVisible?.(token, null);
  }, [
    binding,
    item.likeSummary.awaitingBatch,
    item.likeSummary.verified,
    localAwaitingSignature,
    item.verifiedReplyCount,
    setVisible,
    token,
  ]);

  return {
    engagement: context?.summaries.get(binding) ?? null,
    optimisticLikeFloor:
      context?.optimisticLikeFloors.get(binding) ?? null,
    onVisibilityChange,
  };
}

const EMPTY_OPTIMISTIC_LIKE_FLOORS: ReadonlyMap<string, number> = new Map();

export function displayedLikeCount(
  item: FeedItem,
  liveCount: number | null,
  optimisticFloor: number | null,
): number {
  const storedCount =
    item.likeSummary.verified +
    (item.localOrigin ? item.likeSummary.awaitingBatch : 0);
  return Math.max(storedCount, liveCount ?? 0, optimisticFloor ?? 0);
}

export function activeEngagementKey(item: FeedItem): string {
  return [
    item.author.nodeId,
    item.postId,
    item.bodyDigest ?? "",
    item.objectDigest ?? "",
    item.bodyLength?.toString() ?? "",
  ].join("\u0000");
}

export function visibleLikeCount(
  detail: LikesDetail,
  item: FeedItem,
): number {
  const verifiedActors = new Set<string>();
  for (const group of detail.packages) {
    if (group.state !== "verified") continue;
    for (const receipt of group.receipts) {
      if (receipt.state === "verified") {
        verifiedActors.add(receipt.actorNodeId);
      }
    }
  }
  if (item.localOrigin) {
    for (const receipt of detail.awaitingBatch) {
      verifiedActors.add(receipt.actorNodeId);
    }
    if (item.localAwaitingLikerIds) {
      for (const actorNodeId of item.localAwaitingLikerIds) {
        verifiedActors.add(actorNodeId);
      }
      return verifiedActors.size;
    }
    return verifiedActors.size + Math.max(
      0,
      item.likeSummary.awaitingBatch - detail.awaitingBatch.length,
    );
  }
  return verifiedActors.size;
}

function uniqueActivePosts(items: Iterable<FeedItem>): FeedItem[] {
  const unique = new Map<string, FeedItem>();
  for (const item of items) {
    if (
      item.verification !== "verified" ||
      item.promotion !== "committed" ||
      item.kind === "tombstone" ||
      !item.bodyDigest ||
      !item.objectDigest ||
      item.bodyLength === null
    ) continue;
    unique.set(activeEngagementKey(item), item);
  }
  return [...unique.values()];
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const value = values[next]!;
      next += 1;
      await visit(value);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
}
