import { useEffect, useRef, useState } from "react";
import { createMsgBusClient, updateSelf } from "neutron-tools/app";
import { createEvmWalletClient } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { IoArrowBack, IoCheckmark, IoOpenOutline, IoPeopleOutline, IoRefresh, IoWalletOutline } from "react-icons/io5";
import { TokenMark } from "./token_mark.tsx";
import { formatTokenAmount, maxTransferAmount, parseTransferAmount } from "./format.ts";
import { readWalletWithdrawalQuote, type WalletWithdrawalQuote } from "./withdrawal_quote.ts";
import { createEthereumWithdrawalAttempt, executeEthereumWithdrawal, type EthereumWithdrawalAttempt } from "./ethereum_withdrawal_controller.ts";
import type { WalletTransferOperation } from "./transfers.ts";
import type { WalletLedger } from "./wallet_data.ts";

export type EthereumDestinationMode = "evm" | "address" | "contacts";
export function EthereumDestinationTabs({ mode, onMode, disabled = false }: { mode: EthereumDestinationMode; onMode: (mode: EthereumDestinationMode) => void; disabled?: boolean }) {
  return <div className="wallet-ethereum-destination-tabs" aria-label="Ethereum recipient">
    <button type="button" aria-pressed={mode === "evm"} disabled={disabled} onClick={() => onMode("evm")}><IoWalletOutline /> EVM Wallet</button>
    <button type="button" aria-pressed={mode === "address"} disabled={disabled} onClick={() => onMode("address")}>Ethereum address</button>
    <button type="button" title="Choose a saved contact" aria-label="Choose a saved contact" aria-pressed={mode === "contacts"} disabled={disabled} onClick={() => onMode("contacts")}><IoPeopleOutline /></button>
  </div>;
}

/** A direct withdrawal uses the same durable minter journal as contact sends.
 * No allowance or withdrawal is submitted until the explicit Withdraw action.
 */
