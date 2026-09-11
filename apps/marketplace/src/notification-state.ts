import type { OperationResult } from "./view-types.ts";

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

/** Pass the latest observations first; each retained request appears once. */
export function visibleNotifications(operations: readonly OperationResult[]): OperationResult[] {
  const seen = new Set<string>();
  return operations.filter(operation => {
    if (seen.has(operation.operationId)) return false;
    seen.add(operation.operationId);
    return !operation.installation && !isCanceledBeforeSubmission(operation);
  });
}

export function notificationAttentionCount(operations: readonly OperationResult[]): number {
  return visibleNotifications(operations).filter(operation => operation.state !== "complete" || operation.settlement?.state === "failed").length;
}

export function notificationTitle(operation: OperationResult): string {
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
  return !operation.entitled && operation.state !== "complete"
    && (operation.paymentRail === "ethereum" || !!operation.ethereumWallet);
}
