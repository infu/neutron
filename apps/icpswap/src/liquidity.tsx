import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callTool, createMsgBusClient, isJsonObject, loadNeutronCanisterId, type JsonObject, type JsonValue } from "neutron-tools/app";
import { createLiquidityReadClient, type BrowserPoolView, type BrowserPosition, type PoolIdentity } from "./liquidity_reads.ts";
import { amountsForLiquidity, getSqrtRatioAtTick, liquidityForAmounts, priceToTick, tickToPrice, usableTickRange } from "./liquidity_math.ts";
import { fromBaseUnits, toBaseUnits } from "./amount.ts";
import { formatFeeTier, formatTokenAmount, shortPrincipal } from "./format.ts";
import { createRequestId } from "./funding.ts";
import { addLedgerToWallet, readTokenInfo, walletSetupRequired, type WalletTokenInfo } from "./wallet.ts";
import { parseActionProgress, type ActionProgress } from "./action_client.ts";
import { ActionCard, loadActionHistory, type SavedAction } from "./activity.tsx";
import { TokenMark } from "./token_mark.tsx";
import { retainedPoolsFromOperations } from "./tools.ts";
import { formatLiquidityAmount, formatLiquidityUsd, liquidityPairValue, liquidityRangeProgress, liquidityUsdValue } from "./liquidity_display.ts";
import { fetchPositionPerformance, type PositionPerformance } from "./position_performance.ts";
import type { InfoToken } from "./api.ts";
import type { SwapToken } from "./swap.tsx";
import { amountAtPercent, percentForAmount, spendableBalance } from "./amount_allocation.ts";
import { estimateLiquidityPayout } from "./liquidity_quote.ts";

type LiquidityKind = "mint" | "increase" | "decrease" | "claim" | "withdraw";
type Selection = { kind: LiquidityKind; pool: string; position?: BrowserPosition; withdrawToken?: string };
type RangePreview = { ok: true; tickLower: number; tickUpper: number; atoms0: bigint; atoms1: bigint; liquidity: bigint; amounts: { amount0: bigint; amount1: bigint }; error: "" } | { ok: false; error: string };
type TokenMeta = { address: string; symbol: string; decimals: number | null; priceUsd?: number | null };
const NO_MARKET_PRICES: readonly Pick<InfoToken, "ledgerId" | "price">[] = [];
const actionNames: Record<LiquidityKind, string> = { mint: "New position", increase: "Add liquidity", decrease: "Remove liquidity", claim: "Collect fees", withdraw: "Withdraw unused funds" };
const message = (value: unknown) => value instanceof Error ? value.message : String(value);
function shortPrice(value: string): string {
  if (value.length <= 16) return value;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toPrecision(6).replace(/\.0+(?=e|$)/u, "") : value;
}
function shownAmount(atoms: string | null, token: TokenMeta): string {
  if (atoms === null) return "Unavailable";
  return token.decimals === null ? `${atoms} atoms` : formatTokenAmount(BigInt(atoms), token.decimals);
}
function poolLabel(pool: PoolIdentity, tokens: Map<string, TokenMeta>): string {
  return `${tokens.get(pool.token0.address)?.symbol ?? shortPrincipal(pool.token0.address)} / ${tokens.get(pool.token1.address)?.symbol ?? shortPrincipal(pool.token1.address)}`;
}
function PriceRange({ position, token0, token1 }: { position: Pick<BrowserPosition, "tickLower" | "tickUpper">; token0: TokenMeta; token1: TokenMeta }) {
  if (token0.decimals === null || token1.decimals === null) return <span>Ticks {position.tickLower} → {position.tickUpper}</span>;
  const lower = tickToPrice(position.tickLower, token0.decimals, token1.decimals);
  const upper = tickToPrice(position.tickUpper, token0.decimals, token1.decimals);
  return <span title={`${lower} – ${upper} ${token1.symbol} per ${token0.symbol}`}>{shortPrice(lower)} – {shortPrice(upper)} <small>{token1.symbol} / {token0.symbol}</small></span>;
}

function MetricInfo({ label, children }: { label: string; children: string }) {
  return <details className="ics-metric-info"><summary aria-label={label}><span aria-hidden="true">i</span></summary><p>{children}</p></details>;
}

