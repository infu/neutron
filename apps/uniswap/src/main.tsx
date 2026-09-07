import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callTool } from "neutron-tools/app";
import { createEvmWalletClient, type EvmAccount, type EvmBalancesResult } from "neutron-tools/evm_wallet";
import { formatUnits, getAddress } from "viem";
import { amountAtoms, slippageBasisPoints, customToken, defaultTokens, NETWORKS, type Chain, type Token } from "./swap.ts";
import { createSwapStore, reconcileStep, savedIntent, approvalConfirmed, receivedTokenAtoms, walletReader, storedOperation, effectiveOperation, type SavedIntent, type SwapRecord } from "./controller.ts";
import { estimateSwapFees, totalEstimatedFee } from "./fees.ts";
import { NetworkFees } from "./fee_review.tsx";
import { readWalletAccounts } from "./read_connection.ts";
import { continueSwap, type SwapProgress } from "./workflow.ts";
import { TokenPicker } from "./token_picker.tsx";
import { quoteUnifiedSwap, prepareQuotedSwap, parseUnifiedSwapInput, type UnifiedQuote, type UnifiedSwapInput } from "./swap_routes.ts";
import { ActionHistory, ActionProgress, LiquidityView, useActionController } from "./liquidity_view.tsx";
import { useEvmPrices } from "./use_usd_prices.ts";
import { draftAtoms, UsdAmount } from "./usd_amount.tsx";
import "./style.scss";

const wallet = createEvmWalletClient({ callTool });
const store = createSwapStore();
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const tokenKey = (token: Token) => token.address?.toLowerCase() ?? "native";
function short(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
function displayAmount(atoms: string, decimals: number) {
  const value = formatUnits(BigInt(atoms), decimals);
  const number = Number(value);
  return number !== 0 && number < 0.000001 ? value : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 7 }).format(number);
}
function expired(saved: SavedIntent, now = Date.now()) { return BigInt(saved.quote.deadline) <= BigInt(Math.floor(now / 1000)); }

