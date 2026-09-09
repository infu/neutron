// Token detail: everything ICPSwap publishes about one token on a single page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { cx } from "neutron-design-system";
import {
  ICP_LEDGER_ID,
  IcpSwapApiError,
  denominateInIcp,
  fetchTokenChart,
  fetchTokenTransactionPage,
  loadTokenPools,
  type ChartLevel,
  type InfoCandle,
  type InfoPool,
  type InfoToken,
  type InfoTokenRank,
  type InfoTransaction,
} from "./api.ts";
import type { TokenDetail } from "./backend.ts";
import { Chart, type ChartPoint } from "./chart.tsx";
import {
  formatDate,
  formatDateTime,
  formatFeeTier,
  formatIcp,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRelative,
  formatUsdCompact,
  shortPrincipal,
  trendOf,
} from "./format.ts";
import { isPlausibleExtreme } from "./scale.ts";
import { SwapPanel, type SwapToken } from "./swap.tsx";
import { TokenMark } from "./token_mark.tsx";
import type { PickerCandidate } from "./picker.tsx";
import { formatPoolAmount } from "./pool_composition.ts";

type RangeKey = "24H" | "7D" | "30D" | "90D" | "1Y";
type MetricKey = "price" | "volume" | "tvl";
type CurrencyKey = "USD" | "ICP";

const RANGES: ReadonlyArray<{
  key: RangeKey;
  level: ChartLevel;
  limit: number;
  label: string;
}> = [
  { key: "24H", level: "m15", limit: 96, label: "24H" },
  { key: "7D", level: "h1", limit: 168, label: "7D" },
  { key: "30D", level: "d1", limit: 30, label: "30D" },
  { key: "90D", level: "d1", limit: 90, label: "90D" },
  { key: "1Y", level: "d1", limit: 365, label: "1Y" },
];

const METRICS: ReadonlyArray<{ key: MetricKey; label: string }> = [
  { key: "price", label: "Price" },
  { key: "volume", label: "Volume" },
  { key: "tvl", label: "TVL" },
];

const TRADES_PER_PAGE = 15;
/**
 * ckBTC reports 118,896 trades. Paging to the end of that is not a thing anyone
 * wants to do through a tile, and the upstream slows down on deep pages.
 */
const TRADES_MAX_PAGES = 200;

const CURRENCIES: ReadonlyArray<{ key: CurrencyKey; label: string }> = [
  { key: "USD", label: "USD" },
  { key: "ICP", label: "ICP" },
];

function metricPoints(candles: InfoCandle[], metric: MetricKey): ChartPoint[] {
  return candles.map((candle) => ({
    t: candle.t,
    v:
      metric === "price"
        ? candle.close
        : metric === "volume"
          ? candle.volumeUSD
          : candle.tvlUSD,
  }));
}

function describeError(error: unknown): string {
  if (error instanceof IcpSwapApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "up" | "down" | "flat";
}) {
  return (
    <article className="nt-metric">
      <span className="nt-metric-label">{label}</span>
      <strong
        className={cx("nt-metric-value", tone ? `ics-change ics-change--${tone}` : null)}
      >
        {value}
      </strong>
      {detail ? <span className="nt-metric-detail">{detail}</span> : null}
    </article>
  );
}

export type TokenDetailViewProps = {
  address: string;
  detail: TokenDetail | null;
  live: InfoToken | undefined;
  rank: InfoTokenRank | undefined;
  onBack: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onSaveNote: (note: string) => void;
  /** ICP reference price in USD, used to derive an ICP quote when the
   *  on-chain price index has not been read yet. */
  icpPriceUsd: number;
  busy: boolean;
  /** Watched tokens the owner can swap into, excluding this one. */
  swapChoices: SwapToken[];
  swapSlippage: number;
  pickerCandidates: PickerCandidate[];
  pickerSource: "live" | "on-chain";
  pickerError: string | null;
};

