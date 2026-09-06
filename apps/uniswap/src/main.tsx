import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callTool } from "neutron-tools/app";
import { createEvmWalletClient, type EvmAccount, type EvmBalancesResult } from "neutron-tools/evm_wallet";
import { formatUnits, getAddress } from "viem";
import { amountAtoms, slippageBasisPoints, customToken, defaultTokens, NETWORKS, type Chain, type Token } from "./swap.ts";
import { createIntent, createSwapStore, reconcileStep, savedIntent, approvalConfirmed, receivedTokenAtoms, walletReader, storedOperation, effectiveOperation, type SavedIntent, type SwapRecord } from "./controller.ts";
import { estimateSwapFees, totalEstimatedFee } from "./fees.ts";
import { NetworkFees } from "./fee_review.tsx";
import { connectWalletReads } from "./read_connection.ts";
import { continueSwap, type SwapProgress } from "./workflow.ts";
import { TokenPicker } from "./token_picker.tsx";
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
  const [intent, setIntent] = useState<SavedIntent | null>(null);
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
  const [readPaused, setReadPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tracking = useRef<AbortController | null>(null);
  const errorRecord = useRef<string | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);
  const working = useRef(false);
  const refreshCurrent = useRef<() => Promise<void>>(async () => {});
  const quoteGeneration = useRef(0);
  const quoteDraft = useRef("");
  const account = accounts.find((entry) => entry.accountId === accountId);
  const tokenIn = tokens.find((token) => tokenKey(token) === inputKey)!;
  const tokenOut = tokens.find((token) => tokenKey(token) === outputKey)!;
  const destination = recipient || account?.address || "";
  const draftIdentity = JSON.stringify({ chain, accountId, inputKey, outputKey, amount, destination, slippage, minutes });
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
    if (balanceScope.current === scope) setBalances(result);
  }
  async function connect() {
    setProgress("Connecting EVM Wallet…");
    await connectWalletReads();
    const result = await wallet.accounts();
    setAccounts(result.accounts); setReadPaused(false);
    const selected = result.accounts.find((entry) => entry.accountId === accountId) ?? result.accounts[0];
    if (selected) setAccountId(selected.accountId);
  }
  // Passive reads use the established connection. Permission errors suspend
  // refresh until the owner reconnects, rather than reopening permission dialogs.
  refreshCurrent.current = async () => {
    if (document.visibilityState === "hidden" || working.current) return;
    if (refreshing.current) return refreshing.current;
    const refresh = async () => {
      await Promise.all([
        (async () => {
          if (account && !readPaused) for (const saved of records) {
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
            } catch (e) { setError(errorText(e)); setReadPaused(true); break; }
          }
          await reload();
        })().catch((e) => setError(errorText(e))),
        account && !readPaused ? refreshBalances().catch(() => setReadPaused(true)) : Promise.resolve(),
      ]);
    };
    refreshing.current = refresh();
    try { await refreshing.current; } finally { refreshing.current = null; }
  };
  useEffect(() => {
    void refreshCurrent.current();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const refresh = () => { void refreshCurrent.current(); };
    const poll = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(clock); clearInterval(poll); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); tracking.current?.abort(); };
  }, []);
  useEffect(() => { setBalances(null); }, [chain, accountId, account?.address]);
  useEffect(() => { if (!busy) void refreshCurrent.current(); }, [chain, accountId, account?.address, tokens, readPaused, busy]);

  useEffect(() => {
    const generation = ++quoteGeneration.current;
    if (busy) { setQuoting(false); return; }
    setIntent(null); setQuoteError(""); setQuoting(false);
    if (!account || readPaused || busy || !amount || !tokenIn || !tokenOut || inputKey === outputKey) return;
    let amountIn: string, duration: number, bps: number;
    try {
      amountIn = amountAtoms(amount, tokenIn); duration = Number(minutes); bps = slippageBasisPoints(slippage);
      if (BigInt(amountIn) === 0n) return;
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(Math.round(duration * 60))) throw new Error("Enter a positive deadline in minutes.");
      getAddress(destination);
    } catch (e) { setQuoteError(errorText(e)); return; }
    setQuoting(true);
    const timer = setTimeout(() => {
      const selected = account;
      void (async () => {
        try {
          const next = await createIntent(wallet, { chainId: chain, accountId: selected.accountId, accountAddress: getAddress(selected.address), tokenIn, tokenOut, amountIn, slippageBps: bps, recipient: getAddress(destination), deadline: (BigInt(Math.floor(Date.now() / 1000)) + BigInt(Math.round(duration * 60))).toString() });
          if (quoteGeneration.current !== generation) return;
          quoteDraft.current = draftIdentity;
          setIntent(next); setQuoting(false);
          const networkFees = await estimateSwapFees(wallet, next);
          if (quoteGeneration.current === generation) setIntent({ ...next, quote: { ...next.quote, networkFees } });
        } catch (e) {
          if (quoteGeneration.current === generation) { setQuoteError(errorText(e)); setQuoting(false); }
        }
      })();
    }, 450);
    return () => { clearTimeout(timer); if (quoteGeneration.current === generation) quoteGeneration.current++; };
  }, [draftIdentity, account?.address, readPaused, busy, quoteNonce]);
  useEffect(() => { if (intent && expired(intent, now) && !busy && !quoting) setQuoteNonce((value) => value + 1); }, [now, intent, busy, quoting]);

  function changeChain(value: Chain) { const next = defaultTokens(value); setChain(value); setTokens(next); setInputKey("native"); setOutputKey(tokenKey(next[1]!)); }
  function selectToken(stage: "input" | "output", key: string) {
    if (stage === "input") { if (key === outputKey) setOutputKey(inputKey); setInputKey(key); }
    else { if (key === inputKey) setInputKey(outputKey); setOutputKey(key); }
  }
  function balance(token: Token) {
    if (!balances || balances.chainId !== token.chainId) return "—";
    if (token.address === null) return displayAmount(balances.nativeBalanceWei, 18);
    const entry = balances.tokens.find((value) => value.address.toLowerCase() === token.address!.toLowerCase());
    return entry?.balanceAtoms === null || !entry ? "—" : displayAmount(entry.balanceAtoms, token.decimals);
  }
  function useSavedDraft(saved: SavedIntent) {
    const next = defaultTokens(saved.quote.chainId as Chain);
    for (const token of [saved.quote.tokenIn, saved.quote.tokenOut]) if (!next.some((value) => tokenKey(value) === tokenKey(token))) next.push(token);
    setChain(saved.quote.chainId as Chain); setTokens(next); setAccountId(saved.quote.accountId);
    setInputKey(tokenKey(saved.quote.tokenIn)); setOutputKey(tokenKey(saved.quote.tokenOut));
    setAmount(formatUnits(BigInt(saved.quote.amountIn), saved.quote.tokenIn.decimals));
    setRecipient(saved.quote.recipient); setSlippage(String(saved.quote.slippageBps / 100));
    setIntent(null); setQuoteNonce((value) => value + 1);
    setNotice("Review the updated quote above, then tap Swap. Any existing token allowance is checked automatically.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function proceed(initial: SwapRecord) {
    if (!account || readPaused) await connect(); else await connectWalletReads();
    setActiveId(initial.id); tracking.current = new AbortController();
    try {
      const result = await continueSwap(wallet, store, initial, {
        signal: tracking.current.signal, onRecord: showRecord,
        onProgress: (next) => { setWorkflowProgress(next); setProgress(next.message); },
      });
      if (result.state === "complete") { setNotice("Swap complete. Your balances are updating."); setAmount(""); await refreshBalances().catch(() => setReadPaused(true)); }
      else if (result.state === "expired") useSavedDraft(savedIntent(result.record));
      else if (result.state === "review") setNotice("Wallet updated the transaction. Continue your swap below to review it.");
      else setNotice("The transaction did not complete. You can check it or try again below.");
    } catch (e) { errorRecord.current = initial.id; throw e; }
    finally { await reload().catch((e) => setError(errorText(e))); }
  }
  async function save() {
    if (!intent || expired(intent) || quoting) return;
    const selected = intent;
    if (quoteDraft.current !== currentDraft.current) return;
    const record = await store.begin(selected);
    showRecord(record);
    await proceed(record);
  }
  async function retryWithFreshQuote(record: SwapRecord) {
    if (!account || readPaused) await connect(); else await connectWalletReads();
    record = await store.get(record.id) ?? record;
    if (record.approval_request_id) record = await reconcileStep(wallet, store, record, "approval");
    record = await reconcileStep(wallet, store, record, "swap"); showRecord(record);
    const op = effectiveOperation(record, "swap"), approval = effectiveOperation(record, "approval");
    const waiting = [op, approval].some((value) => value && ["signing", "signed", "submitted", "unknown"].includes(value.status));
    if (waiting || op?.status === "confirmed") await proceed(record);
    else useSavedDraft(savedIntent(record));
  }
  const totalFee = intent?.quote.networkFees ? totalEstimatedFee(intent.quote.networkFees) : null;
  const validQuote = intent && quoteDraft.current === draftIdentity && !expired(intent, now);
  const swapButton = !account ? "Connect EVM Wallet" : readPaused ? "Reconnect wallet" : !amount || Number(amount) === 0 ? "Enter an amount" : quoting ? "Finding the best price…" : !validQuote ? "Swap unavailable" : "Swap";

  return <main className="nt-app uni-app"><div className="uni-shell">
    <header className="uni-header"><div><p className="nt-eyebrow">Uniswap</p><h1 className="nt-title">Swap tokens</h1></div>{account && !readPaused ? <span className="uni-connected" title={account.address}><span/> {short(account.address)}</span> : <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void run(connect)}>{readPaused ? "Reconnect wallet" : "Connect wallet"}</button>}</header>
    <section className="nt-panel uni-form" aria-label="Swap tokens">
      <div className="uni-form-top"><label className="uni-network"><span className="nt-sr-only">Network</span><select aria-label="Network" value={chain} disabled={busy} onChange={(e) => changeChain(e.target.value as Chain)}>{Object.entries(NETWORKS).map(([id, net]) => <option key={id} value={id}>{net.name}</option>)}</select></label><span className="uni-muted">Powered by EVM Wallet</span></div>
      <div className="uni-token-panel"><label>You pay<input aria-label="Input amount" inputMode="decimal" placeholder="0" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)}/></label><TokenPicker label="Input token" tokens={tokens} value={inputKey} disabled={busy} onChange={(value) => selectToken("input", value)}/><p className="uni-muted">Balance: {balance(tokenIn)} {tokenIn.symbol}</p></div>
      <button className="uni-direction" aria-label="Reverse tokens" title="Reverse tokens" disabled={busy} onClick={() => { setInputKey(outputKey); setOutputKey(inputKey); }}>↓</button>
      <div className="uni-token-panel uni-receive"><label>You receive<output aria-label="Output amount" aria-live="polite">{intent ? displayAmount(intent.quote.amountOut, intent.quote.tokenOut.decimals) : quoting ? "…" : "0"}</output></label><TokenPicker label="Output token" tokens={tokens} value={outputKey} disabled={busy} onChange={(value) => selectToken("output", value)}/><p className="uni-muted">Balance: {balance(tokenOut)} {tokenOut.symbol}</p></div>
      {intent && <div className="uni-quote-summary"><span>Estimated network fee</span><span>{totalFee === null ? "Reviewed in Wallet" : `${displayAmount(totalFee, 18)} ETH`}</span></div>}
      {quoteError && !busy && <div className="uni-quote-error"><p>No quote available yet.</p><details><summary>Show reason</summary><p>{quoteError}</p></details><button className="uni-text-button" onClick={() => setQuoteNonce((value) => value + 1)}>Try again</button></div>}
      {busy && <div role="status" className="uni-progress" data-testid="uniswap-progress"><span className="uni-spinner"/><div><strong>{progress || "Working…"}</strong>{workflowProgress && <p className="uni-muted">{workflowProgress.stage === "approval" ? "Token approval · swap confirmation follows automatically" : "Your tokens are swapped when this transaction confirms"}</p>}</div></div>}
      <button className="nt-button uni-primary" disabled={busy || (!!account && !readPaused && (!validQuote || quoting))} onClick={() => void run(!account || readPaused ? connect : save)}>{busy ? workflowProgress?.state === "review" ? "Confirm in EVM Wallet" : "Swap in progress…" : swapButton}</button>
      {busy && tracking.current && workflowProgress?.state === "pending" && <button className="uni-text-button" onClick={() => tracking.current?.abort()}>Pause tracking</button>}
      {intent?.approval && !busy && <p className="uni-help">Your wallet will ask for token approval, then confirm the swap.</p>}
      <details className="uni-details"><summary title="Price details, slippage, recipient and custom tokens">⚙ <span>Details & settings</span></summary><div className="uni-settings">
        {intent && <><dl><dt>Minimum received</dt><dd>{formatUnits(BigInt(intent.quote.minimumOut), tokenOut.decimals)} {tokenOut.symbol}</dd><dt>Pool fee</dt><dd>{intent.quote.fee / 10000}%</dd><dt>Price impact</dt><dd>{intent.quote.priceImpactBps === null ? "Unavailable" : `${Number(intent.quote.priceImpactBps) / 100}%`}</dd><dt>Quote age</dt><dd>{Math.max(0, Math.floor((now - intent.quote.quotedAtMs) / 1000))} seconds</dd><dt>Token access</dt><dd>{intent.approval ? `Approve exactly ${amount} ${tokenIn.symbol}; unused allowance remains until spent or revoked.` : "No new approval needed"}</dd></dl><NetworkFees fees={intent.quote.networkFees} approvalRequired={!!intent.approval} chainId={chain}/>{intent.quote.routeWarnings.map((warning) => <p className="uni-muted" key={warning}>{warning}</p>)}</>}
        <div className="uni-row"><label>Slippage %<input disabled={busy} inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)}/></label><label>Deadline · minutes<input disabled={busy} inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)}/></label></div>
        <label>Account<select value={accountId} disabled={!accounts.length || busy} onChange={(e) => setAccountId(e.target.value)}>{accounts.length ? accounts.map((value) => <option key={value.accountId} value={value.accountId}>{value.accountId} · {short(value.address)}</option>) : <option value="main">Connect EVM Wallet</option>}</select></label>
        <label>Recipient<input value={recipient} disabled={busy} spellCheck={false} onChange={(e) => setRecipient(e.target.value)} placeholder={account?.address ?? "Your connected wallet"}/></label>
        <div className="uni-contracts"><p>Pay token: <code>{tokenIn.address ?? "Native ETH"}</code></p><p>Receive token: <code>{tokenOut.address ?? "Native ETH"}</code></p></div>
        <label>Add token by contract<input value={custom} disabled={busy} spellCheck={false} onChange={(e) => setCustom(e.target.value)} placeholder="0x…"/></label><button className="nt-button nt-button--sm" disabled={busy || !account || !custom} onClick={() => void run(async () => { await connectWalletReads(); setProgress("Reading token details…"); const token = await customToken(walletReader(wallet, account!.accountId), chain, custom); setTokens((previous) => previous.some((value) => tokenKey(value) === tokenKey(token)) ? previous : [...previous, token]); setCustom(""); })}>Add token</button>
        <p className="uni-muted">Direct Uniswap V3 pools. Verify custom token addresses. Quotes can change; your minimum received and deadline are enforced on-chain.</p>
      </div></details>
    </section>
    {error && <div role="alert" className="uni-alert"><strong>We couldn't complete that step.</strong><p>Your saved swaps are below. Continue the same swap to check its status.</p><details><summary>Show details</summary><p>{error}</p></details></div>}
    {notice && <p role="status" className="uni-notice">{notice}</p>}
    <section className="uni-activity"><header><h2 className="nt-subtitle">Your swaps</h2><span className="uni-muted" title="Balances and history update automatically" aria-label="Updates automatically">↻</span></header>{!records.length && <p className="uni-empty">Your swaps will appear here.</p>}
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
            {!complete && approvalConfirmed(record) && record.approval_request_id && <p className="uni-muted">Token approved. {needsFreshQuote ? "Update the price to continue your swap." : "Continue to confirm the swap in your wallet."}</p>}
            {saved.executionMode === "agent" ? <p className="uni-muted">Managed by your agent.</p> : !complete && <button className="nt-button uni-continue" disabled={busy} onClick={() => void run(() => needsFreshQuote ? retryWithFreshQuote(record) : proceed(record))}>{activeId === record.id ? "In progress…" : needsFreshQuote ? terminal ? "Try swap again" : "Refresh swap" : "Continue swap"}</button>}
            {op?.transactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${op.transactionHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
            <details className="uni-details"><summary>Transaction details</summary><div className="uni-settings"><p>Minimum {formatUnits(BigInt(saved.quote.minimumOut), saved.quote.tokenOut.decimals)} {saved.quote.tokenOut.symbol}</p><p>Recipient <code>{saved.quote.recipient}</code></p><p>Saved status: {record.phase.replaceAll("_", " ")}</p>{op?.message && <p>{op.message}</p>}{approval?.message && <p>{approval.message}</p>}{originalApproval?.transactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${originalApproval.transactionHash}`} target="_blank" rel="noreferrer">View token approval ↗</a>}{[originalApproval?.replacementTransactionHash, originalSwap?.replacementTransactionHash].filter(Boolean).map((hash) => <a key={hash} href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${hash}`} target="_blank" rel="noreferrer">View replacement transaction ↗</a>)}<NetworkFees fees={saved.quote.networkFees} approvalRequired={!!saved.approval} chainId={saved.quote.chainId}/><pre>{JSON.stringify({ id: record.id, approvalRequest: record.approval_request_json ? JSON.parse(record.approval_request_json) : null, swapRequest: JSON.parse(record.swap_request_json) }, null, 2)}</pre></div></details>
          </article>;
        } catch (e) { return <article className="nt-panel uni-saved" key={record.id}><strong>Saved swap needs attention</strong><details><summary>Show details</summary><p>{errorText(e)}</p></details><button className="nt-button" disabled={busy} onClick={() => void run(() => proceed(record))}>Continue swap</button></article>; }
      })}{historyCursor !== null && <button className="uni-text-button" disabled={busy} onClick={() => void run(loadOlder)}>Load older swaps</button>}
    </section>
    <footer className="uni-muted">Ethereum & Arbitrum · An independent interface for Uniswap V3</footer>
  </div></main>;
}
const root = document.getElementById("root"); if (!root) throw new Error("Missing app root"); createRoot(root).render(<App/>);
