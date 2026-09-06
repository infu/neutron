import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callTool } from "neutron-tools/app";
import { createEvmWalletClient, type EvmAccount, type EvmBalancesResult } from "neutron-tools/evm_wallet";
import { formatUnits, getAddress } from "viem";
import { amountAtoms, slippageBasisPoints, customToken, defaultTokens, NETWORKS, type Chain, type Token } from "./swap.ts";
import { createIntent, createSwapStore, executeStep, reconcileStep, savedIntent, approvalConfirmed, receivedTokenAtoms, walletReader, storedOperation, effectiveOperation, type SavedIntent, type SwapRecord } from "./controller.ts";
import { estimateSwapFees, type SwapFeeEstimates } from "./fees.ts";
import { NetworkFees } from "./fee_review.tsx";
import "./style.scss";

const wallet = createEvmWalletClient({ callTool });
const store = createSwapStore();
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const tokenKey = (token: Token) => token.address?.toLowerCase() ?? "native";
function short(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }

export function App() {
  const [chain, setChain] = useState<Chain>("1");
  const [accounts, setAccounts] = useState<EvmAccount[]>([]);
  const [accountId, setAccountId] = useState("main");
  const [tokens, setTokens] = useState(defaultTokens("1"));
  const [inputKey, setInputKey] = useState("native");
  const [outputKey, setOutputKey] = useState(defaultTokens("1")[1]!.address!.toLowerCase());
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [minutes, setMinutes] = useState("20");
  const [recipient, setRecipient] = useState("");
  const [custom, setCustom] = useState("");
  const [balances, setBalances] = useState<EvmBalancesResult | null>(null);
  const [intent, setIntent] = useState<SavedIntent | null>(null);
  const [records, setRecords] = useState<SwapRecord[]>([]);
  const [refreshedFees, setRefreshedFees] = useState<Record<string, SwapFeeEstimates>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const account = accounts.find((entry) => entry.accountId === accountId);
  const tokenIn = tokens.find((token) => tokenKey(token) === inputKey)!;
  const tokenOut = tokens.find((token) => tokenKey(token) === outputKey)!;
  const draftIdentity = JSON.stringify({ chain, accountId, inputKey, outputKey, amount, recipient, slippage, minutes });
  const currentDraft = useRef(draftIdentity);
  currentDraft.current = draftIdentity;
  const balanceScope = useRef(`${chain}:${accountId}`);
  balanceScope.current = `${chain}:${accountId}`;
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  async function reload() { setRecords((await store.list()).sort((a,b) => Number(BigInt(b.created_at) - BigInt(a.created_at)))); }
  async function connect() {
    const result = await wallet.accounts(); setAccounts(result.accounts);
    const selected = result.accounts.find((entry) => entry.accountId === accountId) ?? result.accounts[0];
    if (selected) { setAccountId(selected.accountId); if (!recipient) setRecipient(selected.address); await refreshBalances(selected); }
  }
  async function refreshBalances(selected = account) {
    if (!selected) return;
    const scope = `${chain}:${selected.accountId}`;
    const result = await wallet.balances({ accountId: selected.accountId, chainId: chain, tokens: tokens.flatMap((token) => token.address ? [token.address] : []) });
    if (balanceScope.current === scope) setBalances(result);
  }
  useEffect(() => { void reload().catch((e) => setError(errorText(e))); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setIntent(null); }, [chain, accountId, inputKey, outputKey, amount, recipient, slippage, minutes]);
  useEffect(() => { setBalances(null); }, [chain, accountId]);
  function changeChain(value: Chain) { const next = defaultTokens(value); setChain(value); setTokens(next); setInputKey("native"); setOutputKey(next[1]!.address!.toLowerCase()); }
  function balance(token: Token) {
    if (!balances || balances.chainId !== token.chainId) return "—";
    if (token.address === null) return formatUnits(BigInt(balances.nativeBalanceWei), 18);
    const entry = balances.tokens.find((value) => value.address.toLowerCase() === token.address!.toLowerCase());
    return entry?.balanceAtoms === null || !entry ? "Unavailable" : formatUnits(BigInt(entry.balanceAtoms), token.decimals);
  }
  async function getQuote() {
    if (!account) throw new Error("Connect EVM Wallet first.");
    const duration = Number(minutes), bps = slippageBasisPoints(slippage);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(Math.round(duration * 60))) throw new Error("Enter a positive deadline in minutes.");
    const requestedDraft = currentDraft.current;
    const next = await createIntent(wallet, { chainId: chain, accountId: account.accountId, accountAddress: getAddress(account.address), tokenIn, tokenOut, amountIn: amountAtoms(amount, tokenIn), slippageBps: bps, recipient: getAddress(recipient), deadline: (BigInt(Math.floor(Date.now() / 1000)) + BigInt(Math.round(duration * 60))).toString() });
    next.quote = { ...next.quote, networkFees: await estimateSwapFees(wallet, next) };
    if (currentDraft.current !== requestedDraft) throw new Error("Swap inputs changed while the quote was loading. Request a new quote.");
    setIntent(next); await refreshBalances();
  }
  async function save() { if (!intent) return; const record = await store.begin(intent); setIntent(null); await reload(); await runStep(record, record.approval_request_id ? "approval" : "swap"); }
  async function runStep(record: SwapRecord, stage: "approval" | "swap") { try { await executeStep(wallet, store, record, stage); } finally { await reload(); } }
  async function reconcile(record: SwapRecord) { if (record.approval_request_id) record = await reconcileStep(wallet, store, record, "approval"); await reconcileStep(wallet, store, record, "swap"); await reload(); }
  async function refreshNetworkFees(record: SwapRecord) { const fees = await estimateSwapFees(wallet, savedIntent(record), approvalConfirmed(record)); setRefreshedFees((previous) => ({ ...previous, [record.id]: fees })); }
  return <main className="nt-app uni-app"><div className="uni-shell">
    <header className="uni-header"><div><p className="nt-eyebrow">Uniswap V3</p><h1 className="nt-title">Swap</h1><p className="uni-muted">Your EVM Wallet signs. Your tokens stay in your account.</p></div><button className="nt-button" disabled={busy} onClick={() => void run(connect)}>{account ? "Refresh wallet" : "Connect EVM Wallet"}</button></header>
    {error && <div role="alert" className="uni-alert">{error}</div>}
    <section className="nt-panel uni-form"><div className="uni-row"><label>Network<select value={chain} disabled={busy} onChange={(e) => changeChain(e.target.value as Chain)}>{Object.entries(NETWORKS).map(([id,net]) => <option key={id} value={id}>{net.name}</option>)}</select></label><label>Account<select value={accountId} disabled={!accounts.length || busy} onChange={(e) => setAccountId(e.target.value)}>{accounts.length ? accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.accountId} · {short(a.address)}</option>) : <option value="main">Connect EVM Wallet</option>}</select></label></div>
      <div className="uni-token-panel"><label>You pay<input aria-label="Input amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}/></label><select aria-label="Input token" value={inputKey} onChange={(e) => setInputKey(e.target.value)}>{tokens.map((t) => <option key={tokenKey(t)} value={tokenKey(t)}>{t.symbol}</option>)}</select><p className="uni-muted">Balance {balance(tokenIn)} {tokenIn.symbol}</p><code>{tokenIn.address ?? "Native ETH"}</code></div>
      <div className="uni-direction">↓</div>
      <div className="uni-token-panel"><label>You receive<output>{intent ? formatUnits(BigInt(intent.quote.amountOut), intent.quote.tokenOut.decimals) : "—"}</output></label><select aria-label="Output token" value={outputKey} onChange={(e) => setOutputKey(e.target.value)}>{tokens.map((t) => <option key={tokenKey(t)} value={tokenKey(t)}>{t.symbol}</option>)}</select><p className="uni-muted">Balance {balance(tokenOut)} {tokenOut.symbol}</p><code>{tokenOut.address ?? "Native ETH"}</code></div>
      <details><summary>Swap settings and custom token</summary><div className="uni-settings"><label>Recipient<input value={recipient} spellCheck={false} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…"/></label><div className="uni-row"><label>Slippage %<input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)}/></label><label>Deadline · minutes<input inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)}/></label></div><label>Custom token contract<input value={custom} spellCheck={false} onChange={(e) => setCustom(e.target.value)} placeholder="0x…"/></label><button className="nt-button" disabled={busy || !account || !custom} onClick={() => void run(async () => { const token = await customToken(walletReader(wallet, account!.accountId), chain, custom); setTokens((previous) => previous.some((t) => tokenKey(t) === tokenKey(token)) ? previous : [...previous, token]); setCustom(""); })}>Read and add token</button><p className="uni-muted">Token labels come from contracts. Verify the network and full address. Fee-on-transfer and rebasing tokens may fail standard V3 swaps.</p></div></details>
      <button className="nt-button uni-primary" disabled={busy || !account || !amount} onClick={() => void run(getQuote)}>{busy ? "Working…" : intent ? "Refresh quote" : "Get quote"}</button>
      {intent && <div className="uni-review"><dl><dt>Route</dt><dd>One V3 pool · {intent.quote.fee / 10000}% fee</dd><dt>Minimum received</dt><dd>{formatUnits(BigInt(intent.quote.minimumOut), tokenOut.decimals)} {tokenOut.symbol}</dd><dt>Price impact excluding pool fee</dt><dd>{intent.quote.priceImpactBps === null ? "Unavailable" : `${Number(intent.quote.priceImpactBps) / 100}%`}</dd><dt>Quote</dt><dd>{Math.max(0, Math.floor((now - intent.quote.quotedAtMs) / 1000))} seconds ago · block {intent.quote.blockNumber ?? "unknown"}</dd><dt>Swap gas estimate</dt><dd>{intent.quote.gasEstimate} execution gas units</dd><dt>Recipient</dt><dd><code>{recipient}</code></dd><dt>Deadline</dt><dd>{new Date(Number(intent.quote.deadline) * 1000).toLocaleString()}</dd><dt>Token allowance</dt><dd>{intent.approval ? <>Approve exactly {amount} {tokenIn.symbol} to <code>{intent.quote.router}</code>. No automatic expiry; this allowance remains until spent or revoked.</> : "No new approval needed"}</dd></dl><NetworkFees fees={intent.quote.networkFees} approvalRequired={!!intent.approval} chainId={chain}/>{intent.quote.routeWarnings.map((warning) => <p className="uni-muted" key={warning}>{warning}</p>)}{BigInt(intent.quote.deadline) <= BigInt(Math.floor(now / 1000)) && <p role="status">Quote expired · request a fresh quote.</p>}<p className="uni-muted">Quotes change with the market. The saved minimum and deadline are enforced on-chain. Refresh to update them before saving.</p><button className="nt-button uni-primary" disabled={busy || BigInt(intent.quote.deadline) <= BigInt(Math.floor(now / 1000))} onClick={() => void run(save)}>{intent.approval ? "Save swap and review approval" : "Review swap in EVM Wallet"}</button></div>}
    </section>
    <section className="uni-activity"><header><h2 className="nt-subtitle">Saved swaps</h2><button className="nt-button nt-button--sm" disabled={busy} onClick={() => void run(reload)}>Refresh history</button></header>{!records.length && <p className="uni-muted">Swaps are saved before EVM Wallet is asked to sign.</p>}{records.map((record) => { let saved: SavedIntent; try { saved = savedIntent(record); } catch (e) { return <article className="nt-panel" key={record.id}>Saved swap unavailable: {errorText(e)}</article>; } const originalSwap = storedOperation(record, "swap"); const originalApproval = storedOperation(record, "approval"); const op = effectiveOperation(record, "swap"); const approval = effectiveOperation(record, "approval"); const received = receivedTokenAtoms(record); const expired = BigInt(saved.quote.deadline) <= BigInt(Math.floor(now / 1000)); return <article className="nt-panel uni-saved" key={record.id}><div className="uni-saved-title"><strong>{formatUnits(BigInt(saved.quote.amountIn), saved.quote.tokenIn.decimals)} {saved.quote.tokenIn.symbol} → {saved.quote.tokenOut.symbol}</strong><span className="nt-tag">{NETWORKS[saved.quote.chainId as Chain].name}</span></div><p>{record.phase.replaceAll("_", " ")}{expired && !op ? " · deadline expired" : ""}</p><p className="uni-muted">Minimum {formatUnits(BigInt(saved.quote.minimumOut), saved.quote.tokenOut.decimals)} {saved.quote.tokenOut.symbol} · recipient {short(saved.quote.recipient)}</p>{originalApproval?.transactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${originalApproval.transactionHash}`} target="_blank" rel="noreferrer">Approval {short(originalApproval.transactionHash)}</a>}{originalApproval?.replacementTransactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${originalApproval.replacementTransactionHash}`} target="_blank" rel="noreferrer">Replacement approval {short(originalApproval.replacementTransactionHash)}</a>}{originalSwap?.transactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${originalSwap.transactionHash}`} target="_blank" rel="noreferrer">Swap {short(originalSwap.transactionHash)}</a>}{originalSwap?.replacementTransactionHash && <a href={`${NETWORKS[saved.quote.chainId as Chain].explorer}${originalSwap.replacementTransactionHash}`} target="_blank" rel="noreferrer">Replacement swap {short(originalSwap.replacementTransactionHash)}</a>}{approval?.source === "replacement" && <p className="uni-muted">Replacement approval: {approval.status}. {approval.message}</p>}{received !== null && <p>Receipt transfers to recipient: {formatUnits(BigInt(received), saved.quote.tokenOut.decimals)} {saved.quote.tokenOut.symbol}</p>}{op?.receipt && <p className="uni-muted">Receipt: {op.receipt.status} · {op.receipt.finality}. {saved.quote.tokenOut.address === null ? "Native output is bound to the router unwrap call; receipts do not contain native transfer logs." : ""}</p>}{op?.message && <p>{op.message}</p>}{saved.executionMode === "agent" ? <p className="uni-muted">Managed by the root agent. It calls EVM Wallet directly with these saved requests.</p> : <div className="uni-actions"><button className="nt-button nt-button--sm" disabled={busy} onClick={() => void run(() => reconcile(record))}>Check wallet status</button>{record.approval_request_id && !approvalConfirmed(record) && !expired && (!approval || ["preparing", "prepared"].includes(approval.status)) && <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void run(() => runStep(record, "approval"))}>Review exact approval</button>}{approvalConfirmed(record) && !expired && (!op || ["preparing", "prepared"].includes(op.status)) && <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void run(() => runStep(record, "swap"))}>Review swap</button>}</div>}<details><summary>Network fee estimates</summary>{!refreshedFees[record.id] && <p className="uni-muted">These estimates were saved with the original quote.</p>}<NetworkFees fees={refreshedFees[record.id] ?? saved.quote.networkFees} approvalRequired={!!saved.approval && !(refreshedFees[record.id] && approvalConfirmed(record))} chainId={saved.quote.chainId} remaining={!!refreshedFees[record.id] && approvalConfirmed(record)}/></details>{(!op || ["preparing", "prepared"].includes(op.status)) && <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void run(() => refreshNetworkFees(record))}>Refresh network fees</button>}<details><summary>Saved request details</summary><pre>{JSON.stringify({ id: record.id, approvalRequest: record.approval_request_json ? JSON.parse(record.approval_request_json) : null, swapRequest: JSON.parse(record.swap_request_json) }, null, 2)}</pre></details>{approvalConfirmed(record) && expired && !op && <p className="uni-muted">Approval is still recorded; no swap was repeated. Request a fresh quote to make a new swap. Manage remaining allowance in EVM Wallet.</p>}</article>; })}</section>
    <footer className="uni-muted">Direct V3 pools on Ethereum and Arbitrum. Quotes compare available fee tiers, not all routes or protocols. Independent interface for Uniswap contracts.</footer>
  </div></main>;
}
const root = document.getElementById("root"); if (!root) throw new Error("Missing app root"); createRoot(root).render(<App/>);
