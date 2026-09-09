// The swap panel.
//
// Two legs, pay above and receive below, because that is what a swap is. The
// middle step is not ours: we quote, the Wallet takes the owner's decision in
// its own modal, then we instruct the pool. There is deliberately no confirm
// button here that moves money — the only confirmation that matters happens in
// the Wallet.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "neutron-design-system";
import { createMsgBusClient } from "neutron-tools/app";
import {
  describeAmountProblem,
  fromBaseUnits,
  slippageLabel,
  toBaseUnits,
  unitRate,
} from "./amount.ts";
import {
  quoteSwap,
  setSlippage as saveSlippage,
  setTokenInfo,
  type SwapQuote,
} from "./backend.ts";
import { createRequestId } from "./funding.ts";
import { runSwapAction, type ActionProgress, type SwapActionInput } from "./action_client.ts";
import { formatNumber, formatTokenAmount } from "./format.ts";
import { TokenMark } from "./token_mark.tsx";
import { amountAtPercent, percentForAmount, spendableBalance } from "./amount_allocation.ts";
import { addLedgerToWallet, readTokenInfo, walletSetupRequired, type WalletTokenInfo } from "./wallet.ts";

/** Slippage presets, in thousandths of a percent, as ICPSwap carries them. */
const SLIPPAGE_PRESETS = [100, 500, 1000, 5000] as const;
const MAX_SLIPPAGE = 50_000;

/** Quotes go stale; refresh while the panel is open and the inputs are valid. */
const QUOTE_REFRESH_MS = 15_000;

/** Debounce typing so a quote is not fired per keystroke. */
const QUOTE_DEBOUNCE_MS = 450;

export type SwapToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
};

export type SwapPanelProps = {
  input: SwapToken;
  inputChoices?: SwapToken[];
  onChooseInput?: (address: string) => void;
  output: SwapToken | null;
  choices: SwapToken[];
  initialSlippage: number;
  onChooseOutput: (address: string) => void;
  onDone?: () => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "funding" }
  | { kind: "swapping" }
  | { kind: "done"; progress: ActionProgress }
  | { kind: "error"; message: string };

