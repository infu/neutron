import { useEffect, useRef, useState } from "react";
import { createEvmWalletClient, type EvmAccount, type EvmWalletClient } from "neutron-tools/evm_wallet";
import { callTool } from "neutron-tools/app";
import { formatUnits, getAddress } from "viem";
import { walletReader } from "./controller.ts";
import { createActionStore, type ActionRecord } from "./action_store.ts";
import { actionResult, latestAction, parseActionIntent, runAction, type ActionEnvelope, type ActionResult } from "./action_workflow.ts";
import { prepareUnifiedSwap, parseUnifiedSwapInput } from "./swap_routes.ts";
import { prepareLiquidity, type LiquidityInput, type LiquidityPreview } from "./liquidity.ts";
import { listPositions, readPosition, type PositionListCursor, type PositionRecord } from "./positions.ts";
import { amountAtoms, customToken, slippageBasisPoints, NETWORKS, type Chain, type Token } from "./swap.ts";
import { TokenIcon, TokenPicker } from "./token_picker.tsx";
import { useEvmPrices } from "./use_usd_prices.ts";
import { draftAtoms, UsdAmount, UsdTotal } from "./usd_amount.tsx";

const actionStore = createActionStore();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const keyOf = (token: Token) => token.address?.toLowerCase() ?? "native";
const amountText = (atoms: string, decimals: number) => {
  const exact = formatUnits(BigInt(atoms), decimals), number = Number(exact);
  return number > 0 && number < 0.000001 ? "<0.000001" : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 7 }).format(number);
};
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");

/** The tile uses the same durable action executor as the resident tools. It
 * only resumes its own human requests; another app's activity stays read-only. */
export function useActionController(onComplete: () => Promise<void>) {
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<ActionResult | null>(null);
  const [currentEnvelope, setCurrentEnvelope] = useState<ActionEnvelope | null>(null);
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [history, setHistory] = useState<Awaited<ReturnType<typeof actionStore.page>>["rows"]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [refreshError, setRefreshError] = useState("");
  const [revision, setRevision] = useState(0);
  const tracking = useRef<AbortController | null>(null), working = useRef(false), refreshing = useRef(false);
  const completed = useRef(onComplete); completed.current = onComplete;

  async function refresh(older = false) {
    if (refreshing.current || document.visibilityState === "hidden") return;
    refreshing.current = true;
    try {
      const boundary = older ? null : history.at(-1)?.id ?? null;
      const rows: typeof history = [];
      let page = await actionStore.page(older ? cursor : null), nextCursor = page.nextCursor;
      // Refresh the whole retained range so an action completed elsewhere also
      // updates after it has moved off the first page. Stop at the loaded tail;
      // older records remain behind the explicit pagination control.
      for (;;) {
        const boundaryIndex = boundary === null ? -1 : page.rows.findIndex((row) => row.id === boundary);
        if (boundary !== null && boundaryIndex >= 0) {
          rows.push(...page.rows.slice(0, boundaryIndex + 1));
          nextCursor = boundaryIndex + 1 < page.rows.length || page.nextCursor !== null ? boundary : null;
          break;
        }
        rows.push(...page.rows);
        nextCursor = page.nextCursor;
        if (older || boundary === null || nextCursor === null) break;
        page = await actionStore.page(nextCursor);
      }
      setHistory((previous) => [...new Map([...previous, ...rows].map((row) => [row.id, row])).values()].sort((a, b) => BigInt(a.created_at) === BigInt(b.created_at) ? b.id.localeCompare(a.id) : BigInt(a.created_at) > BigInt(b.created_at) ? -1 : 1));
      setCursor(nextCursor);
      setRefreshError("");
    } catch (error) { setRefreshError(errorText(error)); }
    finally { refreshing.current = false; }
  }
  const currentRefresh = useRef(refresh); currentRefresh.current = refresh;
  useEffect(() => {
    const update = () => { if (!working.current) void currentRefresh.current(); };
    update();
    const timer = setInterval(update, 15000);
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); tracking.current?.abort(); };
  }, []);
  async function perform(envelope: ActionEnvelope) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice(""); setProgress(null); setCurrentEnvelope(envelope); setMessage("Preparing your request…");
    const controller = new AbortController(); tracking.current = controller;
    const wallet = createEvmWalletClient({ callTool }, { callOptions: { signal: controller.signal } });
    try {
      const result = await runAction(wallet, actionStore, envelope, null, false, async ({ wallet: scopedWallet, envelope: saved, account, onProgress, now }) => {
        const read = walletReader(scopedWallet, account.accountId);
        if (saved.kind === "swap") return prepareUnifiedSwap(read, account, parseUnifiedSwapInput(saved.input), now(), onProgress);
        if (saved.kind === "liquidity") return prepareLiquidity(read, account, saved.input as LiquidityInput, now());
        throw new Error("This action must be continued by the app version that created it.");
      }, {
        signal: controller.signal,
        onProgress: (next, result) => { setMessage(next); if (result) setProgress(result); },
        onRecord: (record) => setProgress(actionResult(record)),
      });
      setProgress(result);
      if (result.state === "complete") {
        setNotice(envelope.kind === "swap" ? "Swap complete. Your balances are updating." : "Position updated. Your balances and liquidity are updating.");
        setRevision((value) => value + 1);
        await completed.current();
      } else setNotice(result.message);
    } catch (error) {
      if (controller.signal.aborted) setNotice("Tracking paused. Your request is saved; continue the same action below to check its status.");
      else setError(errorText(error));
    } finally { tracking.current = null; working.current = false; setBusy(false); setMessage(""); await refresh(); }
  }
  async function resume(id: string) {
    try {
      const record = await actionStore.get(id);
      if (!record) throw new Error("This saved action could not be found.");
      const intent = parseActionIntent(record);
      if (intent.caller !== null || intent.agentMode) throw new Error("This action is managed by its originating app or agent.");
      const latest = await latestAction(actionStore, intent.envelope.operationId) ?? record;
      const current = parseActionIntent(latest);
      if (current.caller !== null || current.agentMode) throw new Error("This action is managed by its originating app or agent.");
      await perform(current.envelope);
    } catch (error) { setError(errorText(error)); }
  }
  return { busy, progress, currentEnvelope, message, error, notice, history, cursor, refreshError, revision, perform, resume, refresh, pause: () => tracking.current?.abort() };
}

