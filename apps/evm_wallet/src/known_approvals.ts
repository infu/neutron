import { address, decodeKnownCall, quantity, type Operation } from "./data.ts";

export type KnownApproval = { key: string; token: string; spender: string };

function hasSuccessfulReceipt(operation: Operation): boolean {
  if (
    operation.status !== "confirmed" ||
    !operation.transactionHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(operation.transactionHash) ||
    operation.receiptJson === null
  ) return false;
  try {
    const receipt: unknown = JSON.parse(operation.receiptJson);
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
    const value = receipt as Record<string, unknown>;
    return quantity(value.status, "receipt status") === "1" &&
      typeof value.transactionHash === "string" &&
      value.transactionHash.toLowerCase() === operation.transactionHash.toLowerCase();
  } catch { return false; }
}

/**
 * Spender discovery from successfully mined Wallet calls, not an allowance
 * index. The backend's confirmed state records its canonical-block check;
 * callers must still read the live allowance before presenting or revoking it.
 */
export function knownApprovals(history: readonly Operation[], chainId: string): KnownApproval[] {
  const known = new Map<string, KnownApproval>();
  for (const operation of history) {
    if (operation.chainId !== chainId || !hasSuccessfulReceipt(operation)) continue;
    const replacement = operation.intent.replacement;
    if (replacement?.cancel) continue;
    // A replacement intent contains fee/cancel instructions. The backend's
    // prepared transaction holds the exact destination and calldata it signed.
    const transaction = replacement
      ? operation.preparedTransaction
      : operation.preparedTransaction ?? operation.intent.transaction;
    if (!transaction || ("chainId" in transaction && transaction.chainId !== chainId)) continue;
    const decoded = decodeKnownCall(transaction.data);
    if (decoded?.name !== "ERC-20 approval") continue;
    try {
      const token = address(transaction.to), spender = address(decoded.details[0]?.[1]);
      const key = `${chainId}:${token.toLowerCase()}:${spender.toLowerCase()}`;
      known.set(key, { key, token, spender });
    } catch {
      // An unrecognized historical entry cannot establish a token/spender pair.
    }
  }
  return [...known.values()];
}