function PositionCard({ position, view, token0, token1, performance, select }: { position: BrowserPosition; view: BrowserPoolView; token0: TokenMeta; token1: TokenMeta; performance: PositionPerformance | undefined; select: (kind: LiquidityKind) => void }) {
  const amounts = [position.amount0, position.amount1] as const;
  const fees = [position.tokensOwed0, position.tokensOwed1] as const;
  const tokens = [token0, token1] as const;
  const values = tokens.map((token, index) => liquidityUsdValue(amounts[index]!, token));
  const value = liquidityPairValue(values);
  const feesAvailable = position.feeError === null && fees.every((amount) => amount !== null);
  const feeValue = feesAvailable ? liquidityPairValue(tokens.map((token, index) => liquidityUsdValue(fees[index]!, token))) : null;
  const tick = view.metadata?.tick ?? null;
  const inRange = tick === null ? null : tick >= position.tickLower && tick < position.tickUpper;
  const progress = liquidityRangeProgress(position.tickLower, position.tickUpper, tick);
  const pricedRange = token0.decimals !== null && token1.decimals !== null;
  const price = (at: number) => shortPrice(tickToPrice(at, token0.decimals!, token1.decimals!));
  const amountTitle = (amount: string | null, token: TokenMeta) => amount === null ? "Amount unavailable" : `${token.decimals === null ? `${amount} atoms` : fromBaseUnits(BigInt(amount), token.decimals)} ${token.symbol}`;
  const pnl = performance?.status === "estimated" ? performance.pnlUsd : null;
  const pnlHelp = performance?.status === "estimated" ? `${formatLiquidityUsd(performance.contributedUsd)} added; ${formatLiquidityUsd(performance.withdrawnUsd)} withdrawn or collected at historical prices. P&L includes current holdings and uncollected fees, before ledger and network fees. Analytics history does not verify Wallet settlement.` : performance?.reason ?? "Reading the deposit, withdrawal and collection history needed to estimate this position’s profit or loss.";
  return <article className="ics-position-card" aria-label={`Position ${position.id}`}>
    <header><span className="ics-position-id">Position #{position.id}</span><span className={`ics-range-state ${inRange === true ? "ics-range-state--active" : inRange === false ? "ics-range-state--outside" : ""}`} title={inRange === true ? "Providing liquidity at the current pool price." : inRange === false ? "The current price is outside your range. This position is not earning swap fees." : "The current pool price is unavailable."}><span aria-hidden="true">●</span>{inRange === null ? "Range unavailable" : inRange ? "In range" : "Out of range"}</span></header>
    <div className="ics-position-metrics">
      <div className="ics-position-value"><span className="ics-metric-label">Position value<MetricInfo label="About position value">Estimated value of the tokens currently in this position, using ICPSwap market prices. Uncollected fees are shown separately.</MetricInfo></span><strong>{formatLiquidityUsd(value)}</strong>{value === null ? <small>Value unavailable</small> : null}</div>
      <div className="ics-position-pnl"><span className="ics-metric-label">Position P&amp;L<MetricInfo label="About position profit and loss">{pnlHelp}</MetricInfo></span><strong className={pnl === null || pnl === 0 ? undefined : pnl > 0 ? "ics-change--up" : "ics-change--down"}>{pnl === null ? "—" : `${pnl > 0 ? "+" : ""}${formatLiquidityUsd(pnl)}`}</strong><small>{performance?.status === "estimated" ? "Est. before fees" : performance ? "Unavailable" : "Reading history…"}</small></div>
    </div>
    <div className="ics-position-holdings" aria-label="Tokens in this position">
      {tokens.map((token, index) => <div className="ics-position-token" key={token.address}><span className="ics-position-token-name"><TokenMark address={token.address} symbol={token.symbol} /><span>{token.symbol}</span></span><span className="ics-position-token-value"><strong title={amountTitle(amounts[index]!, token)}>{formatLiquidityAmount(amounts[index]!, token.decimals)}</strong><small>{formatLiquidityUsd(values[index] ?? null)}</small></span></div>)}
      {value !== null && value > 0 ? <div className="ics-position-composition" role="img" aria-label={`${token0.symbol} ${(values[0]! / value * 100).toFixed(1)}%, ${token1.symbol} ${(values[1]! / value * 100).toFixed(1)}% by estimated value`}><span style={{ width: `${values[0]! / value * 100}%` }} /><span style={{ width: `${values[1]! / value * 100}%` }} /></div> : null}
    </div>
    <section className="ics-position-fees" aria-label="Uncollected fees"><header><span className="ics-metric-label">Uncollected fees<MetricInfo label="About uncollected fees">Current pool fee estimate before ledger withdrawal fees. Already collected amounts can include withdrawn principal and are not necessarily profit.</MetricInfo></span><strong>{feesAvailable ? formatLiquidityUsd(feeValue) : "Unavailable"}</strong></header><div className="ics-position-fee-tokens">{tokens.map((token, index) => <span key={token.address} title={amountTitle(feesAvailable ? fees[index]! : null, token)}><strong>{formatLiquidityAmount(feesAvailable ? fees[index]! : null, token.decimals)}</strong> {token.symbol}</span>)}</div>{position.feeError ? <details className="ics-inline-note"><summary>Fee estimate unavailable</summary><p>{position.feeError}</p></details> : null}</section>
    <div className="ics-position-range-view"><header><span>Price range</span>{pricedRange && tick !== null ? <span className="ics-current-price">Now {price(tick)}</span> : null}</header>{pricedRange ? <><div className={`ics-position-range-track ${inRange === false ? "ics-position-range-track--outside" : ""}`}>{progress !== null ? <span style={{ left: `${progress * 100}%` }} title={`Current price ${price(tick!)} ${token1.symbol} per ${token0.symbol}`} /> : null}</div><div className="ics-position-range-bounds"><span title={tickToPrice(position.tickLower, token0.decimals!, token1.decimals!)}>{price(position.tickLower)}</span><span title={tickToPrice(position.tickUpper, token0.decimals!, token1.decimals!)}>{price(position.tickUpper)}</span></div><small>{token1.symbol} per {token0.symbol}</small></> : <span className="nt-meta">Price data unavailable</span>}</div>
    <div className="ics-position-actions"><button className="nt-button nt-button--secondary nt-button--sm" onClick={() => select("increase")} type="button">Add</button><button className="nt-button nt-button--secondary nt-button--sm" onClick={() => select("decrease")} type="button">Remove</button><button className="nt-button nt-button--ghost nt-button--sm" onClick={() => select("claim")} type="button">Collect fees</button></div>
  </article>;
}

