import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatUnits, getAddress, type Address } from "viem";
import type { EvmAccount, EvmBalancesResult } from "neutron-tools/evm_wallet";
import { CHAINS, FAMILIES, poolKey, tokenKey, type ChainId, type Family, type Pool, type PoolRef, type Token, type VerifiedPool } from "./contracts.ts";
import { parseInput, type Fee, type Input, type Plan } from "./plans.ts";
import type { Result } from "./workflow.ts";
import { stable } from "./store.ts";
import { describeToken, type TokenOption } from "./tokens.ts";
import { accountBalances, accountScope, atoms, balanceFor, display, ErrorNote, invoke, liquidityDraftAmounts, message, short, Spinner, TokenMark, Usd, usePrices, useRead, useObservedAccount, wallet } from "./ui.tsx";
import "./style.scss";

type Activity = { id: string; created_at: string; result: Result; input: Input; humanOwned: boolean };
type Position = { accountAddress: Address; pool: VerifiedPool; lpBalance: string; assets: { token: Token; amount: string }[] };
const native = (chainId: ChainId): Token => ({ chainId, address: null, decimals: 18, symbol: "ETH" });
const defaultOut = (chainId: ChainId): Token => ({ chainId, address: chainId === "1" ? "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" : "0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5", decimals: 18, symbol: "crvUSD" });
const refOf = (pool: PoolRef): PoolRef => ({ chainId: pool.chainId, address: pool.address, family: pool.family });
const explorer = (chainId: ChainId) => chainId === "1" ? "https://etherscan.io" : "https://arbiscan.io";
function draft(value: string, token: Token) { try { return atoms(value, token.decimals); } catch { return null; } }

function TokenListBadge({ listed }: { listed: boolean }) {
  return <span className={`cv-token-status ${listed ? "cv-listed" : "cv-unlisted"}`}><span aria-hidden="true">{listed ? "✓" : "?"}</span> {listed ? "Listed" : "Unlisted"}</span>;
}

function TokenIdentity({ token }: { token: Token }) {
  const asset = describeToken(token);
  return <details className="cv-token-identity"><summary><TokenListBadge listed={asset.listed} /><span>{asset.address ? short(asset.address) : "Native ETH"}</span></summary>
    <div><strong>{asset.name ?? asset.symbol} · {CHAINS[asset.chainId].name}</strong>
      {asset.address && <a className="cv-contract-address" href={`${explorer(asset.chainId)}/token/${asset.address}`} target="_blank" rel="noreferrer" aria-label={`View ${asset.symbol} contract`}>{asset.address} ↗</a>}
      <p>{asset.listed ? "This address matches Neutron’s token list. Listing is not a safety rating." : "This address is not on Neutron’s token list. Anyone can copy a token’s name or symbol; check the contract with the issuer."}</p>
      {asset.sourceUrl && <a href={asset.sourceUrl} target="_blank" rel="noreferrer">Token list source ↗</a>}
    </div>
  </details>;
}

function TokenPicker({ value, select, disabled, account, onAccountChanged }: { value: Token; select: (token: Token) => void; disabled: boolean; account: EvmAccount | null; onAccountChanged: () => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [offset, setOffset] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const search = useRead(open ? `${value.chainId}:${query}:${offset}` : null, async (signal) => {
    const result = await invoke<{ tokensJson: string; nextOffset: number | null; errors: string[] }>("curve_tokens_v1", { chainId: value.chainId, query, offset }, signal);
    return { tokens: JSON.parse(result.tokensJson) as TokenOption[], next: result.nextOffset, errors: result.errors };
  }, 0, 250);
  const tokens = search.data?.tokens ?? [];
  const balances = useRead(open && tokens.length && account ? `${value.chainId}:${accountScope(account)}:${tokens.map(tokenKey).join(",")}` : null, (signal) => wallet.balances({ accountId: "main", chainId: value.chainId, tokens: tokens.flatMap((token) => token.address ? [token.address] : []) }, { signal }));
  useObservedAccount(balances.data?.address ?? null, account, onAccountChanged);
  useEffect(() => { if (open) dialog.current?.showModal(); else { dialog.current?.close(); trigger.current?.focus(); } }, [open]);
  return <><button ref={trigger} type="button" className="cv-token-button" onClick={() => { setQuery(""); setOffset(0); setOpen(true); }} disabled={disabled} aria-label={`Select token, currently ${value.symbol}`}><TokenMark token={value} /><span>{value.symbol}</span><span aria-hidden="true">⌄</span></button>
    <dialog ref={dialog} className="cv-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-label="Select a token">
      <header><h2>Select a token</h2><button type="button" className="cv-quiet" onClick={() => setOpen(false)} aria-label="Close token picker">✕</button></header>
      <input aria-label="Search tokens" placeholder="Search name or paste an address" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} autoFocus />
      <p className="cv-muted">{CHAINS[value.chainId].name} · Listed tokens first</p>
      <details className="cv-token-help"><summary>What do the labels mean?</summary><p className="cv-muted">Listed means the network and contract address match Neutron’s token list. It is not a safety rating. Unlisted tokens may be legitimate, but anyone can copy a symbol. Check their full address with the issuer. This menu is not sorted by liquidity.</p></details>
      {search.loading && <Spinner label="Finding tokens…" />}<ErrorNote error={search.error} />
      {search.data?.errors.length ? <details><summary>Some discovery data is unavailable</summary><p className="cv-muted">{search.data.errors.join(" · ")}</p></details> : null}
      <div className="cv-token-list">{tokens.map((token) => { const balance = balanceFor(balances.data, token, account); return <div key={tokenKey(token)} className="cv-token-row">
        <button type="button" className="cv-token-option" aria-label={`Select ${token.symbol}, ${token.listed ? "listed" : "unlisted"} token, ${token.address ?? "native Ether"}`} onClick={() => { const { chainId, address, symbol, decimals } = token; select({ chainId, address, symbol, decimals }); setOpen(false); }}>
          <TokenMark token={token} /><span className="cv-token-label"><span className="cv-token-heading"><strong><bdi>{token.symbol}</bdi></strong><TokenListBadge listed={token.listed} /></span><small>{token.name ?? "Unknown token · check the contract"}</small></span><span className="cv-token-balance">{balance === null ? "—" : display(balance, token.decimals, 5)}</span>
        </button>
        <div className="cv-token-address">{token.address ? <a className="cv-contract-address" href={`${explorer(token.chainId)}/token/${token.address}`} target="_blank" rel="noreferrer" aria-label={`View ${token.symbol} contract on ${CHAINS[token.chainId].name}`}>{token.address} ↗</a> : <span>Native Ether</span>}</div>
      </div>; })}</div>
      {!search.loading && search.data && !tokens.length && <p className="cv-empty">No matching assets. Try a full token address.</p>}
      <div className="cv-row">{offset > 0 && <button type="button" className="cv-quiet" onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>}{search.data?.next != null && <button type="button" className="cv-quiet" onClick={() => setOffset(search.data!.next!)}>More tokens</button>}</div>
    </dialog></>;
}

