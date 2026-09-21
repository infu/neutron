import { useState } from "react";
import { formatTokenAmount, parseTokenAmount } from "./format.ts";
import { withWithdrawalGasBudget, type WalletWithdrawalQuote } from "./withdrawal_quote.ts";

export function useWithdrawalGasBudget(source: WalletWithdrawalQuote | null) {
  const [custom, setCustom] = useState<{ source: WalletWithdrawalQuote; value: string } | null>(null);
  const value = custom?.source === source ? custom?.value ?? "" : source?.gas ? formatTokenAmount(source.gas.budget, 18).replaceAll(",", "") : "";
  let quote = source;
  let error: string | null = null;
  if (source?.gas) {
    try { quote = withWithdrawalGasBudget(source, parseTokenAmount(value, 18)); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  return { quote, value, error, onChange: (value: string) => { if (source) setCustom({ source, value }); } };
}

export function WithdrawalGasReview({ review, disabled }: {
  review: ReturnType<typeof useWithdrawalGasBudget>; disabled: boolean;
}) {
  const gas = review.quote?.gas;
  if (!gas) return null;
  return <div className="wallet-withdrawal-gas-review">
    <small>Estimated gas: {formatTokenAmount(gas.estimate, 18)} ckETH</small>
    <details className="wallet-withdrawal-advanced"><summary>Adjust maximum gas</summary>
      <label>Maximum gas (ckETH)<input className="nt-input" aria-label="Maximum gas (ckETH)" inputMode="decimal" autoComplete="off" value={review.value} disabled={disabled} onChange={(event) => review.onChange(event.target.value)} /></label>
      <small>The default allows 20% above the estimate for gas changes. The minter calculates the charge; unused allowance is not charged. The ckETH approval fee is separate.</small>
    </details>
    {review.error ? <small className="wallet-amount-error" role="alert">{review.error}</small> : null}
  </div>;
}