export function App() {
  const [chain, setChain] = useState<Chain>("1");
  const [tab, setTab] = useState<"swap" | "liquidity">("swap");
  const [protocol, setProtocol] = useState<"auto" | "v3" | "v4">("auto");
  const [accounts, setAccounts] = useState<EvmAccount[]>([]);
  const [accountId, setAccountId] = useState("main");
  const [tokens, setTokens] = useState(defaultTokens("1"));
  const [inputKey, setInputKey] = useState("native");
  const [outputKey, setOutputKey] = useState(tokenKey(defaultTokens("1")[1]!));
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [minutes, setMinutes] = useState("20");
  const [recipient, setRecipient] = useState("");
  const [custom, setCustom] = useState("");
  const [balances, setBalances] = useState<EvmBalancesResult | null>(null);
  const [quote, setQuote] = useState<UnifiedQuote | null>(null);
  const [approvalRequired, setApprovalRequired] = useState<boolean | null>(null);
  const [records, setRecords] = useState<SwapRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [progress, setProgress] = useState("");
  const [workflowProgress, setWorkflowProgress] = useState<SwapProgress | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [now, setNow] = useState(Date.now());
  const tracking = useRef<AbortController | null>(null);
  const errorRecord = useRef<string | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const working = useRef(false);
  const refreshCurrent = useRef<() => Promise<void>>(async () => {});
  const quoteGeneration = useRef(0);
  const quoteDraft = useRef("");
  const account = accounts.find((entry) => entry.accountId === accountId);
  const tokenIn = tokens.find((token) => tokenKey(token) === inputKey)!;
  const tokenOut = tokens.find((token) => tokenKey(token) === outputKey)!;
  const { priceFor } = useEvmPrices(tokens);
  const nativePrice = priceFor({ chainId: chain, address: null });
  const destination = recipient || account?.address || "";
  const actions = useActionController(async () => { setAmount(""); await refreshBalances().catch((error) => setRefreshError(errorText(error))); });
  const locked = busy || actions.busy;
  const draftIdentity = JSON.stringify({ chain, accountId, inputKey, outputKey, amount, destination, slippage, minutes, protocol });
  const currentDraft = useRef(draftIdentity);
  currentDraft.current = draftIdentity;
  const balanceScope = useRef(`${chain}:${accountId}`);
  balanceScope.current = `${chain}:${accountId}`;

  function showRecord(record: SwapRecord) { setRecords((previous) => [record, ...previous.filter((row) => row.id !== record.id)]); }
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    errorRecord.current = null;
    setBusy(true); setError(""); setNotice(""); setProgress("");
    try { await refreshing.current; await action(); }
    catch (e) {
      if (tracking.current?.signal.aborted) setNotice("Tracking paused. Your transaction can still complete; continue it below.");
      else setError(errorText(e));
    } finally { working.current = false; setBusy(false); setProgress(""); setWorkflowProgress(null); setActiveId(null); tracking.current = null; }
  }
  async function reload() {
    const page = await store.page();
    setRecords((previous) => [...page.rows, ...previous.filter((row) => !page.rows.some((latest) => latest.id === row.id))]);
    setHistoryCursor(page.nextCursor);
  }
  async function loadOlder() {
    if (historyCursor === null) return;
    const page = await store.page(historyCursor);
    setRecords((previous) => [...new Map([...previous, ...page.rows].map((row) => [row.id, row])).values()]);
    setHistoryCursor(page.nextCursor);
  }
  async function refreshBalances(selected = account) {
    if (!selected) return;
    const scope = `${chain}:${selected.accountId}`;
    const result = await wallet.balances({ accountId: selected.accountId, chainId: chain, tokens: tokens.flatMap((token) => token.address ? [token.address] : []) });
    if (result.address.toLowerCase() !== selected.address.toLowerCase()) throw new Error("The Wallet address changed during the balance read. Updating your account and balances again.");
    if (balanceScope.current === scope) setBalances(result);
  }
  async function loadAccounts() {
    const result = await readWalletAccounts(wallet, accountId);
    setAccounts(result.accounts);
    // Do not overwrite a selection that changed while this read was in flight.
    if (result.selected && balanceScope.current === `${chain}:${accountId}`) {
      balanceScope.current = `${chain}:${result.selected.accountId}`;
      setAccountId(result.selected.accountId);
    }
    setWalletError(result.selected ? "" : "Create an account in EVM Wallet to start swapping.");
    return result.selected;
  }
  // The app's install-declared access makes these ordinary Wallet reads. A
  // temporary failure is retried on the next visible poll or focus event.
  refreshCurrent.current = async () => {
    if (document.visibilityState === "hidden" || working.current || actions.busy) return;
    if (refreshing.current) { refreshQueued.current = true; return refreshing.current; }
    const refresh = async () => {
      const failures: string[] = [];
      const selected = await loadAccounts().catch((e) => { setWalletError(errorText(e)); return null; });
      setWalletLoading(false);
      await Promise.all([
        (async () => {
          if (selected) for (const saved of records) {
            if (working.current) break;
            try {
              if (savedIntent(saved).executionMode !== "human") continue;
              const pending = saved.phase.endsWith("_requested") || [effectiveOperation(saved, "approval"), effectiveOperation(saved, "swap")].some((value) => value && ["signing", "signed", "submitted", "unknown"].includes(value.status));
              if (!pending) continue;
              let latest = await store.get(saved.id) ?? saved;
              if (latest.approval_request_id) latest = await reconcileStep(wallet, store, latest, "approval");
              latest = await reconcileStep(wallet, store, latest, "swap");
              showRecord(latest);
              if (errorRecord.current === latest.id && effectiveOperation(latest, "swap")?.receipt?.status === "success") {
                errorRecord.current = null; setError(""); setNotice("Swap complete. Your balances update automatically.");
              }
            } catch (e) { failures.push(errorText(e)); break; }
          }
          await reload();
        })().catch((e) => { failures.push(errorText(e)); }),
        selected ? refreshBalances(selected).catch((e) => { failures.push(errorText(e)); }) : Promise.resolve(),
      ]);
      setRefreshError(failures[0] ?? "");
    };
    refreshing.current = refresh();
    try { await refreshing.current; } finally {
      refreshing.current = null;
      if (refreshQueued.current) { refreshQueued.current = false; queueMicrotask(() => void refreshCurrent.current()); }
    }
  };
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const refresh = () => { void refreshCurrent.current(); };
    const poll = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(clock); clearInterval(poll); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); tracking.current?.abort(); };
  }, []);
  useEffect(() => { setBalances(null); }, [chain, accountId, account?.address]);
  useEffect(() => { if (!locked) void refreshCurrent.current(); }, [chain, accountId, tokens, locked]);

  function swapInput(): UnifiedSwapInput {
    const duration = Number(minutes);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(Math.round(duration * 60))) throw new Error("Enter a positive deadline in minutes.");
    return parseUnifiedSwapInput({ protocol, chainId: chain, accountId, tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: amountAtoms(amount, tokenIn), recipient: destination, slippageBps: slippageBasisPoints(slippage), quoteValiditySeconds: String(Math.round(duration * 60)) });
  }
  useEffect(() => {
    const generation = ++quoteGeneration.current;
    if (locked) { setQuoting(false); return; }
    setQuote(null); setApprovalRequired(null); setQuoteError(""); setQuoting(false);
    if (tab !== "swap" || !account || walletError || !amount || !tokenIn || !tokenOut || inputKey === outputKey) return;
    let input: UnifiedSwapInput;
    try { input = swapInput(); } catch (error) { setQuoteError(errorText(error)); return; }
    setQuoting(true);
    const timer = setTimeout(() => {
      const selected = account;
      void (async () => {
        let quoted: UnifiedQuote | null = null;
        try {
          const next = await quoteUnifiedSwap(walletReader(wallet, selected.accountId), selected, input);
          if (quoteGeneration.current !== generation) return;
          quoteDraft.current = draftIdentity;
          quoted = next; setQuote(next); setQuoting(false);
          if (next.protocol === "v3") {
            const plan = await prepareQuotedSwap(walletReader(wallet, selected.accountId), next);
            if (quoteGeneration.current !== generation) return;
            const approvals = plan.steps.filter((step) => step.kind === "approval");
            setApprovalRequired(approvals.length > 0);
            // The legacy fee panel has one approval slot. A reset plus approval
            // must not be presented as a complete two-transaction fee estimate.
            if (approvals.length > 1) { setQuote({ ...next, routeWarnings: [...next.routeWarnings, "This token needs an approval reset first. Wallet reviews each transaction’s network fee."] }); return; }
            const networkFees = await estimateSwapFees(wallet, { quote: next, allowance: null, approval: approvals[0]?.transaction ?? null, swap: plan.steps.at(-1)!.transaction });
            if (quoteGeneration.current === generation) setQuote({ ...next, networkFees });
          }
        } catch (error) {
          if (quoteGeneration.current === generation) {
            if (quoted) setQuote({ ...quoted, routeWarnings: [...quoted.routeWarnings, `Token access or fee observation unavailable: ${errorText(error)}`] });
            else setQuoteError(errorText(error));
            setQuoting(false);
          }
        }
      })();
    }, 450);
    return () => { clearTimeout(timer); if (quoteGeneration.current === generation) quoteGeneration.current++; };
  }, [draftIdentity, account?.address, walletError, locked, quoteNonce, tab]);
  useEffect(() => { if (quote && BigInt(quote.deadline) <= BigInt(Math.floor(now / 1000)) && !locked && !quoting) setQuoteNonce((value) => value + 1); }, [now, quote, locked, quoting]);

  function changeChain(value: Chain) { const next = defaultTokens(value); setChain(value); setTokens(next); setInputKey("native"); setOutputKey(tokenKey(next[1]!)); }
  function selectToken(stage: "input" | "output", key: string) {
    if (stage === "input") { if (key === outputKey) setOutputKey(inputKey); setInputKey(key); }
    else { if (key === inputKey) setInputKey(outputKey); setOutputKey(key); }
  }
  function balanceAtoms(token: Token): string | null {
    if (!balances || !account || balances.chainId !== token.chainId || balances.accountId !== accountId || balances.address.toLowerCase() !== account.address.toLowerCase()) return null;
    if (token.address === null) return balances.nativeBalanceWei;
    const entry = balances.tokens.find((value) => value.address.toLowerCase() === token.address!.toLowerCase());
    return entry?.balanceAtoms ?? null;
  }
  function balance(token: Token) {
    const atoms = balanceAtoms(token);
    return atoms === null ? "—" : displayAmount(atoms, token.decimals);
  }
  function useSavedDraft(saved: SavedIntent) {
    const next = defaultTokens(saved.quote.chainId as Chain);
    for (const token of [saved.quote.tokenIn, saved.quote.tokenOut]) if (!next.some((value) => tokenKey(value) === tokenKey(token))) next.push(token);
    setChain(saved.quote.chainId as Chain); setTokens(next); setAccountId(saved.quote.accountId);
    setInputKey(tokenKey(saved.quote.tokenIn)); setOutputKey(tokenKey(saved.quote.tokenOut));
    setAmount(formatUnits(BigInt(saved.quote.amountIn), saved.quote.tokenIn.decimals));
    setRecipient(saved.quote.recipient); setSlippage(String(saved.quote.slippageBps / 100));
    setQuote(null); setProtocol("v3"); setTab("swap"); setQuoteNonce((value) => value + 1);
    setNotice("Review the updated quote above, then tap Swap. Any existing token allowance is checked automatically.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function proceed(initial: SwapRecord) {
    if (savedIntent(initial).executionMode !== "human") throw new Error("This swap is managed by its originating app or agent.");
    if (!account || walletError) await loadAccounts();
    setActiveId(initial.id); tracking.current = new AbortController();
    try {
      const result = await continueSwap(wallet, store, initial, {
        signal: tracking.current.signal, onRecord: showRecord,
        onProgress: (next) => { setWorkflowProgress(next); setProgress(next.message); },
      });
      if (result.state === "complete") { setNotice("Swap complete. Your balances are updating."); setAmount(""); await refreshBalances().catch((e) => setRefreshError(errorText(e))); }
      else if (result.state === "expired") useSavedDraft(savedIntent(result.record));
      else if (result.state === "review") setNotice("Wallet updated the transaction. Continue your swap below to review it.");
      else setNotice("The transaction did not complete. You can check it or try again below.");
    } catch (e) { errorRecord.current = initial.id; throw e; }
    finally { await reload().catch((e) => setError(errorText(e))); }
  }
  async function save() {
    if (!quote || BigInt(quote.deadline) <= BigInt(Math.floor(Date.now() / 1000)) || quoting || !account) return;
    if (quoteDraft.current !== currentDraft.current) return;
    const input = swapInput(), previous = actions.currentEnvelope;
    if (previous?.kind === "swap" && JSON.stringify(previous.input) === JSON.stringify(input) && actions.progress && ["pending", "review"].includes(actions.progress.state)) {
      await actions.perform(previous); return;
    }
    const operationId = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
    await actions.perform({ operationId, kind: "swap", chainId: chain, accountId: account.accountId, input });
  }
  async function retryWithFreshQuote(record: SwapRecord) {
    if (savedIntent(record).executionMode !== "human") throw new Error("This swap is managed by its originating app or agent.");
    if (!account || walletError) await loadAccounts();
    record = await store.get(record.id) ?? record;
    if (record.approval_request_id) record = await reconcileStep(wallet, store, record, "approval");
    record = await reconcileStep(wallet, store, record, "swap"); showRecord(record);
    const op = effectiveOperation(record, "swap"), approval = effectiveOperation(record, "approval");
    const waiting = [op, approval].some((value) => value && ["signing", "signed", "submitted", "unknown"].includes(value.status));
    if (waiting || op?.status === "confirmed") await proceed(record);
    else useSavedDraft(savedIntent(record));
  }
  const totalFee = quote?.networkFees ? totalEstimatedFee(quote.networkFees) : null;
  const validQuote = quote && quoteDraft.current === draftIdentity && BigInt(quote.deadline) > BigInt(Math.floor(now / 1000));
  const swapButton = walletLoading ? "Loading wallet…" : !account || walletError ? "Wallet unavailable" : !amount || Number(amount) === 0 ? "Enter an amount" : quoting ? "Comparing pools…" : !validQuote ? "Swap unavailable" : "Swap";

  return <main className="nt-app uni-app"><div className="uni-shell">
    <header className="uni-header"><div><p className="nt-eyebrow">Uniswap</p><h1 className="nt-title">{tab === "swap" ? "Swap tokens" : "Manage liquidity"}</h1></div>{account && !walletError ? <span className="uni-connected" title={account.address}><span/> {short(account.address)}</span> : <span className="uni-muted" role="status">{walletLoading ? "Loading wallet…" : "Wallet unavailable"}</span>}</header>
    <nav className="uni-tabs" aria-label="Uniswap views"><button aria-current={tab === "swap" ? "page" : undefined} disabled={locked} onClick={() => setTab("swap")}>Swap</button><button aria-current={tab === "liquidity" ? "page" : undefined} disabled={locked} onClick={() => setTab("liquidity")}>Liquidity</button></nav>
    {actions.error && <div role="alert" className="uni-alert"><strong>We couldn’t complete that step.</strong><p>{actions.progress ? "Your request is saved in activity. Continue the same action to check its status." : "Review the details and try again. Activity below shows any saved requests."}</p><details><summary>Show details</summary><p>{actions.error}</p></details></div>}
    {actions.notice && actions.currentEnvelope?.kind === tab && actions.currentEnvelope.chainId === chain && <p role="status" className="uni-notice">{actions.notice}</p>}
    {tab === "liquidity" && <><div className="uni-form-top"><label className="uni-network"><span className="nt-sr-only">Network</span><select aria-label="Network" value={chain} disabled={locked} onChange={(event) => changeChain(event.target.value as Chain)}>{Object.entries(NETWORKS).map(([id, network]) => <option key={id} value={id}>{network.name}</option>)}</select></label><span className="uni-muted">Powered by EVM Wallet</span></div><LiquidityView wallet={wallet} account={account} chain={chain} tokens={tokens} balance={balance} balanceAtoms={balanceAtoms} actions={actions} disabled={locked || !!walletError} onTokens={(token) => setTokens((previous) => previous.some((value) => tokenKey(value) === tokenKey(token)) ? previous : [...previous, token])}/></>}
    {tab === "swap" && <section className="nt-panel uni-form" aria-label="Swap tokens">
      <div className="uni-form-top"><label className="uni-network"><span className="nt-sr-only">Network</span><select aria-label="Network" value={chain} disabled={locked} onChange={(e) => changeChain(e.target.value as Chain)}>{Object.entries(NETWORKS).map(([id, net]) => <option key={id} value={id}>{net.name}</option>)}</select></label><span className="uni-muted">Powered by EVM Wallet</span></div>
      <div className="uni-token-panel"><label>You pay<input aria-label="Input amount" inputMode="decimal" placeholder="0" value={amount} disabled={locked} onChange={(e) => setAmount(e.target.value)}/></label><TokenPicker label="Input token" priceFor={priceFor} balance={balance} balanceAtoms={balanceAtoms} tokens={tokens} value={inputKey} disabled={locked} onChange={(value) => selectToken("input", value)}/><div className="uni-token-values"><UsdAmount atoms={draftAtoms(amount, tokenIn)} decimals={tokenIn.decimals} price={priceFor(tokenIn)}/><span className="uni-muted">Balance: {balance(tokenIn)} {tokenIn.symbol}<UsdAmount atoms={balanceAtoms(tokenIn)} decimals={tokenIn.decimals} price={priceFor(tokenIn)} label="Input token balance in USD"/></span></div></div>
      <button className="uni-direction" aria-label="Reverse tokens" title="Reverse tokens" disabled={locked} onClick={() => { setInputKey(outputKey); setOutputKey(inputKey); }}>↓</button>
      <div className="uni-token-panel uni-receive"><label>You receive<output aria-label="Output amount" aria-live="polite">{quote ? displayAmount(quote.amountOut, quote.tokenOut.decimals) : quoting ? "…" : "0"}</output></label><TokenPicker label="Output token" priceFor={priceFor} balance={balance} balanceAtoms={balanceAtoms} tokens={tokens} value={outputKey} disabled={locked} onChange={(value) => selectToken("output", value)}/><div className="uni-token-values"><UsdAmount atoms={quote?.amountOut ?? null} decimals={tokenOut.decimals} price={priceFor(tokenOut)}/><span className="uni-muted">Balance: {balance(tokenOut)} {tokenOut.symbol}<UsdAmount atoms={balanceAtoms(tokenOut)} decimals={tokenOut.decimals} price={priceFor(tokenOut)} label="Output token balance in USD"/></span></div></div>
      {quote && <div className="uni-quote-summary"><span>Estimated network fee</span><span>{totalFee === null ? "Reviewed in Wallet" : `${displayAmount(totalFee, 18)} ETH`}<UsdAmount atoms={totalFee} decimals={18} price={nativePrice} label="Estimated network fee in USD"/></span></div>}
      {quoteError && !locked && <div className="uni-quote-error"><p>No quote available yet.</p><details><summary>Show reason</summary><p>{quoteError}</p></details><button className="uni-text-button" onClick={() => setQuoteNonce((value) => value + 1)}>Try again</button></div>}
      {busy && <div role="status" className="uni-progress" data-testid="uniswap-progress"><span className="uni-spinner"/><div><strong>{progress || "Working…"}</strong>{workflowProgress && <p className="uni-muted">{workflowProgress.stage === "approval" ? "Token approval · swap confirmation follows automatically" : "Your tokens are swapped when this transaction confirms"}</p>}</div></div>}
      <ActionProgress actions={actions}/>
      <button className="nt-button uni-primary" disabled={locked || !account || !!walletError || !validQuote || quoting} onClick={() => void save()}>{locked ? workflowProgress?.state === "review" ? "Confirm in EVM Wallet" : "Swap in progress…" : swapButton}</button>
      {(walletError || refreshError) && <details className="uni-quote-error"><summary>{walletError ? "Wallet unavailable · retrying automatically" : "Updates delayed · retrying automatically"}</summary><p>{walletError || refreshError}</p></details>}
      {busy && tracking.current && workflowProgress?.state === "pending" && <button className="uni-text-button" onClick={() => tracking.current?.abort()}>Pause tracking</button>}
      {approvalRequired && !locked && <p className="uni-help">Your wallet will ask for token approval, then confirm the swap.</p>}
      <details className="uni-details"><summary title="Price details, slippage, recipient and custom tokens">⚙ <span>Details & settings</span></summary><div className="uni-settings">
        {quote && <><dl><dt>Minimum received</dt><dd>{formatUnits(BigInt(quote.minimumOut), tokenOut.decimals)} {tokenOut.symbol}<UsdAmount atoms={quote.minimumOut} decimals={tokenOut.decimals} price={priceFor(tokenOut)} label="Minimum received in USD"/></dd><dt>Route</dt><dd>Uniswap {quote.protocol.toUpperCase()}</dd><dt>Pool fee</dt><dd>{quote.fee / 10000}%</dd><dt>Price impact</dt><dd>{quote.priceImpactBps === null ? "Unavailable" : `${Number(quote.priceImpactBps) / 100}%`}</dd><dt>Quote age</dt><dd>{Math.max(0, Math.floor((now - quote.quotedAtMs) / 1000))} seconds</dd><dt>Token access</dt><dd>{approvalRequired ? `Approve exactly ${amount} ${tokenIn.symbol}; unused allowance remains until spent or revoked.` : approvalRequired === false ? "No new approval needed" : "Exact token access is reviewed in Wallet"}</dd></dl><NetworkFees fees={quote.networkFees} approvalRequired={!!approvalRequired} chainId={chain} nativePrice={nativePrice}/>{quote.routeWarnings.map((warning) => <p className="uni-muted" key={warning}>{warning}</p>)}</>}
        <label>Pool version<select value={protocol} disabled={locked} onChange={(event) => setProtocol(event.target.value as "auto" | "v3" | "v4")}><option value="auto">Auto · compare V3 & V4</option><option value="v4">Uniswap V4</option><option value="v3">Uniswap V3</option></select></label>
        <div className="uni-row"><label>Slippage %<input disabled={locked} inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)}/></label><label>Deadline · minutes<input disabled={locked} inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)}/></label></div>
        <label>Account<select value={accountId} disabled={!accounts.length || locked} onChange={(e) => setAccountId(e.target.value)}>{accounts.length ? accounts.map((value) => <option key={value.accountId} value={value.accountId}>{value.accountId} · {short(value.address)}</option>) : <option value="main">{walletLoading ? "Loading accounts…" : "No account available"}</option>}</select></label>
        <label>Recipient<input value={recipient} disabled={locked} spellCheck={false} onChange={(e) => setRecipient(e.target.value)} placeholder={account?.address ?? "Your wallet address"}/></label>
        <div className="uni-contracts"><p>Pay token: <code>{tokenIn.address ?? "Native ETH"}</code></p><p>Receive token: <code>{tokenOut.address ?? "Native ETH"}</code></p></div>
        <label>Add token by contract<input value={custom} disabled={locked} spellCheck={false} onChange={(e) => setCustom(e.target.value)} placeholder="0x…"/></label><button className="nt-button nt-button--sm" disabled={locked || !account || !!walletError || !custom} onClick={() => void run(async () => { setProgress("Reading token details…"); const token = await customToken(walletReader(wallet, account!.accountId), chain, custom); setTokens((previous) => previous.some((value) => tokenKey(value) === tokenKey(token)) ? previous : [...previous, token]); setCustom(""); })}>Add token</button>
        <p className="uni-muted">Direct Uniswap V3 & V4 pools. Auto compares output across supported pools; it does not compare every possible route. Verify custom token addresses. Quotes can change; your minimum received and deadline are enforced on-chain.</p>
      </div></details>
    </section>}
    {error && <div role="alert" className="uni-alert"><strong>We couldn't complete that step.</strong><p>Your saved swaps are below. Continue the same swap to check its status.</p><details><summary>Show details</summary><p>{error}</p></details></div>}
    {notice && <p role="status" className="uni-notice">{notice}</p>}
    {tab === "swap" && <ActionHistory actions={actions} kind="swap" chain={chain} accountId={accountId}/>}
    {tab === "swap" && records.length > 0 && <section className="uni-activity"><header><h2 className="nt-subtitle">Earlier swaps</h2><span className="uni-muted" title="Balances and history update automatically" aria-label="Updates automatically">↻</span></header>{!records.length && <p className="uni-empty">Your swaps will appear here.</p>}
      {records.map((record) => {
        try {
          const saved = savedIntent(record), op = effectiveOperation(record, "swap"), approval = effectiveOperation(record, "approval"), received = receivedTokenAtoms(record);
          const originalSwap = storedOperation(record, "swap"), originalApproval = storedOperation(record, "approval");
          const complete = op?.status === "confirmed" && op.receipt?.status === "success";
          const pending = [op, approval].some((value) => value && ["signing", "signed", "submitted", "unknown"].includes(value.status));
          const terminal = [op, approval].some((value) => value && ["rejected", "reverted", "failed", "replaced"].includes(value.status));
          const needsFreshQuote = !pending && !complete && (expired(saved, now) || terminal);
          const label = complete ? "Complete" : activeId === record.id ? progress || "In progress" : pending ? op ? "Swap pending" : "Token approval pending" : terminal ? "Not completed" : approvalConfirmed(record) ? "Ready to swap" : "Ready to continue";
          return <article className={`nt-panel uni-saved${complete ? " uni-saved-complete" : ""}`} key={record.id}>
            <div className="uni-saved-title"><strong>{displayAmount(saved.quote.amountIn, saved.quote.tokenIn.decimals)} {saved.quote.tokenIn.symbol}<span className="uni-arrow"> → </span>{saved.quote.tokenOut.symbol}</strong><span className="uni-status">{complete ? "✓ Complete" : NETWORKS[saved.quote.chainId as Chain].name}</span></div>
            {!complete && <p className="uni-saved-state">{label}</p>}{complete && received !== null && <p>Received {displayAmount(received, saved.quote.tokenOut.decimals)} {saved.quote.tokenOut.symbol}</p>}
            {!complete && approvalConfirmed(record) && record.approval_request_id && <p className="uni-muted">Token approved. {saved.executionMode !== "human" ? "The requesting app controls the next step." : needsFreshQuote ? "Update the price to continue your swap." : "Continue to confirm the swap in your wallet."}</p>}
            {saved.executionMode !== "human" ? <p className="uni-muted">{saved.executionMode === "agent" ? "Managed by your agent." : "Managed by the requesting app."}</p> : !complete && <button className="nt-button uni-continue" disabled={locked} onClick={() => void run(() => needsFreshQuote ? retryWithFreshQuote(record) : proceed(record))}>{activeId === record.id ? "In progress…" : needsFreshQuote ? terminal ? "Try swap again" : "Refresh swap" : "Continue swap"}</button>}
            {op?.transactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${op.transactionHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
            <details className="uni-details"><summary>Transaction details</summary><div className="uni-settings"><p>Minimum {formatUnits(BigInt(saved.quote.minimumOut), saved.quote.tokenOut.decimals)} {saved.quote.tokenOut.symbol}</p><p>Recipient <code>{saved.quote.recipient}</code></p><p>Saved status: {record.phase.replaceAll("_", " ")}</p>{op?.message && <p>{op.message}</p>}{approval?.message && <p>{approval.message}</p>}{originalApproval?.transactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${originalApproval.transactionHash}`} target="_blank" rel="noreferrer">View token approval ↗</a>}{[originalApproval?.replacementTransactionHash, originalSwap?.replacementTransactionHash].filter(Boolean).map((hash) => <a key={hash} href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${hash}`} target="_blank" rel="noreferrer">View replacement transaction ↗</a>)}<NetworkFees fees={saved.quote.networkFees} approvalRequired={!!saved.approval} chainId={saved.quote.chainId} nativePrice={priceFor({ chainId: saved.quote.chainId, address: null })}/><pre>{JSON.stringify({ id: record.id, approvalRequest: record.approval_request_json ? JSON.parse(record.approval_request_json) : null, swapRequest: JSON.parse(record.swap_request_json) }, null, 2)}</pre></div></details>
          </article>;
        } catch (e) { return <article className="nt-panel uni-saved" key={record.id}><strong>Saved swap needs attention</strong><details><summary>Show details</summary><p>{errorText(e)}</p></details></article>; }
      })}{historyCursor !== null && <button className="uni-text-button" disabled={locked} onClick={() => void run(loadOlder)}>Load older swaps</button>}
    </section>}
    <footer className="uni-muted">Ethereum & Arbitrum · An independent interface for Uniswap V3 & V4</footer>
  </div></main>;
}
const root = document.getElementById("root"); if (!root) throw new Error("Missing app root"); createRoot(root).render(<App/>);