function AmountPanel({ token, value, change, output, balance, choose, disabled, label, account, onAccountChanged }: { account: EvmAccount | null; onAccountChanged: () => void; token: Token; value: string; change?: (value: string) => void; output?: boolean; balance: string | null; choose?: (token: Token) => void; disabled: boolean; label: string }) {
  const price = usePrices([token])(token), atomic = draft(value, token), asset = describeToken(token);
  return <div className={`cv-amount ${output ? "cv-receive" : ""}`}><div className="cv-row cv-muted"><span>{label}</span>{balance !== null && <span>Balance: {display(balance, token.decimals, 5)}{!output && token.address && <button type="button" className="cv-text" onClick={() => change?.(formatUnits(BigInt(balance), token.decimals))} disabled={disabled}>Max</button>}</span>}</div>
    <div className="cv-amount-main">{output ? <output aria-label={label}>{value || "0"}</output> : <input aria-label={`${label} amount`} placeholder="0" inputMode="decimal" autoComplete="off" spellCheck={false} value={value} onChange={(event) => change?.(event.target.value)} disabled={disabled} />}
      {choose ? <TokenPicker value={asset} select={choose} disabled={disabled} account={account} onAccountChanged={onAccountChanged} /> : <span className="cv-token-fixed"><TokenMark token={asset} />{asset.symbol}</span>}</div>
    <div className="cv-amount-footer"><Usd value={atomic} token={token} price={price} /><TokenIdentity token={token} /></div>
  </div>;
}

function Settings({ slippage, setSlippage, recipient, setRecipient, disabled }: { slippage: string; setSlippage: (value: string) => void; recipient: string; setRecipient: (value: string) => void; disabled: boolean }) {
  return <details className="cv-details"><summary>Settings <span>{slippage || "—"}% slippage{recipient ? " · custom recipient" : ""}</span></summary><div className="cv-settings">
    <label>Slippage tolerance (%)<input aria-label="Slippage tolerance (%)" inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value)} disabled={disabled} /></label>
    <div className="cv-row cv-presets">{["0.1", "0.5", "1"].map((value) => <button key={value} type="button" className="cv-quiet" onClick={() => setSlippage(value)} disabled={disabled}>{value}%</button>)}</div>
    <label>Receive at<input aria-label="Recipient address" placeholder="Your Ethereum Wallet" value={recipient} onChange={(event) => setRecipient(event.target.value)} disabled={disabled} /></label><p className="cv-muted">Leaving this blank sends assets to your wallet.</p>
  </div></details>;
}
function common(chainId: ChainId, slippage: string, recipient: string) {
  if (!/^\d+(?:\.\d{0,2})?$/.test(slippage) || Number(slippage) > 100) throw new Error("Enter slippage between 0 and 100%, with up to two decimal places.");
  return { chainId, slippageBps: Number(atoms(slippage, 2)), recipient: recipient.trim() ? getAddress(recipient.trim()) : null, quoteValiditySeconds: "1200" };
}

