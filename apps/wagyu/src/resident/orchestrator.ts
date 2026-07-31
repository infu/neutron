import {
  WAGYU_DRAIN_LIMIT,
  WAGYU_OUTBOX_PAGE_LIMIT,
  WAGYU_OUTBOX_PROJECTION_MAX,
  WAGYU_RESIDENT_TOPICS,
  WAGYU_TRAY_NOTIFICATION_MAX,
  trayBadgeForStatus,
  type WagyuBackendPauseReason,
  type WagyuBackendStatus,
  type WagyuDrainResult,
  type WagyuOutboxItem,
  type WagyuResidentBackend,
  type WagyuResidentNotification,
} from "./contracts.ts";
import {
  emptyStoredProjection,
  type WagyuResidentStorage,
} from "./storage.ts";

export const WAGYU_RESIDENT_POLL_BASE_MS = 60_000;
export const WAGYU_RESIDENT_POLL_MAX_MS = 5 * 60_000;
export const WAGYU_RESIDENT_OUTBOX_PAGE_REQUEST_MAX = Math.ceil(
  WAGYU_OUTBOX_PROJECTION_MAX / WAGYU_OUTBOX_PAGE_LIMIT,
);
export const WAGYU_AUTO_RENEW_LIMIT = 4;
const NAT64_MAX = (1n << 64n) - 1n;

export type WagyuResidentPhase =
  | "starting"
  | "ready"
  | "degraded"
  | "paused";

export type WagyuResidentOperation =
  | "status"
  | "notification_page"
  | "notification_mark_read"
  | "renew"
  | "outbox_page"
  | "drain"
  | "retry"
  | null;

export type WagyuResidentError = {
  operation: Exclude<WagyuResidentOperation, null>;
  message: string;
  atMs: number;
};

export type WagyuResidentSnapshot = {
  version: 1;
  residentRevision: string;
  source: "none" | "cached" | "authoritative";
  phase: WagyuResidentPhase;
  autoDrainEnabled: boolean;
  pauseReason: "user" | WagyuBackendPauseReason | null;
  operation: WagyuResidentOperation;
  lastAuthoritativeAtMs: number | null;
  consecutiveFailures: number;
  lastError: WagyuResidentError | null;
  badge: number | null;
  status: WagyuBackendStatus | null;
  notificationItems: WagyuResidentNotification[];
  outboxItems: WagyuOutboxItem[];
};

export type WagyuResidentScheduler = {
  set(delayMs: number, callback: () => void): number;
  clear(handle: number): void;
};

export type WagyuResidentDependencies = {
  backend: WagyuResidentBackend;
  storage: WagyuResidentStorage;
  setBadge(badge: number | null): Promise<void>;
  publish(topic: string, revision: string): Promise<void>;
  now(): number;
  scheduler: WagyuResidentScheduler;
};

type WagyuStatusTransition =
  | "initial"
  | "same_installation"
  | "new_installation"
  | "different_identity";

export class WagyuResidentBusyError extends Error {
  constructor() {
    super("Wagyu resident already has an outbound operation in progress");
    this.name = "WagyuResidentBusyError";
  }
}

export class WagyuResidentOrchestrator {
  private started = false;
  private stopped = false;
  private timer: number | null = null;
  private source: WagyuResidentSnapshot["source"] = "none";
  private statusValue: WagyuBackendStatus | null = null;
  private notificationItemsValue: WagyuResidentNotification[] = [];
  private outboxItemsValue: WagyuOutboxItem[] = [];
  private autoDrainEnabledValue = true;
  private operationValue: WagyuResidentOperation = null;
  private lastAuthoritativeAtMsValue: number | null = null;
  private consecutiveFailuresValue = 0;
  private lastErrorValue: WagyuResidentError | null = null;
  private residentRevision = 0n;
  private statusRead: Promise<WagyuBackendStatus> | null = null;
  private notificationRead: Promise<WagyuResidentSnapshot> | null = null;
  private notificationMarkRead: Promise<WagyuResidentSnapshot> | null = null;
  private renewalTask: Promise<boolean> | null = null;
  private renewalCursor: string | null = null;
  private renewalQueue: string[] = [];
  private renewalRestartAfterQueue = false;
  private outboxRead: Promise<WagyuResidentSnapshot> | null = null;
  private mutation: Promise<WagyuResidentSnapshot> | null = null;
  private wakeTask: Promise<WagyuResidentSnapshot> | null = null;
  private wakeRequested = false;
  private lastPublishedBadge: number | null | undefined;

