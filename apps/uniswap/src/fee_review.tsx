import { formatUnits } from "viem";
import { readFeeEstimates, totalEstimatedFee, type SwapFeeEstimates, type TransactionFeeEstimate } from "./fees.ts";
import type { EvmUsdPrice } from "neutron-tools/src/evm_prices.js";
import { UsdAmount } from "./usd_amount.tsx";

function Fee({ estimate, stage, nativePrice }: { estimate: TransactionFeeEstimate | null; stage: "approval" | "swap"; nativePrice: EvmUsdPrice | undefined }) {
  return <dd data-testid={`uniswap-${stage}-fee`}>
    {estimate?.estimatedFeeWei !== null && estimate?.estimatedFeeWei !== undefined
      ? <>{formatUnits(BigInt(estimate.estimatedFeeWei), 18)} ETH<UsdAmount atoms={estimate.estimatedFeeWei} decimals={18} price={nativePrice} label={`${stage} network fee in USD`}/>{estimate.maximumFeeWei !== null && <span className="uni-muted"> · maximum estimate {formatUnits(BigInt(estimate.maximumFeeWei), 18)} ETH<UsdAmount atoms={estimate.maximumFeeWei} decimals={18} price={nativePrice} label={`Maximum ${stage} network fee in USD`}/></span>}</>
      : "Unavailable"}
    {estimate?.reason && <p className="uni-muted">{estimate.reason}</p>}
    {estimate?.blockNumber && <p className="uni-muted">Observed at block {estimate.blockNumber}. Fees can change before signing.</p>}
  </dd>;
}

/** Fee observations are informational. EVM Wallet separately reviews live fees. */
export function NetworkFees({ fees, approvalRequired, chainId, remaining = false, nativePrice }: { fees?: SwapFeeEstimates | undefined; approvalRequired: boolean; chainId: string; remaining?: boolean; nativePrice?: EvmUsdPrice | undefined }) {
  const parsed = readFeeEstimates(fees);
  const total = parsed ? totalEstimatedFee(parsed) : null;
  const required = parsed ? [parsed.swap, ...(parsed.approval ? [parsed.approval] : [])] : [];
  const postingIncluded = required.length > 0 && required.every((estimate) => estimate.postingCosts === "included");
  return <div className="uni-fees" data-testid="uniswap-network-fees"><dl>
    {approvalRequired && <><dt>Approval network fee</dt><Fee estimate={parsed?.approval ?? null} stage="approval" nativePrice={nativePrice}/></>}
    <dt>Swap network fee</dt><Fee estimate={parsed?.swap ?? null} stage="swap" nativePrice={nativePrice}/>
    <dt>{remaining ? "Estimated remaining network fee" : "Estimated total network fee"}</dt><dd data-testid="uniswap-total-fee">{total === null ? "Unavailable" : `${formatUnits(BigInt(total), 18)} ETH`}<UsdAmount atoms={total} decimals={18} price={nativePrice} label="Total network fee in USD"/></dd>
  </dl>
  {chainId === "42161" && <p className="uni-muted">{postingIncluded
    ? "Arbitrum estimates include L1 posting costs in the RPC gas estimate once; no separate posting fee is added."
    : "An Arbitrum total including L1 posting costs is unavailable for any step without a complete RPC estimate."}</p>}
  {approvalRequired && parsed?.swap.estimatedFeeWei === null && <p className="uni-muted">The swap fee becomes available after token approval. Your wallet will show the current fee before you confirm.</p>}
  <p className="uni-muted">Network fees can change. Review the final fee in your wallet.</p>
  </div>;
}
