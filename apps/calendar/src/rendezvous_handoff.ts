const MAX_DURATION_MINUTES = 480;

/**
 * Kernel tile views are deliberately tiny and non-secret. This handoff carries
 * only the local range the owner selected; Rendezvous still requires the owner
 * to choose a peer, review availability, select options, and send.
 */
export function scheduleView(start: Date, end: Date): string {
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > MAX_DURATION_MINUTES ||
    start.getTime() <= Date.now() ||
    start.toDateString() !== end.toDateString()
  ) {
    throw new Error(
      "Choose a future 15-minute to 8-hour range that starts and ends on the same day.",
    );
  }
  return `schedule/${start.getTime().toString(36)}/${end.getTime().toString(36)}`;
}

/** Opens the locally corresponding confirmed negotiation without exposing an ID. */
export function meetingView(start: Date, end: Date): string {
  if (
    !Number.isSafeInteger(start.getTime()) ||
    !Number.isSafeInteger(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    throw new Error("This meeting has an invalid time range.");
  }
  return `meeting/${start.getTime().toString(36)}/${end.getTime().toString(36)}`;
}
