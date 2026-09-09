/** Read-only follow-up for an acknowledgement whose order outcome is unresolved.
 * Resting/partially open orders are observed outcomes, not failed requests.
 * This never authorizes a resend and also works with older saved records.
 */
export interface TradeProgress {
  state?: string;
  intent?: { kind?: string };
  orders?: { state: string; venueStatus?: string }[];
  modification?: { originalLive: boolean | null; replacementLive: boolean | null };
}

export function needsTradeReconciliation(trade: TradeProgress): boolean {
  if (!trade.state || ["prepared", "signed"].includes(trade.state)) return false;
  if (["submitting", "uncertain"].includes(trade.state)) return true;
  if (trade.state === "accepted" && trade.intent?.kind === "cancelAll" && trade.orders?.length === 0) return false;
  if (trade.intent?.kind === "modify" && (!trade.modification || trade.modification.originalLive === null || trade.modification.replacementLive === null)) return true;
  if (trade.state === "accepted" && !["leverage", "margin"].includes(trade.intent?.kind ?? "")) return true;
  return !!trade.orders?.some((order) => ["unknown", "accepted", "prepared", "signed"].includes(order.state)
    || order.state === "partial" && !order.venueStatus);
}
