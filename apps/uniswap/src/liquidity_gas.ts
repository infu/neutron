import {
  parseEvmEstimateTransactionResult, parseEvmSendTransactionRequest,
  type EvmEstimateTransactionResult, type EvmSendTransactionRequest,
  type EvmWalletCallOptions, type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import { V3_POSITION_MANAGER } from "./positions.ts";

// A V3 increase can accrue fees and update position/pool storage after the
// estimate's block. The September 2026 production reproduction grew from
// 193,332 to 245,079 estimated gas in four blocks; Wallet's 20% margin was
// insufficient. Reserve another 100,000 gas for this operation only. This is
// a reviewed maximum, not gas charged, and cannot guarantee future state costs.
export const V3_INCREASE_ADDITIONAL_GAS = 100_000n;

/** The Wallet estimate already contains its own automatic gas headroom. */
export function v3IncreaseGasLimit(walletGasLimit: bigint): bigint {
  if (walletGasLimit <= 0n) throw new Error("The Wallet gas estimate must be positive.");
  return walletGasLimit + V3_INCREASE_ADDITIONAL_GAS;
}

export type LiquidityGasDiagnostics = {
  version: 1;
  basis: "wallet_estimate_plus_v3_increase_reserve";
  /** Exact public Wallet observation, including its block and fee evidence.
   * gasLimit is Wallet's proposed limit, not a raw eth_estimateGas quantity. */
  observation: EvmEstimateTransactionResult;
  additionalGas: string;
  gasLimit: string;
  /** At the observed suggested fee; the final Wallet review uses fresh fees. */
  maximumFeeWei: string | null;
};

/** Read-only preparation immediately before an undispatched increase. The
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
  if (context.kind !== "liquidity" || context.input.protocol !== "v3" || context.input.operation !== "increase"
      || context.stepKind !== "transaction" || context.request.gasLimit !== undefined) return null;
  const request = parseEvmSendTransactionRequest(context.request);
  if (request.to.toLowerCase() !== V3_POSITION_MANAGER.toLowerCase()) throw new Error("The V3 increase does not target the position manager.");
  options?.signal?.throwIfAborted();
  const { accountId, chainId, to, valueWei, data } = request;
  const readRequest = { accountId, chainId, to, valueWei, data };
  const observation = parseEvmEstimateTransactionResult(await wallet.estimateTransaction(readRequest, options), readRequest);
  options?.signal?.throwIfAborted();
  if (observation.address.toLowerCase() !== context.accountAddress.toLowerCase()) throw new Error("The gas estimate belongs to a different Wallet address.");
  if (observation.gasLimit === null || observation.blockNumber === null) {
    throw new Error(`Could not estimate this V3 increase before signing. Continue the same operation ID to retry preparation. ${observation.reasons.join(" ")}`.trim());
  }
  const gasLimit = v3IncreaseGasLimit(BigInt(observation.gasLimit)).toString();
  return {
    request: parseEvmSendTransactionRequest({ ...request, gasLimit }),
    diagnostics: {
      version: 1, basis: "wallet_estimate_plus_v3_increase_reserve", observation,
      additionalGas: V3_INCREASE_ADDITIONAL_GAS.toString(), gasLimit,
      maximumFeeWei: observation.maxFeePerGasWei === null ? null : (BigInt(gasLimit) * BigInt(observation.maxFeePerGasWei)).toString(),
    },
  };
}
