import {
  parseEvmEstimateTransactionResult, parseEvmSendTransactionRequest,
  type EvmEstimateTransactionResult, type EvmSendTransactionRequest,
  type EvmWalletCallOptions, type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import { positionManager } from "./positions.ts";

// A V3 increase can accrue fees and update position/pool storage after the
// estimate's block. The September 2026 production reproduction grew from
// 193,332 to 245,079 estimated gas in four blocks; Wallet's 20% margin was
// insufficient. Reserve another 100,000 gas for this operation only. This is
// a reviewed maximum, not gas charged, and cannot guarantee future state costs.
export const V3_INCREASE_ADDITIONAL_GAS = 100_000n;

// V4 collect skips settlement work when no fees are due. Production estimates
// grew from 83,006 to 113,315 as fees arrived; the earlier 99,608 limit ran out
// of gas inside unlockCallback. Reserve settlement/storage work in either
// currency, including native ETH. The same additional 100,000 succeeds in the
// historical trace and zero-to-two-currency local fee-accrual regressions.
export const V4_COLLECT_ADDITIONAL_GAS = 100_000n;

function withReserve(walletGasLimit: bigint, additionalGas: bigint): bigint {
  if (walletGasLimit <= 0n) throw new Error("The Wallet gas estimate must be positive.");
  return walletGasLimit + additionalGas;
}

/** The Wallet estimate already contains its own automatic gas headroom. */
export function v3IncreaseGasLimit(walletGasLimit: bigint): bigint {
  return withReserve(walletGasLimit, V3_INCREASE_ADDITIONAL_GAS);
}

export function v4CollectGasLimit(walletGasLimit: bigint): bigint {
  return withReserve(walletGasLimit, V4_COLLECT_ADDITIONAL_GAS);
}

export type LiquidityGasDiagnostics = {
  version: 1;
  basis: "wallet_estimate_plus_v3_increase_reserve" | "wallet_estimate_plus_v4_collect_reserve";
  /** Exact public Wallet observation, including its block and fee evidence.
   * gasLimit is Wallet's proposed limit, not a raw eth_estimateGas quantity. */
  observation: EvmEstimateTransactionResult;
  additionalGas: string;
  gasLimit: string;
  /** At the observed suggested fee; the final Wallet review uses fresh fees. */
  maximumFeeWei: string | null;
};

/** Read-only preparation immediately before an undispatched liquidity action. The
 * caller journals the returned exact request before sending and never calls
 * this again for a dispatched request. Wallet independently estimates and
 * simulates this explicit cap before approval/signing. */
export async function prepareLiquidityGas(
  wallet: Pick<EvmWalletClient, "estimateTransaction">,
  context: {
    kind: string; input: Record<string, unknown>; stepKind: "approval" | "transaction";
    accountAddress: string; request: EvmSendTransactionRequest;
  },
  options?: EvmWalletCallOptions,
): Promise<{ request: EvmSendTransactionRequest; diagnostics: LiquidityGasDiagnostics } | null> {
  if (context.kind !== "liquidity" || context.stepKind !== "transaction" || context.request.gasLimit !== undefined) return null;
  const v3Increase = context.input.protocol === "v3" && context.input.operation === "increase";
  const v4Collect = context.input.protocol === "v4" && context.input.operation === "collect";
  if (!v3Increase && !v4Collect) return null;
  const protocol = v3Increase ? "v3" : "v4", label = v3Increase ? "V3 increase" : "V4 collect";
  const request = parseEvmSendTransactionRequest(context.request);
  if (request.to.toLowerCase() !== positionManager(request.chainId, protocol).toLowerCase()) throw new Error(`The ${label} does not target the position manager.`);
  options?.signal?.throwIfAborted();
  const { accountId, chainId, to, valueWei, data } = request;
  const readRequest = { accountId, chainId, to, valueWei, data };
  const observation = parseEvmEstimateTransactionResult(await wallet.estimateTransaction(readRequest, options), readRequest);
  options?.signal?.throwIfAborted();
  if (observation.address.toLowerCase() !== context.accountAddress.toLowerCase()) throw new Error("The gas estimate belongs to a different Wallet address.");
  if (observation.gasLimit === null || observation.blockNumber === null) {
    throw new Error(`Could not estimate this ${label} before signing. Continue the same operation ID to retry preparation. ${observation.reasons.join(" ")}`.trim());
  }
  const gasLimit = (v3Increase ? v3IncreaseGasLimit : v4CollectGasLimit)(BigInt(observation.gasLimit)).toString();
  const additionalGas = v3Increase ? V3_INCREASE_ADDITIONAL_GAS : V4_COLLECT_ADDITIONAL_GAS;
  return {
    request: parseEvmSendTransactionRequest({ ...request, gasLimit }),
    diagnostics: {
      version: 1, basis: v3Increase ? "wallet_estimate_plus_v3_increase_reserve" : "wallet_estimate_plus_v4_collect_reserve", observation,
      additionalGas: additionalGas.toString(), gasLimit,
      maximumFeeWei: observation.maxFeePerGasWei === null ? null : (BigInt(gasLimit) * BigInt(observation.maxFeePerGasWei)).toString(),
    },
  };
}
