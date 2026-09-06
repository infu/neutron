import { formatUnits } from "viem";
import { readFeeEstimates, totalEstimatedFee, type SwapFeeEstimates, type TransactionFeeEstimate } from "./fees.ts";

function Fee({ estimate, stage }: { estimate: TransactionFeeEstimate | null; stage: "approval" | "swap" }) {
  return <dd data-testid={`uniswap-${stage}-fee`}>
    {estimate?.estimatedFeeWei !== null && estimate?.estimatedFeeWei !== undefined
      ? <>{formatUnits(BigInt(estimate.estimatedFeeWei), 18)} ETH{estimate.maximumFeeWei !== null && <span className="uni-muted"> · maximum estimate {formatUnits(BigInt(estimate.maximumFeeWei), 18)} ETH</span>}</>
      : "Unavailable"}
    {estimate?.reason && <p className="uni-muted">{estimate.reason}</p>}
    {estimate?.blockNumber && <p className="uni-muted">Observed at block {estimate.blockNumber}. Fees can change before signing.</p>}
  </dd>;
}

/** Fee observations are informational. EVM Wallet separately reviews live fees. */
export function NetworkFees({ fees, approvalRequired, chainId, remaining = false }: { fees?: SwapFeeEstimates | undefined; approvalRequired: boolean; chainId: string; remaining?: boolean }) {
  const parsed = readFeeEstimates(fees);
  const total = parsed ? totalEstimatedFee(parsed) : null;
  const required = parsed ? [parsed.swap, ...(parsed.approval ? [parsed.approval] : [])] : [];
  const postingIncluded = required.length > 0 && required.every((estimate) => estimate.postingCosts === "included");
  return <div className="uni-fees" data-testid="uniswap-network-fees"><dl>
    {approvalRequired && <><dt>Approval network fee</dt><Fee estimate={parsed?.approval ?? null} stage="approval"/></>}
    <dt>Swap network fee</dt><Fee estimate={parsed?.swap ?? null} stage="swap"/>
    <dt>{remaining ? "Estimated remaining network fee" : "Estimated total network fee"}</dt><dd data-testid="uniswap-total-fee">{total === null ? "Unavailable" : `${formatUnits(BigInt(total), 18)} ETH`}</dd>
  </dl>
  {chainId === "42161" && <p className="uni-muted">{postingIncluded
    ? "Arbitrum estimates include L1 posting costs in the RPC gas estimate once; no separate posting fee is added."
    : "An Arbitrum total including L1 posting costs is unavailable for any step without a complete RPC estimate."}</p>}
  {approvalRequired && parsed?.swap.estimatedFeeWei === null && <p className="uni-muted">The swap may require the approval to confirm before it can be simulated. Refresh network fees after approval.</p>}
  <p className="uni-muted">EVM Wallet reviews current fees separately before each signature. These estimates authorize no transaction.</p>
  </div>;
}
