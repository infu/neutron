import type { NotificationItem, NotificationPage } from "./model.ts";

const DEFAULT_PAGE_SLICE = 2;
const DEFAULT_PROOF_BATCH = 4;
const DEFAULT_PROOF_CONCURRENCY = 2;
const DEFAULT_SLICE_DELAY_MS = 250;

export function notificationEvidenceNeedsAutomaticHydration(
  item: NotificationItem,
): boolean {
  return (
    item.verification === "pending" &&
    (item.kind === "reply" || item.kind === "like" || item.kind === "share")
  );
}

export interface NotificationProofProgressOptions {
  initialCursor: string;
  signal: AbortSignal;
  loadPage(cursor: string): Promise<NotificationPage>;
  hydrate(item: NotificationItem, signal: AbortSignal): Promise<void>;
  pause?: (signal: AbortSignal) => Promise<void>;
  pageSlice?: number;
  proofBatch?: number;
  proofConcurrency?: number;
}

/**
 * Progresses older notification proofs without retaining or rendering the
 * scanned pages. Work is deliberately sliced: at most two local page queries
 * or four proofs run before yielding back to the tile.
 *
 * A page cursor is revisited after each proof batch so the durable local
 * dispositions decide what remains pending. Rows that could not be durably
 * updated are attempted only once per run and become eligible again on the
 * next explicit refresh/open.
 */
export async function progressOlderNotificationProofs({
  initialCursor,
  signal,
  loadPage,
  hydrate,
  pause = pauseNotificationProofProgress,
  pageSlice = DEFAULT_PAGE_SLICE,
  proofBatch = DEFAULT_PROOF_BATCH,
  proofConcurrency = DEFAULT_PROOF_CONCURRENCY,
}: NotificationProofProgressOptions): Promise<void> {
  assertPositiveInteger(pageSlice, "page slice");
  assertPositiveInteger(proofBatch, "proof batch");
  assertPositiveInteger(proofConcurrency, "proof concurrency");

  let cursor: string | null = initialCursor;
  let attemptedCursor = cursor;
  let attemptedAtCursor = new Set<string>();

  while (cursor && !signal.aborted) {
    let pagesScanned = 0;
    while (cursor && pagesScanned < pageSlice && !signal.aborted) {
      if (attemptedCursor !== cursor) {
        attemptedCursor = cursor;
        attemptedAtCursor = new Set();
      }
      const requestedCursor: string = cursor;
      const page: NotificationPage = await loadPage(requestedCursor);
      if (signal.aborted) return;
      pagesScanned += 1;

      const pending = page.items
        .filter(
          (item) =>
            notificationEvidenceNeedsAutomaticHydration(item) &&
            !attemptedAtCursor.has(item.id),
        )
        .slice(0, proofBatch);
      if (pending.length > 0) {
        for (const item of pending) attemptedAtCursor.add(item.id);
        await forEachConcurrent(
          pending,
          proofConcurrency,
          (item) => hydrate(item, signal),
        );
        // Re-read the same bounded page after yielding. Successfully recorded
        // dispositions disappear from its pending set; failed bookkeeping
        // cannot create a tight retry loop in this run.
        break;
      }

      const nextCursor = page.nextCursor;
      if (nextCursor === requestedCursor) return;
      cursor = nextCursor;
    }
    if (!cursor || signal.aborted) return;
    await pause(signal);
  }
}

export function pauseNotificationProofProgress(
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, DEFAULT_SLICE_DELAY_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      if (next >= values.length) return;
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

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Notification proof ${label} must be a positive integer`);
  }
}