export type ActionController = ReturnType<typeof useActionController>;

export function ActionProgress({ actions }: { actions: ActionController }) {
  if (!actions.busy) return null;
  const steps = actions.progress?.steps ?? [];
  return <div className="uni-action-progress" role="status" aria-live="polite">
    <div className="uni-progress"><span className="uni-spinner"/><strong>{actions.message || "Working…"}</strong></div>
    {steps.length > 0 && <ol className="uni-step-list">{steps.map((step, index) => <li key={index} className={step.status === "confirmed" ? "is-complete" : ""}><span aria-hidden="true">{step.status === "confirmed" ? "✓" : index + 1}</span><span>{step.label}</span><small>{step.status.replaceAll("_", " ")}</small></li>)}</ol>}
    <p className="uni-help">Confirm each request in EVM Wallet. The next step opens automatically.</p>
    <button className="uni-text-button" onClick={actions.pause}>Pause tracking</button>
  </div>;
}

function ActionHistoryRow({ id, summary, humanOwned, phase, revision, actions }: { id: string; summary: string; humanOwned: boolean; phase: string; revision: string; actions: ActionController }) {
  const [record, setRecord] = useState<ActionRecord | null>(null), [error, setError] = useState(""), [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setRecord(null); setError("");
    void actionStore.get(id).then((next) => { if (active) setRecord(next); }).catch((error) => { if (active) setError(errorText(error)); });
    return () => { active = false; };
  }, [id, phase, revision, expanded]);
  const detail = record ? actionResult(record) : null;
  return <article className={`nt-panel uni-saved${phase === "complete" ? " uni-saved-complete" : ""}`}>
    <div className="uni-saved-title"><strong>{summary}</strong><span className="uni-status">{phase === "complete" ? "✓ Complete" : phase.replaceAll("_", " ")}</span></div>
    {!humanOwned && <p className="uni-muted">Managed by your agent or the requesting app.</p>}
    {humanOwned && !["complete", "superseded"].includes(phase) && <button className="nt-button uni-continue" disabled={actions.busy} onClick={() => void actions.resume(id)}>Continue</button>}
    <details className="uni-details" onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>Transaction details</summary><div className="uni-settings">{error && <p>{error}</p>}{detail ? <>{detail.steps.map((step, index) => <div key={index}><p>{step.label} · {step.status}</p>{step.transactionHash && <a href={`${NETWORKS[parseActionIntent(record!).envelope.chainId as Chain].explorer}${step.transactionHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}</div>)}<p>{detail.message}</p><pre>{JSON.stringify(detail.details, null, 2)}</pre></> : !error && <p className="uni-muted">Loading details…</p>}</div></details>
  </article>;
}

export function ActionHistory({ actions, kind, chain, accountId }: { actions: ActionController; kind: "swap" | "liquidity"; chain: Chain; accountId: string }) {
  const records = actions.history.filter((row) => row.kind === kind && row.chainId === chain && row.accountId === accountId && row.phase !== "superseded");
  return <section className="uni-activity"><header><h2 className="nt-subtitle">{kind === "swap" ? "Recent swaps" : "Recent activity"}</h2><span className="uni-muted" title="History updates automatically" aria-label="Updates automatically">↻</span></header>
    {records.map((row) => <ActionHistoryRow key={row.id} id={row.id} summary={row.summary} phase={row.phase} revision={row.revision} humanOwned={row.humanOwned} actions={actions}/>)}
    {actions.refreshError && <details className="uni-quote-error"><summary>Activity updates delayed · retrying automatically</summary><p>{actions.refreshError}</p></details>}
    {!records.length && !actions.refreshError && <p className="uni-empty">Your {kind === "swap" ? "swaps" : "liquidity activity"} will appear here.</p>}
    {actions.cursor !== null && <button className="uni-text-button" disabled={actions.busy} onClick={() => void actions.refresh(true)}>Load older activity</button>}
  </section>;
}

type Props = { wallet: EvmWalletClient; account: EvmAccount | undefined; chain: Chain; tokens: Token[]; balance: (token: Token) => string; balanceAtoms: (token: Token) => string | null; actions: ActionController; disabled: boolean; onTokens: (token: Token) => void };
type Editor = { operation: "mint" | "increase" | "decrease" | "collect" | "close"; position: PositionRecord | null };

export function LiquidityView({ wallet, account, chain, tokens, balance, balanceAtoms, actions, disabled, onTokens }: Props) {
  const [positions, setPositions] = useState<PositionRecord[]>([]), [loading, setLoading] = useState(true), [readError, setReadError] = useState("");
  const [complete, setComplete] = useState(false), [discoveryErrors, setDiscoveryErrors] = useState<string[]>([]);
  const [positionCursor, setPositionCursor] = useState<PositionListCursor | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null), [protocol, setProtocol] = useState<"v3" | "v4">("v4");
  const [tokenA, setTokenA] = useState("native"), [tokenB, setTokenB] = useState(keyOf(tokens[1]!));
  const [amountA, setAmountA] = useState(""), [amountB, setAmountB] = useState("");
  const [fee, setFee] = useState("500"), [range, setRange] = useState("full"), [lower, setLower] = useState(""), [upper, setUpper] = useState("");
  const [percentage, setPercentage] = useState("100"), [slippage, setSlippage] = useState("0.5");
  const [preview, setPreview] = useState<LiquidityPreview | null>(null), [previewing, setPreviewing] = useState(false), [previewError, setPreviewError] = useState("");
  const [importId, setImportId] = useState(""), [importProtocol, setImportProtocol] = useState<"v3" | "v4">("v4"), [importing, setImporting] = useState(false), [importError, setImportError] = useState("");
  const [customTokenAddress, setCustomTokenAddress] = useState("");
  const known = useRef<Array<{ protocol: "v3" | "v4"; tokenId: string }>>([]), pending = useRef<string | null>(null), generation = useRef(0);
  const loadedPositions = useRef(20), discovery = useRef<AbortController | null>(null);
  const previewInput = useRef<LiquidityInput | null>(null), scope = `${chain}:${account?.address ?? ""}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const position = editor?.position ?? null;
  const available = [...tokens];
  for (const token of position ? [position.pool.token0, position.pool.token1] : []) if (!available.some((candidate) => keyOf(candidate) === keyOf(token))) available.push(token);
  const selectedA = available.find((token) => keyOf(token) === tokenA) ?? available[0]!;
  const selectedB = available.find((token) => keyOf(token) === tokenB) ?? available[1]!;
  const { priceFor } = useEvmPrices([...available, ...positions.flatMap((position) => [position.pool.token0, position.pool.token1]), ...(preview ? [preview.token0, preview.token1] : [])]);

  async function refresh(more = false) {
    if (!account || pending.current === scope || actions.busy || document.visibilityState === "hidden") { if (!account) setLoading(false); return; }
    pending.current = scope;
    discovery.current?.abort();
    const controller = new AbortController(); discovery.current = controller;
    if (more) setLoadingMore(true);
    const readingScope = scope;
    try {
      const references = more ? known.current : await actionStore.positionRefs(chain);
      if (currentScope.current !== readingScope) return;
      known.current = references;
      const result = await listPositions(walletReader(wallet, account.accountId), { accountId: account.accountId, address: getAddress(account.address) }, chain, { knownIds: references, pageSize: more ? 20 : loadedPositions.current, signal: controller.signal, ...(more && positionCursor ? { cursor: positionCursor } : {}) });
      if (currentScope.current !== readingScope) return;
      if (more) loadedPositions.current += 20;
      setPositions((previous) => more ? [...new Map([...previous, ...result.positions].map((position) => [`${position.protocol}:${position.tokenId}`, position])).values()] : result.positions);
      setPositionCursor(result.nextCursor); setComplete(result.complete); setDiscoveryErrors((previous) => more ? [...new Set([...previous, ...result.errors])] : result.errors); setReadError("");
    } catch (error) { if (currentScope.current === readingScope && !controller.signal.aborted) setReadError(errorText(error)); }
    finally { if (pending.current === readingScope) pending.current = null; if (currentScope.current === readingScope) { setLoading(false); setLoadingMore(false); } }
  }
  const currentRefresh = useRef(refresh); currentRefresh.current = refresh;
  useEffect(() => { discovery.current?.abort(); setPositions([]); known.current = []; loadedPositions.current = 20; setComplete(false); setReadError(""); setDiscoveryErrors([]); setPositionCursor(null); setLoading(true); setEditor(null); setTokenA("native"); setTokenB(keyOf(tokens[1]!)); void currentRefresh.current(); }, [scope]);
  useEffect(() => { if (!actions.busy) void currentRefresh.current(); }, [actions.busy, actions.revision]);
  useEffect(() => { setEditor(null); }, [actions.revision]);
  useEffect(() => {
    const update = () => { void currentRefresh.current(); };
    const timer = setInterval(update, 30000); window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); discovery.current?.abort(); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);

  const draft = JSON.stringify({ editor, protocol, tokenA, tokenB, amountA, amountB, fee, range, lower, upper, percentage, slippage, scope });
  useEffect(() => {
    const current = ++generation.current;
    setPreview(null); setPreviewError(""); setPreviewing(false); previewInput.current = null;
    if (!editor || !account || disabled || actions.busy) return;
    let input: LiquidityInput;
    try {
      const bps = slippageBasisPoints(slippage);
      input = { operation: editor.operation, protocol: position?.protocol ?? protocol, chainId: chain, accountId: account.accountId, slippageBps: bps };
      if (position) input.tokenId = position.tokenId;
      if (["mint", "increase"].includes(editor.operation)) {
        if (!amountA && !amountB) return;
        if (keyOf(selectedA) === keyOf(selectedB)) throw new Error("Choose two different tokens.");
        input.tokenA = selectedA.address; input.tokenB = selectedB.address;
        input.maxAmountA = amountA ? amountAtoms(amountA, selectedA) : "0";
        input.maxAmountB = amountB ? amountAtoms(amountB, selectedB) : "0";
        if (BigInt(input.maxAmountA) === 0n && BigInt(input.maxAmountB) === 0n) return;
      }
      if (editor.operation === "mint") {
        input.fee = Number(fee);
        if (protocol === "v4") input.tickSpacing = ({ "100": 1, "500": 10, "3000": 60, "10000": 200 } as Record<string, number>)[fee]!;
        if (range === "custom") {
          if (!lower || !upper) return;
          input.tickLower = Number(lower); input.tickUpper = Number(upper);
          if (!Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper)) throw new Error("Range ticks must be whole numbers.");
        }
      }
      if (editor.operation === "decrease") {
        if (!/^\d+(?:\.\d{1,2})?$/.test(percentage)) throw new Error("Enter a percentage with up to two decimal places.");
        const [whole, fraction = ""] = percentage.split(".");
        const removal = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
        if (removal <= 0n || removal > 10000n) throw new Error("Enter a percentage above 0 and at most 100.");
        input.liquidityBps = Number(removal);
      }
    } catch (error) { setPreviewError(errorText(error)); return; }
    setPreviewing(true);
    const timer = setTimeout(() => { void prepareLiquidity(walletReader(wallet, account.accountId), account, input).then((plan) => {
      if (generation.current !== current) return;
      const next = plan.details.preview as LiquidityPreview;
      setPreview(next); previewInput.current = input; setPreviewing(false);
    }).catch((error) => { if (generation.current === current) { setPreviewError(errorText(error)); setPreviewing(false); } }); }, 450);
    return () => { clearTimeout(timer); if (generation.current === current) generation.current++; };
  }, [draft, disabled, actions.busy]);

  function open(operation: Editor["operation"], next: PositionRecord | null = null) {
    setEditor({ operation, position: next }); setAmountA(""); setAmountB(""); setPercentage("100"); setPreview(null); setPreviewError("");
    if (next) { setProtocol(next.protocol); setTokenA(keyOf(next.pool.token0)); setTokenB(keyOf(next.pool.token1)); }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function submit() {
    if (!account || !preview || !previewInput.current) return;
    const input = previewInput.current as unknown as Record<string, unknown>;
    const previous = actions.currentEnvelope;
    const resume = previous?.kind === "liquidity" && JSON.stringify(previous.input) === JSON.stringify(input) && actions.progress && ["pending", "review"].includes(actions.progress.state);
    await actions.perform(resume ? previous : { operationId: newId(), kind: "liquidity", chainId: chain, accountId: account.accountId, input });
  }
  async function importPosition() {
    if (!account || !/^[1-9][0-9]*$/.test(importId)) { setImportError("Enter the position’s numeric ID."); return; }
    setImporting(true); setImportError("");
    try {
      const next = await readPosition(walletReader(wallet, account.accountId), { chainId: chain, accountId: account.accountId, owner: getAddress(account.address), protocol: importProtocol, tokenId: importId });
      await actionStore.trackPosition({ chainId: chain, protocol: next.protocol, tokenId: next.tokenId });
      if (currentScope.current !== scope) return;
      known.current = [...known.current.filter((value) => value.protocol !== next.protocol || value.tokenId !== next.tokenId), { protocol: next.protocol, tokenId: next.tokenId }];
      setPositions((previous) => [...previous.filter((value) => value.protocol !== next.protocol || value.tokenId !== next.tokenId), next]); setImportId("");
    } catch (error) { setImportError(errorText(error)); }
    finally { setImporting(false); }
  }
  async function addCustomToken() {
    if (!account) return;
    const address = customTokenAddress, readingScope = scope;
    try {
      const token = await customToken(walletReader(wallet, account.accountId), chain, address);
      if (currentScope.current !== readingScope) return;
      onTokens(token);
      setCustomTokenAddress((current) => current === address ? "" : current);
    } catch (error) {
      if (currentScope.current === readingScope) setPreviewError(errorText(error));
    }
  }
  const title = editor?.operation === "mint" ? "New position" : editor?.operation === "increase" ? "Add liquidity" : editor?.operation === "decrease" ? "Remove liquidity" : editor?.operation === "close" ? "Close position" : "Collect available amounts";
  const addingLiquidity = editor?.operation === "mint" || editor?.operation === "increase";
  const removingLiquidity = editor?.operation === "decrease" || editor?.operation === "close";
  const priceSlippageHelp = "Token limits are calculated from pool-price movement. Each token amount can change by more than this percentage, especially in a narrow price range.";
  return <>
    {editor ? <section className="nt-panel uni-form uni-liquidity-editor" aria-label={title}>
      <div className="uni-form-top"><h2 className="nt-subtitle">{title}</h2><button className="uni-icon-button" title="Back to positions" aria-label="Back to positions" disabled={actions.busy} onClick={() => setEditor(null)}>×</button></div>
      {position && <p className="uni-position-pair">{position.pool.token0.symbol} / {position.pool.token1.symbol} <span className="uni-version">{position.protocol.toUpperCase()} · #{position.tokenId}</span></p>}
      {editor.operation === "mint" && <div className="uni-row"><label>Version<select value={protocol} disabled={disabled || actions.busy} onChange={(event) => setProtocol(event.target.value as "v3" | "v4")}><option value="v4">Uniswap V4</option><option value="v3">Uniswap V3</option></select></label><label>Pool fee<select value={fee} disabled={disabled || actions.busy} onChange={(event) => setFee(event.target.value)}><option value="100">0.01%</option><option value="500">0.05%</option><option value="3000">0.3%</option><option value="10000">1%</option></select></label></div>}
      {["mint", "increase"].includes(editor.operation) && <>{[[selectedA, amountA, setAmountA, "A"], [selectedB, amountB, setAmountB, "B"]].map(([token, value, setter, side]) => { const current = token as Token; return <div className="uni-token-panel" key={String(side)}><label>Maximum deposit<input aria-label={`Token ${side} amount`} inputMode="decimal" placeholder="0" value={value as string} disabled={disabled || actions.busy} onChange={(event) => (setter as (value: string) => void)(event.target.value)}/></label><TokenPicker label={`Liquidity token ${side}`} priceFor={priceFor} balance={balance} balanceAtoms={balanceAtoms} tokens={available} value={keyOf(current)} disabled={disabled || actions.busy || !!position} onChange={(key) => side === "A" ? setTokenA(key) : setTokenB(key)}/><div className="uni-token-values"><UsdAmount atoms={draftAtoms(value as string, current)} decimals={current.decimals} price={priceFor(current)} label={`Token ${side} deposit in USD`}/><span className="uni-muted">Balance: {balance(current)} {current.symbol}<UsdAmount atoms={balanceAtoms(current)} decimals={current.decimals} price={priceFor(current)} label={`${current.symbol} balance in USD`}/></span></div></div>; })}<p className="uni-help">The pool uses the amounts it needs within your limits. Any unused tokens stay in your wallet.</p></>}
      {editor.operation === "mint" && <div className="uni-range-choice"><strong>Price range</strong><div className="uni-segmented" aria-label="Price range"><button className={range === "full" ? "is-selected" : ""} disabled={actions.busy} onClick={() => setRange("full")}>Full range</button><button className={range === "custom" ? "is-selected" : ""} disabled={actions.busy} onClick={() => setRange("custom")}>Custom</button></div><p className="uni-muted">{range === "full" ? "Provide liquidity across the pool’s full price range." : "Choose exact pool ticks in advanced settings below."}</p></div>}
      {editor.operation === "decrease" && <div className="uni-remove-amount"><label>Remove from position<div className="uni-percentage"><input aria-label="Liquidity removal percentage" inputMode="decimal" value={percentage} disabled={actions.busy} onChange={(event) => setPercentage(event.target.value)}/><span>%</span></div></label><div className="uni-segmented">{[25, 50, 75, 100].map((value) => <button key={value} className={percentage === String(value) ? "is-selected" : ""} disabled={actions.busy} onClick={() => setPercentage(String(value))}>{value}%</button>)}</div><p className="uni-help">Withdrawn tokens and collectible fees return to your wallet in the same transaction.</p></div>}
      {editor.operation === "close" && <p className="uni-help">Close this empty position and remove its NFT. Any collectible tokens return to your wallet in the same transaction.</p>}
      {previewing && <p className="uni-muted" role="status">Calculating your position…</p>}
      {preview && <div className="uni-liquidity-preview"><p>{editor.operation === "collect" ? "Available to collect" : removingLiquidity ? "Estimated withdrawal" : "Estimated deposit"}</p><div><strong>{amountText(preview.amount0, preview.token0.decimals)} {preview.token0.symbol}<UsdAmount atoms={preview.amount0} decimals={preview.token0.decimals} price={priceFor(preview.token0)} label={`${preview.token0.symbol} preview in USD`}/></strong><strong>{amountText(preview.amount1, preview.token1.decimals)} {preview.token1.symbol}<UsdAmount atoms={preview.amount1} decimals={preview.token1.decimals} price={priceFor(preview.token1)} label={`${preview.token1.symbol} preview in USD`}/></strong></div><p className="uni-usd-total">Estimated value<UsdTotal amounts={[{ token: preview.token0, atoms: preview.amount0 }, { token: preview.token1, atoms: preview.amount1 }]} priceFor={priceFor} label="Liquidity preview total in USD"/></p></div>}
      {previewError && <details className="uni-quote-error" open><summary>Position preview unavailable</summary><p>{previewError}</p></details>}
      <ActionProgress actions={actions}/>
      <button className="nt-button uni-primary" disabled={disabled || actions.busy || !preview || previewing} onClick={() => void submit()}>{actions.busy ? "Updating position…" : previewing ? "Calculating…" : title === "New position" ? "Create position" : title}</button>
      <details className="uni-details" open={range === "custom" && editor.operation === "mint" || undefined}><summary>⚙ Details & settings</summary><div className="uni-settings">
        {range === "custom" && editor.operation === "mint" && <><div className="uni-row"><label>Lower tick<input inputMode="numeric" value={lower} disabled={actions.busy} onChange={(event) => setLower(event.target.value)}/></label><label>Upper tick<input inputMode="numeric" value={upper} disabled={actions.busy} onChange={(event) => setUpper(event.target.value)}/></label></div><p className="uni-muted">Ticks use the pool’s currency order and must align with its tick spacing. A position earns pool fees while its price is inside this range.</p></>}
        <label>Pool price slippage %<input inputMode="decimal" title={priceSlippageHelp} aria-description={priceSlippageHelp} value={slippage} disabled={actions.busy} onChange={(event) => setSlippage(event.target.value)}/></label>
        {preview && <><dl><dt>Version</dt><dd>{preview.protocol.toUpperCase()}</dd><dt>Pool fee</dt><dd>{preview.pool.fee / 10000}%</dd><dt>Position range</dt><dd>{preview.tickLower} to {preview.tickUpper}</dd><dt>Current tick</dt><dd>{preview.pool.tick}</dd><dt>Range status</dt><dd>{preview.inRange ? "In range" : "Out of range"}</dd>{addingLiquidity && <><dt>Maximum deposit</dt><dd>{amountText(preview.amount0Max, preview.token0.decimals)} {preview.token0.symbol} + {amountText(preview.amount1Max, preview.token1.decimals)} {preview.token1.symbol}<UsdTotal amounts={[{ token: preview.token0, atoms: preview.amount0Max }, { token: preview.token1, atoms: preview.amount1Max }]} priceFor={priceFor} label="Maximum deposit in USD"/></dd></>}{(removingLiquidity || addingLiquidity && preview.protocol === "v3") && <><dt>{addingLiquidity ? "Minimum deposit" : "Minimum principal withdrawal"}</dt><dd>{amountText(preview.amount0Min, preview.token0.decimals)} {preview.token0.symbol} + {amountText(preview.amount1Min, preview.token1.decimals)} {preview.token1.symbol}<UsdTotal amounts={[{ token: preview.token0, atoms: preview.amount0Min }, { token: preview.token1, atoms: preview.amount1Min }]} priceFor={priceFor} label={addingLiquidity ? "Minimum deposit in USD" : "Minimum principal withdrawal in USD"}/></dd></>}</dl>{preview.warnings.map((warning) => <p className="uni-muted" key={warning}>{warning}</p>)}</>}
        {editor.operation === "mint" && <><label>Add token by contract<input value={customTokenAddress} disabled={disabled || actions.busy} spellCheck={false} onChange={(event) => setCustomTokenAddress(event.target.value)} placeholder="0x…"/></label><button className="uni-text-button" disabled={disabled || !account || !customTokenAddress || actions.busy} onClick={() => void addCustomToken()}>Add token</button><p className="uni-muted">New positions use existing pools. V3 native ETH is wrapped into WETH in the position. V4 pools distinguish ETH from WETH.</p></>}
      </div></details>
    </section> : <section className="uni-positions" aria-label="Liquidity positions">
      <header className="uni-form-top"><div><h2 className="nt-subtitle">Your positions</h2><p className="uni-muted">V3 & V4 · {NETWORKS[chain].name}</p></div><button className="nt-button uni-new-position" disabled={disabled || !account || actions.busy} onClick={() => open("mint")}>+ New position</button></header>
      {loading && <div className="uni-progress" role="status"><span className="uni-spinner"/><span>Loading positions…</span></div>}
      {!loading && !positions.length && <div className="nt-panel uni-position-empty"><span aria-hidden="true">◫</span><h3>{complete ? "No positions yet" : "Positions unavailable"}</h3><p className="uni-muted">{complete ? "Create a position to provide liquidity and earn pool fees." : "We haven’t verified your full position list. Reads retry automatically; you can also import a position below."}</p></div>}
      {positions.map((position) => <article className="nt-panel uni-position-card" key={`${position.protocol}:${position.tokenId}`}>
        <div className="uni-saved-title"><strong className="uni-position-heading"><span className="uni-pair-icons"><TokenIcon token={position.pool.token0}/><TokenIcon token={position.pool.token1}/></span>{position.pool.token0.symbol} / {position.pool.token1.symbol}</strong><span className={`uni-range-status${position.inRange && BigInt(position.liquidity) > 0n ? " is-active" : ""}`}>{BigInt(position.liquidity) === 0n ? "Empty" : position.inRange ? "● In range" : "Out of range"}</span></div>
        <p className="uni-muted">{position.protocol.toUpperCase()} · {position.pool.fee / 10000}% · #{position.tokenId}</p>
        <div className="uni-position-tokens"><strong>{amountText(position.amount0, position.pool.token0.decimals)} <span>{position.pool.token0.symbol}</span><UsdAmount atoms={position.amount0} decimals={position.pool.token0.decimals} price={priceFor(position.pool.token0)} label={`${position.pool.token0.symbol} position amount in USD`}/></strong><strong>{amountText(position.amount1, position.pool.token1.decimals)} <span>{position.pool.token1.symbol}</span><UsdAmount atoms={position.amount1} decimals={position.pool.token1.decimals} price={priceFor(position.pool.token1)} label={`${position.pool.token1.symbol} position amount in USD`}/></strong></div><p className="uni-usd-total">Position value<UsdTotal amounts={[{ token: position.pool.token0, atoms: position.amount0 }, { token: position.pool.token1, atoms: position.amount1 }]} priceFor={priceFor} label="Position principal in USD"/></p>
        <p className="uni-collectible">Available to collect <span>{amountText(position.claimable0, position.pool.token0.decimals)} {position.pool.token0.symbol} + {amountText(position.claimable1, position.pool.token1.decimals)} {position.pool.token1.symbol}</span><UsdTotal amounts={[{ token: position.pool.token0, atoms: position.claimable0 }, { token: position.pool.token1, atoms: position.claimable1 }]} priceFor={priceFor} label="Collectible amount in USD"/></p>
        <div className="uni-position-buttons"><button disabled={disabled || actions.busy} onClick={() => open("increase", position)}>Add</button><button disabled={disabled || actions.busy || BigInt(position.liquidity) === 0n} onClick={() => open("decrease", position)}>Remove</button><button disabled={disabled || actions.busy || BigInt(position.claimable0) + BigInt(position.claimable1) === 0n} onClick={() => open("collect", position)}>Collect</button></div>
        <details className="uni-details"><summary>Position details</summary><div className="uni-settings"><dl><dt>Ticks</dt><dd>{position.tickLower} to {position.tickUpper}</dd><dt>Current tick</dt><dd>{position.pool.tick}</dd><dt>Tick spacing</dt><dd>{position.pool.tickSpacing}</dd><dt>Fresh fee accrual</dt><dd>{amountText(position.fees0, position.pool.token0.decimals)} {position.pool.token0.symbol} + {amountText(position.fees1, position.pool.token1.decimals)} {position.pool.token1.symbol}</dd></dl><p className="uni-muted">Collectible amounts are estimates. V3 totals may include previously withdrawn tokens.</p><p className="uni-muted">Pool <code>{position.pool.poolId ?? position.pool.address}</code></p><p className="uni-muted">Position contract <code>{position.manager}</code></p>{BigInt(position.liquidity) === 0n && <button className="uni-text-button" disabled={disabled || actions.busy} onClick={() => open("close", position)}>Close empty position</button>}</div></details>
      </article>)}
      {positionCursor && <button className="uni-text-button" disabled={loadingMore || actions.busy} onClick={() => void refresh(true)}>{loadingMore ? "Loading positions…" : "Load more positions"}</button>}
      {(readError || !complete && !loading && discoveryErrors.length > 0) && <details className="uni-quote-error"><summary>Some positions may not be shown</summary><p>{readError || discoveryErrors.join(" ") || "Position discovery is incomplete. You can import a position by its ID below."}</p></details>}
      <details className="uni-details"><summary>Import an existing position</summary><div className="uni-settings"><p className="uni-muted">Enter an NFT position ID. Ownership and balances are checked on-chain.</p><div className="uni-row"><label>Version<select value={importProtocol} onChange={(event) => setImportProtocol(event.target.value as "v3" | "v4")}><option value="v4">Uniswap V4</option><option value="v3">Uniswap V3</option></select></label><label>Position ID<input inputMode="numeric" placeholder="123456" value={importId} onChange={(event) => setImportId(event.target.value)}/></label></div><button className="nt-button uni-continue" disabled={importing || disabled || !account || actions.busy || !importId} onClick={() => void importPosition()}>{importing ? "Checking ownership…" : "Import position"}</button>{importError && <p role="alert" className="uni-quote-error">{importError}</p>}</div></details>
    </section>}
    <ActionHistory actions={actions} kind="liquidity" chain={chain} accountId={account?.accountId ?? "main"}/>
  </>;
}
