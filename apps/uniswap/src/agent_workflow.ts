import {
  EVM_WALLET_TARGET, EVM_WALLET_TOOLS, parseEvmOperationStatusResult,
  type EvmOperationStatusResult, type EvmWalletCaller,
  type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import {
  checkAccount, effectiveOperation, savedIntent, stageRequest, storedOperation, validateOperation, verifyAgentResult,
  type Store, type SwapRecord,
} from "./controller.ts";

type Stage = "approval" | "swap";
type NextCall = { target: string; tool: string; argsJson: string };
export type AgentSwapAction = {
  swapId: string;
  phase: string;
  state: "check_status" | "send" | "wait" | "complete" | "quote_expired" | "stopped";
  stage: Stage | null;
  message: string;
  nextCall: NextCall | null;
  pollAfterSeconds: number | null;
};
export type AgentSwapObservations = { swapOperationJson: string | null; approvalOperationJson: string | null };

function observation(record: SwapRecord, stage: Stage, json: string | null): EvmOperationStatusResult | null {
  if (json === null) return null;
  const requestId = stage === "approval" ? record.approval_request_id : record.swap_request_id;
  if (!requestId) throw new Error("This saved swap has no approval request.");
  const result = parseEvmOperationStatusResult(JSON.parse(json), { accountId: "main", chainId: record.chain_id, requestId });
  if (result.status !== "not_found") validateOperation(record, stage, result);
  return result;
}

/** One bounded continuation step. Wallet journal reads and signatures stay with
 * the owning root Agent. Supplied hashes use the same independent public-chain
 * and Wallet request-binding verification as uniswap_record_result_v1.
 */
export async function nextAgentSwapAction(
  wallet: EvmWalletClient, store: Store, initial: SwapRecord, caller: EvmWalletCaller,
  observations: AgentSwapObservations, nowMs?: number,
): Promise<AgentSwapAction> {
  let record = await store.get(initial.id) ?? initial;
  const intent = savedIntent(record);
  if (intent.executionMode !== "agent" || intent.walletCaller?.appId !== caller.appId || intent.walletCaller.installationUid !== caller.installationUid) {
    throw new Error("Continue this swap from the Agent installation that created it.");
  }
  const results = {
    swap: observation(record, "swap", observations.swapOperationJson),
    approval: observation(record, "approval", observations.approvalOperationJson),
  };
  const nowSeconds = () => BigInt(Math.floor((nowMs ?? Date.now()) / 1000));
  const quoteExpired = () => BigInt(intent.quote.deadline) <= nowSeconds();
  const result = (state: AgentSwapAction["state"], stage: Stage | null, message: string, nextCall: NextCall | null = null, pollAfterSeconds: number | null = null): AgentSwapAction => ({
    swapId: record.id, phase: record.phase, state, stage, message, nextCall, pollAfterSeconds,
  });
  const status = (stage: Stage, pending = false, message = ""): AgentSwapAction => result(
    pending ? "wait" : "check_status", stage,
    message || `Call EVM Wallet directly as the owning root Agent to reconcile the saved ${stage} request. Pass its result back as ${stage}OperationJson; retain the other latest observation.`,
    { target: EVM_WALLET_TARGET, tool: EVM_WALLET_TOOLS.operationStatus, argsJson: JSON.stringify({ accountId: record.account_id, chainId: record.chain_id, requestId: stage === "swap" ? record.swap_request_id : record.approval_request_id }) },
    pending ? 3 : null,
  );
  const send = async (stage: Stage): Promise<AgentSwapAction> => {
    await checkAccount(wallet, intent);
    if (quoteExpired()) return expired();
    const request = stageRequest(record, stage);
    return result("send", stage,
      `Call this exact saved ${stage} request directly through the root Wallet tool within the owner's instructions. Then call uniswap_next_action_v1 with the returned operation as ${stage}OperationJson. If the reply is lost, reconcile this same request ID; do not create another intent.`,
      { target: EVM_WALLET_TARGET, tool: EVM_WALLET_TOOLS.sendTransactionRoot, argsJson: JSON.stringify(request) });
  };
  const expired = (): AgentSwapAction => {
    const quote = intent.quote;
    const quotedAtSeconds = Math.floor(quote.quotedAtMs / 1000);
    if (!Number.isSafeInteger(quotedAtSeconds)) throw new Error("Saved quote creation time is unavailable; choose a fresh deadline within the owner's instructions.");
    const validitySeconds = BigInt(quote.deadline) - BigInt(quotedAtSeconds);
    if (validitySeconds <= 0n) throw new Error("Saved quote validity is unavailable; choose a fresh deadline within the owner's instructions.");
    return result("quote_expired", null,
      "The old swap is unsigned and its approval is resolved. Continue with this fresh quote, preserving the original amount, tokens, recipient and slippage and renewing the original quote validity window. Check it against the owner's instructions, then prepare a distinct swapId. The quote reads the live allowance and reuses any confirmed approval; do not approve again unless the new preparation requires it. Retain the old intent and never submit its expired calldata.",
      { target: "app:uniswap:background", tool: "uniswap_quote_v1", argsJson: JSON.stringify({
        chainId: quote.chainId, accountId: quote.accountId, tokenIn: quote.tokenIn.address, tokenOut: quote.tokenOut.address,
        amountIn: quote.amountIn, slippageBps: quote.slippageBps, recipient: quote.recipient,
        deadline: String(nowSeconds() + validitySeconds),
      }) });
  };

  // Always reconcile swap first: approval progress or expiry cannot establish
  // that a lost swap submission did not already spend the requested amount.
  for (const stage of ["swap", "approval"] as const) {
    if (stage === "approval" && record.approval_request_id === null) continue;
    const latest = results[stage];
    if (!latest) return status(stage);
    if (latest.status !== "not_found" && latest.transactionHash) {
      try {
        record = await verifyAgentResult(wallet, store, record, stage, latest);
      } catch (error) {
        if (error instanceof Error && error.message === "Transaction is not yet visible through EVM RPC. Keep the same request ID and check again.") {
          return status(stage, true, "The saved transaction is not yet visible through RPC. Wait, then reconcile the same Wallet request and pass the result back. Quote expiry does not authorize another swap.");
        }
        throw error;
      }
      const verified = effectiveOperation(record, stage)!;
      if (verified.status === "confirmed" && verified.receipt?.status === "success") {
        if (stage === "swap") return result("complete", "swap", "The saved swap has an independently verified successful receipt. Do not submit another swap. Receipt inclusion is not necessarily final settlement.");
        continue;
      }
      if (["reverted", "replaced"].includes(verified.status)) {
        return result("stopped", stage, `The saved ${stage} did not complete: ${verified.message ?? verified.status}. Keep its evidence. A new attempt requires checking the owner's instructions; never report this as a successful swap.`);
      }
      return status(stage, true, `The saved ${stage} is still unresolved. Wait, then reconcile the same root Wallet request and pass its latest result back. Do not repeat the signature or replace the intent, even if its quote expires.`);
    }
    // An absent or unsigned claim cannot erase a previously verified hash.
    // Only another independent observation can change recorded chain evidence.
    if (storedOperation(record, stage)?.transactionHash) {
      return status(stage, true, `The supplied ${stage} status conflicts with a transaction already retained in the saved journal. Reconcile the same original request from its owning Agent installation; do not create a replacement intent.`);
    }
    if (latest.status === "rejected") return result("stopped", stage, `The ${stage} request was declined. Keep the saved request; do not turn that decision into another transaction.`);
    if (!["not_found", "prepared", "failed"].includes(latest.status)) {
      return status(stage, true, `The saved ${stage} may already be signing or have an uncertain effect. Reconcile that same root Wallet request and pass its result back before continuing.`);
    }
    if (latest.status === "failed" && !quoteExpired()) return result("stopped", stage, `The saved ${stage} failed before a transaction hash was available. Inspect the Wallet error before another attempt: ${latest.message ?? "No additional error detail."}`);
    if (stage === "approval") return quoteExpired() ? expired() : send("approval");
  }
  return quoteExpired() ? expired() : send("swap");
}