function Preview({ plan, refreshing }: { plan: Plan; refreshing: boolean }) {
  const fees = useRead(JSON.stringify(plan.steps), async (signal) => JSON.parse((await invoke<{ feesJson: string }>("curve_fees_v1", { planJson: JSON.stringify(plan) }, signal)).feesJson) as Fee[]);
  const total = fees.data?.length && fees.data.every((fee) => fee.estimate?.estimatedFeeWei != null) ? fees.data.reduce((sum, fee) => sum + BigInt(fee.estimate!.estimatedFeeWei!), 0n).toString() : null;
  const priceFor = usePrices([...plan.preview.outputs.map(({ token }) => token), native(plan.chainId)]);
  return <div className="cv-preview"><div className="cv-row"><span className="cv-muted">Estimated network fee</span><span>{fees.loading ? "Estimating…" : total === null ? "Unavailable" : `${display(total, 18, 7)} ETH`}</span></div>{total !== null && <div className="cv-right"><Usd value={total} token={native(plan.chainId)} price={priceFor(native(plan.chainId))} /></div>}
    <details className="cv-details"><summary>Quote details <span>{refreshing ? "Refreshing…" : `${plan.steps.length} wallet ${plan.steps.length === 1 ? "step" : "steps"}`}</span></summary><div className="cv-settings"><dl>
      {plan.preview.outputs.map(({ token, minimum }) => <div key={tokenKey(token)}><dt>Requested minimum {token.symbol}</dt><dd>{display(minimum ?? "0", token.decimals, 10)}<Usd value={minimum ?? null} token={token} price={priceFor(token)} /></dd></div>)}
      <div><dt>Price impact</dt><dd>{plan.preview.priceImpactBps === null ? "Not available" : `${(Number(plan.preview.priceImpactBps) / 100).toFixed(2)}%`}</dd></div><div><dt>Recipient</dt><dd title={plan.preview.recipient}>{short(plan.preview.recipient)}</dd></div><div><dt>Quote block</dt><dd>{plan.preview.blockNumber}</dd></div>
      {plan.pool && <div><dt>Pool</dt><dd><a href={`${explorer(plan.chainId)}/address/${plan.pool.address}`} target="_blank" rel="noreferrer">{plan.pool.name} ↗</a></dd></div>}
    </dl><p className="cv-muted">Quotes refresh automatically. Transactions include the requested minimum amounts and have no onchain expiry. Your wallet reviews the current amounts and fee before signing.</p>
    {fees.data?.map((fee, index) => <p className="cv-muted" key={index}>{fee.label}: {fee.estimate?.estimatedFeeWei != null ? `${display(fee.estimate.estimatedFeeWei, 18)} ETH` : fee.error || fee.estimate?.reasons.join(" · ") || "Estimate unavailable until prerequisites are met"}</p>)}<ErrorNote error={fees.error} />
    {plan.preview.warnings.length > 0 && <details><summary>Quote observations</summary>{plan.preview.warnings.map((warning, index) => <p className="cv-muted" key={index}>{warning}</p>)}</details>}
    </div></details></div>;
}

function Progress({ result, chainId, busy, humanOwned, resume, check }: { result: Result; chainId: ChainId; busy: boolean; humanOwned: boolean; resume: () => void; check: () => void }) {
  return <section className={`cv-progress cv-${result.state}`} aria-label="Transaction progress"><header className="cv-row"><strong>{result.summary}</strong><span className="cv-badge">{result.state === "complete" ? "Confirmed" : result.state === "review" ? "Review" : result.state === "stopped" ? "Stopped" : "In progress"}</span></header><p role="status">{result.message}</p>
    <ol className="cv-steps">{result.steps.map((step, index) => <li key={index}><span className={step.status === "confirmed" ? "cv-done" : ""}>{step.status === "confirmed" ? "✓" : index + 1}</span><span>{step.label}</span><small>{step.status === "queued" ? "Waiting" : step.status}</small>{step.transactionHash && <a href={`${explorer(chainId)}/tx/${step.transactionHash}`} target="_blank" rel="noreferrer" aria-label={`View ${step.label} transaction`}>↗</a>}</li>)}</ol>
    {result.state !== "complete" && <div className="cv-row">{humanOwned && result.state !== "stopped" && <button type="button" className="cv-secondary" disabled={busy} onClick={resume}>{busy ? "Following wallet…" : "Continue in wallet"}</button>}<button type="button" className="cv-quiet" disabled={busy || !humanOwned} onClick={check}>Check status</button></div>}
    {!humanOwned && result.state !== "complete" && <p className="cv-muted">Continue this operation in the Agent or app that started it.</p>}
  </section>;
}

