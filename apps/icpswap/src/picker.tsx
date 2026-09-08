// Add-token overlay: search the whole ICPSwap universe with enough context to
// pick the right token, not just the right symbol.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "neutron-design-system";
import type { InfoToken } from "./api.ts";
import type { TokenCandidate } from "./backend.ts";
import {
  formatCompact,
  formatPercent,
  formatPrice,
  formatUsdCompact,
  trendOf,
} from "./format.ts";
import { TokenMark } from "./token_mark.tsx";

const PAGE_SIZE = 60;

export type PickerCandidate = {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange24H: number | null;
  volumeUsd24h: number | null;
  volumeUsd7d: number;
  tvlUsd: number;
  /** Only known on the on-chain fallback path. */
  poolCount: number | null;
  verified: boolean;
  watched: boolean;
};

export function candidatesFromUniverse(
  universe: InfoToken[],
  watched: ReadonlySet<string>,
  verified: ReadonlySet<string>,
): PickerCandidate[] {
  return universe.map((token) => ({
    address: token.ledgerId,
    symbol: token.symbol,
    name: token.name,
    priceUsd: token.price,
    priceChange24H: token.priceChange24H,
    volumeUsd24h: token.volumeUSD24H,
    volumeUsd7d: token.volumeUSD7D,
    tvlUsd: token.tvlUSD,
    poolCount: null,
    verified: verified.has(token.ledgerId),
    watched: watched.has(token.ledgerId),
  }));
}

export function candidatesFromBackend(
  items: TokenCandidate[],
): PickerCandidate[] {
  return items.map((item) => ({
    address: item.address,
    // The on-chain registry knows the pair and the pool count, not the market.
    symbol: item.symbol || item.address.slice(0, 8),
    name: item.name,
    priceUsd: 0,
    priceChange24H: null,
    volumeUsd24h: null,
    volumeUsd7d: 0,
    tvlUsd: 0,
    poolCount: item.poolCount,
    verified: item.verified,
    watched: item.watched,
  }));
}

function score(candidate: PickerCandidate, needle: string): number {
  if (needle === "") return 3;
  const symbol = candidate.symbol.toLowerCase();
  if (symbol === needle || candidate.address.toLowerCase() === needle) return 0;
  if (symbol.startsWith(needle)) return 1;
  if (symbol.includes(needle)) return 2;
  return 3;
}

export function rankCandidates(
  candidates: PickerCandidate[],
  term: string,
): PickerCandidate[] {
  const needle = term.trim().toLowerCase();
  const matched =
    needle === ""
      ? [...candidates]
      : candidates.filter(
          (candidate) =>
            candidate.symbol.toLowerCase().includes(needle) ||
            candidate.name.toLowerCase().includes(needle) ||
            candidate.address.toLowerCase().includes(needle),
        );
  matched.sort((left, right) => {
    const byScore = score(left, needle) - score(right, needle);
    if (byScore !== 0) return byScore;
    const byVolume = right.volumeUsd7d - left.volumeUsd7d;
    if (byVolume !== 0) return byVolume;
    return left.symbol.localeCompare(right.symbol, "en");
  });
  return matched;
}

export type TokenPickerProps = {
  candidates: PickerCandidate[];
  source: "live" | "on-chain";
  loading: boolean;
  error: string | null;
  busyAddress: string | null;
  onAdd: (candidate: PickerCandidate) => void;
  onClose: () => void;
};

