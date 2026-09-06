import type { EvmAccountId, EvmWalletClient } from "neutron-tools/evm_wallet";
import type { PreparedSwap, Transaction } from "./swap.ts";

export type TransactionFeeEstimate = {
  estimatedFeeWei: string | null;
  maximumFeeWei: string | null;
  gasLimit: string | null;
  gasPriceWei: string | null;
  baseFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  maxFeePerGasWei: string | null;
  feeBasis: "base_fee_plus_priority" | "gas_price" | "arbitrum_total_gas" | "unavailable";
  blockNumber: string | null;
  observedAtNs: string | null;
  postingCosts: "included" | "not_applicable" | "unavailable";
  reason: string | null;
};
export type SwapFeeEstimates = { approval: TransactionFeeEstimate | null; swap: TransactionFeeEstimate };

function quantity(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.exec(value)?.[0] === value;
}
function feeObservation(value: unknown): value is TransactionFeeEstimate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fee = value as Record<string, unknown>;
  return ["estimatedFeeWei", "maximumFeeWei", "gasLimit", "gasPriceWei", "baseFeePerGasWei", "maxPriorityFeePerGasWei", "maxFeePerGasWei", "blockNumber", "observedAtNs"].every((key) => quantity(fee[key]))
    && ["base_fee_plus_priority", "gas_price", "arbitrum_total_gas", "unavailable"].includes(String(fee.feeBasis))
    && ["included", "not_applicable", "unavailable"].includes(String(fee.postingCosts))
    && (fee.reason === null || typeof fee.reason === "string");
}
/** Older saved quotes have no fee annotation; malformed annotations are unavailable. */
export function readFeeEstimates(value: unknown): SwapFeeEstimates | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fees = value as Record<string, unknown>;
  if (!feeObservation(fees.swap) || fees.approval !== null && !feeObservation(fees.approval)) return null;
  return { approval: fees.approval as TransactionFeeEstimate | null, swap: fees.swap };
}

/** Sum only complete observations; never replace missing gas with Quoter units. */
export function totalEstimatedFee(fees: SwapFeeEstimates): string | null {
  const parsed = readFeeEstimates(fees);
  if (!parsed) return null;
  const required = [parsed.swap, ...(parsed.approval ? [parsed.approval] : [])];
  if (required.some((estimate) => estimate.estimatedFeeWei === null)) return null;
  return required.reduce((sum, estimate) => sum + BigInt(estimate.estimatedFeeWei!), 0n).toString();
}

function unavailable(reason: string): TransactionFeeEstimate {
  return { estimatedFeeWei: null, maximumFeeWei: null, gasLimit: null, gasPriceWei: null, baseFeePerGasWei: null, maxPriorityFeePerGasWei: null, maxFeePerGasWei: null, feeBasis: "unavailable", blockNumber: null, observedAtNs: null, postingCosts: "unavailable", reason };
}

async function estimateTransaction(wallet: EvmWalletClient, transaction: Transaction, accountAddress: string): Promise<TransactionFeeEstimate> {
  try {
    // The Wallet provider owns RPC selection and response validation. This read
    // does not prepare a command, reserve a nonce, or request a signature.
    const result = await wallet.estimateTransaction({ accountId: transaction.accountId as EvmAccountId, chainId: transaction.chainId, to: transaction.to, valueWei: transaction.value, data: transaction.data });
    if (result.address.toLowerCase() !== accountAddress.toLowerCase()) return unavailable("The fee estimate belongs to a different Wallet address. Reconnect and quote again.");
    const postingUnavailable = transaction.chainId === "42161" && result.postingCosts !== "included";
    const reasons = [...result.reasons, ...(postingUnavailable && result.status === "available" ? ["The RPC estimate does not establish Arbitrum L1 posting costs; a complete network fee is unavailable."] : [])];
    return {
      estimatedFeeWei: postingUnavailable ? null : result.estimatedFeeWei, maximumFeeWei: postingUnavailable ? null : result.maximumFeeWei,
      gasLimit: result.gasLimit, gasPriceWei: result.gasPriceWei,
      baseFeePerGasWei: result.baseFeePerGasWei, maxPriorityFeePerGasWei: result.maxPriorityFeePerGasWei, maxFeePerGasWei: result.maxFeePerGasWei, feeBasis: result.feeBasis,
      blockNumber: result.blockNumber, observedAtNs: result.observedAtNs,
      postingCosts: result.postingCosts, reason: reasons.length ? reasons.join(" ") : null,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export async function estimateSwapFees(wallet: EvmWalletClient, prepared: PreparedSwap, approvalComplete = false): Promise<SwapFeeEstimates> {
  // First-use read permissions share Kernel attention. Prompt once at a time.
  const approval = prepared.approval && !approvalComplete ? await estimateTransaction(wallet, prepared.approval, prepared.quote.accountAddress) : null;
  const swap = await estimateTransaction(wallet, prepared.swap, prepared.quote.accountAddress);
  return { approval, swap };
}
