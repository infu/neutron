export type RefreshLatch = {
  pending: boolean;
};

export function createRefreshLatch(): RefreshLatch {
  return { pending: false };
}

export function queueRefresh(latch: RefreshLatch): void {
  latch.pending = true;
}

export function beginRefresh(
  latch: RefreshLatch,
  sameEpochRefreshActive: boolean,
): boolean {
  if (sameEpochRefreshActive) return false;
  latch.pending = false;
  return true;
}

export function shouldDrainRefresh(
  latch: RefreshLatch,
  mounted: boolean,
  mutationActive: boolean,
): boolean {
  return mounted && !mutationActive && latch.pending;
}
