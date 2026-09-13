import type { OperationResult } from "./view-types.ts";

export function canDismissNotification(operation: OperationResult): boolean {
  if (operation.state === "complete") return !operation.settlement || operation.settlement.state === "complete";
  if (operation.settlement && operation.settlement.state !== "complete") return false;
  return operation.canDismiss === true;
}
/** Historical accounting is not an inbox. Only unfinished payments need a
 * recovery notification when this Neutron has no saved checkout. */
export function needsPaymentRecovery(operation: OperationResult): boolean {
  return !canDismissNotification(operation);
}

/** A wallet's explicit pre-submission refusal can leave its invoice retained
 * without requiring a persistent notification. Never infer this from prose or
 * apply it to an uncertain payment, an on-chain receipt, or pending settlement. */
export function isCanceledBeforeSubmission(operation: OperationResult): boolean {
  return operation.canceledBeforeSubmission === true
    && operation.ethereumWallet === "browser"
    && operation.state === "failed"
    && !operation.ethereumTransactionHash
    && !operation.ledgerBlock
    && !operation.entitled
    && !operation.settlement;
}

/** Explicitly canceled protocol checkout with no observed payment to recover.
 * Re-evaluate every observation: a later receipt or settlement must reappear. */
export function isCanceledCheckout(operation: OperationResult): boolean {
  return operation.checkoutCanceled === true
    && operation.state === "failed"
    && operation.nextAction === "none"
    && !operation.ethereumTransactionHash
    && !operation.ledgerBlock
    && !operation.entitled
    && !operation.settlement;
}

/** Pass the latest observations first; each retained request appears once. */
export function visibleNotifications(operations: readonly OperationResult[]): OperationResult[] {
  const seen = new Set<string>();
  return operations.filter(operation => {
    if (seen.has(operation.operationId)) return false;
    seen.add(operation.operationId);
    return !operation.installation && !isCanceledBeforeSubmission(operation) && !isCanceledCheckout(operation);
  });
}

export function notificationAttentionCount(operations: readonly OperationResult[]): number {
  return visibleNotifications(operations).filter(operation => operation.state !== "complete" || operation.settlement?.state === "failed").length;
}

export function notificationTitle(operation: OperationResult): string {
  if (isCanceledCheckout(operation)) return "Checkout canceled";
  if (operation.entitled) return "Purchase complete";
  switch (operation.state) {
    case "complete": return "Completed";
    case "pending": return "In progress";
    case "approval_required": return "Approval needed";
    case "review_required": return "Review needed";
    case "failed": return "Action stopped";
  }
}

export function canRecoverEthereumPayment(operation: OperationResult): boolean {
  return !isCanceledCheckout(operation) && !operation.entitled && operation.state !== "complete"
    && (operation.paymentRail === "ethereum" || !!operation.ethereumWallet);
}