export function WalletEthereumWithdrawal({ ledger, mode, onMode, onBack, onNetwork, operations, onOperation }: {
  ledger: WalletLedger; mode: Exclude<EthereumDestinationMode, "contacts">;
  onMode: (mode: EthereumDestinationMode) => void; onBack: () => void;
  onNetwork: () => void; operations: WalletTransferOperation[];
  onOperation: (operation: WalletTransferOperation) => void;
}) {
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<WalletWithdrawalQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<WalletTransferOperation | null>(null);
  const attempt = useRef<EthereumWithdrawalAttempt | null>(null);
  const running = useRef(false);
  const onOperationRef = useRef(onOperation);
  onOperationRef.current = onOperation;
  const nativeSymbol = ledger.symbol?.startsWith("ck") ? ledger.symbol.slice(2) : ledger.symbol ?? "tokens";
  const symbol = ledger.symbol ?? "tokens";

  useEffect(() => {
    if (mode !== "evm" || attempt.current) return;
    let active = true;
    setAccountBusy(true); setAccountError(null);
    void createEvmWalletClient(createMsgBusClient()).accounts().then((result) => {
      const account = result.accounts.find((candidate) => candidate.accountId === "main");
      if (!account) throw new Error("EVM Wallet has no available account. You can enter an Ethereum address instead.");
      if (active) setEvmAddress(getAddress(account.address));
    }).catch((reason) => { if (active) setAccountError(message(reason)); })
      .finally(() => { if (active) setAccountBusy(false); });
    return () => { active = false; };
  }, [mode, readRevision]);

  useEffect(() => {
    if (attempt.current) return;
    let active = true;
    setQuoteBusy(true); setQuoteError(null);
    void readWalletWithdrawalQuote({ ledger: ledger.principal }, updateSelf).then((next) => {
      if (active) setQuote(next);
    }).catch((reason) => { if (active) setQuoteError(message(reason)); })
      .finally(() => { if (active) setQuoteBusy(false); });
    return () => { active = false; };
  }, [ledger.principal, readRevision]);

  // Wallet's shared visible-page poll refreshes submitted withdrawals only.
  // Retain a terminal result when its acknowledged journal row disappears.
  useEffect(() => {
    const saved = attempt.current;
    if (!saved) return;
    const next = operations.find((entry) => entry.requestId === saved.requestId);
    if (!next || saved.operation?.settlement?.status === "confirmed" || saved.operation?.settlement?.status === "failed") return;
    if (saved.operation?.status !== "pending" && saved.operation !== null && next.status === "pending") return;
    saved.operation = next;
    setOperation(next);
  }, [operations]);

  const destination = attempt.current ? String(attempt.current.args.address) : mode === "evm" ? evmAddress ?? "" : address.trim();
  let addressError: string | null = null;
  if (destination) { try { getAddress(destination); } catch { addressError = "Enter a valid Ethereum address."; } }
  const reviewedLedger = quote ? { ...ledger, balance: quote.assetBalance, fee: quote.assetFee } : ledger;
  let amountAtoms: string | null = null;
  let amountError: string | null = null;
  if (amount.trim()) { try { amountAtoms = parseTransferAmount(amount, reviewedLedger); } catch (reason) { amountError = message(reason); } }
  const maximum = maxTransferAmount(reviewedLedger);
  const ready = quote !== null && !quoteBusy && quoteError === null && amountAtoms !== null && !amountError && destination !== "" && !addressError && !(mode === "evm" && (accountBusy || accountError)) && (quote.gas === null || quote.gas.sufficient);
  const accepted = operation?.status === "succeeded";
  const complete = accepted && operation.settlement?.status === "confirmed";
  const failed = operation?.status === "rejected" || operation?.settlement?.status === "failed";
  const saved = attempt.current !== null;
  const stateMessage = complete ? `${nativeSymbol} received on Ethereum.` : accepted ? operation.settlement?.message ?? "Your withdrawal is queued. Receiving tokens on Ethereum can take a few minutes." : operation?.message ?? (saved ? "The withdrawal is saved. Continue the same request to check its progress." : null);
  const remember = (next: WalletTransferOperation) => {
    setOperation(next);
    onOperationRef.current(next);
  };
  const submit = async () => {
    if (running.current || (!attempt.current && !ready)) return;
    running.current = true; setBusy(true); setError(null);
    try {
      if (!attempt.current) attempt.current = createEthereumWithdrawalAttempt({ ledger: ledger.principal, address: destination, amountAtoms: amountAtoms!, quote: quote! });
      await executeEthereumWithdrawal(attempt.current, { updateSelf }, remember);
    } catch (reason) { setError(message(reason)); }
    finally { running.current = false; setBusy(false); }
  };
  const displayAtoms = (atoms: string, decimals = ledger.decimals, ticker = symbol) => decimals === null ? `${atoms} units` : `${formatTokenAmount(atoms, decimals)} ${ticker}`;

  return <section className="wallet-transfer wallet-ethereum-withdrawal" aria-label={`Withdraw ${symbol} to Ethereum`}>
    <header className="wallet-destination-toolbar">
      <button className="nt-icon-button" type="button" title="Back to tokens" aria-label="Back to tokens" disabled={busy} onClick={onBack}><IoArrowBack /></button>
      <TokenMark logo={ledger.logo} symbol={symbol} />
      <span className="wallet-destination-title"><strong>Withdraw {symbol}</strong><small>Internet Computer → Ethereum</small></span>
      <select aria-label="Transfer network" className="wallet-network-select" disabled={busy || saved} value="ethereum_mainnet" onChange={() => onNetwork()}><option value="internet_computer">Internet Computer</option><option value="ethereum_mainnet">Ethereum</option></select>
    </header>
    <div className="wallet-transfer-body">
      {!saved ? <EthereumDestinationTabs mode={mode} onMode={onMode} disabled={busy} /> : null}
      <div className="wallet-ethereum-recipient">
        <span className="wallet-transfer-label">To {mode === "evm" ? "your EVM Wallet" : "Ethereum address"}</span>
        {mode === "address" && !saved ? <input className="nt-input" aria-label="Ethereum recipient address" value={address} onChange={(event) => { setAddress(event.target.value); setError(null); }} autoComplete="off" spellCheck={false} placeholder="0x…" /> : <code title={destination}>{accountBusy && !saved ? "Connecting to EVM Wallet…" : destination || "Account unavailable"}</code>}
        {addressError ? <small role="alert">{addressError}</small> : null}
        {mode === "evm" && accountError && !saved ? <small role="alert">{accountError}</small> : null}
      </div>
      <div className="wallet-amount-field">
        <div className="wallet-amount-heading"><label htmlFor="wallet-ethereum-amount">Amount</label><button className="wallet-max-button" disabled={busy || saved || maximum === null} type="button" onClick={() => maximum !== null && setAmount(maximum)}>Max</button></div>
        <label className="wallet-amount-control"><input id="wallet-ethereum-amount" aria-label="Withdrawal amount" autoComplete="off" inputMode="decimal" value={amount} disabled={busy || saved} placeholder="0" onChange={(event) => { setAmount(event.target.value); setError(null); }} /><strong>{symbol}</strong></label>
        {amountError && !saved ? <span className="wallet-amount-error" role="alert">{amountError}</span> : null}
        <p className="wallet-ethereum-receive">{amount.trim() || "0"} {nativeSymbol} on Ethereum{quote?.gas === null ? " · network fee deducted" : ""}</p>
      </div>
      {!saved ? <>
        <dl className="wallet-transfer-details">
          <div><dt>Available</dt><dd>{reviewedLedger.balance === null ? "—" : displayAtoms(reviewedLedger.balance)}</dd></div>
          <div><dt>Approval fee</dt><dd>{quote ? displayAtoms(quote.assetFee) : "—"}</dd></div>
          {quote?.gas ? <div className="wallet-withdrawal-cost"><dt>Maximum Ethereum gas cost</dt><dd>{displayAtoms(quote.gas.totalDebit, 18, "ckETH")}</dd></div> : null}
        </dl>
        {quoteBusy ? <small role="status">Checking fees and balances…</small> : null}
        {quoteError ? <small className="wallet-amount-error" role="alert">{quoteError}</small> : null}
        {quote?.gas && !quote.gas.sufficient ? <small className="wallet-amount-error" role="alert">You need {displayAtoms(quote.gas.totalDebit, 18, "ckETH")} to cover Ethereum gas and its approval fee.</small> : null}
      </> : <div className={`wallet-ethereum-progress${complete ? " is-complete" : ""}`} role="status">
        <strong>{complete ? "Withdrawal complete" : failed ? "Withdrawal stopped" : busy ? "Preparing withdrawal…" : accepted ? "On its way to Ethereum" : "Withdrawal saved"}</strong>
        <ol><li className={accepted ? "is-complete" : "is-current"}>{accepted ? <IoCheckmark /> : <span>1</span>} Withdraw from Internet Computer</li><li className={complete ? "is-complete" : accepted ? "is-current" : ""}>{complete ? <IoCheckmark /> : <span>2</span>} Receive {nativeSymbol} on Ethereum</li></ol>
        <small>{stateMessage}</small>
        {accepted && !complete && !failed ? <small>Progress updates automatically while Wallet is open.</small> : null}
        {operation?.settlement?.transactionHash ? <a href={`https://etherscan.io/tx/${operation.settlement.transactionHash}`} target="_blank" rel="noopener noreferrer">View on Etherscan <IoOpenOutline /></a> : null}
      </div>}
      {error ? <p className="wallet-amount-error" role="alert">{saved ? `Your request is saved. ${error}` : error}</p> : null}
      <div className="wallet-ethereum-submit">
        {complete || failed ? <button className="nt-button" type="button" onClick={onBack}>Done</button> : <button className="nt-button" type="button" disabled={busy || (!saved && !ready)} onClick={() => void submit()}>{busy ? <span className="wallet-spinner" /> : accepted ? <IoRefresh /> : null}{busy ? "Processing…" : accepted ? "Check progress" : saved ? "Continue withdrawal" : `Withdraw ${symbol}`}</button>}
        {!saved ? <button className="nt-icon-button" type="button" title="Refresh fees and balances" aria-label="Refresh fees and balances" disabled={quoteBusy || accountBusy} onClick={() => setReadRevision((value) => value + 1)}><IoRefresh /></button> : null}
      </div>
      {quote || saved ? <details className="wallet-withdrawal-advanced"><summary>Details</summary><dl className="wallet-transfer-details">
        <div><dt>Recipient</dt><dd><code>{destination}</code></dd></div>
        {quote ? <><div><dt>Token approval</dt><dd>{amountAtoms ?? "—"} atomic units</dd></div><div><dt>Approval fee</dt><dd>{quote.assetFee} atomic units</dd></div>{quote.gas ? <><div><dt>ckETH gas budget</dt><dd>{displayAtoms(quote.gas.budget, 18, "ckETH")}</dd></div><div><dt>ckETH approval fee</dt><dd>{displayAtoms(quote.gas.ledgerFee, 18, "ckETH")}</dd></div><div><dt>ckETH allowance</dt><dd>{quote.gas.allowance} atomic units</dd></div><div><dt>Available ckETH</dt><dd>{displayAtoms(quote.gas.balance, 18, "ckETH")}</dd></div></> : <div><dt>Ethereum gas</dt><dd>Deducted from the withdrawn ETH</dd></div>}<div><dt>Quote checked</dt><dd>{new Date(Number(BigInt(quote.observedAtNs) / 1_000_000n)).toLocaleTimeString()}</dd></div></> : null}
        {attempt.current ? <div><dt>Request</dt><dd><code>{attempt.current.requestId}</code></dd></div> : null}
      </dl><p>Ethereum Mainnet. Costs are checked again before approvals; a changed quote requires a fresh review.</p></details> : null}
    </div>
  </section>;
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
