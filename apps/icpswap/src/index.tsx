// ICPSwap Market tile.
//
// Two data planes are merged here: the app's own Neutron backend (watchlist,
// on-chain prices and pool TVL, locally recorded history) and the ICPSwap
// analytics API (24h figures, OHLC charts, market cap). The backend plane keeps
// working when the API does not, and the header always says which one is live.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { onAppStateChange, onTileViewRequest } from "neutron-tools/app";
import {
  ICP_LEDGER_ID,
  IcpSwapApiError,
  loadTokenRanks,
  loadTokenUniverse,
  type InfoToken,
  type InfoTokenRank,
} from "./api.ts";
import {
  addToken,
  getMarket,
  getSwapJournal,
  getToken,
  removeToken,
  searchTokens,
  setNote,
  setPinned,
  type MarketRow,
  type MarketSnapshot,
  type SortKey,
  type TokenDetail,
} from "./backend.ts";
import { TokenDetailView } from "./detail.tsx";
import { SwapPanel, type SwapToken } from "./swap.tsx";
import { formatRelative } from "./format.ts";
import {
  MARKET_COLUMNS,
  MarketKpis,
  MarketTable,
  defaultDirectionFor,
  type MarketColumn,
  type MergedRow,
} from "./market.tsx";
import {
  TokenPicker,
  candidatesFromBackend,
  candidatesFromUniverse,
  type PickerCandidate,
} from "./picker.tsx";
import { ReviewHost } from "./review.tsx";
import { LiquidityView } from "./liquidity.tsx";
import { ActivityView } from "./activity.tsx";
import "./style.scss";

/** A sensible starting watchlist offered on an empty install. */
const STARTER_TOKENS: ReadonlyArray<{ address: string; symbol: string; name: string }> =
  [
    { address: "ryjl3-tyaaa-aaaaa-aaaba-cai", symbol: "ICP", name: "Internet Computer" },
    { address: "mxzaz-hqaaa-aaaar-qaada-cai", symbol: "ckBTC", name: "ckBTC" },
    { address: "ss2fx-dyaaa-aaaar-qacoq-cai", symbol: "ckETH", name: "ckETH" },
    { address: "xevnm-gaaaa-aaaar-qafnq-cai", symbol: "ckUSDC", name: "ckUSDC" },
    { address: "cngnf-vqaaa-aaaar-qag4q-cai", symbol: "ckUSDT", name: "ckUSDT" },
    { address: "f54if-eqaaa-aaaaq-aacea-cai", symbol: "NTN", name: "Neutrinite" },
    { address: "hvgxa-wqaaa-aaaaq-aacia-cai", symbol: "SNEED", name: "Sneed DAO" },
    { address: "kylwo-viaaa-aaaaq-aae7a-cai", symbol: "TENDY", name: "Tendies" },
    { address: "rh2pm-ryaaa-aaaan-qeniq-cai", symbol: "EXE", name: "Windoge98" },
    { address: "n5r46-eqaaa-aaaae-qfzba-cai", symbol: "TOKO", name: "Toko Token" },
    { address: "zfcdd-tqaaa-aaaaq-aaaga-cai", symbol: "DKP", name: "Draggin Karma Points" },
  ];

const UNIVERSE_REFRESH_MS = 60_000;

type View = { kind: "swap" } | { kind: "market" } | { kind: "liquidity" } | { kind: "activity" } | { kind: "token"; address: string };