  constructor(private readonly dependencies: WagyuResidentDependencies) {}

  async start(): Promise<WagyuResidentSnapshot> {
    if (this.started) {
      if (this.stopped) {
        this.stopped = false;
        try {
          await this.refreshStatus();
        } catch {
          // The resumed snapshot retains the bounded failure contract.
        }
        await this.runBackgroundWork();
        this.scheduleNextPoll();
      }
      return this.snapshot();
    }
    this.started = true;
    this.stopped = false;

    const stored = this.dependencies.storage.load();
    if (stored !== null) {
      this.autoDrainEnabledValue = stored.autoDrainEnabled;
      this.lastAuthoritativeAtMsValue = stored.lastAuthoritativeAtMs;
      this.statusValue = stored.status;
      this.source = stored.status === null ? "none" : "cached";
      this.bump();
      if (stored.status !== null) {
        await this.publishBadge(trayBadgeForStatus(stored.status), "status");
      }
    }

    try {
      await this.refreshStatus();
    } catch {
      // The returned snapshot carries a bounded error. Cached state remains
      // visibly stale and is never promoted to authoritative.
    } finally {
      await this.runBackgroundWork();
      this.scheduleNextPoll();
    }
    return this.snapshot();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.dependencies.scheduler.clear(this.timer);
      this.timer = null;
    }
  }

  snapshot(): WagyuResidentSnapshot {
    return {
      version: 1,
      residentRevision: String(this.residentRevision),
      source: this.source,
      phase: this.phase(),
      autoDrainEnabled: this.autoDrainEnabledValue,
      pauseReason: this.pauseReason(),
      operation: this.operationValue,
      lastAuthoritativeAtMs: this.lastAuthoritativeAtMsValue,
      consecutiveFailures: this.consecutiveFailuresValue,
      lastError: this.lastErrorValue === null ? null : { ...this.lastErrorValue },
      badge:
        this.statusValue === null ? null : trayBadgeForStatus(this.statusValue),
      status:
        this.statusValue === null
          ? null
          : {
            ...this.statusValue,
            networkId: [...this.statusValue.networkId],
          },
      notificationItems: this.notificationItemsValue.map((item) => ({
        ...item,
      })),
      outboxItems: this.outboxItemsValue.map((item) => ({ ...item })),
    };
  }

  async refresh(includeOutbox = false): Promise<WagyuResidentSnapshot> {
    try {
      await this.refreshStatus();
    } catch {
      // Return the explicit cached/degraded status contract below.
    }
    if (includeOutbox) {
      try {
        await this.refreshOutboxPage();
      } catch {
        // Snapshot consumers need the resident's explicit degraded/error state,
        // not an untyped message-bus rejection.
      }
    }
    return this.snapshot();
  }

  async refreshTray(): Promise<WagyuResidentSnapshot> {
    await this.refresh(false);
    try {
      await this.refreshNotificationPage();
      await this.markVisibleNotificationsRead();
    } catch {
      // Keep the last bounded notification projection and expose the resident
      // error in the returned snapshot.
    }
    return this.snapshot();
  }

  /**
   * Wake durable outbound processing after a foreground action. Concurrent
   * callers coalesce, and a wake arriving during an existing drain performs a
   * fresh status check afterward so newly queued work cannot miss the pass.
   */
  async wake(): Promise<WagyuResidentSnapshot> {
    this.wakeRequested = true;
    if (this.wakeTask !== null) return this.wakeTask;
    const task = this.runWakeLoop();
    this.wakeTask = task;
    try {
      return await task;
    } finally {
      if (this.wakeTask === task) this.wakeTask = null;
    }
  }

  private async runWakeLoop(): Promise<WagyuResidentSnapshot> {
    do {
      this.wakeRequested = false;
      await this.runWake();
    } while (this.wakeRequested);
    return this.snapshot();
  }

  private async runWake(): Promise<WagyuResidentSnapshot> {
    try {
      await this.refreshStatus();
    } catch {
      return this.snapshot();
    }
    if (!this.autoDrainEnabledValue || this.statusValue?.outboxPaused) {
      return this.snapshot();
    }
    const activeMutation = this.mutation;
    if (activeMutation !== null) {
      try {
        await activeMutation;
      } catch {
        // Re-read canonical status below. A failed prior pass must not consume
        // the wake for an action that was queued while it was running.
      }
      try {
        await this.refreshStatus();
      } catch {
        return this.snapshot();
      }
    }
    if (!this.shouldAutoDrain()) return this.snapshot();
    return this.drain("automatic");
  }

  async refreshOutboxPage(): Promise<WagyuResidentSnapshot> {
    if (this.outboxRead !== null) return this.outboxRead;
    if (this.operationValue !== null) return this.snapshot();
    const task = this.readOutboxPage();
    this.outboxRead = task;
    try {
      return await task;
    } finally {
      if (this.outboxRead === task) this.outboxRead = null;
    }
  }

  async refreshNotificationPage(): Promise<WagyuResidentSnapshot> {
    if (this.notificationRead !== null) return this.notificationRead;
    if (this.operationValue !== null) return this.snapshot();
    const task = this.readNotificationPage();
    this.notificationRead = task;
    try {
      return await task;
    } finally {
      if (this.notificationRead === task) this.notificationRead = null;
    }
  }

  private async readNotificationPage(): Promise<WagyuResidentSnapshot> {
    this.operationValue = "notification_page";
    this.bump();
    try {
      const page = await this.dependencies.backend.notificationPage(
        WAGYU_TRAY_NOTIFICATION_MAX,
      );
      this.notificationItemsValue = page.items;
      this.clearFailure("notification_page");
      this.bump();
      return this.snapshot();
    } catch (cause) {
      this.recordFailure("notification_page", cause);
      throw cause;
    } finally {
      this.operationValue = null;
      this.bump();
    }
  }

  private async markVisibleNotificationsRead(): Promise<WagyuResidentSnapshot> {
    if (this.notificationMarkRead !== null) {
      return this.notificationMarkRead;
    }
    if (this.operationValue !== null) return this.snapshot();
    const unread = this.notificationItemsValue
      .filter((item) => !item.read)
      .map((item) => item.localSequence);
    if (unread.length === 0) return this.snapshot();

    const task = this.writeVisibleNotificationsRead(unread);
    this.notificationMarkRead = task;
    try {
      return await task;
    } finally {
      if (this.notificationMarkRead === task) {
        this.notificationMarkRead = null;
      }
    }
  }

  private async writeVisibleNotificationsRead(
    unread: string[],
  ): Promise<WagyuResidentSnapshot> {
    this.operationValue = "notification_mark_read";
    this.bump();
    try {
      const notificationRevision =
        await this.dependencies.backend.markNotificationsRead(unread);
      const unreadSet = new Set(unread);
      this.notificationItemsValue = this.notificationItemsValue.map((item) =>
        unreadSet.has(item.localSequence) ? { ...item, read: true } : item
      );
      this.clearFailure("notification_mark_read");
      this.bump();
      await this.safePublish(
        WAGYU_RESIDENT_TOPICS.notifications,
        notificationRevision,
      );
      try {
        await this.refreshStatus();
      } catch {
        // Mark-read succeeded. The next status poll remains the badge recovery
        // path if this immediate local refresh is unavailable.
      }
      return this.snapshot();
    } catch (cause) {
      this.recordFailure("notification_mark_read", cause);
      throw cause;
    } finally {
      this.operationValue = null;
      this.bump();
    }
  }

  private async readOutboxPage(): Promise<WagyuResidentSnapshot> {
    this.operationValue = "outbox_page";
    this.bump();
    try {
      this.outboxItemsValue = await this.loadOutboxProjection();
      this.clearFailure("outbox_page");
      this.bump();
      return this.snapshot();
    } catch (cause) {
      this.recordFailure("outbox_page", cause);
      throw cause;
    } finally {
      this.operationValue = null;
      this.bump();
    }
  }

  private async runAutomaticRenewalPass(): Promise<boolean> {
    if (
      !this.autoDrainEnabledValue ||
      this.statusValue === null ||
      !this.statusValue.networkConfigured ||
      this.statusValue.outboxPaused
    ) return false;
    if (this.renewalTask !== null) return this.renewalTask;
    if (this.operationValue !== null) return false;
    const task = this.advanceAutomaticRenewals();
    this.renewalTask = task;
    try {
      return await task;
    } finally {
      if (this.renewalTask === task) this.renewalTask = null;
    }
  }

  private async advanceAutomaticRenewals(): Promise<boolean> {
    this.operationValue = "renew";
    this.bump();
    try {
      if (this.renewalQueue.length === 0) {
        const page = await this.dependencies.backend.renewalPage(
          this.renewalCursor,
        );
        this.renewalCursor = page.nextBeforeNode;
        this.renewalQueue = [...page.dueNodeIds];
        this.renewalRestartAfterQueue = page.nextBeforeNode === null;
      }

      let queued = false;
      let attempted = 0;
      while (
        attempted < WAGYU_AUTO_RENEW_LIMIT &&
        this.renewalQueue.length > 0
      ) {
        const nodeId = this.renewalQueue.shift();
        if (nodeId === undefined) break;
        attempted += 1;
        queued = await this.dependencies.backend.renewFollowingIfDue(nodeId) ||
          queued;
      }
      if (
        this.renewalQueue.length === 0 &&
        this.renewalRestartAfterQueue
      ) {
        this.resetRenewalScan();
      }
      this.clearFailure("renew");
      this.bump();
      return queued;
    } catch (cause) {
      this.recordFailure("renew", cause);
      throw cause;
    } finally {
      this.operationValue = null;
      this.bump();
    }
  }

  private resetRenewalScan(): void {
    this.renewalCursor = null;
    this.renewalQueue = [];
    this.renewalRestartAfterQueue = false;
  }

  private async runBackgroundWork(): Promise<void> {
    try {
      const renewed = await this.runAutomaticRenewalPass();
      if (renewed) await this.refreshStatus();
    } catch {
      // Renewal health is reported independently and must not block delivery.
    }
    if (!this.shouldAutoDrain()) return;
    try {
      await this.drain("automatic");
    } catch {
      // The resident snapshot retains the bounded delivery failure.
    }
  }

  async drainNow(): Promise<WagyuResidentSnapshot> {
    return this.drain("manual");
  }

  async retry(localSequence: string): Promise<WagyuResidentSnapshot> {
    if (!/^[1-9][0-9]{0,19}$/u.test(localSequence)) {
      throw new Error("Wagyu outbox local sequence is invalid");
    }
    // The resident projection is intentionally bounded and can be stale.
    // Retry eligibility is canonical backend state, so the local view must
    // never become an authorization gate for a valid direct sequence.
    return this.runMutation("retry", async () =>
      this.dependencies.backend.retry(localSequence)
    );
  }

  async setAutoDrain(enabled: boolean): Promise<WagyuResidentSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new Error("Wagyu automatic drain setting is invalid");
    }
    if (enabled === this.autoDrainEnabledValue) return this.snapshot();
    this.autoDrainEnabledValue = enabled;
    this.persist();
    this.bump();
    if (enabled) this.scheduleNextPoll(0);
    return this.snapshot();
  }

  private async refreshStatus(): Promise<WagyuBackendStatus> {
    if (this.statusRead !== null) return this.statusRead;
    const task = this.readStatus();
    this.statusRead = task;
    try {
      return await task;
    } finally {
      if (this.statusRead === task) this.statusRead = null;
    }
  }

  private async readStatus(): Promise<WagyuBackendStatus> {
    const previousOperation = this.operationValue;
    if (previousOperation === null) {
      this.operationValue = "status";
      this.bump();
    }
    try {
      const previous = this.statusValue;
      const next = await this.dependencies.backend.status();
      const transition = classifyStatusTransition(previous, next);
      this.statusValue = next;
      this.source = "authoritative";
      this.lastAuthoritativeAtMsValue = this.dependencies.now();
      this.clearFailure("status");
      this.persist();
      this.bump();
      await this.publishBadge(trayBadgeForStatus(next), "status");
      await this.publishRevisions(previous, next, transition);
      return next;
    } catch (cause) {
      this.recordFailure("status", cause);
      throw cause;
    } finally {
      if (previousOperation === null) {
        this.operationValue = null;
        this.bump();
      }
    }
  }

  private async drain(
    reason: "automatic" | "manual",
  ): Promise<WagyuResidentSnapshot> {
    if (reason === "automatic" && !this.shouldAutoDrain()) {
      return this.snapshot();
    }
    return this.runMutation("drain", async () =>
      this.dependencies.backend.drain(WAGYU_DRAIN_LIMIT)
    );
  }

  private async runMutation(
    operation: "drain" | "retry",
    run: () => Promise<WagyuDrainResult>,
  ): Promise<WagyuResidentSnapshot> {
    if (this.mutation !== null) throw new WagyuResidentBusyError();
    const task = this.executeMutation(operation, run);
    this.mutation = task;
    try {
      return await task;
    } finally {
      if (this.mutation === task) this.mutation = null;
    }
  }

  private async executeMutation(
    operation: "drain" | "retry",
    run: () => Promise<WagyuDrainResult>,
  ): Promise<WagyuResidentSnapshot> {
    this.operationValue = operation;
    this.bump();
    let result: WagyuDrainResult;
    try {
      result = await run();
    } catch (cause) {
      this.recordFailure(operation, cause);
      throw cause;
    }

    try {
      this.clearFailure(operation);
      await this.safePublish(
        WAGYU_RESIDENT_TOPICS.outbox,
        result.outboxRevision,
      );
      await this.safePublish(
        WAGYU_RESIDENT_TOPICS.status,
        result.stateRevision,
      );
      try {
        await this.refreshStatus();
      } catch {
        // The durable mutation succeeded. Its follow-up status failure is
        // retained in the explicit resident error contract.
      }
      try {
        this.outboxItemsValue = await this.loadOutboxProjection();
        this.bump();
      } catch (cause) {
        this.recordFailure("outbox_page", cause);
      }
      return this.snapshot();
    } finally {
      this.operationValue = null;
      this.bump();
    }
  }

  private async loadOutboxProjection(): Promise<WagyuOutboxItem[]> {
    const items: WagyuOutboxItem[] = [];
    const seenCursors = new Set<string>();
    let beforeSequence: string | null = null;
    let expectedRevision: string | null = null;
    let pageRequests = 0;

    while (
      items.length < WAGYU_OUTBOX_PROJECTION_MAX &&
      pageRequests < WAGYU_RESIDENT_OUTBOX_PAGE_REQUEST_MAX
    ) {
      const remaining = WAGYU_OUTBOX_PROJECTION_MAX - items.length;
      pageRequests += 1;
      const page = await this.dependencies.backend.outboxPage(
        Math.min(WAGYU_OUTBOX_PAGE_LIMIT, remaining),
        beforeSequence,
        expectedRevision,
      );
      if (expectedRevision === null) {
        expectedRevision = page.revision;
      } else if (page.revision !== expectedRevision) {
        throw new Error("Wagyu outbox revision changed during pagination");
      }
      const previous = items.at(-1);
      const next = page.items[0];
      if (
        previous !== undefined &&
        next !== undefined &&
        BigInt(previous.localSequence) <= BigInt(next.localSequence)
      ) {
        throw new Error("Wagyu outbox pagination did not advance");
      }
      items.push(...page.items);

      const cursor = page.nextBeforeSequence;
      if (cursor === null || items.length >= WAGYU_OUTBOX_PROJECTION_MAX) {
        break;
      }
      if (seenCursors.has(cursor)) {
        throw new Error("Wagyu outbox pagination cursor repeated");
      }
      seenCursors.add(cursor);
      beforeSequence = cursor;
    }
    return items;
  }

  private async publishRevisions(
    previous: WagyuBackendStatus | null,
    next: WagyuBackendStatus,
    transition: WagyuStatusTransition,
  ): Promise<void> {
    const publications: Promise<void>[] = [];
    const reset = transition !== "same_installation";
    if (
      previous === null ||
      reset ||
      BigInt(next.stateRevision) > BigInt(previous.stateRevision)
    ) {
      publications.push(
        this.safePublish(WAGYU_RESIDENT_TOPICS.status, next.stateRevision),
      );
    }
    if (
      previous === null ||
      reset ||
      BigInt(next.feedRevision) > BigInt(previous.feedRevision)
    ) {
      publications.push(
        this.safePublish(WAGYU_RESIDENT_TOPICS.feed, next.feedRevision),
      );
    }
    if (
      previous === null ||
      reset ||
      BigInt(next.notificationRevision) >
        BigInt(previous.notificationRevision)
    ) {
      publications.push(
        this.safePublish(
          WAGYU_RESIDENT_TOPICS.notifications,
          next.notificationRevision,
        ),
      );
    }
    await Promise.all(publications);
  }

  private safePublish(topic: string, revision: string): Promise<void> {
    return this.dependencies.publish(topic, revision).catch(() => {
      // State invalidations are a latency optimization. Tiles and trays load a
      // full authoritative snapshot at mount and retain a recovery poll.
    });
  }

  private async publishBadge(
    badge: number | null,
    operation: Exclude<WagyuResidentOperation, null>,
  ): Promise<void> {
    if (badge === this.lastPublishedBadge) return;
    try {
      await this.dependencies.setBadge(badge);
      this.lastPublishedBadge = badge;
    } catch (cause) {
      this.recordFailure(operation, cause);
    }
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    void this.refreshStatus()
      .then(async () => {
        await this.runBackgroundWork();
      })
      .catch(() => undefined)
      .finally(() => this.scheduleNextPoll());
  }

  private scheduleNextPoll(delay = residentPollDelay(this.consecutiveFailuresValue)): void {
    if (this.stopped) return;
    if (this.timer !== null) this.dependencies.scheduler.clear(this.timer);
    this.timer = this.dependencies.scheduler.set(delay, () => this.tick());
  }

  private shouldAutoDrain(): boolean {
    return (
      this.autoDrainEnabledValue &&
      this.mutation === null &&
      this.statusValue !== null &&
      !this.statusValue.outboxPaused &&
      this.statusValue.outboundWorkPending
    );
  }

  private phase(): WagyuResidentPhase {
    if (
      !this.autoDrainEnabledValue ||
      (this.statusValue !== null && this.statusValue.outboxPaused)
    ) {
      return "paused";
    }
    if (this.source !== "authoritative") return "starting";
    if (this.consecutiveFailuresValue > 0 || this.lastErrorValue !== null) {
      return "degraded";
    }
    return "ready";
  }

  private pauseReason(): WagyuResidentSnapshot["pauseReason"] {
    if (!this.autoDrainEnabledValue) return "user";
    if (this.statusValue?.outboxPaused) {
      return this.statusValue.pauseReason ?? "unsupported";
    }
    return null;
  }

  private clearFailure(
    operation?: Exclude<WagyuResidentOperation, null>,
  ): void {
    if (
      this.consecutiveFailuresValue === 0 &&
      this.lastErrorValue === null
    ) {
      return;
    }
    if (
      operation !== undefined &&
      this.lastErrorValue !== null &&
      this.lastErrorValue.operation !== operation
    ) {
      return;
    }
    this.consecutiveFailuresValue = 0;
    this.lastErrorValue = null;
    this.bump();
  }

  private recordFailure(
    operation: Exclude<WagyuResidentOperation, null>,
    cause: unknown,
  ): void {
    this.consecutiveFailuresValue = Math.min(
      this.consecutiveFailuresValue + 1,
      8,
    );
    this.lastErrorValue = {
      operation,
      message: boundedError(cause),
      atMs: this.dependencies.now(),
    };
    this.bump();
  }

  private persist(): void {
    this.dependencies.storage.save({
      ...emptyStoredProjection(),
      autoDrainEnabled: this.autoDrainEnabledValue,
      lastAuthoritativeAtMs: this.lastAuthoritativeAtMsValue,
      status:
        this.statusValue === null
          ? null
          : {
            ...this.statusValue,
            networkId: [...this.statusValue.networkId],
          },
    });
  }

  private bump(): void {
    if (this.residentRevision < NAT64_MAX) this.residentRevision += 1n;
  }
}