export function TokenDetailView({
  address,
  detail,
  live,
  rank,
  onBack,
  onTogglePin,
  onRemove,
  onSaveNote,
  icpPriceUsd,
  busy,
  swapChoices,
  swapSlippage,
  pickerCandidates,
  pickerSource,
  pickerError,
}: TokenDetailViewProps) {
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapOutput, setSwapOutput] = useState<string>("");
  // Memoised: the panel debounces its quote on this value's identity, so a
  // fresh object every render would reset the timer forever and no quote would
  // ever fire.
  const swapTarget = useMemo(
    () => swapChoices.find((token) => token.address === swapOutput) ?? null,
    [swapChoices, swapOutput],
  );
  const [range, setRange] = useState<RangeKey>("30D");
  const [metric, setMetric] = useState<MetricKey>("price");
  const [currency, setCurrency] = useState<CurrencyKey>("USD");
  const [candles, setCandles] = useState<InfoCandle[]>([]);
  const [icpCandles, setIcpCandles] = useState<InfoCandle[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [pools, setPools] = useState<InfoPool[]>([]);
  const [poolsError, setPoolsError] = useState<string | null>(null);
  const [trades, setTrades] = useState<InfoTransaction[]>([]);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [tradesPage, setTradesPage] = useState(1);
  const [tradesTotal, setTradesTotal] = useState(0);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState(detail?.row.note ?? "");
  const [noteDirty, setNoteDirty] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!noteDirty) setNoteDraft(detail?.row.note ?? "");
  }, [detail?.row.note, noteDirty]);

  const selected = RANGES.find((entry) => entry.key === range) ?? RANGES[2]!;
  const isIcp = address === ICP_LEDGER_ID;
  // Only a price series can be re-expressed in ICP; volume and TVL stay in USD.
  const canQuoteInIcp = !isIcp && metric === "price";
  const quoteInIcp = canQuoteInIcp && currency === "ICP";

  useEffect(() => {
    const controller = new AbortController();
    setChartLoading(true);
    setCandles([]);
    setChartError(null);
    fetchTokenChart(address, selected.level, selected.limit, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setCandles(page.candles);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCandles([]);
        setChartError(describeError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChartLoading(false);
      });
    return () => controller.abort();
  }, [address, selected.level, selected.limit]);

  useEffect(() => {
    if (!canQuoteInIcp) {
      setIcpCandles([]);
      return;
    }
    const controller = new AbortController();
    fetchTokenChart(ICP_LEDGER_ID, selected.level, selected.limit, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setIcpCandles(page.candles);
      })
      .catch(() => {
        if (!controller.signal.aborted) setIcpCandles([]);
      });
    return () => controller.abort();
  }, [canQuoteInIcp, selected.level, selected.limit]);

  useEffect(() => {
    const controller = new AbortController();
    setPoolsError(null);
    loadTokenPools(address, 120_000, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPools(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPools([]);
          setPoolsError(describeError(error));
        }
      });
    return () => controller.abort();
  }, [address]);

  // A new token starts at the first page of its own trade log.
  useEffect(() => {
    setTradesPage(1);
  }, [address]);

  useEffect(() => {
    const controller = new AbortController();
    setTradesError(null);
    setTradesLoading(true);
    fetchTokenTransactionPage(address, tradesPage, TRADES_PER_PAGE, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setTrades(page.trades);
        setTradesTotal(page.total);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTrades([]);
        setTradesTotal(0);
        setTradesError(describeError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTradesLoading(false);
      });
    return () => controller.abort();
  }, [address, tradesPage]);

  const tradePageCount = Math.max(
    1,
    Math.min(TRADES_MAX_PAGES, Math.ceil(tradesTotal / TRADES_PER_PAGE) || 1),
  );

  const shownCandles = useMemo(
    () => (quoteInIcp ? denominateInIcp(candles, icpCandles) : candles),
    [candles, icpCandles, quoteInIcp],
  );

  const points = useMemo(
    () => metricPoints(shownCandles, metric),
    [shownCandles, metric],
  );
  const volumePoints = useMemo(
    () =>
      metric === "price"
        ? shownCandles.map((candle) => ({ t: candle.t, v: candle.volumeUSD }))
        : undefined,
    [shownCandles, metric],
  );
  // Only a price chart is a candle chart; volume and TVL are single values.
  const ohlc = useMemo(
    () =>
      metric === "price"
        ? shownCandles.map((candle) => ({
            t: candle.t,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          }))
        : undefined,
    [shownCandles, metric],
  );

  const localPoints = useMemo<ChartPoint[]>(
    () =>
      (detail?.history ?? []).map((sample) => ({
        t: sample.t,
        v: sample.priceUsd,
      })),
    [detail?.history],
  );

  const handleCopy = useCallback(() => {
    setCopied(true);
    void copyToClipboard(address).catch(() => undefined);
    window.setTimeout(() => setCopied(false), 1500);
  }, [address]);

  const row = detail?.row;
  const profile = detail?.profile ?? null;
  const price = live?.price ?? row?.priceUsd ?? 0;
  const change = live?.priceChange24H;
  const tone = trendOf(change);
  const orderedPools = useMemo(
    () => [...pools].sort((left, right) => right.tvlUSD - left.tvlUSD),
    [pools],
  );

  // ICPSwap reports a 24h high of $199,924,397 for ckBTC against a $78,760
  // traded price. Printing that as a fact is worse than printing nothing.
  const priceRanges = useMemo(() => {
    const keep = (value: number) =>
      isPlausibleExtreme(value, price) ? value : null;
    return live
      ? [
          {
            label: "24h low / high",
            low: keep(live.priceLow24H),
            high: keep(live.priceHigh24H),
          },
          {
            label: "7d low / high",
            low: keep(live.priceLow7D),
            high: keep(live.priceHigh7D),
          },
          {
            label: "30d low / high",
            low: keep(live.priceLow30D),
            high: keep(live.priceHigh30D),
          },
        ]
      : [];
  }, [live, price]);

  const droppedExtremes = priceRanges.some(
    (entry) => entry.low === null || entry.high === null,
  );

  const formatValue = useCallback(
    (value: number) => {
      if (metric !== "price") return formatUsdCompact(value);
      return quoteInIcp ? formatIcp(value) : formatPrice(value);
    },
    [metric, quoteInIcp],
  );

  const formatTime = useCallback(
    (timestamp: number) =>
      selected.level === "d1" ? formatDate(timestamp) : formatDateTime(timestamp),
    [selected.level],
  );

  return (
    <div className="nt-stack ics-detail">
      <header className="ics-detail-header">
        <div className="ics-detail-identity">
          <button className="nt-icon-button" aria-label="Back to markets" title="Back to markets" onClick={onBack} type="button">←</button>
          <TokenMark address={address} size="lg" symbol={row?.symbol ?? ""} />
          <div className="nt-stack nt-stack--tight">
            <h2 className="ics-token-title">
              {row?.symbol || live?.symbol || shortPrincipal(address)}
            </h2>
            <p className="nt-muted">{live?.name || row?.name || "Unknown token"}</p>

          </div>
        </div>

        <div className="nt-stack nt-stack--tight">
          <div className="ics-detail-price">
            <span className="ics-detail-price-value">{formatPrice(price)}</span>
            <span className={`ics-change ics-change--${tone}`}>
              {change === undefined ? "-" : `${formatPercent(change)} 24h`}
            </span>
          </div>
          <div className="ics-inline-actions">
            <button
              className="nt-button nt-button--sm"
              disabled={busy || swapChoices.length === 0}
              onClick={() => setSwapOpen((open) => !open)}
              title={
                swapChoices.length === 0
                  ? "Watch a second token to swap into"
                  : undefined
              }
              type="button"
            >
              {swapOpen ? "Hide swap" : "Swap"}
            </button>
            <button className="nt-icon-button" aria-label={row?.pinned ? "Unpin token" : "Pin token"} title={row?.pinned ? "Unpin" : "Pin to top"} disabled={busy} onClick={onTogglePin} type="button">{row?.pinned ? "★" : "☆"}</button>
            <button className="nt-icon-button" aria-label="Remove token from watchlist" title="Remove from watchlist" disabled={busy} onClick={onRemove} type="button">×</button>

          </div>
          <button className="ics-ledger-copy" onClick={handleCopy} type="button" title={address}>{copied ? "Copied" : shortPrincipal(address)} <span aria-hidden="true">⧉</span></button>
        </div>
      </header>

      {swapOpen ? (
        <SwapPanel
          choices={swapChoices}
          pickerCandidates={pickerCandidates}
          pickerSource={pickerSource}
          pickerError={pickerError}
          initialSlippage={swapSlippage}
          input={{
            address,
            symbol: row?.symbol ?? "",
            name: row?.name ?? "",
            decimals: row?.decimals ?? 8,
          }}
          onChooseOutput={setSwapOutput}
          onDone={() => setSwapOpen(false)}
          output={swapTarget}
        />
      ) : null}

      <section className="ics-chart-panel nt-stack">
        <div className="ics-chart-toolbar">
          <div className="nt-segmented" role="group" aria-label="Chart metric">
            {METRICS.map((entry) => (
              <button
                aria-pressed={metric === entry.key}
                className={cx(
                  "nt-button nt-button--sm",
                  metric === entry.key ? null : "nt-button--secondary",
                )}
                key={entry.key}
                onClick={() => setMetric(entry.key)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
          {canQuoteInIcp ? (
            <div className="nt-segmented" role="group" aria-label="Chart currency">
              {CURRENCIES.map((entry) => (
                <button
                  aria-pressed={currency === entry.key}
                  className={cx(
                    "nt-button nt-button--sm",
                    currency === entry.key ? null : "nt-button--secondary",
                  )}
                  key={entry.key}
                  onClick={() => setCurrency(entry.key)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="nt-segmented" role="group" aria-label="Chart range">
            {RANGES.map((entry) => (
              <button
                aria-pressed={range === entry.key}
                className={cx(
                  "nt-button nt-button--sm",
                  range === entry.key ? null : "nt-button--secondary",
                )}
                key={entry.key}
                onClick={() => setRange(entry.key)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {chartError ? (
          <div className="nt-alert nt-alert--danger" role="alert">
            Chart unavailable: {chartError}
          </div>
        ) : null}

        <div className="ics-chart-stage" aria-busy={chartLoading}>
          {chartLoading && candles.length === 0 ? (
            <div className="nt-state nt-state--loading">Loading chart…</div>
          ) : (
            <Chart
              barLabel="Volume (USD)"
              formatBar={formatUsdCompact}
              formatTime={formatTime}
              formatValue={formatValue}
              height={300}
              points={points}
              valueLabel={
                metric === "price" ? "Price" : metric === "volume" ? "Volume" : "TVL"
              }
              {...(ohlc ? { candles: ohlc } : {})}
              {...(volumePoints ? { bars: volumePoints } : {})}
            />
          )}
        </div>
      </section>

      <details className="nt-section ics-disclosure">
        <summary>Market details</summary>
        <div className="ics-kpi-row">
          <Metric
            label="Price in ICP"
            value={
              row && row.priceIcp > 0
                ? formatIcp(row.priceIcp)
                : icpPriceUsd > 0 && price > 0
                  ? formatIcp(price / icpPriceUsd)
                  : "-"
            }
            detail={
              row?.quote
                ? `On chain via ${row.quote.quoteSymbol}`
                : "Derived from the ICP reference price"
            }
          />
          <Metric
            label="Volume 24h"
            value={live ? formatUsdCompact(live.volumeUSD24H) : "-"}
            {...(live ? { detail: `${formatNumber(live.txCount24H, 0)} trades` } : {})}
          />
          <Metric
            label="Volume 7d"
            value={live ? formatUsdCompact(live.volumeUSD7D) : "-"}
          />
          <Metric
            label="Volume total"
            value={live ? formatUsdCompact(live.totalVolumeUSD) : "-"}
            detail="Since listing"
          />
          <Metric
            label="TVL"
            value={live ? formatUsdCompact(live.tvlUSD) : "-"}
            {...(live
              ? {
                  detail: `${formatPercent(live.tvlUSDChange24H)} 24h`,
                  tone: trendOf(live.tvlUSDChange24H),
                }
              : {})}
          />
          <Metric
            label="Market cap"
            value={rank ? formatUsdCompact(rank.marketCap) : "-"}
            {...(rank ? { detail: `FDV ${formatUsdCompact(rank.fdv)}` } : {})}
          />
          <Metric
            label="Holders"
            value={rank && rank.holders > 0 ? formatNumber(rank.holders, 0) : "-"}
          />
          <Metric
            label="Pools"
            value={formatNumber(pools.length || (row?.poolCount ?? 0), 0)}
            detail="Trading this token"
          />
        </div>
      </details>


      {live ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">Price ranges</h2>
          </header>
          <dl className="nt-detail-grid">
            {priceRanges.map((entry) => (
              <div className="nt-detail" key={entry.label}>
                <dt className="nt-detail-label">{entry.label}</dt>
                <dd className="nt-detail-value">
                  {entry.low === null ? "-" : formatPrice(entry.low)} —{" "}
                  {entry.high === null ? "-" : formatPrice(entry.high)}
                </dd>
              </div>
            ))}
          </dl>
          {droppedExtremes ? (
            <p className="nt-meta">
              A reported extreme was left out: it sits more than twentyfold away
              from the traded price, which is a bad tick in ICPSwap&rsquo;s feed
              rather than a price this token reached.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Pools</h2>
          <span className="nt-section-count">{orderedPools.length}</span>
        </header>
        {poolsError ? (
          <div className="nt-alert nt-alert--warning">Pools unavailable: {poolsError}</div>
        ) : orderedPools.length === 0 ? (
          <div className="nt-state nt-state--empty">No pools reported for this token.</div>
        ) : (
          <div className="ics-table-wrap nt-scroll-x">
            <table className="ics-table">
              <thead>
                <tr>
                  <th className="ics-col-name" scope="col">Pair / token amounts</th>
                  <th scope="col">Fee</th>
                  <th scope="col" title="Reported dollar value can be inflated by illiquid token prices. Compare both token amounts.">Reported TVL</th>
                  <th scope="col">Volume 24h</th>
                  <th scope="col">Volume 7d</th>
                  <th scope="col">Fees 24h</th>
                  <th scope="col">Trades 24h</th>
                  <th className="ics-col-name" scope="col">Pool</th>
                </tr>
              </thead>
              <tbody>
                {orderedPools.slice(0, 25).map((pool) => (
                  <tr key={pool.poolId}>
                    <td className="ics-col-name">
                      <strong className="ics-pool-pair">{pool.token0Symbol} / {pool.token1Symbol}</strong>
                      <dl className="ics-pool-composition" aria-label="Reported pool token amounts">
                        {[pool.composition.token0, pool.composition.token1].map((token, side) => (
                          <div
                            className="ics-pool-composition__token"
                            key={side}
                            title={`${token.amount_tokens ?? "Unavailable"} ${token.symbol || "Token"}`}
                          >
                            <dt title={token.ledger_id}>{token.symbol || "Token"}</dt>
                            <dd>{formatPoolAmount(token.amount_tokens)}</dd>
                          </div>
                        ))}
                      </dl>
                    </td>
                    <td>{formatFeeTier(pool.poolFee)}</td>
                    <td title={pool.composition.reported_tvl_usd === null ? "Reported TVL unavailable" : `$${pool.composition.reported_tvl_usd}`}>
                      {pool.composition.reported_tvl_usd === null ? "Unavailable" : formatUsdCompact(pool.tvlUSD)}
                    </td>
                    <td>{formatUsdCompact(pool.volumeUSD24H)}</td>
                    <td>{formatUsdCompact(pool.volumeUSD7D)}</td>
                    <td>{formatUsdCompact(pool.feesUSD24H)}</td>
                    <td>{formatNumber(pool.txCount24H, 0)}</td>
                    <td className="ics-col-name ics-mono">
                      {shortPrincipal(pool.poolId)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {orderedPools.length > 0 ? (
          <p className="nt-meta ics-pool-composition-note">
            Token prices can inflate reported TVL. Compare both token amounts; they don&rsquo;t guarantee how much you can swap.
          </p>
        ) : null}
      </section>

      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Recent trades</h2>
          <span className="nt-section-count">
            {tradesTotal > 0 ? formatNumber(tradesTotal, 0) : trades.length}
          </span>
        </header>
        {tradesError ? (
          <div className="nt-alert nt-alert--warning">Trades unavailable: {tradesError}</div>
        ) : trades.length === 0 ? (
          <div className="nt-state nt-state--empty">
            {tradesLoading ? "Loading trades…" : "No recent trades reported."}
          </div>
        ) : (
          <div className="ics-table-wrap nt-scroll-x">
            <table className="ics-table">
              <thead>
                <tr>
                  <th className="ics-col-name" scope="col">When</th>
                  <th className="ics-col-name" scope="col">Action</th>
                  <th className="ics-col-name" scope="col">Pair</th>
                  <th scope="col">Value</th>
                  <th className="ics-col-name" scope="col">From</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade, index) => (
                  <tr key={`${trade.txHash}-${index}`}>
                    <td className="ics-col-name" title={formatDateTime(trade.txTime)}>
                      {formatRelative(trade.txTime)}
                    </td>
                    <td className="ics-col-name">{trade.actionType || "swap"}</td>
                    <td className="ics-col-name">
                      {trade.token0Symbol} / {trade.token1Symbol}
                    </td>
                    <td>
                      {formatUsdCompact(
                        Math.max(trade.token0TxValue, trade.token1TxValue),
                      )}
                    </td>
                    <td className="ics-col-name ics-mono">
                      {trade.from ? shortPrincipal(trade.from) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tradePageCount > 1 ? (
          <nav aria-label="Trade log pages" className="ics-pager">
            <button
              className="nt-button"
              disabled={tradesPage <= 1 || tradesLoading}
              onClick={() => setTradesPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              Newer
            </button>
            <span className="nt-meta">
              Page {formatNumber(tradesPage, 0)} of {formatNumber(tradePageCount, 0)}
            </span>
            <button
              className="nt-button"
              disabled={tradesPage >= tradePageCount || tradesLoading}
              onClick={() =>
                setTradesPage((current) => Math.min(tradePageCount, current + 1))
              }
              type="button"
            >
              Older
            </button>
          </nav>
        ) : null}
      </section>

      {row?.quote ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">On-chain price</h2>
            <span className="nt-section-count">
              {row.quote.viaIcp ? "via ICP" : "direct"}
            </span>
          </header>
          <dl className="nt-detail-grid">
            <div className="nt-detail">
              <dt className="nt-detail-label">Spot price</dt>
              <dd className="nt-detail-value">{formatPrice(row.priceUsd)}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Quoted against</dt>
              <dd className="nt-detail-value">{row.quote.quoteSymbol}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Fee tier</dt>
              <dd className="nt-detail-value">{formatFeeTier(row.quote.feeTier)}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Pool</dt>
              <dd className="nt-detail-value ics-mono">{row.quote.pool}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Recorded by this Neutron</h2>
          <span className="nt-section-count">{detail?.history.length ?? 0}</span>
        </header>
        {localPoints.length < 2 ? (
          <div className="nt-state nt-state--empty">
            Samples are recorded from live on-chain pool state on the app&apos;s own
            schedule. This series fills in over time and keeps working even when the
            ICPSwap API is unreachable.
          </div>
        ) : (
          <Chart
            formatTime={formatDateTime}
            formatValue={formatPrice}
            height={180}
            points={localPoints}
            valueLabel="Recorded price"
          />
        )}
      </section>

      {profile ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">Project</h2>
          </header>
          {profile.introduction ? (
            <p className="nt-text">{profile.introduction}</p>
          ) : null}
          <dl className="nt-detail-grid">
            <div className="nt-detail">
              <dt className="nt-detail-label">Standard</dt>
              <dd className="nt-detail-value">{profile.standard || "-"}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Decimals</dt>
              <dd className="nt-detail-value">{formatNumber(profile.decimals, 0)}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Transfer fee</dt>
              <dd className="nt-detail-value">{formatNumber(profile.fee, 0)}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Total supply</dt>
              <dd className="nt-detail-value">
                {profile.totalSupply > 0 ? formatNumber(profile.totalSupply / 10 ** profile.decimals, 0) : "-"}
              </dd>
            </div>
          </dl>
          {profile.links.length > 0 ? (
            <ul className="nt-tag-list">
              {profile.links.map((link) => (
                <li key={`${link.mediaType}-${link.link}`}>
                  <a
                    className="nt-tag"
                    href={link.link}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {link.mediaType || "Link"}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Your note</h2>
        </header>
        <div className="nt-field">
          <label className="nt-label" htmlFor="ics-note">
            Private to this Neutron
          </label>
          <textarea
            className="nt-textarea"
            id="ics-note"
            maxLength={280}
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setNoteDirty(true);
            }}
            rows={2}
            value={noteDraft}
          />
          <span className="nt-help">{noteDraft.length}/280</span>
        </div>
        <div className="ics-inline-actions">
          <button
            className="nt-button nt-button--sm"
            disabled={busy || !noteDirty}
            onClick={() => {
              onSaveNote(noteDraft);
              setNoteDirty(false);
            }}
            type="button"
          >
            Save note
          </button>
        </div>
      </section>
    </div>
  );
}
