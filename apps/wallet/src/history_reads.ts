import { Actor } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { queryAgent } from "./native.ts";
import { readIcrcAccountPage, readIcrcIndexedBlocks, readIcrcTransaction } from "./history_icrc.ts";
import { readIcpAccountPage, readIcpIndexedBlocks, readIcpTransaction } from "./history_icp.ts";
import type { HistoryQuery, IndexPageData, WalletTransaction } from "./history_transaction.ts";
import { abortableHistoryQuery } from "./history_transaction.ts";

export type HistoryAccount = { ledger: string; owner: string; index: string | null; historyKind: "icp" | "icrc" };
export type AccountTransactionsResult = {
  version: 1; ledger: string; owner: string; observedAtNs: string; available: boolean; error: string | null;
  source: { kind: "index"; canister: string | null; ledgerVerified: false };
  transactions: WalletTransaction[];
  pagination: { beforeBlock: string | null; nextBeforeBlock: string | null; oldestBlock: string | null; hasMore: boolean; completeToOldest: boolean };
  observation: { indexedAccountBalanceAtoms: string | null; newestAccountBlock: string | null; indexedBlocks: string | null; indexedBlocksError: string | null };
};
export type TransactionResult = {
  version: 1; ledger: string; owner: string; blockIndex: string; observedAtNs: string; available: boolean; error: string | null;
  transaction: WalletTransaction | null;
  source: { kind: "ledger" | "index" | "unavailable"; canister: string | null; method: string | null; ledgerVerified: boolean; archived: boolean };
  chainLength: string | null; diagnostics: string[];
};

export function createDirectHistoryQuery(href = typeof window === "undefined" ? "https://icp0.io" : window.location.href): HistoryQuery {
  return abortableHistoryQuery(async (request) => {
    request.signal?.throwIfAborted();
    const agent = await queryAgent(href);
    request.signal?.throwIfAborted();
    // Every method is constructed as a query, including a callback obtained
    // from a canonical ledger's archive response. No identity or update call.
    const actor = Actor.createActor<Record<string, (...args: unknown[]) => Promise<unknown>>>(
      () => IDL.Service({ [request.method]: IDL.Func(request.argTypes as [] | [IDL.Type, ...IDL.Type[]], [request.resultType], ["query"]) }),
      { agent, canisterId: request.canister },
    );
    const value = await actor[request.method]!(...request.args);
    request.signal?.throwIfAborted();
    return value;
  });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function createHistoryReader(query: HistoryQuery = createDirectHistoryQuery(), now: () => bigint = () => BigInt(Date.now()) * 1_000_000n) {
  query = abortableHistoryQuery(query);
  async function accountTransactions(account: HistoryAccount, before: bigint | null = null, limit = 50n, signal?: AbortSignal): Promise<AccountTransactionsResult> {
    const { ledger, owner, index, historyKind } = account;
    if (limit <= 0n) throw new Error("History page limit must be positive");
    signal?.throwIfAborted();
    let page: IndexPageData | null = null, error: string | null = null, indexedBlocks: string | null = null, indexedBlocksError: string | null = null;
    if (index === null) error = "This Wallet ledger has no canonical account index. Use wallet_transaction_v1 for a known ledger block.";
    else {
      const results = await Promise.allSettled([
        (historyKind === "icp" ? readIcpAccountPage : readIcrcAccountPage)(query, index, owner, before, limit, signal),
        (historyKind === "icp" ? readIcpIndexedBlocks : readIcrcIndexedBlocks)(query, index, signal),
      ]);
      signal?.throwIfAborted();
      if (results[0].status === "fulfilled") page = results[0].value; else error = errorMessage(results[0].reason);
      if (results[1].status === "fulfilled") indexedBlocks = results[1].value; else indexedBlocksError = errorMessage(results[1].reason);
    }
    return { version: 1, ledger, owner, observedAtNs: now().toString(), available: page !== null, error,
      source: { kind: "index", canister: index, ledgerVerified: false }, transactions: page?.transactions ?? [],
      pagination: { beforeBlock: before?.toString() ?? null, nextBeforeBlock: page?.nextBeforeBlock ?? null, oldestBlock: page?.oldestBlock ?? null,
        hasMore: page?.hasMore ?? false, completeToOldest: page?.completeToOldest ?? false },
      observation: { indexedAccountBalanceAtoms: page?.indexedAccountBalanceAtoms ?? null, newestAccountBlock: page?.newestAccountBlock ?? null, indexedBlocks, indexedBlocksError } };
  }

  async function transaction(account: HistoryAccount, block: bigint, source: "auto" | "ledger" | "index" = "auto", signal?: AbortSignal): Promise<TransactionResult> {
    const { ledger, owner, historyKind, index } = account, diagnostics: string[] = [];
    signal?.throwIfAborted();
    let chainLength: string | null = null;
    if (source !== "index") {
      try {
        const found = await (historyKind === "icp" ? readIcpTransaction : readIcrcTransaction)(query, ledger, owner, block, signal);
        signal?.throwIfAborted();
        chainLength = found.chainLength;
        if (found.transaction) return { version: 1, ledger, owner, blockIndex: block.toString(), observedAtNs: now().toString(), available: true, error: null,
          transaction: found.transaction, source: { kind: "ledger", canister: found.sourceCanister, method: found.sourceMethod, ledgerVerified: true, archived: found.archived }, chainLength, diagnostics };
        diagnostics.push("The ledger did not return a transaction for this Wallet at the exact requested block. A missing future block is not a failed payout.");
      } catch (error) { signal?.throwIfAborted(); diagnostics.push(`Ledger lookup: ${errorMessage(error)}`); }
    }
    if (source !== "ledger" && index !== null) {
      try {
        const page = await (historyKind === "icp" ? readIcpAccountPage : readIcrcAccountPage)(query, index, owner, block + 1n, 1n, signal);
        signal?.throwIfAborted();
        const found = page.transactions.find((item) => item.blockIndex === block.toString());
        if (found) return { version: 1, ledger, owner, blockIndex: block.toString(), observedAtNs: now().toString(), available: true, error: null, transaction: found,
          source: { kind: "index", canister: index, method: "get_account_transactions", ledgerVerified: false, archived: false }, chainLength, diagnostics };
        diagnostics.push("The canonical index did not return this exact block; it can be behind the ledger. This does not prove the payout absent.");
      } catch (error) { signal?.throwIfAborted(); diagnostics.push(`Index lookup: ${errorMessage(error)}`); }
    } else if (source !== "ledger" && index === null) diagnostics.push("This ledger has no canonical account index for fallback.");
    return { version: 1, ledger, owner, blockIndex: block.toString(), observedAtNs: now().toString(), available: false, error: diagnostics.join(" "), transaction: null,
      source: { kind: "unavailable", canister: null, method: null, ledgerVerified: false, archived: false }, chainLength, diagnostics };
  }
  return { accountTransactions, transaction };
}
