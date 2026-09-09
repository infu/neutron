// The watchlist market table: a compact, sortable overview of every token the
// owner is tracking, merging live ICPSwap analytics onto the sovereign
// on-chain row the backend supplies.

import { useMemo } from "react";
import { cx } from "neutron-design-system";
import type { InfoToken, InfoTokenRank } from "./api.ts";
import type { MarketRow, SortKey } from "./backend.ts";
import { Sparkline } from "./chart.tsx";
import {
  formatCompact,
  formatNumber,
  formatPercent,
  formatPrice,
  formatUsdCompact,
  trendOf,
} from "./format.ts";
import { sortMerged, type SortColumnKey } from "./sort.ts";
import { TokenMark } from "./token_mark.tsx";

export type MergedRow = {
  row: MarketRow;
  live: InfoToken | undefined;
  rank: InfoTokenRank | undefined;
};

export type MarketColumn = {
  key: SortColumnKey;
  label: string;
  title: string;
  /** Columns the backend can order; others sort locally on merged data. */
  backendSort: SortKey | null;
  /** Which way a first click sorts: names read A-Z, figures read biggest first. */
  defaultAscending: boolean;
};

/** The direction a column takes when it is newly selected. */
export function defaultDirectionFor(key: MarketColumn["key"]): boolean {
  return MARKET_COLUMNS.find((column) => column.key === key)?.defaultAscending ?? false;
}

export const MARKET_COLUMNS: MarketColumn[] = [
  { key: "symbol", label: "Token", title: "Symbol and name", backendSort: "symbol", defaultAscending: true },
  { key: "price", label: "Price", title: "Last traded price in USD", backendSort: "price", defaultAscending: false },
  { key: "change24h", label: "24h %", title: "Price change over 24 hours", backendSort: null, defaultAscending: false },
  { key: "volume24h", label: "24h volume", title: "Traded volume over 24 hours", backendSort: null, defaultAscending: false },
  { key: "volume7d", label: "7d volume", title: "Traded volume over 7 days", backendSort: null, defaultAscending: false },
  { key: "tvl", label: "Liquidity", title: "Value held in pools trading this token", backendSort: null, defaultAscending: false },
  { key: "marketCap", label: "Market cap", title: "Circulating market capitalisation. Only the tokens ICPSwap ranks report one.", backendSort: null, defaultAscending: false },
  { key: "pools", label: "Pools", title: "Pools trading this token, from the on-chain registry", backendSort: "pools", defaultAscending: false },
];

export type MarketTableProps = {
  entries: MergedRow[];
  sortKey: MarketColumn["key"];
  ascending: boolean;
  onSort: (key: MarketColumn["key"]) => void;
  onOpen: (address: string) => void;
  onTogglePin: (row: MarketRow) => void;
  onRemove: (row: MarketRow) => void;
  busyAddress: string | null;
  compact?: boolean;
};

function MarketPrice({ row, live }: Pick<MergedRow, "row" | "live">) {
  const price = live?.price ?? row.priceUsd;
  if (!Number.isFinite(price) || price <= 0) return <span title="Price unavailable">—</span>;
  return <span title={live ? "Price in USD" : "Last saved price; current price unavailable"}>{formatPrice(price)}{!live ? <span className="nt-sr-only"> (last saved price)</span> : null}</span>;
}