function describeError(error: unknown): string {
  if (error instanceof IcpSwapApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tokens the owner can swap into: the rest of the watchlist.
 *
 * Deliberately not the whole ICPSwap universe — a swap needs the ledger to be
 * selected in the owner's Wallet, and the watchlist is the set this Neutron
 * already knows the decimals and symbol for.
 */
function swapChoices(
  snapshot: MarketSnapshot | null,
  exclude: string,
): SwapToken[] {
  return (snapshot?.rows ?? [])
    .filter((row) => row.address !== exclude)
    .map((row) => ({
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
    }));
}

function backendSortFor(key: MarketColumn["key"]): SortKey {
  const column = MARKET_COLUMNS.find((entry) => entry.key === key);
  return column?.backendSort ?? "price";
}

export function App() {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [universe, setUniverse] = useState<InfoToken[]>([]);
  const [ranks, setRanks] = useState<InfoTokenRank[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "swap" });
  const [swapInput, setSwapInput] = useState("");
  const [swapOutput, setSwapOutput] = useState("");
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFallback, setPickerFallback] = useState<PickerCandidate[]>([]);
  const [pickerFallbackLoading, setPickerFallbackLoading] = useState(false);
  const [pickerFallbackError, setPickerFallbackError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<MarketColumn["key"]>("volume24h");
  const [ascending, setAscending] = useState(false);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [swapSlippage, setSwapSlippage] = useState(500);
  const mounted = useRef(true);
  const backendRead = useRef(0);
  const analyticsRead = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => {
      if (mounted.current) setToast(null);
    }, 3200);
  }, []);

  const loadBackend = useCallback(async () => {
    const sequence = ++backendRead.current;
    try {
      const next = await getMarket(backendSortFor(sortKey), ascending);
      if (!mounted.current || sequence !== backendRead.current) return;
      setSnapshot(next);
      setBackendError(null);
    } catch (error) {
      if (!mounted.current || sequence !== backendRead.current) return;
      setBackendError(describeError(error));
    }
  }, [ascending, sortKey]);

  const loadLive = useCallback(async (ttlMs = UNIVERSE_REFRESH_MS) => {
    const sequence = ++analyticsRead.current;
    try {
      const [tokens, tokenRanks] = await Promise.all([
        loadTokenUniverse(ttlMs),
        loadTokenRanks().catch(() => [] as InfoTokenRank[]),
      ]);
      if (!mounted.current || sequence !== analyticsRead.current) return;
      setUniverse(tokens);
      setRanks(tokenRanks);
      setLiveError(null);
    } catch (error) {
      if (!mounted.current || sequence !== analyticsRead.current) return;
      setLiveError(describeError(error));
    }
  }, []);

  useEffect(() => {
    void getSwapJournal(1)
      .then((page) => {
        if (mounted.current && page.slippage > 0) setSwapSlippage(page.slippage);
      })
      .catch(() => undefined);
  }, []);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([loadBackend(), loadLive()]);
      if (!cancelled && mounted.current) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately runs once: later refreshes go through the handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sort through the backend when the chosen column is one it can order.
  useEffect(() => {
    if (loading) return;
    void loadBackend();
  }, [loadBackend, loading]);

  // The resident background publishes a revision whenever it refreshes.
  useEffect(() => {
    const stop = onAppStateChange("market", () => {
      void loadBackend();
      void loadLive(0);
    });
    return stop;
  }, [loadBackend, loadLive]);

  // Deep link support: a view token of "add" opens the picker.
  useEffect(() => {
    const stop = onTileViewRequest((requested) => {
      if (requested === "add") setPickerOpen(true);
      if (requested === "market") setView({ kind: "market" });
      if (requested === "swap") setView({ kind: "swap" });
      if (requested === "liquidity") setView({ kind: "liquidity" });
      if (requested === "activity") setView({ kind: "activity" });
    });
    return stop;
  }, []);

  // Keep live analytics warm while the tile is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadLive();
    }, UNIVERSE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadLive]);

  const universeMap = useMemo(() => {
    const index = new Map<string, InfoToken>();
    for (const token of universe) index.set(token.ledgerId, token);
    return index;
  }, [universe]);

  const rankMap = useMemo(() => {
    const index = new Map<string, InfoTokenRank>();
    for (const rank of ranks) index.set(rank.ledgerId, rank);
    return index;
  }, [ranks]);

  const watchedSet = useMemo(
    () => new Set((snapshot?.rows ?? []).map((row) => row.address)),
    [snapshot],
  );

  const verifiedSet = useMemo(
    () =>
      new Set(
        (snapshot?.rows ?? [])
          .filter((row) => row.verified)
          .map((row) => row.address),
      ),
    [snapshot],
  );

  const detailSwapChoices = useMemo(
    () =>
      view.kind === "token" ? swapChoices(snapshot, view.address) : [],
    [snapshot, view],
  );

  const tradeTokens = useMemo(() => swapChoices(snapshot, ""), [snapshot]);
  const tradeInput = tradeTokens.find((token) => token.address === swapInput) ?? tradeTokens[0] ?? null;
  const tradeChoices = useMemo(() => tradeTokens.filter((token) => token.address !== tradeInput?.address), [tradeTokens, tradeInput?.address]);
  const tradeOutput = tradeChoices.find((token) => token.address === swapOutput) ?? tradeChoices[0] ?? null;
  // Persist the initially displayed pair. Backend market ordering can change
  // during a refresh and must not silently change the asset being priced.
  useEffect(() => {
    if (tradeInput && swapInput !== tradeInput.address) setSwapInput(tradeInput.address);
    if (tradeOutput && swapOutput !== tradeOutput.address) setSwapOutput(tradeOutput.address);
  }, [tradeInput?.address, tradeOutput?.address, swapInput, swapOutput]);

  const merged = useMemo<MergedRow[]>(() => {
    const rows = snapshot?.rows ?? [];
    const needle = filter.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (needle === "") return true;
        const live = universeMap.get(row.address);
        return (
          row.symbol.toLowerCase().includes(needle) ||
          row.name.toLowerCase().includes(needle) ||
          row.address.toLowerCase().includes(needle) ||
          (live?.name.toLowerCase().includes(needle) ?? false)
        );
      })
      .map((row) => ({
        row,
        live: liveError ? undefined : universeMap.get(row.address),
        rank: liveError ? undefined : rankMap.get(row.address),
      }));
  }, [filter, rankMap, snapshot, universeMap, liveError]);

  // Token detail data.
  useEffect(() => {
    if (view.kind !== "token") {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void getToken(view.address)
      .then((value) => {
        if (!cancelled && mounted.current) setDetail(value);
      })
      .catch((error: unknown) => {
        if (!cancelled && mounted.current) setBackendError(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot, view]);

  // Picker fallback: if the live universe is unavailable, search on chain.
  useEffect(() => {
    if (!pickerOpen || universe.length > 0) return;
    let cancelled = false;
    setPickerFallbackLoading(true);
    setPickerFallbackError(null);
    void searchTokens("", 0, 50)
      .then((page) => {
        if (!cancelled && mounted.current) {
          setPickerFallback(candidatesFromBackend(page.items));
        }
      })
      .catch((error) => { if (!cancelled && mounted.current) setPickerFallbackError(describeError(error)); })
      .finally(() => { if (!cancelled && mounted.current) setPickerFallbackLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, universe.length]);

  const handleSort = useCallback((key: MarketColumn["key"]) => {
    setSortKey((current) => {
      if (current === key) {
        setAscending((value) => !value);
        return current;
      }
      // A newly chosen column opens the way that column reads best: names
      // A-Z, figures biggest first.
      setAscending(defaultDirectionFor(key));
      return key;
    });
  }, []);

  const runMutation = useCallback(
    async (address: string, action: () => Promise<string>) => {
      setBusyAddress(address);
      try {
        const message = await action();
        await loadBackend();
        showToast(message);
      } catch (error) {
        showToast(describeError(error));
      } finally {
        if (mounted.current) setBusyAddress(null);
      }
    },
    [loadBackend, showToast],
  );

  const handleAdd = useCallback(
    (candidate: PickerCandidate) =>
      void runMutation(candidate.address, async () => {
        const report = await addToken({
          address: candidate.address,
          symbol: candidate.symbol,
          name: candidate.name,
          standard: "",
          decimals: 0,
        });
        return report.message;
      }),
    [runMutation],
  );

  const handleRemove = useCallback(
    (row: MarketRow) =>
      void runMutation(row.address, async () => {
        const report = await removeToken(row.address);
        if (view.kind === "token" && view.address === row.address) {
          setView({ kind: "market" });
        }
        return report.message;
      }),
    [runMutation, view],
  );

  const handleTogglePin = useCallback(
    (row: MarketRow) =>
      void runMutation(row.address, async () => {
        const report = await setPinned(row.address, !row.pinned);
        return report.message;
      }),
    [runMutation],
  );

  const handleSaveNote = useCallback(
    (address: string, note: string) =>
      void runMutation(address, async () => {
        const report = await setNote(address, note);
        return report.message;
      }),
    [runMutation],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadLive(0), loadBackend()]);
      showToast("Market data refreshed");
    } catch (error) {
      showToast(describeError(error));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [loadBackend, loadLive, showToast]);

  const handleSeed = useCallback(async () => {
    setRefreshing(true);
    try {
      for (const token of STARTER_TOKENS) {
        await addToken({
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          standard: "",
          decimals: 0,
        });
      }
      await loadBackend();
      showToast("Starter tokens added");
    } catch (error) {
      showToast(describeError(error));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [loadBackend, showToast]);

  const pickerCandidates = useMemo<PickerCandidate[]>(
    () =>
      universe.length > 0
        ? candidatesFromUniverse(universe, watchedSet, verifiedSet).map((candidate) => liveError ? { ...candidate, priceUsd: 0, priceChange24H: null, volumeUsd24h: null, volumeUsd7d: 0, tvlUsd: 0 } : candidate)
        : pickerFallback.map((candidate) => ({
            ...candidate,
            watched: watchedSet.has(candidate.address),
          })),
    [pickerFallback, universe, verifiedSet, watchedSet, liveError],
  );

  // The on-chain price index is the preferred ICP reference, but the live
  // analytics list carries ICP too, so a cold or failed on-chain refresh does
  // not leave every ICP quote blank.
  const icpPriceUsd = useMemo(() => {
    const onChain = snapshot?.status.icpPriceUsd ?? 0;
    if (onChain > 0) return onChain;
    return liveError ? 0 : universeMap.get(ICP_LEDGER_ID)?.price ?? 0;
  }, [snapshot, universeMap, liveError]);

  const status = snapshot?.status;
  const freshness = status && status.lastRefreshAt > 0
    ? formatRelative(status.lastRefreshAt)
    : "never";
  const statusTone = liveError
    ? "ics-status--error"
    : status && status.lastRefreshAt === 0
      ? "ics-status--stale"
      : "";

  return (
    <main className={cx(nt.appFill, "ics-app")}>
      <div className="ics-shell">
        <header className="nt-app-header ics-app-header">
          <div className="nt-app-header-main">
            <img className="nt-app-header-icon" src="static/icon.svg" alt="" />
            <div className="nt-app-header-copy">
              <h1 className="nt-app-header-title">via ICPSwap</h1>
              <p className="nt-app-header-subtitle">Swaps &amp; liquidity</p>
            </div>
          </div>
          <div className="nt-app-header-actions">
            <span className={cx("ics-status", statusTone)} title={`On-chain prices refreshed ${freshness}${liveError ? "; analytics unavailable" : "; ICPSwap analytics available"}`} aria-label={liveError ? "Analytics unavailable" : "Internet Computer"}>
              <span aria-hidden="true" className="nt-status-dot" />
              <span className="ics-network-label">ICP</span>
            </span>
            <button className="nt-icon-button nt-app-header-control" disabled={refreshing} onClick={() => void handleRefresh()} aria-label={refreshing ? "Refreshing market data" : "Refresh market data"} title="Refresh" type="button">↻</button>
          </div>
        </header>
        <nav className="ics-navigation" aria-label="ICPSwap views">
          <div className="ics-tabs">
            <button className="ics-tab" aria-current={view.kind === "swap" ? "page" : undefined} onClick={() => setView({ kind: "swap" })} type="button">Swap</button>
            <button className="ics-tab" aria-current={view.kind === "market" || view.kind === "token" ? "page" : undefined} onClick={() => setView({ kind: "market" })} type="button">Markets</button>
            <button className="ics-tab" aria-current={view.kind === "liquidity" ? "page" : undefined} onClick={() => setView({ kind: "liquidity" })} type="button">Liquidity</button>
            <button className="ics-tab" aria-current={view.kind === "activity" ? "page" : undefined} onClick={() => setView({ kind: "activity" })} type="button">Activity</button>
          </div>
          <button className="nt-button nt-button--ghost nt-button--sm" onClick={() => setPickerOpen(true)} type="button">+ Token</button>
        </nav>

        <div className="ics-body">
          {backendError ? (
            <details className="nt-alert nt-alert--warning"><summary>Saved token data is unavailable</summary><p className="nt-meta">{backendError}</p></details>
          ) : null}
          {liveError ? (
            <details className="nt-alert nt-alert--warning"><summary>Market data is delayed</summary><p className="nt-meta">Showing saved pool prices where available. {liveError}</p></details>
          ) : null}
          {status?.lastRefreshError ? (
            <details className="nt-alert nt-alert--warning">
              <summary>
                Some pool prices could not be refreshed
              </summary>
              <p className="nt-meta ics-mono">{status.lastRefreshError}</p>
            </details>
          ) : null}

          {view.kind === "liquidity" ? <LiquidityView tokens={tradeTokens} prices={liveError ? [] : universe} /> : view.kind === "activity" ? <ActivityView /> : loading ? (
            <div className="nt-state nt-state--loading">Loading market…</div>
          ) : view.kind === "token" ? (
            <TokenDetailView
              key={view.address}
              address={view.address}
              busy={busyAddress === view.address}
              detail={detail?.row.address === view.address ? detail : null}
              live={liveError ? undefined : universeMap.get(view.address)}
              onBack={() => setView({ kind: "market" })}
              onRemove={() => {
                if (detail?.row.address === view.address) handleRemove(detail.row);
              }}
              onSaveNote={(note) => handleSaveNote(view.address, note)}
              onTogglePin={() => {
                if (detail?.row.address === view.address) handleTogglePin(detail.row);
              }}
              icpPriceUsd={icpPriceUsd}
              rank={liveError ? undefined : rankMap.get(view.address)}
              swapChoices={detailSwapChoices}
              swapSlippage={swapSlippage}
            />
          ) : snapshot === null ? (
            <section className="ics-empty-block"><h2 className="nt-subtitle">Your tokens could not be loaded</h2><p className="nt-muted">Refresh to reconnect to your saved watchlist.</p><button className="nt-button" disabled={refreshing} onClick={() => void handleRefresh()} type="button">Refresh tokens</button></section>
          ) : snapshot.rows.length === 0 ? (
            <section className="nt-panel ics-empty-block">
              <h2 className="nt-subtitle">Your watchlist is empty</h2>
              <p className="nt-text">
                Add tokens to swap and follow their prices, charts and pools.
              </p>
              <div className="ics-inline-actions">
                <button
                  className="nt-button"
                  disabled={refreshing}
                  onClick={() => void handleSeed()}
                  type="button"
                >
                  Add starter tokens
                </button>
                <button
                  className="nt-button nt-button--secondary"
                  onClick={() => setPickerOpen(true)}
                  type="button"
                >
                  Browse all tokens
                </button>
              </div>
            </section>
          ) : view.kind === "swap" && tradeInput ? (
            <div className="ics-trade-layout">
              <SwapPanel
                input={tradeInput}
                inputChoices={tradeTokens}
                onChooseInput={setSwapInput}
                output={tradeOutput}
                choices={tradeChoices}
                onChooseOutput={setSwapOutput}
                initialSlippage={swapSlippage}
              />
              <aside className="ics-trade-markets">
                <header className="nt-section-header"><h2 className="nt-section-heading">Your markets</h2><button className="nt-button nt-button--ghost nt-button--sm" onClick={() => setView({ kind: "market" })} type="button">View all →</button></header>
                <MarketTable ascending={ascending} busyAddress={busyAddress} entries={merged} onOpen={(address) => setView({ kind: "token", address })} onRemove={handleRemove} onSort={handleSort} onTogglePin={handleTogglePin} sortKey={sortKey} compact />
              </aside>
            </div>
          ) : (
            <>
              <div className="ics-market-toolbar">
                <label className="nt-sr-only" htmlFor="ics-filter">Filter your watchlist</label>
                <input autoComplete="off" className="nt-input" id="ics-filter" onChange={(event) => setFilter(event.target.value)} placeholder="Search tokens" spellCheck={false} type="search" value={filter} />
                <select className="nt-select ics-market-sort" aria-label="Sort markets" value={sortKey} onChange={(event) => handleSort(event.target.value as MarketColumn["key"])}>{MARKET_COLUMNS.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select>
                <button className="nt-icon-button" aria-label={ascending ? "Sort descending" : "Sort ascending"} title={ascending ? "Ascending" : "Descending"} onClick={() => setAscending((value) => !value)} type="button">{ascending ? "↑" : "↓"}</button>
              </div>
              <MarketKpis
                entries={merged}
                icpPriceUsd={icpPriceUsd}
                universeSize={universe.length || (status?.universeTokens ?? 0)}
              />
              {merged.length === 0 ? (
                <div className="nt-state nt-state--empty">
                  No watched token matches “{filter}”.
                </div>
              ) : (
                <MarketTable
                  ascending={ascending}
                  busyAddress={busyAddress}
                  entries={merged}
                  onOpen={(address) => setView({ kind: "token", address })}
                  onRemove={handleRemove}
                  onSort={handleSort}
                  onTogglePin={handleTogglePin}
                  sortKey={sortKey}
                />
              )}
            </>
          )}
        </div>

        {toast ? (
          <output aria-live="polite" className="nt-result">
            {toast}
          </output>
        ) : null}
      </div>

      <ReviewHost />
      {pickerOpen ? (
        <TokenPicker
          busyAddress={busyAddress}
          candidates={pickerCandidates}
          error={pickerFallbackError ?? liveError}
          loading={loading || (universe.length === 0 && pickerFallbackLoading)}
          onAdd={(candidate) => {
            handleAdd(candidate);
          }}
          onClose={() => setPickerOpen(false)}
          source={universe.length > 0 ? "live" : "on-chain"}
        />
      ) : null}
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

createRoot(container).render(<App />);
