import type { IDL } from "@dfinity/candid";

export type TransactionAddress =
  | { kind: "icrc"; owner: string; subaccountHex: string | null }
  | { kind: "icp_account_identifier"; accountIdentifierHex: string };
export type WalletTransaction = {
  blockIndex: string;
  operation: "transfer" | "mint" | "burn" | "approve";
  timestampNs: string;
  amountAtoms: string;
  feeAtoms: string | null;
  balanceEffectAtoms: string;
  from: TransactionAddress | null;
  to: TransactionAddress | null;
  spender: TransactionAddress | null;
  memoHex: string | null;
  memoComplete: boolean;
};
export type HistoryQuery = (request: {
  canister: string;
  method: string;
  args: unknown[];
  argTypes: IDL.Type[];
  resultType: IDL.Type;
  signal?: AbortSignal;
}) => Promise<unknown>;
export type IndexPageData = {
  transactions: WalletTransaction[];
  indexedAccountBalanceAtoms: string;
  oldestBlock: string | null;
  nextBeforeBlock: string | null;
  hasMore: boolean;
  completeToOldest: boolean;
  newestAccountBlock: string | null;
};
export type DirectLookup = {
  transaction: WalletTransaction | null;
  chainLength: string;
  sourceCanister: string;
  sourceMethod: string;
  archived: boolean;
};

/** A cancelled public query need not wait for the remote replica to answer.
 * Its eventual response is still consumed; it cannot dispatch a fallback.
 */
export function abortableHistoryQuery(query: HistoryQuery): HistoryQuery {
  return (request) => {
    request.signal?.throwIfAborted();
    const work = Promise.resolve().then(() => {
      request.signal?.throwIfAborted();
      return query(request);
    });
    const signal = request.signal;
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Read aborted", "AbortError")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      work.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
        (error) => { signal.removeEventListener("abort", abort); reject(error); });
    });
  };
}