function Swap({ chainId, balances, execute, busy, account, refresh, onAccountChanged }: { onAccountChanged: () => void; chainId: ChainId; balances: EvmBalancesResult | null; execute: (input: Input) => void; busy: boolean; account: EvmAccount | null; refresh: number }) {
  const [from, setFrom] = useState<Token>(native(chainId)), [to, setTo] = useState<Token>(defaultOut(chainId)), [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5"), [recipient, setRecipient] = useState(""), [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === "visible" && !busy) setTick((n) => n + 1); }, 30000); return () => clearInterval(timer); }, [busy]);
  const selectedBalances = useRead(account ? `${chainId}:${from.address}:${to.address}:${accountScope(account)}` : null, (signal) => wallet.balances({ accountId: "main", chainId, tokens: [from, to].flatMap((token) => token.address ? [token.address] : []).filter((token, i, all) => all.indexOf(token) === i) }, { signal }), refresh + tick);
  useObservedAccount(selectedBalances.data?.address ?? null, account, onAccountChanged);
  let input: Input | null = null, error = "";
  try { if (amount && BigInt(atoms(amount, from.decimals)) > 0n) input = parseInput({ ...common(chainId, slippage, recipient), kind: "swap", tokenIn: from.address, tokenOut: to.address, amountIn: atoms(amount, from.decimals) }); }
  catch (reason) { error = message(reason); }
  const preview = useRead(input && account && !busy ? `${accountScope(account)}:${JSON.stringify(input)}` : null, async (signal) => JSON.parse((await invoke<{ planJson: string }>("curve_quote_v1", input!, signal)).planJson) as Plan, tick, 450);
  const observedPlan = useObservedAccount(preview.data?.accountAddress ?? null, account, onAccountChanged);
  const plan = observedPlan ? preview.data : null;
  const inputBalance = balanceFor(selectedBalances.data ?? balances, from, account);
  const insufficient = input?.kind === "swap" && inputBalance !== null && BigInt(input.amountIn) > BigInt(inputBalance);
  const output = plan?.preview.outputs[0];
  return <section className="cv-editor" aria-label="Swap"><div className="cv-editor-heading"><div><h2>Swap tokens</h2><p className="cv-muted">Trade through Curve with your Ethereum Wallet.</p></div><span className="cv-badge">{CHAINS[chainId].name}</span></div>
    <AmountPanel account={account} onAccountChanged={onAccountChanged} token={from} value={amount} change={setAmount} balance={inputBalance} choose={(token) => { if (tokenKey(token) === tokenKey(to)) setTo(from); setFrom(token); }} disabled={busy} label="You pay" />
    <button type="button" className="cv-direction" aria-label="Reverse swap tokens" disabled={busy} onClick={() => { setFrom(to); setTo(from); setAmount(output ? formatUnits(BigInt(output.amount), output.token.decimals) : ""); }}>↓</button>
    <AmountPanel account={account} onAccountChanged={onAccountChanged} token={to} value={output ? formatUnits(BigInt(output.amount), output.token.decimals) : ""} output balance={balanceFor(selectedBalances.data ?? balances, to, account)} choose={(token) => { if (tokenKey(token) === tokenKey(from)) setFrom(to); setTo(token); }} disabled={busy} label="You receive" />
    <Settings {...{ slippage, setSlippage, recipient, setRecipient }} disabled={busy} />
    <ErrorNote error={error || preview.error} />{preview.loading && !plan && <Spinner label="Finding your Curve quote…" />}
    {plan && <Preview plan={plan} refreshing={preview.loading} />}
    <button type="button" className="cv-primary" disabled={busy || !account || !input || !plan || preview.loading || !!preview.error || !!insufficient || !!error} onClick={() => input && execute(input)}>{!account ? "Connect Ethereum Wallet" : busy ? "Following wallet…" : insufficient ? `Insufficient ${from.symbol}` : !amount ? "Enter an amount" : preview.loading ? "Getting quote…" : "Review swap"}</button>
    <p className="cv-help">You approve each transaction in EVM Wallet.</p><ErrorNote error={selectedBalances.error} />
  </section>;
}

function PoolEditor({ pool, close, account, busy, execute, refresh, onAccountChanged }: { onAccountChanged: () => void; pool: VerifiedPool; close: () => void; account: EvmAccount | null; busy: boolean; execute: (input: Input) => void; refresh: number }) {
  const [mode, setMode] = useState<"deposit" | "withdraw" | "withdraw_one">("deposit"), [amounts, setAmounts] = useState(pool.coins.map(() => "")), [lp, setLp] = useState("");
  const [coinIndex, setCoinIndex] = useState(0), [useNative, setUseNative] = useState(false), [slippage, setSlippage] = useState("0.5"), [recipient, setRecipient] = useState(""), [tick, setTick] = useState(0);
  const [saveMessage, setSaveMessage] = useState("");
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === "visible" && !busy) setTick((n) => n + 1); }, 30000); return () => clearInterval(timer); }, [busy]);
  const coins = pool.coins.map((token) => useNative && token.address === CHAINS[pool.chainId].weth ? native(pool.chainId) : token);
  const positionRead = useRead(account ? `${poolKey(pool)}:${accountScope(account)}` : null, async (signal) => JSON.parse((await invoke<{ positionJson: string }>("curve_position_v1", { pool: refOf(pool) }, signal)).positionJson) as Position, refresh + tick);
  const balances = useRead(account ? `${poolKey(pool)}:${accountScope(account)}:tokens` : null, (signal) => wallet.balances({ accountId: "main", chainId: pool.chainId, tokens: pool.coins.flatMap((token) => token.address ? [token.address] : []) }, { signal }), refresh + tick);
  const observedPosition = useObservedAccount(positionRead.data?.accountAddress ?? null, account, onAccountChanged);
  const position = { ...positionRead, data: observedPosition ? positionRead.data : null };
  useObservedAccount(balances.data?.address ?? null, account, onAccountChanged);
  let input: Input | null = null, error = "";
  try {
    const budget = liquidityDraftAmounts(mode, amounts, coins, lp, pool.lpDecimals);
    if (budget) input = parseInput({ ...common(pool.chainId, slippage, recipient), kind: mode, pool: refOf(pool), ...budget, coinIndex, useNative });
  } catch (reason) { error = message(reason); }
  const preview = useRead(input && account && !busy ? `${accountScope(account)}:${JSON.stringify(input)}` : null, async (signal) => JSON.parse((await invoke<{ planJson: string }>("curve_quote_v1", input!, signal)).planJson) as Plan, tick, 450);
  const observedPlan = useObservedAccount(preview.data?.accountAddress ?? null, account, onAccountChanged);
  const plan = observedPlan ? preview.data : null;
  const insufficient = input && input.kind !== "swap" && (input.kind === "deposit" ? input.amounts.some((amount, i) => { const balance = balanceFor(balances.data, coins[i]!, account); return balance !== null && BigInt(amount) > BigInt(balance); }) : position.data && BigInt(input.lpAmount) > BigInt(position.data.lpBalance));
  const prices = usePrices(plan?.preview.outputs.map(({ token }) => token) ?? []);
  return <section className="cv-editor" aria-label="Manage liquidity"><button type="button" className="cv-back" onClick={close} disabled={busy}>← All pools</button><div className="cv-editor-heading"><div><h2>{pool.name}</h2><p className="cv-muted">{coins.map((token) => token.symbol).join(" / ")}</p></div><span className="cv-badge">{CHAINS[pool.chainId].name}</span></div>
    <div className="cv-position"><span className="cv-muted">Your wallet liquidity</span><strong>{position.data ? `${display(position.data.lpBalance, pool.lpDecimals)} LP` : position.loading ? "Loading…" : "Unavailable"}</strong><p className="cv-muted">Fees accrue in your LP value. Staked LP tokens are separate.</p><ErrorNote error={position.error} /></div>
    <div className="cv-segments" aria-label="Liquidity action"><button type="button" aria-pressed={mode === "deposit"} onClick={() => setMode("deposit")} disabled={busy}>Add liquidity</button><button type="button" aria-pressed={mode !== "deposit"} onClick={() => setMode("withdraw")} disabled={busy}>Remove liquidity</button></div>
    {pool.family === "tricrypto-ng" && pool.coins.some((token) => token.address === CHAINS[pool.chainId].weth) && <label className="cv-checkbox"><input type="checkbox" checked={useNative} onChange={(event) => setUseNative(event.target.checked)} disabled={busy} />Use native ETH instead of WETH</label>}
    {mode === "deposit" ? coins.map((token, i) => <AmountPanel account={account} onAccountChanged={onAccountChanged} key={i} token={token} value={amounts[i]!} change={(value) => setAmounts((old) => old.map((amount, index) => index === i ? value : amount))} balance={balanceFor(balances.data, token, account)} disabled={busy} label={`Deposit ${token.symbol}`} />) : <>
      <label>LP tokens to remove<input aria-label="LP tokens to remove" inputMode="decimal" placeholder="0" value={lp} onChange={(event) => setLp(event.target.value)} disabled={busy} /></label>
      <div className="cv-row cv-presets">{[25, 50, 75, 100].map((percent) => <button key={percent} type="button" className="cv-quiet" disabled={busy || !position.data} onClick={() => setLp(formatUnits(BigInt(position.data!.lpBalance) * BigInt(percent) / 100n, pool.lpDecimals))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}</div>
      <label>Receive<select aria-label="Withdrawal assets" value={mode === "withdraw" ? "all" : String(coinIndex)} onChange={(event) => { if (event.target.value === "all") setMode("withdraw"); else { setMode("withdraw_one"); setCoinIndex(Number(event.target.value)); } }} disabled={busy}><option value="all">All pool assets (proportional)</option>{coins.map((token, i) => <option key={i} value={i}>{token.symbol} only</option>)}</select></label>
    </>}
    <Settings {...{ slippage, setSlippage, recipient, setRecipient }} disabled={busy} /><ErrorNote error={error || preview.error || balances.error} />
    {preview.loading && !plan && <Spinner label="Calculating liquidity…" />}
    {plan && <><div className="cv-output-list"><span className="cv-muted">You receive · estimated</span>{plan.preview.outputs.map(({ token, amount }) => <div key={tokenKey(token)}><strong>{display(amount, token.decimals)} {token.symbol}</strong><Usd value={amount} token={token} price={prices(token)} /></div>)}</div><Preview plan={plan} refreshing={preview.loading} /></>}
    <button type="button" className="cv-primary" disabled={busy || !account || !input || !!error || !!insufficient || !plan || preview.loading || !!preview.error} onClick={() => input && execute(input)}>{busy ? "Following wallet…" : insufficient ? "Insufficient balance" : !input ? "Enter an amount" : preview.loading ? "Getting quote…" : mode === "deposit" ? "Review deposit" : "Review withdrawal"}</button>
    <details className="cv-details"><summary>Pool details</summary><div className="cv-settings"><dl><div><dt>Pool contract</dt><dd><a href={`${explorer(pool.chainId)}/address/${pool.address}`} target="_blank" rel="noreferrer">{pool.address} ↗</a></dd></div><div><dt>LP token</dt><dd>{pool.lpToken}</dd></div><div><dt>Pool type</dt><dd>{pool.family}</dd></div><div><dt>Verified block</dt><dd>{pool.blockNumber}</dd></div></dl>{pool.family === "stable-meta-ng" && <p className="cv-muted">This metapool uses its pool coins, including the base pool LP token. Underlying asset zaps are not included.</p>}<button type="button" className="cv-secondary" onClick={() => { void invoke("curve_track_pool_v1", { pool: refOf(pool) }).then(() => setSaveMessage("Pool saved in My pools."), (error) => setSaveMessage(message(error))); }}>Save to My pools</button><p role="status" className="cv-muted">{saveMessage}</p></div></details>
  </section>;
}

function Pools({ chainId, account, busy, execute, refresh, onAccountChanged }: { onAccountChanged: () => void; chainId: ChainId; account: EvmAccount | null; busy: boolean; execute: (input: Input) => void; refresh: number }) {
  const [query, setQuery] = useState(""), [offset, setOffset] = useState(0), [savedOnly, setSavedOnly] = useState(false), [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<PoolRef | null>(null), [address, setAddress] = useState(""), [family, setFamily] = useState<Family>("stable-ng"), [importError, setImportError] = useState("");
  const catalog = useRead(`${chainId}:${query}:${offset}:${savedOnly}`, async (signal) => {
    if (savedOnly) {
      const saved = JSON.parse((await invoke<{ poolsJson: string }>("curve_tracked_pools_v1", { chainId }, signal)).poolsJson) as PoolRef[];
      const results = await Promise.allSettled(saved.map(async (pool) => JSON.parse((await invoke<{ poolJson: string }>("curve_pool_v1", { pool }, signal)).poolJson) as Pool));
      return { pools: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []).filter((pool) => `${pool.name} ${pool.address} ${pool.coins.map((token) => token.symbol).join(" ")}`.toLowerCase().includes(query.toLowerCase())), next: null, errors: results.flatMap((result) => result.status === "rejected" ? [message(result.reason)] : []), total: saved.length };
    }
    const result = await invoke<{ poolsJson: string; nextOffset: number | null; total: number; errors: string[] }>("curve_pools_v1", { chainId, query, offset, refresh: tick > 0 }, signal);
    return { pools: JSON.parse(result.poolsJson) as Pool[], next: result.nextOffset, errors: result.errors, total: result.total };
  }, refresh + tick, 250);
  const pool = useRead(selected ? poolKey(selected) : null, async (signal) => JSON.parse((await invoke<{ poolJson: string }>("curve_pool_v1", { pool: selected }, signal)).poolJson) as VerifiedPool);
  if (selected) return pool.data ? <PoolEditor key={poolKey(pool.data)} pool={pool.data} close={() => setSelected(null)} {...{ account, busy, execute, refresh, onAccountChanged }} /> : <section className="cv-editor"><button type="button" className="cv-back" onClick={() => setSelected(null)}>← All pools</button>{pool.loading && <Spinner label="Verifying pool and reading your liquidity…" />}<ErrorNote error={pool.error} /></section>;
  return <section className="cv-pools" aria-label="Liquidity pools"><div className="cv-editor-heading"><div><h2>Put your tokens to work</h2><p className="cv-muted">Add liquidity and earn a share of pool trading fees.</p></div><button type="button" className="cv-quiet" onClick={() => setTick((n) => n + 1)} aria-label="Refresh pools">↻</button></div>
    <div className="cv-segments"><button type="button" aria-pressed={!savedOnly} onClick={() => { setSavedOnly(false); setOffset(0); }}>Explore pools</button><button type="button" aria-pressed={savedOnly} onClick={() => { setSavedOnly(true); setOffset(0); }}>My pools</button></div>
    <input aria-label="Search pools" placeholder="Search tokens, pool name or address" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} />
    {savedOnly && <p className="cv-muted">Pools you save or use appear here. Import an existing pool to check liquidity held in your wallet.</p>}
    <ErrorNote error={catalog.error} />{catalog.data?.errors.length ? <details open><summary>Some pools could not be loaded</summary>{catalog.data.errors.map((error, i) => <p className="cv-muted" key={i}>{error}</p>)}</details> : null}
    {catalog.loading && <Spinner label="Loading Curve pools…" />}
    <div className="cv-pool-list">{catalog.data?.pools.map((pool) => <button type="button" key={poolKey(pool)} className="cv-pool-row" onClick={() => setSelected(refOf(pool))}><span className="cv-pool-assets">{pool.coins.slice(0, 3).map((token, i) => <TokenMark token={token} key={i} />)}</span><span className="cv-pool-name"><strong>{pool.name}</strong><small>{pool.coins.map((token) => token.symbol).join(" · ")}</small><small>{pool.family.replaceAll("-", " ")}</small></span><span className="cv-pool-value" title="Pool liquidity observed by the Curve API; this is not your balance.">{pool.tvlUsd === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(pool.tvlUsd)}<small>Pool liquidity</small></span><span aria-hidden="true">›</span></button>)}</div>
    {!catalog.loading && catalog.data && !catalog.data.pools.length && <div className="cv-empty"><h3>{savedOnly ? "Your liquidity starts here" : "No matching pools"}</h3><p>{savedOnly ? "Explore a pool to add liquidity, or import one you already use." : "Try another token name or import a supported pool by address."}</p></div>}
    <div className="cv-row">{offset > 0 && <button type="button" className="cv-quiet" onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button>}{catalog.data?.next != null && <button type="button" className="cv-secondary" onClick={() => setOffset(catalog.data!.next!)}>More pools</button>}</div>
    <details className="cv-details"><summary>Import a pool</summary><div className="cv-settings"><label>Pool address<input aria-label="Pool address" placeholder="0x…" value={address} onChange={(event) => setAddress(event.target.value)} /></label><label>Pool type<select aria-label="Pool type" value={family} onChange={(event) => setFamily(event.target.value as Family)}>{FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}</select></label><button type="button" className="cv-secondary" onClick={() => { try { setSelected({ chainId, address: getAddress(address.trim()), family }); setImportError(""); } catch { setImportError("Enter a valid pool address on this network."); } }}>Open pool</button><ErrorNote error={importError} /></div></details>
  </section>;
}

