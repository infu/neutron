/**
 * Settle one list request without releasing an unrelated operation guard.
 *
 * A focus/state refresh may supersede the initial foreground list request.
 * Whichever list request is newest owns the visible list result and therefore
 * may release `initial`/`list`; stale requests and non-list work stay guarded.
 */
export function settleListRequestBusy(
  request: number,
  latestRequest: number,
  busy: string | null,
): string | null {
  if (request !== latestRequest) return busy;
  return busy === "initial" || busy === "list" ? null : busy;
}