/**
 * Status is read only through querySelf. Within one local identity, the
 * profile generation is the kernel-allocated installation UID copied into the
 * exact-path mutable profile when the owner first creates it. It is therefore
 * the resident's trusted reset discriminator: counters may reset only when it
 * advances. Node/network changes select a different cache identity, so their
 * revision high-water marks are intentionally independent.
 */
function classifyStatusTransition(
  previous: WagyuBackendStatus | null,
  next: WagyuBackendStatus,
): WagyuStatusTransition {
  if (previous === null) return "initial";
  if (!sameStatusIdentity(previous, next)) return "different_identity";

  const previousGeneration = BigInt(previous.profileGeneration);
  const nextGeneration = BigInt(next.profileGeneration);
  if (nextGeneration < previousGeneration) {
    throw new Error("Wagyu backend installation generation regressed");
  }
  if (nextGeneration > previousGeneration) return "new_installation";
  if (BigInt(next.stateRevision) < BigInt(previous.stateRevision)) {
    throw new Error("Wagyu backend state revision regressed");
  }
  return "same_installation";
}

function sameStatusIdentity(
  left: WagyuBackendStatus,
  right: WagyuBackendStatus,
): boolean {
  return (
    left.node === right.node &&
    left.networkConfigured === right.networkConfigured &&
    left.networkId.length === right.networkId.length &&
    left.networkId.every((byte, index) => byte === right.networkId[index])
  );
}

export function residentPollDelay(consecutiveFailures: number): number {
  const bounded = Number.isSafeInteger(consecutiveFailures)
    ? Math.max(0, Math.min(consecutiveFailures, 8))
    : 0;
  return Math.min(
    WAGYU_RESIDENT_POLL_MAX_MS,
    WAGYU_RESIDENT_POLL_BASE_MS * (2 ** bounded),
  );
}

function boundedError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : "Resident operation failed";
  const printable = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (printable.length === 0) return "Resident operation failed";
  return printable.slice(0, 240);
}
