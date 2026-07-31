import type {
  AuthoredItem,
  AuthoredPost,
  PublishResult,
} from "./model.ts";
import { WAGYU_LIMITS } from "../protocol/constants.ts";

// Each retained batch has at least one receipt, and a bounded retention call
// always consumes receipts or its batch row. The small allowance covers head
// stop, at most two unsealed segments, retention setup, and final fanout.
export const WAGYU_MAX_WITHDRAWAL_CONTINUATION_CALLS =
  WAGYU_LIMITS.reactionReceiptCount + 8;

export function closingWithdrawalPosts(
  items: readonly AuthoredItem[],
): AuthoredPost[] {
  return items.filter((item): item is AuthoredPost =>
    item.kind === "post" &&
    item.state === "withdrawal-closing"
  );
}

export async function continueWithdrawalUntilComplete({
  advance,
  signal,
  yieldBetween = yieldToBrowser,
  maximumCalls = WAGYU_MAX_WITHDRAWAL_CONTINUATION_CALLS,
}: {
  advance: () => Promise<PublishResult>;
  signal?: AbortSignal;
  yieldBetween?: () => Promise<void>;
  maximumCalls?: number;
}): Promise<PublishResult> {
  if (!Number.isSafeInteger(maximumCalls) || maximumCalls < 1) {
    throw new Error("Deletion continuation bound is invalid");
  }
  for (let call = 0; call < maximumCalls; call += 1) {
    throwIfCancelled(signal);
    const result = await advance();
    throwIfCancelled(signal);
    if (
      result.stage === "complete" ||
      result.stage === "fanout-queued"
    ) return result;
    if (
      result.stage !== "certified-ref-ready" &&
      result.stage !== "withdrawal-closing"
    ) {
      throw new Error(
        result.message || `Deletion stopped at ${result.stage}`,
      );
    }
    await yieldBetween();
  }
  throw new Error(
    "Deletion did not complete within its protocol continuation bound",
  );
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Deletion continuation was cancelled");
}