export function LiquidityView({ tokens, prices = NO_MARKET_PRICES }: { tokens: SwapToken[]; prices?: readonly Pick<InfoToken, "ledgerId" | "price">[] }) {
  const client = useMemo(() => createLiquidityReadClient(), []);
  const [owner, setOwner] = useState<string | null>(null);
  const [pools, setPools] = useState<PoolIdentity[]>([]);
  const [owned, setOwned] = useState<BrowserPoolView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [metadata, setMetadata] = useState<Record<string, WalletTokenInfo>>({});
  const [performance, setPerformance] = useState<Record<string, PositionPerformance>>({});
  const tokenMap = useMemo(() => {
    const values = new Map<string, TokenMeta>();
    for (const token of tokens) values.set(token.address, { address: token.address, symbol: token.symbol, decimals: token.decimals > 0 ? token.decimals : null });
    for (const info of Object.values(metadata)) values.set(info.ledger, { address: info.ledger, symbol: info.symbol, decimals: info.decimals });
    for (const price of prices) { const token = values.get(price.ledgerId); if (token) token.priceUsd = price.price; }
    return values;
  }, [tokens, metadata, prices]);
  const token = useCallback((address: string): TokenMeta => tokenMap.get(address) ?? { address, symbol: shortPrincipal(address), decimals: null }, [tokenMap]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setNotes([]);
    void (async () => {
      const account = await loadNeutronCanisterId();
      if (controller.signal.aborted) return;
      setOwner(account);
      let knownPools: string[] = [];
      const warnings: string[] = [];
      try {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await loadActionHistory(cursor, controller.signal);
          const retained = retainedPoolsFromOperations(page.items.map((row) => ({ id: row.id, input_json: row.input_json, ...(Array.isArray(row.effects) ? { effects: row.effects.filter((value): value is JsonObject => isJsonObject(value)) } : {}) })));
          knownPools.push(...retained.pools);
          warnings.push(...retained.errors.map((issue) => String(issue.message)));
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) throw new Error("Activity returned a repeated cursor.");
          if (cursor) seen.add(cursor);
          controller.signal.throwIfAborted();
        } while (cursor);
      } catch (cause) { if (controller.signal.aborted) return; warnings.push(`Saved pool references unavailable: ${message(cause)}`); }
      knownPools = [...new Set(knownPools)];
      const [registry, ownership] = await Promise.all([client.discoverPools(controller.signal), client.discoverOwnedPools(account, knownPools, controller.signal)]);
      if (controller.signal.aborted) return;
      setPools(registry.pools);
      warnings.push(...ownership.errors.map((issue) => `${issue.method}: ${issue.message}`));
      const views: BrowserPoolView[] = [];
      for (const pool of ownership.pools) {
        try { views.push(await client.readPool(pool.pool, account, controller.signal)); }
        catch (cause) { if (controller.signal.aborted) return; warnings.push(`${shortPrincipal(pool.pool)}: ${message(cause)}`); }
        if (controller.signal.aborted) return;
        setOwned([...views]);
      }
      if (!controller.signal.aborted) { setOwned(views); setNotes(warnings); }
    })().catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); client.invalidate(); };
  }, [client, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setPerformance({});
    if (!owner || loading) return () => controller.abort();
    void (async () => {
      for (const view of owned) {
        for (const position of view.positions ?? []) {
          const token0 = token(view.pool.token0.address), token1 = token(view.pool.token1.address);
          const toInput = (meta: TokenMeta, amountAtoms: string | null, feesAtoms: string | null) => ({ ledgerId: meta.address, decimals: meta.decimals, amountAtoms, feesAtoms: position.feeError ? null : feesAtoms, priceUsd: meta.priceUsd ?? null });
          const key = `${view.pool.pool}:${position.id}`;
          try {
            const result = await fetchPositionPerformance({ poolId: view.pool.pool, owner, positionId: position.id, liquidity: position.liquidity, token0: toInput(token0, position.amount0, position.tokensOwed0), token1: toInput(token1, position.amount1, position.tokensOwed1) }, { signal: controller.signal, historyAtMs: Date.parse(view.source.observedAt) });
            if (controller.signal.aborted) return;
            setPerformance((previous) => ({ ...previous, [key]: result }));
          } catch (error) {
            if (controller.signal.aborted) return;
            setPerformance((previous) => ({ ...previous, [key]: { status: "unavailable", reason: `Position history could not be read: ${message(error)}`, pnlUsd: null, pnlPercent: null, contributedUsd: null, withdrawnUsd: null, currentValueUsd: null, principalUsd: null, uncollectedFeesUsd: null, source: "ICPSwap analytics", includesNetworkFees: false, settlementVerified: false, historyThroughMs: null } }));
          }
        }
      }
    })();
    return () => controller.abort();
  }, [owned, owner, token, loading]);
  const filteredPools = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pools.filter((pool) => !needle || `${poolLabel(pool, tokenMap)} ${pool.pool} ${pool.token0.address} ${pool.token1.address}`.toLowerCase().includes(needle)).sort((left, right) => {
      const known = (pool: PoolIdentity) => Number(tokenMap.has(pool.token0.address)) + Number(tokenMap.has(pool.token1.address));
      return known(right) - known(left) || poolLabel(left, tokenMap).localeCompare(poolLabel(right, tokenMap)) || left.fee - right.fee;
    });
  }, [pools, query, tokenMap]);
  const count = owned.reduce((sum, pool) => sum + (pool.positions?.length ?? 0), 0);
  const close = () => { setSelection(null); setCreating(false); setRevision((value) => value + 1); };
  if (selection && owner) return <LiquidityEditor key={`${selection.pool}:${selection.kind}:${selection.position?.id ?? "new"}:${selection.withdrawToken ?? ""}`} selection={selection} owner={owner} client={client} token={token} onMetadata={(info) => setMetadata((old) => ({ ...old, [info.ledger]: info }))} onClose={close} />;
  return <section className="ics-liquidity nt-stack">
    <header className="ics-section-top"><h2 className="nt-subtitle">{creating ? "Choose a pool" : "Your liquidity"}</h2><div className="ics-inline-actions"><button className="nt-icon-button" disabled={loading} onClick={() => setRevision((value) => value + 1)} type="button" aria-label="Refresh liquidity">↻</button><button className={`nt-button nt-button--sm ${creating ? "nt-button--secondary" : ""}`} onClick={() => setCreating((value) => !value)} type="button">{creating ? "Your positions" : "+ Position"}</button></div></header>
    {error ? <p className="nt-alert nt-alert--danger" role="alert">{error}</p> : null}
    {notes.length > 0 ? <details className="nt-alert nt-alert--warning"><summary>Some liquidity data is unavailable</summary><ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details> : null}
    {creating ? <><input className="nt-input" type="search" aria-label="Search pools" placeholder="Search token pair" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="ics-pool-list">{filteredPools.map((pool) => <button className="ics-pool-option" key={pool.pool} onClick={() => setSelection({ kind: "mint", pool: pool.pool })} type="button"><span className="ics-pair-marks"><TokenMark address={pool.token0.address} symbol={token(pool.token0.address).symbol} /><TokenMark address={pool.token1.address} symbol={token(pool.token1.address).symbol} /></span><span className="ics-token-names"><strong>{poolLabel(pool, tokenMap)}</strong><small>{(() => { const view = owned.find((view) => view.pool.pool === pool.pool); const count = view?.positions?.length ?? 0; if (!count) return "Create a position"; const value = liquidityPairValue(view!.positions!.flatMap((position) => [liquidityUsdValue(position.amount0, token(pool.token0.address)), liquidityUsdValue(position.amount1, token(pool.token1.address))])); return `${count} position${count === 1 ? "" : "s"}${value === null ? "" : ` · ${formatLiquidityUsd(value)}`}`; })()}</small></span><span className="ics-fee-tier">{formatFeeTier(pool.fee)}</span><span aria-hidden="true">›</span></button>)}</div>{!loading && filteredPools.length === 0 ? <p className="nt-state nt-state--empty">No pool matches this search.</p> : null}</> : <>
      {owned.map((view) => {
        const token0 = token(view.pool.token0.address); const token1 = token(view.pool.token1.address);
        return <section className="ics-owned-pool nt-stack" key={view.pool.pool}>
          <header className="ics-section-top"><div className="ics-pair-heading"><span className="ics-pair-marks"><TokenMark address={token0.address} symbol={token0.symbol} /><TokenMark address={token1.address} symbol={token1.symbol} /></span><strong>{token0.symbol} / {token1.symbol}</strong><span className="ics-fee-tier">{formatFeeTier(view.pool.fee)}</span></div><button className="nt-button nt-button--ghost nt-button--sm" onClick={() => setSelection({ kind: "mint", pool: view.pool.pool })} type="button">+ Add</button></header>
          {view.errors.length > 0 ? <details className="ics-inline-note"><summary>Pool data incomplete</summary><ul>{view.errors.map((issue, i) => <li key={i}>{issue.method}: {issue.message}</li>)}</ul></details> : null}
          {view.positions === null ? <p className="nt-muted">Positions unavailable</p> : <div className="ics-position-grid">{view.positions.map((position) => <PositionCard key={position.id} position={position} view={view} token0={token0} token1={token1} performance={performance[`${view.pool.pool}:${position.id}`]} select={(kind) => setSelection({ kind, pool: view.pool.pool, position })} />)}</div>}
          {view.unused && (BigInt(view.unused.balance0) > 0n || BigInt(view.unused.balance1) > 0n) ? <div className="ics-unused-funds"><strong>Unused funds in pool</strong>{[0, 1].map((index) => { const meta = index === 0 ? token0 : token1; const balance = index === 0 ? view.unused!.balance0 : view.unused!.balance1; return BigInt(balance) > 0n ? <div key={meta.address}><span>{shownAmount(balance, meta)} {meta.symbol}</span><button className="nt-button nt-button--ghost nt-button--sm" onClick={() => setSelection({ kind: "withdraw", pool: view.pool.pool, withdrawToken: meta.address })} type="button">Withdraw</button></div> : null; })}</div> : null}
          {view.withdrawals && view.withdrawals.length > 0 ? <p className="nt-meta">{view.withdrawals.length} protocol payout{view.withdrawals.length === 1 ? "" : "s"} in progress.</p> : null}
          {view.transactions && view.transactions.some((transaction) => transaction.status !== "Completed" || transaction.error) ? <div className="ics-protocol-transactions"><strong>Protocol payouts &amp; recovery</strong>{view.transactions.filter((transaction) => transaction.status !== "Completed" || transaction.error).map((transaction) => <p key={transaction.id} className={transaction.status === "Failed" || transaction.error ? "nt-alert nt-alert--warning" : "nt-meta"}>{transaction.action} #{transaction.id} · {transaction.status}{transaction.error ? `: ${transaction.error}` : ""}</p>)}{view.transactions.some((transaction) => transaction.supportRequired) ? <p className="nt-meta">A failed payout may need ICPSwap support even when unused balances are zero. Keep the pool and transaction IDs; an empty balance does not prove payment arrived.</p> : null}</div> : null}
          <details className="ics-inline-note"><summary>Pool details</summary><p className="ics-mono">{view.pool.pool}</p><p className="ics-mono">{token0.address}<br />{token1.address}</p></details>
        </section>;
      })}
      {!loading && count === 0 && !owned.some((view) => view.unused && (BigInt(view.unused.balance0) > 0n || BigInt(view.unused.balance1) > 0n)) ? <div className="ics-empty-block"><h3 className="nt-subtitle">{error || notes.length || owned.some((view) => view.positions === null || view.unused === null || view.errors.length > 0) ? "Liquidity data is incomplete" : "No liquidity positions yet"}</h3><p className="nt-muted">Choose a pool and the price range in which your tokens provide liquidity.</p><button className="nt-button" onClick={() => setCreating(true)} type="button">New position</button></div> : null}
    </>}
    {loading ? <p className="nt-state nt-state--loading" role="status">Reading pools and positions…</p> : null}
  </section>;
}

function LiquidityEditor({ selection, owner, client, token, onMetadata, onClose }: { selection: Selection; owner: string; client: ReturnType<typeof createLiquidityReadClient>; token: (address: string) => TokenMeta; onMetadata: (info: WalletTokenInfo) => void; onClose: () => void }) {
  const [pool, setPool] = useState<BrowserPoolView | null>(null);
  const [infos, setInfos] = useState<[WalletTokenInfo | null, WalletTokenInfo | null]>([null, null]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [amount0, setAmount0] = useState(""); const [amount1, setAmount1] = useState("");
  const [lower, setLower] = useState(""); const [upper, setUpper] = useState("");
  const [rangePreset, setRangePreset] = useState<number | "full" | "custom">("full");
  const [allocations, setAllocations] = useState<Record<number, { percent: number; value: string; maximum: string }>>({});
  const [percent, setPercent] = useState(100);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [submitted, setSubmitted] = useState<JsonObject | null>(null);
  const [operation, setOperation] = useState<SavedAction | null>(null);
  const [actionProgress, setActionProgress] = useState<ActionProgress | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [setupRequired, setSetupRequired] = useState<[boolean, boolean]>([false, false]);
  const [addingLedger, setAddingLedger] = useState<string | null>(null);
  const setupRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { setupRequest.current?.abort(); }, []);
  useEffect(() => {
    alive.current = true;
    setLoading(true); setError(""); setReadFailed(false);
    const controller = new AbortController();
    void (async () => {
      const view = await client.readPool(selection.pool, owner, controller.signal);
      if (controller.signal.aborted) return;
      setPool(view);
      // Exiting a position or retrieving unused pool credit does not fund a
      // ledger operation through Wallet. Never make recovery depend on both
      // assets being selected in the Wallet's token list.
      if (selection.kind !== "mint" && selection.kind !== "increase") return;
      const wallet = createMsgBusClient();
      const read = async (address: string) => {
        const info = await readTokenInfo(wallet, address, controller.signal);
        if (!controller.signal.aborted) onMetadata(info);
        return info;
      };
      const results = await Promise.allSettled([read(view.pool.token0.address), read(view.pool.token1.address)]);
      if (controller.signal.aborted) return;
      const first = results[0].status === "fulfilled" ? results[0].value : null;
      const second = results[1].status === "fulfilled" ? results[1].value : null;
      setInfos([first, second]);
      setSetupRequired([results[0].status === "rejected" && walletSetupRequired(message(results[0].reason)), results[1].status === "rejected" && walletSetupRequired(message(results[1].reason))]);
      if (first && second && view.metadata) {
        const range = selection.position ? { lower: selection.position.tickLower, upper: selection.position.tickUpper } : usableTickRange(view.pool.tickSpacing);
        setLower((previous) => previous || tickToPrice(range.lower, first.decimals, second.decimals)); setUpper((previous) => previous || tickToPrice(range.upper, first.decimals, second.decimals));
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected" && !walletSetupRequired(message(result.reason)));
      if (failures.length) { setReadFailed(true); setError(`Wallet token details unavailable: ${failures.map((result) => message(result.reason)).join("; ")}`); }
    })().catch((cause) => { if (!controller.signal.aborted) { setReadFailed(true); setError(message(cause)); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [client, owner, selection.pool, readRevision]);
  const token0: TokenMeta | null = pool ? infos[0] ? { address: infos[0].ledger, symbol: infos[0].symbol, decimals: infos[0].decimals } : token(pool.pool.token0.address) : null;
  const token1: TokenMeta | null = pool ? infos[1] ? { address: infos[1].ledger, symbol: infos[1].symbol, decimals: infos[1].decimals } : token(pool.pool.token1.address) : null;
  const position = pool?.positions?.find((item) => item.id === selection.position?.id) ?? null;
  const lock = busy || submitted !== null || addingLedger !== null;
  const adding = selection.kind === "mint" || selection.kind === "increase";
  const preview = useMemo<RangePreview | null>(() => {
    if (!pool?.metadata || !infos[0] || !infos[1]) return null;
    try {
      const tickLower = selection.kind === "increase" && position ? position.tickLower : priceToTick(lower, infos[0].decimals, infos[1].decimals, pool.pool.tickSpacing, "down");
      const tickUpper = selection.kind === "increase" && position ? position.tickUpper : priceToTick(upper, infos[0].decimals, infos[1].decimals, pool.pool.tickSpacing, "up");
      if (tickLower >= tickUpper) throw new Error("The lower price must be below the upper price.");
      const parseAmount = (value: string, info: WalletTokenInfo) => {
        if (value.trim() === "" || /^0*(?:\.0*)?$/u.test(value.trim())) return 0n;
        const atoms = toBaseUnits(value, info.decimals);
        if (atoms === null) throw new Error(`Enter an exact ${info.symbol} amount with at most ${info.decimals} decimal places.`);
        return atoms;
      };
      const atoms0 = parseAmount(amount0, infos[0]);
      const atoms1 = parseAmount(amount1, infos[1]);
      const sqrt = BigInt(pool.metadata.sqrtPriceX96), low = getSqrtRatioAtTick(tickLower), high = getSqrtRatioAtTick(tickUpper);
      const liquidity = liquidityForAmounts(sqrt, low, high, atoms0, atoms1);
      const amounts = amountsForLiquidity(sqrt, low, high, liquidity, true);
      return { ok: true, tickLower, tickUpper, atoms0, atoms1, liquidity, amounts, error: "" };
    } catch (cause) { return { ok: false, error: message(cause) }; }
  }, [pool, infos, lower, upper, amount0, amount1, position, selection.kind]);
  const chooseRange = (width: number | null) => {
    if (!pool?.metadata || !infos[0] || !infos[1]) return;
    const spacing = pool.pool.tickSpacing, limits = usableTickRange(spacing);
    const lo = width === null ? limits.lower : Math.max(limits.lower, Math.floor((pool.metadata.tick + Math.log(1 - width / 100) / Math.log(1.0001)) / spacing) * spacing);
    const hi = width === null ? limits.upper : Math.min(limits.upper, Math.ceil((pool.metadata.tick + Math.log(1 + width / 100) / Math.log(1.0001)) / spacing) * spacing);
    setLower(tickToPrice(lo, infos[0].decimals, infos[1].decimals)); setUpper(tickToPrice(hi, infos[0].decimals, infos[1].decimals));
    setRangePreset(width ?? "full");
  };
  const buildInput = (): JsonObject => {
    if (!pool) throw new Error("Read the pool first.");
    const common: JsonObject = { operationId: createRequestId(), kind: selection.kind, pool: pool.pool.pool };
    if (adding) {
      if (!infos[0] || !infos[1]) throw new Error("Read both deposit tokens from Wallet first.");
      if (!preview || !preview.ok || preview.liquidity === 0n) throw new Error(preview?.error || "Enter amounts that provide liquidity in this range.");
      return { ...common, ...(selection.kind === "increase" ? { positionId: position?.id ?? "" } : { tickLower: preview.tickLower, tickUpper: preview.tickUpper }), amount0: preview.atoms0.toString(), amount1: preview.atoms1.toString() };
    }
    if (selection.kind === "withdraw") {
      if (selection.withdrawToken !== pool.pool.token0.address && selection.withdrawToken !== pool.pool.token1.address) throw new Error("Select a token belonging to this pool.");
      const chosen = token(selection.withdrawToken);
      const amount = toBaseUnits(withdrawAmount, chosen.decimals ?? 0);
      if (amount === null || amount === 0n) throw new Error("Enter the amount to withdraw.");
      return { ...common, token: chosen.address, amount: amount.toString() };
    }
    if (!position) throw new Error("This position is no longer present in the current pool observation.");
    if (selection.kind === "decrease") {
      const amount = BigInt(position.liquidity) * BigInt(Math.round(percent * 100)) / 10000n;
      if (amount === 0n) throw new Error("Choose a larger share of this position.");
      return { ...common, positionId: position.id, liquidity: amount.toString() };
    }
    return { ...common, positionId: position.id };
  };
  const run = async () => {
    setError(""); setReadFailed(false);
    let input: JsonObject;
    try { input = submitted ?? buildInput(); } catch (cause) { setError(message(cause)); return; }
    setSubmitted(input); setBusy(true);
    try {
      const raw = await callTool<JsonValue>({ target: "app:icpswap:background", name: "icpswap_liquidity_v1", arguments: input }, 300);
      const progress = parseActionProgress(raw, String(input.operationId));
      if (!alive.current) return;
      if (isJsonObject(progress.raw.operation)) { setOperation(progress.raw.operation as SavedAction); setActionProgress(progress); }
      else setError(progress.message);
    } catch (cause) { if (alive.current) setError(`${message(cause)} Use Continue action to check or resume this same attempt.`); }
    finally { if (alive.current) setBusy(false); }
  };
  const addToWallet = async (ledger: string) => {
    const controller = new AbortController();
    setupRequest.current = controller;
    setAddingLedger(ledger); setError(""); setReadFailed(false);
    try {
      await addLedgerToWallet(createMsgBusClient(), ledger, controller.signal);
      if (alive.current && !controller.signal.aborted) setReadRevision((value) => value + 1);
    } catch (cause) { if (alive.current && !controller.signal.aborted) setError(message(cause)); }
    finally { if (alive.current && !controller.signal.aborted) setAddingLedger(null); }
  };
  const amountField = (index: 0 | 1) => {
    const info = infos[index], meta = index === 0 ? token0 : token1;
    if (!meta) return null;
    const value = index === 0 ? amount0 : amount1, setValue = index === 0 ? setAmount0 : setAmount1;
    const max = info ? spendableBalance(info.balanceAtoms, info.feeAtoms) : 0n;
    const chosen = allocations[index];
    const percentage = chosen?.value === value && chosen.maximum === max.toString() ? chosen.percent : percentForAmount(info ? toBaseUnits(value, info.decimals) : null, max);
    const allocate = (percent: number) => {
      if (!info) return;
      const next = fromBaseUnits(amountAtPercent(max, percent), info.decimals);
      setValue(next); setAllocations((old) => ({ ...old, [index]: { percent, value: next, maximum: max.toString() } }));
    };
    return <div className="ics-liquidity-amount"><label htmlFor={`ics-liquidity-amount-${index}`}><span className="ics-swap-chip"><TokenMark address={meta.address} symbol={meta.symbol} /><strong>{meta.symbol}</strong></span></label><input aria-label={`${meta.symbol} deposit maximum`} id={`ics-liquidity-amount-${index}`} className="ics-swap-amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={value} onChange={(event) => { setValue(event.target.value); setAllocations((old) => { const next = { ...old }; delete next[index]; return next; }); }} disabled={lock || !info} /><div className="ics-swap-leg-foot"><span className="nt-meta">{info ? `Balance ${formatTokenAmount(info.balanceAtoms, info.decimals)} ${info.symbol}` : setupRequired[index] ? "Add this token to read its Wallet balance" : "Wallet balance unavailable"}</span></div>{setupRequired[index] && !info ? <button className="nt-button nt-button--secondary nt-button--sm ics-wallet-token-setup" disabled={lock || loading} onClick={() => void addToWallet(meta.address)} type="button">{addingLedger === meta.address ? "Adding to Wallet…" : `Add ${meta.symbol} to Wallet`}</button> : null}<div className="ics-amount-allocation"><div className="ics-allocation-label"><span>Use balance<MetricInfo label={`About ${meta.symbol} deposit balance`}>Max leaves enough for approval and transfer fees. Your deposit can use less than the chosen maximum, depending on the pool price and range.</MetricInfo></span><strong>{percentage}%</strong></div><input type="range" aria-label={`${meta.symbol} deposit percentage`} min="0" max="100" step="1" value={percentage} disabled={lock || !info} onChange={(event) => allocate(Number(event.target.value))} /><div className="ics-allocation-presets">{[25, 50, 75, 100].map((percent) => <button type="button" key={percent} disabled={lock || !info} aria-pressed={percentage === percent} onClick={() => allocate(percent)}>{percent === 100 ? "Max" : `${percent}%`}</button>)}</div></div></div>;
  };
  const currentPrice = pool?.metadata && token0?.decimals !== null && token0 && token1?.decimals !== null && token1 ? shortPrice(tickToPrice(pool.metadata.tick, token0.decimals, token1.decimals)) : null;
  const currentFees = position && !position.feeError ? [position.tokensOwed0, position.tokensOwed1] : [null, null];
  const retainedClaimTokens = [token0, token1].flatMap((meta, index) => {
    const gross = currentFees[index], fee = index === 0 ? pool?.cachedFees?.token0Fee : pool?.cachedFees?.token1Fee;
    return meta && gross != null && fee != null && estimateLiquidityPayout(BigInt(gross), BigInt(fee)).status === "retained_in_pool" ? [meta.symbol] : [];
  });
  const removedAmounts = position ? [position.amount0, position.amount1].map((amount) => amount === null ? null : (BigInt(amount) * BigInt(percent) / 100n).toString()) : [null, null];
  const withdrawalToken = selection.withdrawToken === token0?.address ? token0 : token1;
  const withdrawalBalance = pool?.availableUnused ? selection.withdrawToken === token0?.address ? pool.availableUnused.balance0 : pool.availableUnused.balance1 : null;
  return <section className="ics-liquidity-editor nt-stack">
    <header className="ics-section-top"><div className="ics-inline-actions"><button className="nt-icon-button" type="button" aria-label="Back to positions" onClick={onClose}>←</button><h2 className="nt-subtitle">{actionNames[selection.kind]}</h2></div></header>
    {token0 && token1 ? <div className="ics-editor-pair"><div className="ics-pair-heading"><span className="ics-pair-marks"><TokenMark address={token0.address} symbol={token0.symbol} /><TokenMark address={token1.address} symbol={token1.symbol} /></span><strong>{token0.symbol} / {token1.symbol}</strong><span className="ics-fee-tier">{pool ? formatFeeTier(pool.pool.fee) : ""}</span></div>{currentPrice ? <span className="ics-editor-price">1 {token0.symbol} ≈ {currentPrice} {token1.symbol}</span> : null}</div> : null}
    {loading ? <p className="nt-state nt-state--loading" role="status">Reading pool and Wallet…</p> : null}
    {error ? <div className="ics-editor-error nt-alert nt-alert--danger" role="alert"><p>{error}</p>{readFailed && !submitted ? <button className="nt-button nt-button--secondary nt-button--sm" disabled={loading || addingLedger !== null} onClick={() => setReadRevision((value) => value + 1)} type="button">Retry loading</button> : null}</div> : null}
    {pool?.errors.length ? <details className="ics-inline-note"><summary>Some pool data could not be loaded</summary><ul>{pool.errors.map((issue, i) => <li key={i}>{issue.method}: {issue.message}</li>)}</ul></details> : null}
    {!operation ? <>
      {adding ? <div className="ics-liquidity-deposits">{amountField(0)}{amountField(1)}</div> : null}
      {selection.kind === "mint" && token0 && token1 ? <section className="ics-range-editor">
        <header className="ics-section-top"><h3 className="ics-metric-label">Price range<MetricInfo label="About liquidity price ranges">Your position earns swap fees while the pool price stays within this range. A narrower range concentrates liquidity but needs more attention as prices move.</MetricInfo></h3><span className="nt-meta">{token1.symbol} per {token0.symbol}</span></header>
        <div className="ics-range-presets">{[5, 10, 20].map((width) => <button className="nt-button nt-button--secondary nt-button--sm" aria-pressed={rangePreset === width} disabled={lock || !infos[0] || !infos[1]} key={width} onClick={() => chooseRange(width)} type="button">±{width}%</button>)}<button className="nt-button nt-button--secondary nt-button--sm" aria-pressed={rangePreset === "full"} disabled={lock || !infos[0] || !infos[1]} onClick={() => chooseRange(null)} type="button">Full range</button></div>
        {preview?.ok ? <div className="ics-editor-range-summary"><span>{rangePreset === "full" ? "All supported prices" : <PriceRange position={{ tickLower: preview.tickLower, tickUpper: preview.tickUpper }} token0={token0} token1={token1} />}</span>{pool?.metadata ? <span className={`ics-range-state ${pool.metadata.tick >= preview.tickLower && pool.metadata.tick < preview.tickUpper ? "ics-range-state--active" : "ics-range-state--outside"}`}>{pool.metadata.tick >= preview.tickLower && pool.metadata.tick < preview.tickUpper ? "Includes current price" : "Outside current price"}</span> : null}</div> : null}
        <details className="ics-custom-range"><summary>Custom prices</summary><div className="ics-range-inputs"><label><span>Lower price</span><input className="nt-input" aria-label="Lower price" inputMode="decimal" value={lower} onChange={(event) => { setLower(event.target.value); setRangePreset("custom"); }} disabled={lock} /></label><label><span>Upper price</span><input className="nt-input" aria-label="Upper price" inputMode="decimal" value={upper} onChange={(event) => { setUpper(event.target.value); setRangePreset("custom"); }} disabled={lock} /></label></div></details>
      </section> : position && token0 && token1 ? <div className="ics-editor-range-summary"><span>Position range</span><PriceRange position={position} token0={token0} token1={token1} /></div> : null}
      {adding ? <>{preview?.ok && preview.liquidity > 0n && token0 && token1 && infos[0] && infos[1] ? <section className="ics-liquidity-estimate"><h3>Estimated deposit</h3><dl className="ics-position-amounts"><div><dt>{token0.symbol}</dt><dd>{formatLiquidityAmount(preview.amounts.amount0.toString(), infos[0].decimals)}</dd></div><div><dt>{token1.symbol}</dt><dd>{formatLiquidityAmount(preview.amounts.amount1.toString(), infos[1].decimals)}</dd></div></dl></section> : null}{preview?.error && (lower || upper) ? <p className="nt-meta">{preview.error}</p> : null}<p className="ics-form-note">You won’t spend more than these amounts. The pool price may change before your deposit completes.</p></> : null}
      {selection.kind === "decrease" && position ? <section className="ics-remove-allocation"><label htmlFor="ics-remove-percent">Amount to remove <strong>{percent}%</strong></label><input id="ics-remove-percent" type="range" aria-label="Percentage of position to remove" min="1" max="100" step="1" value={percent} disabled={lock} onChange={(event) => setPercent(Number(event.target.value))} /><div className="ics-range-presets">{[25, 50, 75, 100].map((value) => <button className="nt-button nt-button--secondary nt-button--sm" aria-pressed={percent === value} disabled={lock} key={value} onClick={() => setPercent(value)} type="button">{value === 100 ? "Max" : `${value}%`}</button>)}</div>{token0 && token1 ? <section className="ics-liquidity-estimate"><h3>Estimated tokens to remove</h3><dl className="ics-position-amounts">{[token0, token1].map((meta, index) => <div key={meta.address}><dt>{meta.symbol}</dt><dd>{formatLiquidityAmount(removedAmounts[index] ?? null, meta.decimals)}</dd></div>)}</dl><p className="nt-meta">Plus any accrued fees, before transfer fees.</p></section> : null}<p className="ics-form-note">{percent === 100 ? "Removes all liquidity from this position. The pool returns amounts above the transfer fee to your Wallet; smaller amounts stay in your pool balance." : `Removes ${percent}% of your liquidity. The rest stays invested.`}</p></section> : null}
      {selection.kind === "claim" && position && token0 && token1 ? <section className="ics-liquidity-estimate"><h3>Fees before transfer costs</h3><dl className="ics-position-amounts">{[token0, token1].map((meta, index) => <div key={meta.address}><dt>{meta.symbol}</dt><dd>{formatLiquidityAmount(currentFees[index] ?? null, meta.decimals)}</dd></div>)}</dl>{position.feeError ? <details className="ics-inline-note"><summary>Current fee estimate unavailable</summary><p>{position.feeError}</p></details> : currentFees.every((amount) => amount === "0") ? <p className="ics-form-note">No fees were available at the last check. You can still review a collection.</p> : <p className="ics-form-note">{retainedClaimTokens.length ? `${retainedClaimTokens.join(" and ")} fees are at or below the transfer fee. They would stay in your pool balance; no Wallet payout is expected for these tokens.` : "The pool sends amounts above the transfer fee to your Wallet, less that fee. Your position stays invested."}</p>}</section> : null}
      {selection.kind === "withdraw" && pool && withdrawalToken ? <div className="ics-withdraw-input"><label htmlFor="ics-unused-amount">Withdraw {withdrawalToken.symbol}{withdrawalToken.decimals === null ? " (atoms)" : ""}</label><div className="ics-inline-actions"><input id="ics-unused-amount" className="nt-input" inputMode="decimal" placeholder="0.0" value={withdrawAmount} disabled={lock} onChange={(event) => setWithdrawAmount(event.target.value)} /><button className="nt-button nt-button--secondary" disabled={lock || withdrawalBalance === null} type="button" title="Balance remaining after in-progress payouts are reserved" onClick={() => { if (withdrawalBalance !== null) setWithdrawAmount(fromBaseUnits(BigInt(withdrawalBalance), withdrawalToken.decimals ?? 0)); }}>Max</button></div>{withdrawalBalance !== null ? <p className="nt-meta">Available {shownAmount(withdrawalBalance, withdrawalToken)} {withdrawalToken.symbol}</p> : <p className="nt-meta">Checking how much is available after in-progress payouts.</p>}<p className="ics-form-note">Returns tokens held outside your positions to your Wallet, less the transfer fee.</p></div> : null}
      <button className="nt-button ics-liquidity-submit" disabled={busy || loading || !pool || (adding && (!infos[0] || !infos[1]))} onClick={() => void run()} type="button">{busy ? "Following operation…" : submitted ? "Continue action" : `Review ${actionNames[selection.kind].toLowerCase()}`}</button>
    </> : <ActionCard key={operation.id} action={operation} {...(actionProgress?.operationId === operation.id ? { progress: actionProgress } : {})} onChange={setOperation} onNewAction={(next) => { setOperation(next); setActionProgress(null); }} />}
    <details className="ics-disclosure"><summary>Details</summary>{pool ? <dl className="ics-review-fields"><div><dt>Pool</dt><dd>{pool.pool.pool}</dd></div><div><dt>Owner</dt><dd>{owner}</dd></div><div><dt>Token 0</dt><dd>{pool.pool.token0.address}</dd></div><div><dt>Token 1</dt><dd>{pool.pool.token1.address}</dd></div>{position ? <div><dt>Position</dt><dd>{position.id}</dd></div> : null}{preview?.ok ? <div><dt>Range ticks</dt><dd>{preview.tickLower} → {preview.tickUpper}</dd></div> : null}{submitted ? <div><dt>Operation</dt><dd>{String(submitted.operationId)}</dd></div> : null}</dl> : null}<p className="nt-meta">Payouts and refunds continue at the pool after this tile closes. Activity keeps your saved action and its recovery status.</p></details>
  </section>;
}
