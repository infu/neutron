export const MAIL_BADGE_POLL_BASE_MS = 30_000;
export const MAIL_BADGE_POLL_MAX_MS = 5 * 60_000;

/**
 * Keep normal unread polling prompt, but stop hammering an unavailable
 * canister. The counter is resident-only and resets after any successful
 * authoritative pulse read.
 */
export function mailBadgePollDelay(consecutiveFailures: number): number {
  const bounded = Number.isSafeInteger(consecutiveFailures)
    ? Math.max(0, Math.min(consecutiveFailures, 8))
    : 0;
  return Math.min(
    MAIL_BADGE_POLL_MAX_MS,
    MAIL_BADGE_POLL_BASE_MS * (2 ** bounded),
  );
}
