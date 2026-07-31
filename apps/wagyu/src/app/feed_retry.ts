import type { VerificationState } from "./model.ts";

/**
 * A new candidate is verified immediately by the tile. Only an unavailable
 * result enters this delayed policy, so the three retries happen about 5, 20,
 * and 50 seconds after the first failed attempt.
 */
export const FEED_UNAVAILABLE_RETRY_DELAYS_MS =
  [5_000, 15_000, 30_000] as const;

const DEFAULT_MAX_IN_FLIGHT = 6;

export interface FeedRetryObservation {
  readonly id: string;
  readonly verification: VerificationState;
}

export type AutomaticFeedRetry = (
  id: string,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

export interface FeedRetryClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface RetryEntry {
  retry: AutomaticFeedRetry;
  attemptsStarted: number;
  retryableObserved: boolean;
  timer: unknown | null;
  ready: boolean;
  inFlight: AbortController | null;
}

const BROWSER_CLOCK: FeedRetryClock = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as number);
  },
};

/**
 * Owns delayed, per-candidate availability retries.
 *
 * Proof failures never enter this controller: callers observe only
 * `unavailable` results. Timers and in-flight result application are canceled
 * when a row disappears, becomes terminal, or the controller is disposed.
 */
export class FeedUnavailableRetryController {
  readonly #delays: readonly number[];
  readonly #clock: FeedRetryClock;
  readonly #maxInFlight: number;
  readonly #entries = new Map<string, RetryEntry>();
  #activeCount = 0;
  #disposed = false;

  constructor(
    delays: readonly number[] = FEED_UNAVAILABLE_RETRY_DELAYS_MS,
    clock: FeedRetryClock = BROWSER_CLOCK,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  ) {
    if (
      delays.length === 0 ||
      delays.some(
        (delay) => !Number.isSafeInteger(delay) || delay < 1,
      )
    ) {
      throw new Error("Feed retry delays must be positive integers");
    }
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error("Feed retry concurrency must be a positive integer");
    }
    this.#delays = [...delays];
    this.#clock = clock;
    this.#maxInFlight = maxInFlight;
  }

  observe(
    items: readonly FeedRetryObservation[],
    retry: AutomaticFeedRetry,
  ): void {
    if (this.#disposed) return;
    const visible = new Set<string>();
    for (const item of items) {
      visible.add(item.id);
      const existing = this.#entries.get(item.id);
      if (
        item.verification === "unavailable" ||
        (item.verification === "candidate" && existing !== undefined)
      ) {
        const entry = existing ?? this.#newEntry(retry);
        entry.retry = retry;
        entry.retryableObserved = true;
        if (existing === undefined) this.#entries.set(item.id, entry);
        this.#schedule(item.id, entry);
        continue;
      }
      if (isVerificationInProgress(item.verification) && existing) {
        existing.retry = retry;
        this.#pauseEntry(existing);
        continue;
      }
      if (existing) this.#cancel(item.id, existing);
    }
    for (const [id, entry] of this.#entries) {
      if (!visible.has(id)) this.#cancel(id, entry);
    }
    this.#pump();
  }

  /**
   * A manual or immediate verification supersedes a sleeping retry without
   * resetting the bounded automatic-attempt count.
   */
  beginNow(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) this.#pauseEntry(entry);
  }

  /**
   * A global refresh temporarily owns loading. Retry history is retained, so
   * repeated refreshes cannot reset the automatic bound.
   */
  pauseAll(): void {
    for (const entry of this.#entries.values()) {
      this.#pauseEntry(entry);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      this.#pauseEntry(entry);
      entry.inFlight?.abort("feed-retry-controller-disposed");
    }
    this.#entries.clear();
  }

  #newEntry(retry: AutomaticFeedRetry): RetryEntry {
    return {
      retry,
      attemptsStarted: 0,
      retryableObserved: false,
      timer: null,
      ready: false,
      inFlight: null,
    };
  }

  #schedule(id: string, entry: RetryEntry): void {
    if (
      this.#disposed ||
      !entry.retryableObserved ||
      entry.timer !== null ||
      entry.ready ||
      entry.inFlight !== null
    ) {
      return;
    }
    const delay = this.#delays[entry.attemptsStarted];
    if (delay === undefined) return;
    const handle = this.#clock.setTimeout(() => {
      if (entry.timer !== handle) return;
      entry.timer = null;
      if (
        this.#disposed ||
        this.#entries.get(id) !== entry ||
        !entry.retryableObserved
      ) {
        return;
      }
      entry.ready = true;
      this.#pump();
    }, delay);
    entry.timer = handle;
  }

  #pump(): void {
    if (this.#disposed) return;
    for (const [id, entry] of this.#entries) {
      if (this.#activeCount >= this.#maxInFlight) return;
      if (
        !entry.ready ||
        !entry.retryableObserved ||
        entry.inFlight !== null
      ) {
        continue;
      }
      entry.ready = false;
      entry.retryableObserved = false;
      entry.attemptsStarted += 1;
      const controller = new AbortController();
      entry.inFlight = controller;
      this.#activeCount += 1;
      let operation: boolean | Promise<boolean>;
      try {
        operation = entry.retry(id, controller.signal);
      } catch {
        operation = false;
      }
      void Promise.resolve(operation)
        .catch(() => false)
        .then((retryable) => {
          const current = this.#entries.get(id);
          if (
            current === entry &&
            current.inFlight === controller &&
            !controller.signal.aborted
          ) {
            current.retryableObserved = retryable;
          }
        })
        .finally(() => {
          this.#activeCount -= 1;
          const current = this.#entries.get(id);
          if (current === entry && current.inFlight === controller) {
            current.inFlight = null;
            if (current.retryableObserved) this.#schedule(id, current);
          }
          this.#pump();
        });
    }
  }

  #pauseEntry(entry: RetryEntry): void {
    entry.retryableObserved = false;
    entry.ready = false;
    if (entry.timer !== null) {
      this.#clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  #cancel(id: string, entry: RetryEntry): void {
    this.#pauseEntry(entry);
    entry.inFlight?.abort("feed-candidate-no-longer-retryable");
    this.#entries.delete(id);
  }
}

function isVerificationInProgress(state: VerificationState): boolean {
  return (
    state === "fetching" ||
    state === "http-certified" ||
    state === "object-digest-valid" ||
    state === "action-body-valid"
  );
}
