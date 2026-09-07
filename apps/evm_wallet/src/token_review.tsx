import { when, type TokenEvidence } from "./data.ts";

export function TokenReview({
  evidence,
  busy,
  onRefresh,
  fungible = true,
}: {
  evidence: TokenEvidence | null;
  busy: boolean;
  onRefresh: () => void;
  fungible?: boolean;
}) {
  const allowance = evidence?.allowance?.value ?? null;
  let change: string | null = null;
  if (fungible && evidence?.method === "approve" && allowance !== null) {
    const delta = BigInt(evidence.amount) - BigInt(allowance);
    change = delta === 0n
      ? "No change from the observed allowance"
      : `${delta > 0n ? "Increase" : "Decrease"} by ${delta < 0n ? -delta : delta} atomic units`;
  }
  return (
    <section className="evm-token-review" data-testid="evm-token-review">
      <h3 className="evm-card-title">{fungible ? "Token balance and allowance" : "Token contract observations"}</h3>
      {evidence ? (
        <>
          <dl className="evm-review-details">
            <dt>Token contract</dt>
            <dd>{evidence.contract}</dd>
            <dt>Token owner</dt>
            <dd>{evidence.owner}</dd>
            <dt>{fungible ? "Observed token balance" : "Observed balanceOf(owner)"}</dt>
            <dd data-testid="evm-review-token-balance">
              {evidence.balance.value === null
                ? `Unavailable: ${evidence.balance.error}`
                : `${evidence.balance.value} ${fungible ? "atomic units" : "(token units or token count)"}`}
            </dd>
            {evidence.spender && (
              <>
                <dt>{fungible ? "Allowance spender" : "Address used for allowance read"}</dt>
                <dd>{evidence.spender}</dd>
              </>
            )}
            {evidence.allowance && (
              <>
                <dt>{fungible ? "Observed allowance" : "Observed allowance(owner, spender)"}</dt>
                <dd data-testid="evm-review-token-allowance">
                  {allowance === null
                    ? `Unavailable: ${evidence.allowance.error}`
                    : `${allowance} ${fungible ? "atomic units" : "(ERC-20 allowance units)"}`}
                </dd>
              </>
            )}
            {fungible && evidence.method === "approve" && (
              <>
                <dt>Requested allowance</dt>
                <dd>{evidence.amount} atomic units</dd>
                <dt>Requested allowance change</dt>
                <dd data-testid="evm-review-allowance-change">
                  {change ?? "Unavailable until the allowance read succeeds"}
                </dd>
              </>
            )}
            {!fungible && (evidence.method === "approve" || evidence.method === "transferFrom") && (
              <>
                <dt>{evidence.method === "approve" ? "Requested allowance or token ID" : "Requested amount or token ID"}</dt>
                <dd>{evidence.amount}</dd>
              </>
            )}
            <dt>Observed block</dt>
            <dd>
              {evidence.blockNumber ?? "Unavailable"}
              {evidence.blockError && ` · ${evidence.blockError}`}
            </dd>
            {evidence.blockHash && (
              <>
                <dt>Observed block hash</dt>
                <dd>{evidence.blockHash}</dd>
              </>
            )}
            <dt>Observed at</dt>
            <dd>{when(evidence.observedAtNs)}</dd>
          </dl>
          <p className="evm-muted" data-testid="evm-review-token-freshness">
            Saved observations from the block and time shown above. Balances and
            allowances may have changed since then. Refresh to read them again.
          </p>
        </>
      ) : (
        <p className="evm-notice" data-testid="evm-review-token-missing">
          This saved review has no token observations. Refresh to check the
          token balance and any applicable allowance.
        </p>
      )}
      <p className="evm-muted">
        {fungible
          ? "ERC-20 labels are inferred from calldata. The contract implementation and token identity are not authenticated; these observations do not guarantee the contract’s behavior."
          : "The token interface is not identified. Shared approve and transferFrom selectors can refer to ERC-20 quantities or ERC-721 token IDs. The reads above show the contract's responses to balanceOf and allowance; they do not establish an allowance change or guarantee the contract's behavior."}
      </p>
      <button
        type="button"
        className="nt-button nt-button--secondary"
        data-testid="evm-review-token-refresh"
        disabled={busy}
        onClick={onRefresh}
      >
        {busy ? "Working…" : "Refresh token observations"}
      </button>
    </section>
  );
}