export function TokenPicker({
  candidates,
  source,
  loading,
  error,
  busyAddress,
  onAdd,
  onClose,
}: TokenPickerProps) {
  const [term, setTerm] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.showModal();
    inputRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const ranked = useMemo(() => rankCandidates(candidates, term), [candidates, term]);
  const shown = useMemo(() => ranked.slice(0, visible), [ranked, visible]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
    setActive(0);
  }, [term]);

  const commit = useCallback(
    (candidate: PickerCandidate | undefined) => {
      if (!candidate || candidate.watched) return;
      onAdd(candidate);
    },
    [onAdd],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      // Native dialog buttons retain their own keyboard behavior. Search
      // arrows and Enter inspect the matching token without stealing a
      // keyboard click on Close or Show more.
      if (event.target !== inputRef.current) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((current) => Math.max(0, Math.min(current + 1, shown.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commit(shown[active]);
      }
    },
    [active, commit, onClose, shown],
  );

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <dialog
      className="ics-overlay ics-picker-dialog"
      ref={dialogRef}
      aria-labelledby="ics-picker-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ics-picker"
      >
        <header className="ics-picker-header">
          <h2 className="nt-subtitle" id="ics-picker-title">
            Add token
          </h2>
          <div className="ics-picker-search">
            <label className="nt-sr-only" htmlFor="ics-picker-input">
              Search tokens by symbol, name, or ledger id
            </label>
            <input
              autoComplete="off"
              className="nt-input"
              id="ics-picker-input"
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search symbol, name, or ledger canister id"
              ref={inputRef}
              spellCheck={false}
              type="search"
              value={term}
            />
          </div>
          <button
            aria-label="Close"
            className="nt-icon-button"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        <div className="ics-picker-body" ref={listRef}>
          {error ? (
            <div className="nt-alert nt-alert--danger" role="alert">
              {error}
            </div>
          ) : null}
          {loading && candidates.length === 0 ? (
            <div className="nt-state nt-state--loading">Loading token list…</div>
          ) : shown.length === 0 ? (
            <div className="nt-state nt-state--empty">
              No token matches “{term}”.
            </div>
          ) : (
            shown.map((candidate, index) => {
              const tone = trendOf(candidate.priceChange24H ?? 0);
              const busy = busyAddress === candidate.address;
              return (
                <button
                  className={cx("ics-picker-row", {
                    "nt-tag--selected": index === active,
                  })}
                  data-index={index}
                  disabled={candidate.watched || busy}
                  key={candidate.address}
                  onClick={() => commit(candidate)}
                  onMouseEnter={() => setActive(index)}
                  type="button"
                >
                  <TokenMark address={candidate.address} symbol={candidate.symbol} />
                  <span className="ics-picker-main">
                    <span className="ics-token-symbol">
                      {candidate.symbol || candidate.address.slice(0, 8)}
                      {candidate.verified ? (
                        <span className="nt-tag nt-tag--success" style={{ marginLeft: 6 }}>
                          verified
                        </span>
                      ) : null}
                    </span>
                    <span className="ics-token-name">{candidate.name || "—"}</span>
                    <span className="ics-picker-canister">{candidate.address}</span>
                  </span>
                  <span className="ics-picker-stats">
                    <span>
                      {candidate.priceUsd > 0 ? formatPrice(candidate.priceUsd) : "-"}
                    </span>
                    {candidate.priceChange24H === null ? null : (
                      <span className={`ics-change ics-change--${tone}`}>
                        {formatPercent(candidate.priceChange24H)}
                      </span>
                    )}
                    {candidate.volumeUsd24h === null ? (
                      <span className="nt-meta">
                        {candidate.poolCount === null
                          ? "on-chain listing"
                          : `${candidate.poolCount} pool${candidate.poolCount === 1 ? "" : "s"}`}
                      </span>
                    ) : (
                      <>
                        <span className="nt-meta">
                          24h vol {formatUsdCompact(candidate.volumeUsd24h)}
                        </span>
                        <span className="nt-meta">
                          TVL {formatUsdCompact(candidate.tvlUsd)}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="nt-tag">
                    {candidate.watched ? "watching" : busy ? "adding…" : "add"}
                  </span>
                </button>
              );
            })
          )}
          {shown.length < ranked.length ? (
            <div className="ics-empty-block">
              <button
                className="nt-button nt-button--secondary nt-button--sm"
                onClick={() => setVisible((current) => current + PAGE_SIZE)}
                type="button"
              >
                Show more
              </button>
            </div>
          ) : null}
        </div>

        <footer className="ics-picker-footer">
          <span>
            {formatCompact(ranked.length, 0)} of {formatCompact(candidates.length, 0)}{" "}
            tokens
          </span>
          <span>
            {source === "live"
              ? "Live ICPSwap analytics"
              : "On-chain price index (API unavailable)"}
          </span>
        </footer>
      </div>
    </dialog>
  );
}