export function SwapPanel({
  input,
  inputChoices,
  onChooseInput,
  output,
  choices,
  initialSlippage,
  onChooseOutput,
  onDone,
}: SwapPanelProps) {
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(initialSlippage);
  const [quoteState, setQuote] = useState<SwapQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const quoteSequence = useRef(0);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // What the Wallet knows about the token being sold: its true precision, the
  // fee in force, and how much of it this Neutron actually holds. Without this
  // the panel can only guess at precision, which is how it used to render a
  // form that could never quote.
  const [balance, setBalance] = useState<{ ledger: string; phase: "loading" | "ready" | "error"; info: WalletTokenInfo | null; error: string | null } | null>(null);
  const [balanceRead, setBalanceRead] = useState(0);
  const [tokenInfoRevision, setTokenInfoRevision] = useState(0);
  const [allocation, setAllocation] = useState<{ ledger: string; amount: string; maximum: bigint; percent: number } | null>(null);
  const [walletSetup, setWalletSetup] = useState<{ ledger: string; pending: boolean; error: string | null } | null>(null);
  const walletSetupController = useRef<AbortController | null>(null);
  const currentInput = useRef(input.address); currentInput.current = input.address;
  const currentBalance = balance?.ledger === input.address ? balance : null;
  const payInfo = currentBalance?.info ?? null;
  const payInfoError = currentBalance?.error ?? null;
  const balanceLoading = !currentBalance || currentBalance.phase === "loading";
  const availablePayInfo = currentBalance?.phase === "ready" ? payInfo : null;
  const mounted = useRef(true);
  // Held across a retry so a resumed attempt is provably the same attempt and
  // the Wallet replays instead of asking the owner twice.
  const attempt = useRef<SwapActionInput | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; quoteSequence.current += 1; };
  }, []);
  useEffect(() => () => walletSetupController.current?.abort(), [input.address]);

  // The Wallet is authoritative on precision; the watchlist row is only a
  // fallback for the moment before it answers.
  const payDecimals = payInfo?.decimals ?? input.decimals;

  const amountIn = useMemo(
    () => toBaseUnits(amount, payDecimals),
    [amount, payDecimals],
  );

  const busy = phase.kind === "funding" || phase.kind === "swapping" || walletSetup?.pending === true;
  const quoteInputKey = `${input.address}:${output?.address ?? ""}:${amountIn?.toString() ?? ""}:${slippage}`;
  const quote = quoteKey === quoteInputKey ? quoteState : null;

  // A typed amount that cannot be expressed in the token's base units must say
  // so. Silently doing nothing is the worst option: the owner sees a filled
  // form, a flow that looks ready, and no quote. This also catches a token
  // whose decimals this Neutron has not read yet, which reports as zero.
  const amountProblem = useMemo(
    () => /^(?:0+(?:\.0*)?|\.0+)$/u.test(amount.trim()) ? null : describeAmountProblem(amount, payDecimals, input.symbol),
    [amount, payDecimals, input.symbol],
  );

  // Read the selected token as soon as the swap opens. The Wallet remains the
  // authority for its balance and ledger fee; failed refreshes disable sizing
  // without turning the old observation into a usable current balance.
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    setBalance((previous) => ({ ledger: input.address, phase: "loading", info: previous?.ledger === input.address ? previous.info : null, error: null }));
    void (async () => {
      try {
        const info = await readTokenInfo(createMsgBusClient(), input.address, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setBalance({ ledger: input.address, phase: "ready", info, error: null });
        // Publishing metadata for quote construction is separate from whether
        // the live Wallet balance was successfully read.
        await setTokenInfo(info.ledger, info.decimals, info.feeAtoms).catch(() => undefined);
        if (!controller.signal.aborted && mounted.current) setTokenInfoRevision((value) => value + 1);
      } catch (error) {
        if (controller.signal.aborted || !mounted.current) return;
        setBalance((previous) => ({ ledger: input.address, phase: "error", info: previous?.ledger === input.address ? previous.info : null, error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    return () => controller.abort();
  }, [input.address, balanceRead, busy]);

  // The receive token's metadata helps quotes, but its read never replaces the
  // selected pay-token balance. The shared Wallet client queues both reads.
  useEffect(() => {
    if (!output || busy) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const info = await readTokenInfo(createMsgBusClient(), output.address, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        await setTokenInfo(info.ledger, info.decimals, info.feeAtoms);
        if (!controller.signal.aborted && mounted.current) setTokenInfoRevision((value) => value + 1);
      } catch { /* Quotes retain their existing unavailable-metadata diagnostic. */ }
    })();
    return () => controller.abort();
  }, [output?.address, busy]);

  // A return from another browser tab refreshes the observation. Explicit
  // refresh and completion of any swap attempt also read the current balance.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !busy) setBalanceRead((value) => value + 1); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [busy]);

  const maxSpendable = availablePayInfo ? spendableBalance(availablePayInfo.balanceAtoms, availablePayInfo.feeAtoms) : null;
  const allocationDisabled = busy || maxSpendable === null || maxSpendable === 0n;
  const selectedPercent = allocation?.ledger === input.address && allocation.amount === amount && allocation.maximum === maxSpendable
    ? allocation.percent : percentForAmount(amountIn, maxSpendable);
  const chooseAllocation = (percent: number) => {
    if (allocationDisabled || !availablePayInfo || maxSpendable === null) return;
    const next = fromBaseUnits(amountAtPercent(maxSpendable, percent), availablePayInfo.decimals);
    setAmount(next);
    setAllocation({ ledger: input.address, amount: next, maximum: maxSpendable, percent });
  };

  const setupWalletToken = async () => {
    if (busy || !walletSetupRequired(payInfoError)) return;
    const ledger = input.address, controller = new AbortController();
    walletSetupController.current = controller;
    setWalletSetup({ ledger, pending: true, error: null });
    try {
      await addLedgerToWallet(createMsgBusClient(), ledger, controller.signal);
      if (!mounted.current || controller.signal.aborted || currentInput.current !== ledger) return;
      setBalanceRead((value) => value + 1);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || currentInput.current !== ledger) return;
      setWalletSetup({ ledger, pending: true, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (mounted.current && walletSetupController.current === controller) setWalletSetup((previous) => previous?.ledger === ledger ? { ...previous, pending: false } : previous);
    }
  };

  const overBalance =
    amountIn !== null && maxSpendable !== null && amountIn > maxSpendable;

  const refreshQuote = useCallback(async () => {
    const sequence = ++quoteSequence.current;
    if (!output || amountIn === null) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    setQuoting(true);
    try {
      const next = await quoteSwap({
        requestId: createRequestId(),
        inputAddress: input.address,
        outputAddress: output.address,
        amountIn,
        slippage,
      });
      if (!mounted.current || sequence !== quoteSequence.current) return;
      setQuote(next);
      setQuoteKey(quoteInputKey);
      setQuoteError(null);
    } catch (error) {
      if (!mounted.current || sequence !== quoteSequence.current) return;
      setQuote(null);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current && sequence === quoteSequence.current) setQuoting(false);
    }
  }, [amountIn, input.address, output, quoteInputKey, slippage, tokenInfoRevision]);

  // Debounce typing, then keep the quote warm while the panel is open.
  useEffect(() => {
    if (!output || amountIn === null || busy) return;
    const timer = window.setTimeout(() => void refreshQuote(), QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [amountIn, busy, output, refreshQuote, slippage]);

  useEffect(() => {
    if (!output || amountIn === null || busy) return;
    const timer = window.setInterval(() => void refreshQuote(), QUOTE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [amountIn, busy, output, refreshQuote]);

  const chooseSlippage = useCallback((value: number) => {
    const bounded = Math.max(1, Math.min(MAX_SLIPPAGE, Math.trunc(value)));
    setSlippage(bounded);
    void saveSlippage(bounded).catch(() => undefined);
  }, []);

  const run = useCallback(async () => {
    // A saved attempt keeps the original pair, amount, slippage and id even if
    // the current form changed or the initial preparation reply was lost.
    if (!attempt.current) {
      if (!output || amountIn === null || !quote) return;
      attempt.current = { operationId: createRequestId(), from_ledger_id: quote.inputAddress,
        to_ledger_id: quote.outputAddress, amount: quote.amountIn.toString(), slippage };
    }
    const saved = attempt.current;
    setPhase({ kind: "swapping" });
    try {
      const progress = await runSwapAction(saved);
      if (!mounted.current) return;
      if (["complete", "protocol_complete", "settlement_pending", "swapped", "stopped", "funding_expired"].includes(progress.state)) {
        attempt.current = null;
        if (["complete", "protocol_complete", "settlement_pending", "swapped"].includes(progress.state)) {
          setAmount("");
          setQuote(null);
          setBalanceRead((value) => value + 1);
        }
      }
      setPhase({ kind: "done", progress });
    } catch (error) {
      if (!mounted.current) return;
      setPhase({ kind: "error", message: `${error instanceof Error ? error.message : String(error)} Continue the saved swap or inspect Activity before starting another.` });
    }
  }, [amountIn, output, quote, slippage]);

  const impactPercent = quote ? quote.priceImpact * 100 : 0;
  const rate = quote
    ? unitRate(quote.amountIn, quote.quotedOut, quote.decimalsIn, quote.decimalsOut)
    : 0;
  const outputDecimals = quote?.decimalsOut ?? output?.decimals ?? 8;
  const outputSymbol = output?.symbol ?? "";

  const actionLabel =
    phase.kind === "funding"
      ? "Waiting for Wallet…"
      : phase.kind === "swapping"
        ? "Reviewing swap…"
        : attempt.current ? "Continue saved swap" : "Review swap";

  return (
    <section className="nt-section ics-swap">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Swap</h2>
        <details className="ics-swap-settings">
          <summary title="Slippage tolerance">{slippageLabel(slippage)} <span aria-hidden="true">⚙</span></summary>
        <div
          aria-label="Maximum slippage"
          className="nt-segmented ics-swap-slippage"
          role="group"
        >
          {SLIPPAGE_PRESETS.map((preset) => (
            <button
              aria-pressed={slippage === preset}
              className={cx(
                "nt-button nt-button--sm",
                slippage === preset ? null : "nt-button--secondary",
              )}
              disabled={busy}
              key={preset}
              onClick={() => chooseSlippage(preset)}
              title={`Accept at most ${slippageLabel(preset)} slippage`}
              type="button"
            >
              {slippageLabel(preset)}
            </button>
          ))}
        </div>
        </details>
      </header>

      <div className="ics-swap-form">
      <div className="ics-swap-legs">
        <div className="ics-swap-leg">
          <label className="ics-swap-leg-label" htmlFor="ics-swap-amount">
            You pay
          </label>
          <div className="ics-swap-leg-body">
            <span className="ics-swap-chip">
              <TokenMark address={input.address} symbol={input.symbol} />
              {inputChoices && onChooseInput ? <select className="ics-swap-select" aria-label="Token to pay" disabled={busy} onChange={(event) => onChooseInput(event.target.value)} value={input.address}>{inputChoices.map((token) => <option key={token.address} value={token.address}>{token.symbol}</option>)}</select> : <span className="ics-swap-chip-symbol">{input.symbol}</span>}
            </span>
            <input
              autoComplete="off"
              className="ics-swap-amount"
              disabled={busy}
              id="ics-swap-amount"
              inputMode="decimal"
              onChange={(event) => { setAmount(event.target.value); setAllocation(null); }}
              placeholder="0.0"
              spellCheck={false}
              value={amount}
            />
          </div>
          <div className="ics-swap-leg-foot ics-swap-balance">
            <span className="nt-meta" aria-live="polite" title={availablePayInfo ? `Wallet balance ${fromBaseUnits(availablePayInfo.balanceAtoms, availablePayInfo.decimals)} ${availablePayInfo.symbol}` : undefined}>
              {balanceLoading ? "Reading balance…" : availablePayInfo ? <>Balance <strong>{formatTokenAmount(availablePayInfo.balanceAtoms, availablePayInfo.decimals)} {availablePayInfo.symbol}</strong></> : "Balance unavailable"}
            </span>
            <button className="nt-icon-button ics-balance-refresh" type="button" aria-label="Refresh Wallet balance" title="Refresh balance" disabled={busy || balanceLoading} onClick={() => setBalanceRead((value) => value + 1)}>↻</button>
          </div>
          {walletSetupRequired(payInfoError) ? <div className="ics-wallet-setup"><button className="nt-button nt-button--secondary nt-button--sm" type="button" disabled={busy} onClick={() => void setupWalletToken()}>{walletSetup?.pending && walletSetup.ledger === input.address ? "Adding to Wallet…" : `Add ${input.symbol} to Wallet`}</button>{walletSetup?.ledger === input.address && walletSetup.error ? <p className="nt-meta" role="status">{walletSetup.error}</p> : null}</div> : null}
          <div className="ics-amount-allocation" aria-label="Choose swap amount">
            <div className="ics-allocation-label"><span>{maxSpendable === 0n ? availablePayInfo?.balanceAtoms === 0n ? "No balance to swap" : "Balance reserved for fees" : "Amount to swap"}</span><output aria-label="Selected balance percentage">{selectedPercent}%</output></div>
            <input type="range" min="0" max="100" step="1" aria-label="Percentage of spendable balance" aria-valuetext={`${selectedPercent}% of the balance after ledger fees`} disabled={allocationDisabled} value={selectedPercent} onChange={(event) => chooseAllocation(Number(event.target.value))} />
            <div className="ics-allocation-presets">{[0, 25, 50, 75, 100].map((percent) => <button key={percent} type="button" disabled={allocationDisabled} aria-pressed={!allocationDisabled && selectedPercent === percent} onClick={() => chooseAllocation(percent)} title={percent === 100 ? "Your balance, less the approval fee and the pool's transfer fee" : undefined}>{percent === 100 ? "Max" : `${percent}%`}</button>)}</div>
          </div>
        </div>

        <span aria-hidden="true" className="ics-swap-arrow">
          ↓
        </span>

        <div className="ics-swap-leg">
          <label className="ics-swap-leg-label" htmlFor="ics-swap-output">
            You receive
          </label>
          <div className="ics-swap-leg-body">
            <span className="ics-swap-chip">
              {output ? (
                <TokenMark address={output.address} symbol={output.symbol} />
              ) : (
                <span aria-hidden="true" className="ics-swap-chip-empty" />
              )}
              <select
                className="ics-swap-select"
                disabled={busy}
                id="ics-swap-output"
                onChange={(event) => onChooseOutput(event.target.value)}
                value={output?.address ?? ""}
              >
                <option value="">Choose…</option>
                {choices.map((token) => (
                  <option key={token.address} value={token.address}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </span>
            <span
              className={cx("ics-swap-amount ics-swap-amount--readonly", {
                "ics-swap-amount--muted": !quote,
              })}
            >
              {quote
                ? formatTokenAmount(quote.expectedOut, quote.decimalsOut)
                : "—"}
            </span>
          </div>
          {output && amountIn !== null && !quote ? <div className="ics-swap-leg-foot"><span className="nt-meta" role="status">{quoteError ? "Quote unavailable" : quoting ? "Getting quote…" : "Preparing quote…"}</span></div> : null}
        </div>
      </div>

      {quote ? <div className="ics-swap-quote">
        <div className="ics-swap-minimum"><span title="Estimated payout after the outgoing ledger fee. The pool enforces a minimum before that fee.">Minimum received <small>est.</small></span><strong>{formatTokenAmount(quote.amountOutMinimum > quote.tokenOutFee ? quote.amountOutMinimum - quote.tokenOutFee : 0n, outputDecimals)} {outputSymbol}</strong></div>
        <details className="ics-swap-quote-details"><summary>Quote details</summary><dl className="ics-swap-facts">
        <div className="ics-swap-fact">
          <dt>Rate</dt>
          <dd>
            {rate > 0 && output
              ? `1 ${input.symbol} = ${formatNumber(rate, 6)} ${outputSymbol}`
              : "—"}
          </dd>
        </div>
        <div className="ics-swap-fact">
          <dt>Price impact</dt>
          <dd className={cx({ "ics-change--down": quote?.warn === true })}>
            {quote ? `${formatNumber(impactPercent, 2)}%` : "—"}
          </dd>
        </div>
        <div className="ics-swap-fact">
          <dt title="The swap, the pool's transfer fee, and the approval fee">
            Total debited
          </dt>
          <dd>
            {quote
              ? `${formatTokenAmount(quote.totalDebit, quote.decimalsIn)} ${input.symbol}`
              : "—"}
          </dd>
        </div>
      </dl></details></div> : null}

      {payInfoError ? (
        <details className="ics-inline-note"><summary>Wallet balance unavailable</summary><p>{payInfoError}</p></details>
      ) : null}

      {amountProblem ? (
        <div className="nt-alert nt-alert--warning">{amountProblem}</div>
      ) : null}

      {overBalance && payInfo ? (
        <div className="nt-alert nt-alert--warning">
          Available after fees:{" "}
          {formatTokenAmount(maxSpendable ?? 0n, payInfo.decimals)}{" "}
          {payInfo.symbol}.
        </div>
      ) : null}

      {quoteError ? (
        <div className="ics-swap-quote-error nt-alert nt-alert--warning"><div><strong>Could not get a price</strong><button className="nt-button nt-button--secondary nt-button--sm" type="button" disabled={busy || quoting || amountIn === null || !output} onClick={() => void refreshQuote()}>Retry quote</button></div><details className="ics-inline-note"><summary>Details</summary><p>{quoteError}</p></details></div>
      ) : null}

      {quote?.warn ? (
        <div className="nt-alert nt-alert--warning">
          This pool is thin at that size — {formatNumber(impactPercent, 2)}% of
          the value would be lost to price impact.
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className="nt-alert nt-alert--danger">{phase.message}</div>
      ) : null}

      {phase.kind === "done" ? (
        <div className={cx("nt-alert", {
          "nt-alert--danger": phase.progress.state === "uncertain" || phase.progress.state === "ambiguous",
          "nt-alert--warning": phase.progress.state === "stopped" || phase.progress.state === "pending",
        })}>
          {phase.progress.message}
        </div>
      ) : null}

      <div className="ics-swap-actions">
        <button
          // Only a real quote promotes this to the primary style. A prominent
          // button that cannot act is worse than a quiet one.
          className={cx("nt-button ics-swap-submit", {
            "nt-button--secondary": !quote,
          })}
          disabled={busy || (!attempt.current && (!quote || overBalance)) || (phase.kind === "done" && ["uncertain", "ambiguous", "execution_requested"].includes(phase.progress.state))}
          onClick={() => void run()}
          type="button"
        >
          {actionLabel}
        </button>
        {onDone ? <button
          className="nt-button nt-button--secondary"
          disabled={busy}
          onClick={onDone}
          type="button"
        >
          Close
        </button> : null}
      </div>

      </div>
    </section>
  );
}