export function MarketTable({
  entries,
  sortKey,
  ascending,
  onSort,
  onOpen,
  onTogglePin,
  onRemove,
  busyAddress,
  compact = false,
}: MarketTableProps) {
  const ordered = useMemo(
    () => sortMerged(entries, sortKey, ascending),
    [entries, sortKey, ascending],
  );

  return (
    <div className={cx("ics-market-table", compact && "ics-market-table--compact")}>
      <div className="ics-market-cards">
        {ordered.map(({ row, live }) => <div key={row.address} className="ics-market-card-item"><button className="ics-market-card" type="button" onClick={() => onOpen(row.address)}>
          <TokenMark address={row.address} symbol={row.symbol} />
          <span className="ics-token-names" title={row.address}><strong className="ics-token-symbol">{row.symbol || row.address.slice(0, 8)}</strong><span className="ics-token-name">{live?.name || row.name || row.address}</span></span>
          <span className="ics-market-card-values"><strong><MarketPrice row={row} live={live} /></strong><span className={`ics-change ics-change--${trendOf(live?.priceChange24H)}`} title="Price change over 24 hours">{live && Number.isFinite(live.priceChange24H) ? formatPercent(live.priceChange24H) : "—"}</span></span>
        </button><span className="ics-market-card-actions">
          <button className="nt-icon-button" type="button" aria-label={`${row.pinned ? "Unpin" : "Pin"} ${row.symbol || row.address}`} aria-pressed={row.pinned} title={row.pinned ? "Unpin" : "Pin to top"} disabled={busyAddress === row.address} onClick={() => onTogglePin(row)}>{row.pinned ? "★" : "☆"}</button>
          <button className="nt-icon-button" type="button" aria-label={`Remove ${row.symbol || row.address} from watchlist`} title="Remove from watchlist" disabled={busyAddress === row.address} onClick={() => onRemove(row)}>✕</button>
        </span></div>)}
      </div>
      <div className="ics-table-wrap nt-scroll-x"><table className="ics-table">
        <thead>
          <tr>
            <th className="ics-col-rank" scope="col">
              #
            </th>
            {MARKET_COLUMNS.map((column) => (
              <th
                aria-sort={
                  sortKey === column.key
                    ? ascending
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className={cx("ics-col-sortable", {
                  "ics-col-name": column.key === "symbol",
                })}
                key={column.key}
                scope="col"
                title={column.title}
              >
                <button className="ics-sort-button" type="button" onClick={() => onSort(column.key)}>{column.label}
                {sortKey === column.key ? (
                  <span aria-hidden="true" className="ics-sort-caret">
                    {ascending ? "▲" : "▼"}
                  </span>
                ) : null}</button>
              </th>
            ))}
            <th scope="col" title="Locally recorded price trend">
              Trend
            </th>
            <th className="ics-col-actions" scope="col">
              <span className="nt-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((entry, index) => {
            const { row, live, rank } = entry;
            const change = live?.priceChange24H;
            const tone = trendOf(change);
            const busy = busyAddress === row.address;
            return (
              <tr
                key={row.address}
                onClick={() => onOpen(row.address)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onOpen(row.address);
                  }
                }}
              >
                <td className="ics-col-rank">{index + 1}</td>
                <td className="ics-col-name">
                  <span className="ics-token-cell">
                    <TokenMark address={row.address} symbol={row.symbol} />
                    <span className="ics-token-names" title={row.address}>
                      <span className="ics-token-symbol">
                        {row.symbol || row.address.slice(0, 8)}
                        {row.pinned ? (
                          <span className="nt-sr-only"> (pinned)</span>
                        ) : null}
                      </span>
                      <span className="ics-token-name">
                        {live?.name || row.name || row.address}
                      </span>
                    </span>
                  </span>
                </td>
                <td><MarketPrice row={row} live={live} /></td>
                <td className={`ics-change ics-change--${tone}`}>
                  {change === undefined || !Number.isFinite(change) ? "—" : formatPercent(change)}
                </td>
                <td>
                  {live ? formatUsdCompact(live.volumeUSD24H) : "-"}
                </td>
                <td>{live ? formatUsdCompact(live.volumeUSD7D) : "-"}</td>
                <td>{live ? formatUsdCompact(live.tvlUSD) : "-"}</td>
                <td>{rank ? formatUsdCompact(rank.marketCap) : "-"}</td>
                <td>
                  {formatNumber(row.poolCount, 0)}
                </td>
                <td>
                  <Sparkline
                    points={row.sparkline.map((value, position) => ({
                      t: position,
                      v: value,
                    }))}
                    title={`${row.symbol} recorded price trend`}
                    tone={tone}
                  />
                </td>
                <td className="ics-col-actions">
                  <span className="ics-inline-actions">
                    <button
                      aria-label={`${row.pinned ? "Unpin" : "Pin"} ${row.symbol || row.address}`}
                      aria-pressed={row.pinned}
                      className="nt-icon-button"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePin(row);
                      }}
                      title={row.pinned ? "Unpin" : "Pin to top"}
                      type="button"
                    >
                      {row.pinned ? "★" : "☆"}
                    </button>
                    <button
                      aria-label={`Remove ${row.symbol || row.address} from watchlist`}
                      className="nt-icon-button"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(row);
                      }}
                      title="Remove from watchlist"
                      type="button"
                    >
                      ✕
                    </button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}

export type MarketKpisProps = {
  entries: MergedRow[];
  icpPriceUsd: number;
  universeSize: number;
};

export function MarketKpis({
  entries,
  icpPriceUsd,
  universeSize,
}: MarketKpisProps) {
  const movers = useMemo(() => {
    let gainers = 0;
    let losers = 0;
    let available = 0;
    for (const entry of entries) {
      const change = entry.live?.priceChange24H;
      if (change === undefined || !Number.isFinite(change)) continue;
      available += 1;
      if (change > 0) gainers += 1;
      else if (change < 0) losers += 1;
    }
    return { gainers, losers, available };
  }, [entries]);

  return <div className="ics-market-summary">
    <article><span className="nt-meta">ICP</span><strong>{icpPriceUsd > 0 ? formatPrice(icpPriceUsd) : "—"}</strong></article>
    <article><span className="nt-meta">24h movers</span><strong title={movers.available > 0 ? `Price changes available for ${movers.available} of ${entries.length} watched tokens` : "Price changes unavailable"}>{movers.available > 0 ? <><span className="ics-change--up">{movers.gainers} ↑</span><span className="ics-change--down">{movers.losers} ↓</span></> : "—"}</strong></article>
    <article><span className="nt-meta">Watching</span><strong title={`${formatCompact(universeSize, 0)} tokens on ICPSwap`}>{entries.length}</strong></article>
  </div>;
}