function App() {
  const [chainId, setChainId] = useState<ChainId>("1"), [tab, setTab] = useState<"swap" | "pools" | "activity">("swap"), [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [active, setActive] = useState<{ result: Result; input: Input; humanOwned: boolean } | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const executing = useRef(false), executionScope = useRef(0);
  const onAccountChanged = () => setRefresh((value) => value + 1);
  const accountRead = useRead("main", async (signal) => (await wallet.accounts({ signal })).accounts.find((account) => account.accountId === "main") ?? null, refresh);
  const account = accountRead.data;
  const balances = useRead(account ? `${chainId}:${accountScope(account)}` : null, (signal) => wallet.balances({ accountId: "main", chainId, tokens: [] }, { signal }), refresh);
  useObservedAccount(balances.data?.address ?? null, account, onAccountChanged);
  const walletBalances = accountBalances(balances.data, account);
  const [history, setHistory] = useState<Activity[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [historyError, setHistoryError] = useState(""), [historyLoading, setHistoryLoading] = useState(false);
  const historyScope = useRef(0);
  async function loadHistory(cursor: string | null = null) {
    const sequence = ++historyScope.current, execution = executionScope.current;
    setHistoryLoading(true); setHistoryError("");
    try {
      const response = await invoke<{ rowsJson: string; nextCursor: string | null }>("curve_history_v1", { cursor });
      if (sequence !== historyScope.current) return;
      const rows = JSON.parse(response.rowsJson) as Activity[];
      if (!executing.current && execution === executionScope.current) setActive((old) => {
        if (!old || executing.current || execution !== executionScope.current) return old;
        const current = rows.find((row) => row.result.operationId === old.result.operationId);
        return current ? { result: current.result, input: current.input, humanOwned: current.humanOwned } : old;
      });
      setHistory((old) => cursor ? [...old, ...rows.filter((row) => !old.some((existing) => existing.id === row.id))] : rows); setNextCursor(response.nextCursor);
    } catch (error) { if (sequence === historyScope.current) setHistoryError(message(error)); }
    finally { if (sequence === historyScope.current) setHistoryLoading(false); }
  }
  useEffect(() => { void loadHistory(); }, [refresh]);
  useEffect(() => {
    if (!busy || !active) return;
    let alive = true;
    const execution = executionScope.current;
    const timer = setInterval(() => { void invoke<{ result: Result | null }>("curve_status_v1", { operationId: active.result.operationId }).then(({ result }) => { if (alive && executing.current && execution === executionScope.current && result) setActive((old) => old && old.result.operationId === result.operationId ? { ...old, result } : old); }).catch(() => {}); }, 1800);
    return () => { alive = false; clearInterval(timer); };
  }, [busy, active?.result.operationId]);
  async function execute(input: Input, existing?: Result, check = false) {
    if (executing.current) return;
    executing.current = true; executionScope.current++;
    const retained = activeRef.current;
    if (!existing && retained?.humanOwned && ["pending", "review"].includes(retained.result.state) && stable(retained.input) === stable(input)) existing = retained.result;
    const id = existing?.operationId ?? crypto.randomUUID().replaceAll("-", "");
    const initial: Result = existing ?? { operationId: id, recordId: null, summary: input.kind === "swap" ? "Preparing your swap" : "Preparing liquidity", state: "pending", phase: "preparing", transactionHash: null, steps: [], message: "Checking your quote and saving the transaction steps…" };
    setBusy(true); setError(""); setActive({ result: initial, input, humanOwned: true });
    try {
      const result = await invoke<Result>(check ? "curve_reconcile_v1" : existing?.recordId ? "curve_continue_v1" : "curve_execute_v1", check || existing?.recordId ? { operationId: id } : { ...input, operationId: id });
      setActive({ result, input, humanOwned: true });
    } catch (error) {
      setError(message(error));
      // A lost tool reply retains the same original ID and inputs. Read the
      // journal before deciding whether this is a fresh or saved continuation.
      try { const saved = await invoke<{ result: Result | null }>("curve_status_v1", { operationId: id }); if (saved.result) setActive({ result: saved.result, input, humanOwned: true }); } catch { /* Keep ambiguous original intent visible. */ }
    } finally { executing.current = false; executionScope.current++; setBusy(false); setRefresh((value) => value + 1); }
  }
  const visible = history.filter((row) => row.input.chainId === chainId), pending = visible.filter((row) => row.result.state !== "complete" && row.result.state !== "stopped");
  return <main className="nt-app cv-app"><div className={`cv-shell ${tab === "pools" ? "cv-shell-wide" : ""}`}>
    <header className="cv-header"><div className="cv-brand"><img src="static/icon.svg" alt="" /><div><h1>Curve</h1><span>Swaps & liquidity</span></div></div><label className="cv-network"><span className="nt-sr-only">Network</span><select aria-label="Network" value={chainId} disabled={busy} onChange={(event) => { setChainId(event.target.value as ChainId); setActive(null); setError(""); }}>{Object.entries(CHAINS).map(([id, chain]) => <option key={id} value={id}>{chain.name}</option>)}</select></label></header>
    <div className="cv-wallet"><span className="cv-wallet-dot" /><span>{account ? short(account.address) : accountRead.loading ? "Connecting to EVM Wallet…" : "Ethereum Wallet unavailable"}</span><span className="cv-right">{walletBalances ? `${display(walletBalances.nativeBalanceWei, 18, 5)} ETH` : "—"}</span><button type="button" className="cv-text" aria-label="Refresh wallet" onClick={() => setRefresh((value) => value + 1)} disabled={busy}>↻</button></div>
    <ErrorNote error={accountRead.error || balances.error} />
    {!account && !accountRead.loading && <p className="cv-muted">Install and open EVM Wallet to connect your Ethereum account, then refresh this view.</p>}
    <nav className="cv-tabs" aria-label="Curve sections">{(["swap", "pools", "activity"] as const).map((value) => <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{value === "swap" ? "Swap" : value === "pools" ? "Liquidity" : `Activity${pending.length ? ` · ${pending.length}` : ""}`}</button>)}</nav>
    {tab === "swap" && <Swap key={chainId} {...{ chainId, account, busy, refresh, onAccountChanged }} balances={balances.data} execute={(input) => { void execute(input); }} />}
    {tab === "pools" && <Pools key={chainId} {...{ chainId, account, busy, refresh, onAccountChanged }} execute={(input) => { void execute(input); }} />}
    <ErrorNote error={error} />
    {active && tab !== "activity" && <Progress result={active.result} chainId={active.input.chainId} busy={busy} humanOwned={active.humanOwned} resume={() => { void execute(active.input, active.result); }} check={() => { void execute(active.input, active.result, true); }} />}
    {tab !== "activity" && !active && pending.length > 0 && <button type="button" className="cv-resume-banner" onClick={() => setTab("activity")}>{pending.length} saved {pending.length === 1 ? "operation needs" : "operations need"} attention <span>View activity →</span></button>}
    {tab === "activity" && <section className="cv-activity" aria-label="Activity"><div className="cv-editor-heading"><div><h2>Your activity</h2><p className="cv-muted">Saved swaps and liquidity on {CHAINS[chainId].name}.</p></div><button type="button" className="cv-quiet" onClick={() => { void loadHistory(); }}>Refresh</button></div><ErrorNote error={historyError} />{visible.map((row) => <Progress key={row.id} result={active?.result.operationId === row.id ? active.result : row.result} chainId={row.input.chainId} busy={busy} humanOwned={row.humanOwned} resume={() => { void execute(row.input, row.result); }} check={() => { void execute(row.input, row.result, true); }} />)}{historyLoading && <Spinner label="Reading saved activity…" />}{!historyLoading && !visible.length && <div className="cv-empty"><span className="cv-empty-symbol">↔</span><h3>No activity yet</h3><p>Your swaps and liquidity transactions will appear here, with progress saved along the way.</p></div>}{nextCursor && <button type="button" className="cv-secondary" onClick={() => { void loadHistory(nextCursor); }} disabled={historyLoading}>Load older activity</button>}</section>}
    <footer>Powered by Curve · Signed with your EVM Wallet</footer>
  </div></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
