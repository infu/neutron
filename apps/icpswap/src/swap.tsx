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
import { readTokenInfo, type WalletTokenInfo } from "./wallet.ts";

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
  const [payInfoState, setPayInfo] = useState<WalletTokenInfo | null>(null);
  const [payInfoError, setPayInfoError] = useState<string | null>(null);
  const [balanceRead, setBalanceRead] = useState(0);
  const [tokenInfoRevision, setTokenInfoRevision] = useState(0);
  const readBalance = balanceRead > 0;
  const payInfo = payInfoState?.ledger === input.address ? payInfoState : null;
  const mounted = useRef(true);
  // Held across a retry so a resumed attempt is provably the same attempt and
  // the Wallet replays instead of asking the owner twice.
  const attempt = useRef<SwapActionInput | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; quoteSequence.current += 1; };
  }, []);

  // The Wallet is authoritative on precision; the watchlist row is only a
  // fallback for the moment before it answers.
  const payDecimals = payInfo?.decimals ?? input.decimals;

  const amountIn = useMemo(
    () => toBaseUnits(amount, payDecimals),
    [amount, payDecimals],
  );

  const busy = phase.kind === "funding" || phase.kind === "swapping";
  const quoteInputKey = `${input.address}:${output?.address ?? ""}:${amountIn?.toString() ?? ""}:${slippage}`;
  const quote = quoteKey === quoteInputKey ? quoteState : null;

  // A typed amount that cannot be expressed in the token's base units must say
  // so. Silently doing nothing is the worst option: the owner sees a filled
  // form, a flow that looks ready, and no quote. This also catches a token
  // whose decimals this Neutron has not read yet, which reports as zero.
  const amountProblem = useMemo(
    () => describeAmountProblem(amount, payDecimals, input.symbol),
    [amount, payDecimals, input.symbol],
  );

  // Reading a token from the Wallet needs the owner's consent, so it is asked
  // for only once they are actually pricing a swap — a chosen pair and a real
  // amount. Firing it when the panel merely opens would put a permission
  // dialog in front of someone who is only looking.
  //
  // It is an enhancement, never a requirement: without it the panel falls back
  // to the decimals ICPSwap's own curated list reports and simply skips the
  // fee cross-check.
  const wantsWalletInfo = readBalance || (Boolean(output) && amount.trim() !== "");

  useEffect(() => {
    if (!wantsWalletInfo) return;
    let cancelled = false;
    const controller = new AbortController();
    setPayInfoError(null);
    void (async () => {
      const client = createMsgBusClient();
      try {
        const info = await readTokenInfo(client, input.address, controller.signal);
        if (cancelled || !mounted.current) return;
        setPayInfo(info);
        await setTokenInfo(input.address, info.decimals, info.feeAtoms);
        if (!cancelled && mounted.current) setTokenInfoRevision((value) => value + 1);
      } catch (error) {
        if (cancelled || !mounted.current) return;
        setPayInfoError(error instanceof Error ? error.message : String(error));
        return;
      }
      // The output token's facts matter to the backend for the same reasons,
      // but the panel itself never needs them.
      if (!output) return;
      try {
        const info = await readTokenInfo(client, output.address, controller.signal);
        if (cancelled || !mounted.current) return;
        await setTokenInfo(output.address, info.decimals, info.feeAtoms);
        if (!cancelled && mounted.current) setTokenInfoRevision((value) => value + 1);
      } catch {
        // A token the owner has not selected in Wallet cannot be funded
        // either; the quote or the funding call will say so.
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [input.address, output, wantsWalletInfo, balanceRead]);

  // A different input token invalidates what we know about the old one.
  useEffect(() => {
    setPayInfo(null);
    setPayInfoError(null);
    setBalanceRead(0);
  }, [input.address]);

  /** The most that can be swapped: the balance less the two ledger fees. */
  const maxSpendable = useMemo(() => {
    if (!payInfo) return null;
    const reserved = payInfo.feeAtoms * 2n;
    return payInfo.balanceAtoms > reserved
      ? payInfo.balanceAtoms - reserved
      : 0n;
  }, [payInfo]);

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
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.0"
              spellCheck={false}
              value={amount}
            />
          </div>
          {payInfo ? (
            <div className="ics-swap-leg-foot">
              <span className="nt-meta">
                Balance {formatTokenAmount(payInfo.balanceAtoms, payInfo.decimals)}{" "}
                {payInfo.symbol}
              </span>
              <button
                className="nt-button nt-button--ghost nt-button--sm"
                disabled={busy || maxSpendable === null || maxSpendable === 0n}
                onClick={() => {
                  if (maxSpendable !== null) {
                    setAmount(fromBaseUnits(maxSpendable, payInfo.decimals));
                  }
                }}
                title="Your balance, less the approval fee and the pool's transfer fee"
                type="button"
              >
                Max
              </button>
            </div>
          ) : <div className="ics-swap-leg-foot"><button className="nt-button nt-button--ghost nt-button--sm" disabled={busy || (readBalance && !payInfoError)} onClick={() => setBalanceRead((revision) => revision + 1)} type="button">{readBalance && !payInfoError ? "Reading balance…" : "Show balance"}</button></div>}
          {payInfo && maxSpendable !== null && maxSpendable > 0n ? <div className="ics-amount-allocation">
            <input type="range" min="0" max="100" step="1" aria-label="Percentage of spendable balance" disabled={busy} value={Number(((amountIn ?? 0n) * 100n) / maxSpendable) > 100 ? 100 : Number(((amountIn ?? 0n) * 100n) / maxSpendable)} onChange={(event) => setAmount(fromBaseUnits((maxSpendable * BigInt(event.target.value)) / 100n, payInfo.decimals))} />
            <div>{[25, 50, 75, 100].map((percent) => <button key={percent} type="button" disabled={busy} onClick={() => setAmount(fromBaseUnits((maxSpendable * BigInt(percent)) / 100n, payInfo.decimals))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}</div>
          </div> : null}
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
                : quoting
                  ? "…"
                  : "0.0"}
            </span>
          </div>
        </div>
      </div>

      {quote ? <dl className="ics-swap-facts">
        <div className="ics-swap-fact">
          <dt>Rate</dt>
          <dd>
            {rate > 0 && output
              ? `1 ${input.symbol} = ${formatNumber(rate, 6)} ${outputSymbol}`
              : "—"}
          </dd>
        </div>
        <div className="ics-swap-fact">
          <dt title="Pool minimum less the observed outgoing ledger fee; settlement remains asynchronous.">Minimum net estimate</dt>
          <dd>
            {quote
              ? `${formatTokenAmount(quote.amountOutMinimum > quote.tokenOutFee ? quote.amountOutMinimum - quote.tokenOutFee : 0n, outputDecimals)} ${outputSymbol}`
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
      </dl> : null}

      {payInfoError ? (
        <details className="ics-inline-note"><summary>Wallet balance unavailable</summary><p>{payInfoError}</p></details>
      ) : null}

      {amountProblem ? (
        <div className="nt-alert nt-alert--warning">{amountProblem}</div>
      ) : null}

      {overBalance && payInfo ? (
        <div className="nt-alert nt-alert--warning">
          That is more than you hold once both ledger fees are covered. The most
          you can swap is{" "}
          {formatTokenAmount(maxSpendable ?? 0n, payInfo.decimals)}{" "}
          {payInfo.symbol}.
        </div>
      ) : null}

      {quoteError ? (
        <div className="nt-alert nt-alert--warning">{quoteError}</div>
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
