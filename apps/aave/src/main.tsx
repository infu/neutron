import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { formatUnits } from "viem";
import { CHAINS, tokenKey, type AccountPosition, type ChainId, type Market, type Reserve, type Token } from "./contracts.ts";
import { collateralParameters, inBitmap, parseInput, type Fee, type Input, type Plan } from "./plans.ts";
import type { Result } from "./workflow.ts";
import { stable } from "./store.ts";
import { AssetMark, atoms, display, ErrorNote, explorer, invoke, message, money, percent, short, Spinner, useRead, wallet } from "./ui.tsx";
import "./style.scss";

type ActionKind = "supply" | "withdraw" | "borrow" | "repay";
type Selection = { kind: ActionKind | "collateral"; reserve: Reserve } | { kind: "emode" | "rewards"; reserve?: never };
type Activity = { id: string; created_at: string; input: Input; result: Result; humanOwned: boolean };
type Execution = { input: Input; result: Result; humanOwned: boolean };
const apy = (value: number | null) => percent(value === null ? null : value * 100);
const actionName = (kind: string) => kind === "repay_atokens" ? "Repay" : kind.charAt(0).toUpperCase() + kind.slice(1);
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const usdBase = (market: Market, amount: string) => Number(amount) / Number(market.baseCurrencyUnit) * Number(market.baseCurrencyUsd);
const usdAsset = (market: Market, asset: Reserve, amount: string) => BigInt(asset.priceBase) === 0n && BigInt(amount) !== 0n ? NaN : Number(formatUnits(BigInt(amount), asset.decimals)) * usdBase(market, asset.priceBase);
function borrowingEnabled(market: Market, asset: Reserve): boolean {
  const mode = market.eModes.find((category) => category.id === market.account.eModeId);
  return mode ? inBitmap(mode.borrowableBitmap, asset.id) : asset.borrowingEnabled;
}
function hf(value: string | null): string {
  if (value === null) return "∞";
  const amount = BigInt(value);
  // Two-decimal rounding must not present a liquidatable position as 1.00.
  if (amount < 10n ** 18n && amount >= 995n * 10n ** 15n) return "< 1.00";
  return Number(formatUnits(amount, 18)).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
function danger(value: string | null): boolean { return value !== null && BigInt(value) < 10n ** 18n; }
function baseInput(chainId: ChainId, kind: Input["kind"], asset: Token["address"] | null = null): Input {
  return { kind, chainId, asset, amount: "0", all: false, useNative: false, maxPaymentAmount: null, collateralEnabled: false, eModeId: 0, quoteValiditySeconds: "1200" };
}
async function readQuote(input: Input, market: Market, signal: AbortSignal): Promise<Plan> {
  const plan = JSON.parse((await invoke<{ planJson: string }>("aave_quote_v1", input, signal)).planJson) as Plan;
  if (plan.chainId !== market.chainId || plan.accountAddress.toLowerCase() !== market.accountAddress.toLowerCase()) throw new Error("Your wallet account changed. Refresh your position before reviewing this action.");
  return plan;
}
function availableBorrow(market: Market, asset: Reserve): string | null {
  if (BigInt(asset.priceBase) === 0n || market.reserves.some((reserve) => BigInt(reserve.priceBase) === 0n && (BigInt(reserve.supplied) > 0n || BigInt(reserve.variableDebt) > 0n))) return null;
  const accountAmount = BigInt(market.account.availableBorrowsBase) * 10n ** BigInt(asset.decimals) / BigInt(asset.priceBase);
  const cap = BigInt(asset.borrowCap) * 10n ** BigInt(asset.decimals) - BigInt(asset.totalDebt);
  return min(accountAmount, BigInt(asset.availableLiquidity), BigInt(asset.borrowCap) > 0n ? cap > 0n ? cap : 0n : BigInt(asset.availableLiquidity)).toString();
}

function Asset({ asset, secondary = true }: { asset: Token; secondary?: boolean }) {
  return <span className="av-asset"><AssetMark symbol={asset.symbol} address={asset.address} /><span className="av-asset-copy"><strong><bdi>{asset.symbol}</bdi></strong>{secondary && <small>{asset.name}</small>}</span></span>;
}
function Identity({ asset }: { asset: Token }) {
  return <details className="av-contract-details"><summary>{CHAINS[asset.chainId].name} · {short(asset.address)} · Reserve address</summary><div><p className="av-muted">This exact contract is listed in this Aave market. A market listing is not a safety rating.</p><a className="av-contract-address" href={`${explorer(asset.chainId)}/token/${asset.address}`} target="_blank" rel="noreferrer">{asset.address} ↗</a></div></details>;
}
function Health({ account, unpriced }: { account: AccountPosition; unpriced: boolean }) {
  return <div className="av-health"><div className="av-health-heading"><span>Health factor</span><strong className={`av-health-value ${danger(account.healthFactor) ? "av-warning" : ""}`}>{unpriced ? "Unavailable" : hf(account.healthFactor)}</strong></div><p>{unpriced ? "One or more position assets have no current oracle price. Refresh to revalue your position." : account.healthFactor === null ? "No debt. Your supplied assets are not securing a loan." : "Your collateral can be liquidated if health factor falls below 1."}</p><details><summary>How health factor works</summary><p>Collateral value, liquidation thresholds and debt determine this ratio. Prices and interest change it over time. A higher number gives more room before liquidation; a number above 1 does not remove that risk.</p></details></div>;
}
function HealthChange({ before, after, unpriced }: { before: AccountPosition; after: AccountPosition; unpriced: boolean }) {
  return <div className="av-health-change"><div className="av-row"><span>Health factor after</span><span><strong className={danger(before.healthFactor) ? "av-warning" : ""}>{unpriced ? "—" : hf(before.healthFactor)}</strong><span className="av-arrow" aria-hidden="true">→</span><strong className={danger(after.healthFactor) ? "av-warning" : ""}>{unpriced ? "—" : hf(after.healthFactor)}</strong></span></div><p>{unpriced ? "Health factor and borrowing capacity are unavailable because a position asset has no current oracle price. Refresh to revalue your position." : after.healthFactor === null ? "No debt after this action." : "Liquidation is possible below 1. This estimate uses current oracle prices; prices and accrued interest can change before execution."}</p></div>;
}
function Dialog({ title, subtitle, close, children, footer }: { title: string; subtitle?: string; close: () => void; children: ReactNode; footer: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = dialog.current; target?.showModal();
    return () => { target?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="av-dialog" aria-label={title} onCancel={close} onClose={close}><div className="av-dialog-layout"><header><div><h2>{title}</h2>{subtitle && <p className="av-muted">{subtitle}</p>}</div><button type="button" className="av-quiet av-close" aria-label="Close dialog" onClick={close}>×</button></header><div className="av-dialog-content av-stack">{children}</div><footer className="av-dialog-actions">{footer}</footer></div></dialog>;
}
function Preview({ plan, market, refreshing }: { plan: Plan; market: Market; refreshing: boolean }) {
  const fees = useRead(JSON.stringify(plan.steps), async (signal) => JSON.parse((await invoke<{ feesJson: string }>("aave_fees_v1", { planJson: JSON.stringify(plan) }, signal)).feesJson) as Fee[]);
  const total = fees.data?.length && fees.data.every((fee) => fee.estimate?.estimatedFeeWei != null) ? fees.data.reduce((sum, fee) => sum + BigInt(fee.estimate!.estimatedFeeWei!), 0n).toString() : null;
  const reserve = plan.preview.reserve;
  const unpriced = market.reserves.some((asset) => BigInt(asset.priceBase) === 0n && (BigInt(asset.supplied) > 0n || BigInt(asset.variableDebt) > 0n)) || !!reserve && BigInt(reserve.priceBase) === 0n && BigInt(plan.preview.amount) > 0n;
  const parameters = reserve ? collateralParameters(reserve, market.eModes.find((mode) => mode.id === plan.preview.after.eModeId)) : null;
  const weth = market.reserves.find((asset) => asset.address.toLowerCase() === CHAINS[market.chainId].weth.toLowerCase());
  return <div className="av-preview" aria-label="Transaction preview"><HealthChange before={plan.preview.before} after={plan.preview.after} unpriced={unpriced} /><dl><div><dt>Available to borrow after</dt><dd>{unpriced ? "Unavailable" : money(usdBase(market, plan.preview.after.availableBorrowsBase))}</dd></div><div><dt>Estimated network fee</dt><dd>{fees.loading ? "Estimating…" : total === null ? "Unavailable" : `${display(total, 18, 7)} ETH`}{total !== null && weth && <small>{money(usdAsset(market, weth, total))}</small>}</dd></div></dl>
    {plan.preview.warnings.map((warning, index) => <p key={index} className="av-notice">{warning}</p>)}
    <details className="av-details"><summary>Transaction details · {plan.steps.length} wallet {plan.steps.length === 1 ? "step" : "steps"}{refreshing ? " · Refreshing" : ""}</summary><div className="av-stack"><dl>
      {plan.preview.inputs.map(({ token, amount }, index) => <div key={`in-${index}`}><dt>You provide</dt><dd>{display(amount, token.decimals, 9)} {token.symbol}</dd></div>)}
      {plan.preview.outputs.map(({ token, amount }, index) => <div key={`out-${index}`}><dt>You receive</dt><dd>{display(amount, token.decimals, 9)} {token.symbol}</dd></div>)}
      {parameters && <><div><dt>Asset loan-to-value</dt><dd>{percent(parameters.ltvBps / 100)}</dd></div><div><dt>Asset liquidation threshold</dt><dd>{percent(parameters.liquidationThresholdBps / 100)}</dd></div></>}
      <div><dt>Network</dt><dd>{CHAINS[market.chainId].marketName}</dd></div><div><dt>Your wallet</dt><dd><a href={`${explorer(market.chainId)}/address/${market.accountAddress}`} target="_blank" rel="noreferrer">{short(market.accountAddress)} ↗</a></dd></div><div><dt>Aave pool</dt><dd><a href={`${explorer(market.chainId)}/address/${market.pool}`} target="_blank" rel="noreferrer">{short(market.pool)} ↗</a></dd></div><div><dt>Observed block</dt><dd>{plan.preview.blockNumber}</dd></div>
    </dl><ol className="av-steps">{plan.steps.map((step, index) => <li key={index}><span>{index + 1}</span><span>{step.label}</span><small>{fees.data?.[index]?.estimate?.estimatedFeeWei != null ? `${display(fees.data[index]!.estimate!.estimatedFeeWei!, 18)} ETH` : "Fee pending"}</small></li>)}</ol>
      {fees.data?.some((fee) => fee.error || fee.estimate?.status !== "available") && <p className="av-muted">Some fees can only be estimated after the earlier approval is confirmed. EVM Wallet shows the current fee before each signature.</p>}
      <p className="av-muted">The liquidation threshold is the collateral value percentage used to assess liquidation. Borrowing capacity uses a separate loan-to-value ratio. E-mode can change these values.</p><ErrorNote error={fees.error} />
    </div></details></div>;
}

function ActionDialog({ selection, market, nativeBalance, busy, execute, close, refresh }: { selection: Selection & { kind: ActionKind }; market: Market; nativeBalance: string | null; busy: boolean; execute: (input: Input) => void; close: () => void; refresh: number }) {
  const asset = selection.reserve, title = actionName(selection.kind), kind = selection.kind;
  const [amount, setAmount] = useState(""), [useNative, setUseNative] = useState(false), [useATokens, setUseATokens] = useState(false), [all, setAll] = useState(false), [maximum, setMaximum] = useState("");
  const nativeAvailable = asset.address.toLowerCase() === CHAINS[market.chainId].weth.toLowerCase();
  const walletBalance = useNative ? nativeBalance : asset.walletBalance;
  const available = kind === "supply" ? walletBalance : kind === "withdraw" ? min(BigInt(asset.supplied), BigInt(asset.availableLiquidity)).toString() : kind === "borrow" ? availableBorrow(market, asset) : useATokens ? min(BigInt(asset.supplied), BigInt(asset.variableDebt)).toString() : walletBalance === null ? null : min(BigInt(walletBalance), BigInt(asset.variableDebt)).toString();
  const symbol = useNative ? "ETH" : asset.symbol;
  const capRequired = all && ((kind === "repay" && !useATokens) || (kind === "withdraw" && useNative));
  const [tick, setTick] = useState(0), [maxLoading, setMaxLoading] = useState(false), [maxError, setMaxError] = useState("");
  const maxRequest = useRef<AbortController | null>(null);
  const maxScope = stable({ account: market.accountAddress, chainId: market.chainId, asset: asset.address, kind, useNative, useATokens, amount, all, maximum, nativeBalance, debt: asset.variableDebt, block: market.blockNumber });
  const currentMaxScope = useRef(maxScope); currentMaxScope.current = maxScope;
  useEffect(() => { setMaxError(""); return () => { maxRequest.current?.abort(); }; }, [maxScope]);
  useEffect(() => { const timer = setInterval(() => { if (!busy && document.visibilityState === "visible") setTick((value) => value + 1); }, 30000); return () => clearInterval(timer); }, [busy]);
  function chooseAll(enabled: boolean) {
    setAll(enabled);
    if (enabled) {
      const value = kind === "withdraw" ? asset.supplied : useATokens ? min(BigInt(asset.supplied), BigInt(asset.variableDebt)).toString() : asset.variableDebt;
      setAmount(formatUnits(BigInt(value), asset.decimals));
      setMaximum(formatUnits((BigInt(value) * 1001n + 999n) / 1000n, asset.decimals));
    }
  }
  let input: Input | null = null, error = "";
  try {
    if (amount && BigInt(atoms(amount, asset.decimals)) > 0n) input = parseInput({ ...baseInput(market.chainId, useATokens ? "repay_atokens" : kind, asset.address), amount: atoms(amount, asset.decimals), all, useNative, maxPaymentAmount: capRequired && maximum ? atoms(maximum, asset.decimals) : null });
  } catch (reason) { error = message(reason); }
  const inputKey = input ? stable(input) : null;
  const quote = useRead(input && !busy ? `${market.accountAddress}:${inputKey}` : null, (signal) => readQuote(input!, market, signal), tick + refresh, 350);
  async function chooseMax() {
    if (available === null || maxRequest.current) return;
    if (!useNative || useATokens || (kind !== "supply" && kind !== "repay")) {
      setAmount(formatUnits(BigInt(available), asset.decimals)); setAll(false); return;
    }
    const controller = new AbortController(), scope = currentMaxScope.current;
    maxRequest.current = controller; setMaxLoading(true); setMaxError("");
    try {
      const balance = BigInt(nativeBalance!);
      const candidate = kind === "repay" ? min(balance, BigInt(asset.variableDebt)) : balance;
      if (candidate === 0n) throw new Error("No ETH is available for this payment.");
      const candidateInput = parseInput({ ...baseInput(market.chainId, kind, asset.address), amount: candidate.toString(), useNative: true });
      const plan = quote.data && !quote.loading && !quote.error && stable(candidateInput) === inputKey ? quote.data : await readQuote(candidateInput, market, controller.signal);
      const fees = JSON.parse((await invoke<{ feesJson: string }>("aave_fees_v1", { planJson: JSON.stringify(plan) }, controller.signal)).feesJson) as Fee[];
      if (fees.length !== plan.steps.length || fees.some((fee) => fee.estimate?.status !== "available" || fee.estimate.maximumFeeWei === null)) throw new Error("A current network fee could not be estimated.");
      const maximumFee = fees.reduce((total, fee) => total + BigInt(fee.estimate!.maximumFeeWei!), 0n);
      if (balance <= maximumFee) throw new Error("No ETH remains after the observed network fee.");
      const maximumAmount = kind === "repay" ? min(balance - maximumFee, BigInt(asset.variableDebt)) : balance - maximumFee;
      controller.signal.throwIfAborted();
      if (currentMaxScope.current !== scope) return;
      setAmount(formatUnits(maximumAmount, asset.decimals)); setAll(false);
    } catch (error) {
      if (!controller.signal.aborted && currentMaxScope.current === scope) setMaxError(`Max unavailable. ${message(error)}`);
    } finally {
      if (maxRequest.current === controller) { maxRequest.current = null; setMaxLoading(false); }
    }
  }
  const amountUsd = (() => { try { return amount ? usdAsset(market, asset, atoms(amount, asset.decimals)) : null; } catch { return null; } })();
  const canSubmit = !busy && !!input && !!quote.data && !quote.loading && !quote.error && !error;
  return <Dialog title={`${title} ${asset.symbol}`} subtitle={`${CHAINS[market.chainId].marketName} · Aave V3`} close={close} footer={<><button type="button" className="av-primary" disabled={!canSubmit} onClick={() => { if (input && canSubmit) { execute(input); close(); } }}>{busy ? "Following wallet…" : quote.loading ? "Checking position…" : !amount ? "Enter an amount" : `Review ${kind}`}</button><p className="av-help">You review and sign each transaction in EVM Wallet.</p></>}>
    {kind === "borrow" && <p className="av-muted">Borrow against your supplied collateral. Interest accrues at a variable rate until you repay.</p>}
    <div className="av-amount"><div className="av-row"><span>{kind === "borrow" ? "Amount to borrow" : kind === "withdraw" ? "Amount to withdraw" : kind === "repay" ? "Amount to repay" : "Amount to supply"}</span><span>{all ? "Full balance" : "Amount"}</span></div><div className="av-amount-main"><input aria-label={`${title} amount`} placeholder="0" inputMode="decimal" autoComplete="off" spellCheck={false} autoFocus value={amount} onChange={(event) => { setAmount(event.target.value); setAll(false); }} disabled={busy} /><span className="av-asset"><AssetMark symbol={symbol} address={asset.address} /><strong>{symbol}</strong></span></div><div className="av-row"><span>{money(amountUsd)}</span><span>{kind === "borrow" ? "Available" : kind === "withdraw" ? "Withdrawable liquidity" : useATokens ? "Supplied to repay" : "Wallet"}: {available === null ? kind === "borrow" ? "Unavailable" : "—" : display(available, asset.decimals, 5)}</span></div></div>
    <div className="av-presets">{[25, 50, 75].map((portion) => <button type="button" className="av-quiet" key={portion} disabled={busy || available === null} onClick={() => { if (available !== null) { setAmount(formatUnits(BigInt(available) * BigInt(portion) / 100n, asset.decimals)); setAll(false); } }}>{portion}%</button>)}<button type="button" className="av-quiet" disabled={busy || maxLoading || available === null} onClick={() => { void chooseMax(); }}>{maxLoading ? "Estimating…" : "Max"}</button></div>
    <ErrorNote error={maxError} />
    {kind === "borrow" && available === null && <p className="av-muted">Borrowing capacity is unavailable because a position asset or this reserve has no current oracle price. Enter an amount to check it against Aave.</p>}
    {nativeAvailable && !useATokens && <label className="av-checkbox"><input type="checkbox" checked={useNative} onChange={(event) => { setUseNative(event.target.checked); setAmount(""); setAll(false); }} disabled={busy} />Use native ETH</label>}
    {kind === "repay" && BigInt(asset.supplied) > 0n && <label className="av-checkbox"><input type="checkbox" checked={useATokens} onChange={(event) => { setUseATokens(event.target.checked); setUseNative(false); setAmount(""); setAll(false); }} disabled={busy} />Use supplied aTokens</label>}
    {(kind === "repay" || kind === "withdraw") && <label className="av-checkbox"><input type="checkbox" checked={all} onChange={(event) => chooseAll(event.target.checked)} disabled={busy} />{kind === "repay" ? useATokens && BigInt(asset.supplied) < BigInt(asset.variableDebt) ? "Use all supplied aTokens" : "Repay full debt" : "Withdraw full supply"}</label>}
    {capRequired && <label>Maximum payment ({kind === "withdraw" ? `a${asset.symbol}` : symbol})<input aria-label="Maximum payment" inputMode="decimal" value={maximum} onChange={(event) => setMaximum(event.target.value)} disabled={busy} /><span className="av-muted">The suggested maximum adds 0.1% for accrued interest; you can edit it. Only the amount needed is used. Your wallet reviews this maximum.</span></label>}
    {useNative && kind === "supply" && <p className="av-muted">Keep enough ETH in your wallet for network fees. ETH is wrapped and supplied to the WETH reserve.</p>}
    {useATokens && <p className="av-muted">Repaying with supplied tokens reduces both your supply and debt. It may also reduce collateral supporting your other loans.</p>}
    <dl><div><dt>{kind === "borrow" || kind === "repay" ? "Variable borrow APY" : "Supply APY"}</dt><dd>{apy(kind === "borrow" || kind === "repay" ? asset.borrowApy : asset.supplyApy)}<small>Rates change with market demand</small></dd></div>{kind === "repay" && <div><dt>Your current debt</dt><dd>{display(asset.variableDebt, asset.decimals)} {asset.symbol}</dd></div>}{kind === "withdraw" && <div><dt>Your current supply</dt><dd>{display(asset.supplied, asset.decimals)} {asset.symbol}</dd></div>}</dl>
    <Identity asset={asset} /><ErrorNote error={error || quote.error} />{quote.loading && !quote.data && <Spinner label="Checking your Aave position…" />}{quote.data && <Preview plan={quote.data} market={market} refreshing={quote.loading} />}
    
  </Dialog>;
}

function ControlDialog({ selection, market, busy, execute, close }: { selection: Selection; market: Market; busy: boolean; execute: (input: Input) => void; close: () => void }) {
  const kind = selection.kind;
  const [eModeId, setEModeId] = useState(market.account.eModeId);
  const reserve = selection.reserve;
  const [enabled, setEnabled] = useState(reserve ? !reserve.collateralEnabled : false);
  const input = parseInput({ ...baseInput(market.chainId, kind === "collateral" ? "collateral" : kind === "rewards" ? "rewards" : "emode", reserve?.address ?? null), collateralEnabled: enabled, eModeId });
  const changed = kind === "emode" ? eModeId !== market.account.eModeId : kind === "collateral" ? enabled !== reserve!.collateralEnabled : market.rewards.some((reward) => BigInt(reward.amount) > 0n);
  const quote = useRead(changed && !busy ? `${market.accountAddress}:${stable(input)}` : null, (signal) => readQuote(input, market, signal), market.fetchedAtMs);
  const selectedMode = market.eModes.find((mode) => mode.id === eModeId);
  const canSubmit = changed && !busy && !!quote.data && !quote.loading && !quote.error;
  return <Dialog title={kind === "emode" ? "Efficiency mode" : kind === "rewards" ? "Claim rewards" : `${reserve!.symbol} collateral`} subtitle={`${CHAINS[market.chainId].marketName} · Aave V3`} close={close} footer={<><button type="button" className="av-primary" disabled={!canSubmit} onClick={() => { if (canSubmit) { execute(input); close(); } }}>{busy ? "Following wallet…" : quote.loading ? "Checking position…" : kind === "emode" ? "Review E-mode change" : kind === "rewards" ? "Review claim" : "Review collateral change"}</button><p className="av-help">You review and sign each transaction in EVM Wallet.</p></>}>
    {kind === "collateral" && reserve && <><Asset asset={reserve} /><p className="av-muted">Using this supply as collateral increases borrowing capacity. It also makes that collateral eligible for liquidation when your health factor falls below 1.</p><label className="av-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />Use {reserve.symbol} as collateral</label><Identity asset={reserve} /></>}
    {kind === "emode" && <><p className="av-muted">E-mode changes borrowing capacity for specific groups of correlated assets. Each category has its own eligible collateral, borrowable assets and liquidation thresholds.</p><div className="av-radio-group"><label><input type="radio" name="emode" checked={eModeId === 0} onChange={() => setEModeId(0)} disabled={busy} /><span><strong>Disabled</strong><small>Use each reserve’s standard collateral parameters.</small></span></label>{market.eModes.map((mode) => <label key={mode.id}><input type="radio" name="emode" checked={eModeId === mode.id} onChange={() => setEModeId(mode.id)} disabled={busy} /><span><strong>{mode.label}</strong><small>Loan-to-value {percent(mode.ltvBps / 100)} · Liquidation threshold {percent(mode.liquidationThresholdBps / 100)}</small></span></label>)}</div>{selectedMode && <div className="av-stack"><p className="av-muted">Eligible collateral: {market.reserves.filter((asset) => (BigInt(selectedMode.collateralBitmap) & 1n << BigInt(asset.id)) !== 0n).map((asset) => asset.symbol).join(", ") || "None"}.</p><p className="av-muted">Borrowable assets: {market.reserves.filter((asset) => (BigInt(selectedMode.borrowableBitmap) & 1n << BigInt(asset.id)) !== 0n).map((asset) => asset.symbol).join(", ") || "None"}.</p></div>}</>}
    {kind === "rewards" && <><p className="av-muted">Claim the currently accrued incentive tokens from this market to your EVM Wallet.</p><dl>{market.rewards.filter((reward) => BigInt(reward.amount) > 0n).map((reward) => <div key={tokenKey(reward)}><dt>{reward.symbol}</dt><dd>{display(reward.amount, reward.decimals)}<small><a href={`${explorer(reward.chainId)}/token/${reward.address}`} target="_blank" rel="noreferrer">{short(reward.address)} ↗</a></small></dd></div>)}</dl></>}
    <ErrorNote error={quote.error} />{quote.loading && !quote.data && <Spinner label="Checking your Aave position…" />}{quote.data && <Preview plan={quote.data} market={market} refreshing={quote.loading} />}
  </Dialog>;
}

function Overview({ market, busy, select, markets }: { market: Market; busy: boolean; select: (selection: Selection) => void; markets: () => void }) {
  const supplied = market.reserves.filter((asset) => BigInt(asset.supplied) > 0n), borrowed = market.reserves.filter((asset) => BigInt(asset.variableDebt) > 0n);
  const totalSupplied = supplied.reduce((sum, asset) => sum + usdAsset(market, asset, asset.supplied), 0), totalDebt = borrowed.some((asset) => BigInt(asset.priceBase) === 0n) ? NaN : usdBase(market, market.account.totalDebtBase), net = totalSupplied - totalDebt;
  const annualNet = supplied.reduce((sum, asset) => sum + usdAsset(market, asset, asset.supplied) * (asset.supplyApy ?? 0), 0) - borrowed.reduce((sum, asset) => sum + usdAsset(market, asset, asset.variableDebt) * (asset.borrowApy ?? 0), 0);
  const missingPrices = market.reserves.filter((asset) => BigInt(asset.priceBase) === 0n && (BigInt(asset.supplied) > 0n || BigInt(asset.variableDebt) > 0n));
  const ratesKnown = supplied.every((asset) => asset.supplyApy !== null) && borrowed.every((asset) => asset.borrowApy !== null);
  const eMode = market.eModes.find((mode) => mode.id === market.account.eModeId), rewards = market.rewards.filter((reward) => BigInt(reward.amount) > 0n);
  return <section className="av-overview" aria-label="Your position"><div className="av-portfolio"><div className="av-net-worth"><span>Net position</span><strong>{money(net)}</strong><p>{CHAINS[market.chainId].marketName} · Supplied assets minus debt</p></div><Health account={market.account} unpriced={missingPrices.length > 0} /></div>
    <div className="av-stat-grid"><div className="av-stat"><span>Total supplied</span><strong>{money(totalSupplied)}</strong><small>{supplied.length} {supplied.length === 1 ? "asset" : "assets"}</small></div><div className="av-stat"><span>Total borrowed</span><strong>{money(totalDebt)}</strong><small>Interest included</small></div><div className="av-stat"><span>Available to borrow</span><strong>{missingPrices.length ? "Unavailable" : money(usdBase(market, market.account.availableBorrowsBase))}</strong><small>Based on current collateral</small></div><div className="av-stat"><span>Net APY</span><strong>{net > 0 && ratesKnown ? percent(annualNet / net * 100) : "—"}</strong><small>Variable · excludes incentives</small></div></div>
    {missingPrices.length > 0 && <p className="av-notice">Oracle prices are unavailable for {missingPrices.map((asset) => asset.symbol).join(", ")}. USD totals and net APY cannot be fully valued.</p>}
    {!supplied.length && !borrowed.length && <div className="av-start"><div><span className="av-empty-icon" aria-hidden="true">↓</span><h3>Start with a supply</h3><p>Supply an asset to earn variable interest. Your supply remains visible here, with withdrawals available when market liquidity allows.</p><button type="button" className="av-secondary" onClick={markets}>Explore markets</button></div><div><span className="av-empty-icon" aria-hidden="true">↗</span><h3>Borrow against collateral</h3><p>Enable eligible supplies as collateral, then borrow without selling them. Review the effect on your health factor before every action.</p></div></div>}
    <div className="av-positions"><section className="av-position-section" aria-label="Your supplies"><header className="av-section-heading"><h2>Your supplies <span>{supplied.length}</span></h2><button type="button" className="av-text" onClick={markets}>Add assets →</button></header>{supplied.map((asset) => <article className="av-position" key={tokenKey(asset)}><div className="av-row"><Asset asset={asset} /><div className="av-position-value"><strong>{display(asset.supplied, asset.decimals)}</strong><small>{money(usdAsset(market, asset, asset.supplied))}</small></div></div><div className="av-position-meta"><span>{apy(asset.supplyApy)} supply APY</span><button type="button" className="av-collateral-button" aria-label={`Manage ${asset.symbol} collateral`} aria-pressed={asset.collateralEnabled} disabled={busy} onClick={() => select({ kind: "collateral", reserve: asset })}>Collateral {asset.collateralEnabled ? "on" : "off"} · Manage</button></div><div className="av-button-pair"><button type="button" className="av-secondary" aria-label={`Supply ${asset.symbol}`} disabled={busy || !asset.active || asset.paused || asset.frozen} onClick={() => select({ kind: "supply", reserve: asset })}>Supply</button><button type="button" className="av-quiet" aria-label={`Withdraw ${asset.symbol}`} disabled={busy || asset.paused} onClick={() => select({ kind: "withdraw", reserve: asset })}>Withdraw</button></div><Identity asset={asset} /></article>)}{!supplied.length && <div className="av-empty"><h3>No supplied assets</h3><p>Your supplies and collateral settings will appear here.</p></div>}</section>
      <section className="av-position-section" aria-label="Your borrows"><header className="av-section-heading"><h2>Your borrows <span>{borrowed.length}</span></h2><button type="button" className="av-text" onClick={markets}>Borrow assets →</button></header>{borrowed.map((asset) => <article className="av-position" key={tokenKey(asset)}><div className="av-row"><Asset asset={asset} /><div className="av-position-value"><strong>{display(asset.variableDebt, asset.decimals)}</strong><small>{money(usdAsset(market, asset, asset.variableDebt))}</small></div></div><div className="av-position-meta"><span>{apy(asset.borrowApy)} variable borrow APY</span><span className="av-badge av-neutral">Variable debt</span></div><div className="av-button-pair"><button type="button" className="av-secondary" aria-label={`Repay ${asset.symbol}`} disabled={busy || asset.paused} onClick={() => select({ kind: "repay", reserve: asset })}>Repay</button><button type="button" className="av-quiet" aria-label={`Borrow ${asset.symbol}`} disabled={busy || !asset.active || asset.paused || asset.frozen || !borrowingEnabled(market, asset)} onClick={() => select({ kind: "borrow", reserve: asset })}>Borrow</button></div><Identity asset={asset} /></article>)}{!borrowed.length && <div className="av-empty"><h3>No open loans</h3><p>Once you borrow, follow your debt and repay from this view.</p></div>}</section></div>
    <div className="av-settings-row"><div><strong>Efficiency mode <span className="av-badge">{eMode?.label ?? (market.account.eModeId === 0 ? "Disabled" : `Category ${market.account.eModeId}`)}</span></strong><p className="av-muted">Choose a collateral category to use its borrowing parameters.</p></div><button type="button" className="av-quiet" aria-label="Manage E-mode" disabled={busy} onClick={() => select({ kind: "emode" })}>Manage</button></div>
    <div className="av-settings-row"><div><strong>Incentive rewards</strong><p className="av-muted">{rewards.length ? rewards.map((reward) => `${display(reward.amount, reward.decimals)} ${reward.symbol}`).join(" · ") : market.errors.length ? "Reward data is unavailable. Refresh the market to try again." : "No claimable rewards currently reported for your position."}</p></div><button type="button" className="av-secondary" disabled={busy || !rewards.length} onClick={() => select({ kind: "rewards" })}>Claim</button></div>
  </section>;
}

function Markets({ market, busy, select }: { market: Market; busy: boolean; select: (selection: Selection) => void }) {
  const [query, setQuery] = useState(""), [sort, setSort] = useState("liquidity"), [walletOnly, setWalletOnly] = useState(false);
  const needle = query.trim().toLowerCase(), rows = market.reserves.filter((asset) => `${asset.symbol} ${asset.name} ${asset.address}`.toLowerCase().includes(needle) && (!walletOnly || BigInt(asset.walletBalance) > 0n));
  rows.sort((a, b) => (sort === "supply" ? (b.supplyApy ?? -Infinity) - (a.supplyApy ?? -Infinity) : sort === "borrow" ? (a.borrowApy ?? Infinity) - (b.borrowApy ?? Infinity) : sort === "wallet" ? usdAsset(market, b, b.walletBalance) - usdAsset(market, a, a.walletBalance) : usdAsset(market, b, b.availableLiquidity) - usdAsset(market, a, a.availableLiquidity)) || a.address.localeCompare(b.address));
  return <section className="av-stack" aria-label="Markets"><header className="av-section-heading"><div><h2>Explore {CHAINS[market.chainId].marketName}</h2><p className="av-muted">Supply to earn variable interest, or borrow against your collateral.</p></div><span className="av-badge">{market.reserves.length} reserves</span></header><div className="av-toolbar"><label><span className="av-sr-only">Search markets</span><input aria-label="Search markets" placeholder="Search asset or contract address" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label><span className="av-sr-only">Sort markets</span><select aria-label="Sort markets" value={sort} onChange={(event) => setSort(event.target.value)}><option value="liquidity">Available liquidity</option><option value="supply">Supply APY</option><option value="borrow">Borrow APY</option><option value="wallet">Wallet balance</option></select></label></div><label className="av-checkbox"><input type="checkbox" checked={walletOnly} onChange={(event) => setWalletOnly(event.target.checked)} />Only assets in my wallet</label>
    <div className="av-market-table"><div className="av-market-head" aria-hidden="true"><span>Asset</span><span>Supply APY</span><span>Borrow APY</span><span>Wallet balance</span><span>Liquidity</span><span>Actions</span></div>{rows.map((asset) => <article className="av-market-row" key={tokenKey(asset)} aria-label={`${asset.symbol} reserve`}><div className="av-stack"><Asset asset={asset} /><div className="av-market-status">{!asset.active && <span className="av-badge av-warning">Inactive</span>}{asset.paused && <span className="av-badge av-warning">Paused</span>}{asset.frozen && <span className="av-badge av-warning">Frozen</span>}{!borrowingEnabled(market, asset) && <span className="av-badge av-neutral">{market.account.eModeId === 0 ? "Supply only" : "Not borrowable in E-mode"}</span>}{BigInt(asset.debtCeiling) > 0n && <span className="av-badge av-neutral">Isolated collateral</span>}</div><Identity asset={asset} /></div><div className="av-market-data"><span>Supply APY</span><strong>{apy(asset.supplyApy)}</strong><small>Variable</small></div><div className="av-market-data"><span>Borrow APY</span><strong>{borrowingEnabled(market, asset) ? apy(asset.borrowApy) : "—"}</strong><small>Variable</small></div><div className="av-market-data"><span>Wallet</span><strong>{display(asset.walletBalance, asset.decimals, 4)}</strong><small>{money(usdAsset(market, asset, asset.walletBalance), true)}</small></div><div className="av-market-data"><span>Liquidity</span><strong>{money(usdAsset(market, asset, asset.availableLiquidity), true)}</strong><small>Available</small></div><div className="av-button-pair"><button type="button" className="av-secondary" aria-label={`Supply ${asset.symbol}`} disabled={busy || !asset.active || asset.paused || asset.frozen} onClick={() => select({ kind: "supply", reserve: asset })}>Supply</button><button type="button" className="av-quiet" aria-label={`Borrow ${asset.symbol}`} disabled={busy || !asset.active || asset.paused || asset.frozen || !borrowingEnabled(market, asset)} onClick={() => select({ kind: "borrow", reserve: asset })}>Borrow</button></div></article>)}</div>{!rows.length && <div className="av-empty"><h3>No matching reserves</h3><p>Try another asset name or address, or turn off the wallet filter.</p><button type="button" className="av-quiet" onClick={() => { setQuery(""); setWalletOnly(false); }}>Clear filters</button></div>}<p className="av-muted">Assets are identified by their exact contract in this Aave market. APYs are variable, exclude incentives and are not guaranteed. Available market liquidity is separate from your personal borrowing capacity.</p>
  </section>;
}

function Progress({ execution, busy, resume, check }: { execution: Execution; busy: boolean; resume: () => void; check: () => void }) {
  const { result, input, humanOwned } = execution;
  return <section className={`av-progress av-${result.state}`} aria-label="Transaction progress"><header className="av-row"><strong>{result.summary}</strong><span className={`av-badge ${result.state === "complete" ? "av-positive" : result.state === "stopped" ? "av-warning" : ""}`}>{result.state === "complete" ? "Confirmed" : result.state === "review" ? "Review" : result.state === "stopped" ? "Stopped" : "In progress"}</span></header><p role="status">{result.message}</p><ol className="av-steps">{result.steps.map((step, index) => <li key={index}><span className={step.status === "confirmed" ? "av-done" : ""}>{step.status === "confirmed" ? "✓" : index + 1}</span><span>{step.label}</span><small>{step.status === "queued" ? "Waiting" : step.status}</small>{step.transactionHash && <a href={`${explorer(input.chainId)}/tx/${step.transactionHash}`} target="_blank" rel="noreferrer" aria-label={`View ${step.label} transaction`}>↗</a>}</li>)}</ol><div className="av-row">{humanOwned && result.state !== "complete" && result.state !== "stopped" && <button type="button" className="av-secondary" disabled={busy} onClick={resume}>{busy ? "Following wallet…" : "Continue in wallet"}</button>}<button type="button" className="av-quiet" disabled={busy || !humanOwned} onClick={check}>Check status</button></div>{!humanOwned && result.state !== "complete" && <p className="av-muted">Continue this operation in the Agent or app that started it.</p>}<span className="av-caption">{CHAINS[input.chainId].marketName}</span></section>;
}

function App() {
  const [chainId, setChainId] = useState<ChainId>("1"), [tab, setTab] = useState<"position" | "markets" | "activity">("position"), [refresh, setRefresh] = useState(0), [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [active, setActive] = useState<Execution | null>(null), [selection, setSelection] = useState<Selection | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const executing = useRef(false), executionScope = useRef(0);
  const accountRead = useRead("main", async (signal) => (await wallet.accounts({ signal })).accounts.find((account) => account.accountId === "main") ?? null, refresh + tick);
  const account = accountRead.data;
  const accountIdentity = account ? stable(account) : null;
  useEffect(() => { setSelection(null); }, [accountIdentity]);
  const balances = useRead(account ? `${chainId}:${account.address}` : null, async (signal) => {
    const result = await wallet.balances({ accountId: "main", chainId, tokens: [] }, { signal });
    if (result.address.toLowerCase() !== account!.address.toLowerCase()) throw new Error("Your wallet account changed. Refresh to read its balances.");
    return result;
  }, refresh + tick);
  const marketRead = useRead(account ? `${chainId}:${account.address}` : null, async (signal) => {
    const result = JSON.parse((await invoke<{ marketJson: string }>("aave_markets_v1", { chainId, refresh: true }, signal)).marketJson) as Market;
    if (result.chainId !== chainId || result.accountAddress.toLowerCase() !== account!.address.toLowerCase()) throw new Error("Your wallet account changed. Refresh to read its Aave position.");
    return result;
  }, refresh + tick);
  const market = marketRead.data;
  const currentSelection = selection?.reserve && market ? { ...selection, reserve: market.reserves.find((asset) => asset.address === selection.reserve!.address) ?? selection.reserve } : selection;
  const [history, setHistory] = useState<Activity[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [historyError, setHistoryError] = useState(""), [historyLoading, setHistoryLoading] = useState(false);
  const historyScope = useRef(0);
  async function loadHistory(cursor: string | null = null) {
    const sequence = ++historyScope.current, execution = executionScope.current; setHistoryLoading(true); setHistoryError("");
    try {
      const result = await invoke<{ rowsJson: string; nextCursor: string | null }>("aave_history_v1", { cursor });
      if (sequence !== historyScope.current) return;
      const rows = JSON.parse(result.rowsJson) as Activity[];
      if (!executing.current && execution === executionScope.current) setActive((old) => {
        if (!old || executing.current || execution !== executionScope.current) return old;
        const current = rows.find((row) => row.result.operationId === old.result.operationId);
        return current ? { result: current.result, input: current.input, humanOwned: current.humanOwned } : old;
      });
      setHistory((old) => cursor ? [...old, ...rows.filter((row) => !old.some((existing) => existing.id === row.id))] : rows); setNextCursor(result.nextCursor);
    } catch (reason) { if (sequence === historyScope.current) setHistoryError(message(reason)); }
    finally { if (sequence === historyScope.current) setHistoryLoading(false); }
  }
  useEffect(() => { void loadHistory(); }, [refresh]);
  useEffect(() => { const timer = setInterval(() => { if (!busy && document.visibilityState === "visible") setTick((value) => value + 1); }, 30000); return () => clearInterval(timer); }, [busy]);
  useEffect(() => {
    if (!busy || !active) return;
    let alive = true;
    const execution = executionScope.current;
    const timer = setInterval(() => { void invoke<{ result: Result | null }>("aave_status_v1", { operationId: active.result.operationId }).then(({ result }) => { if (alive && executing.current && execution === executionScope.current && result) setActive((old) => old && old.result.operationId === result.operationId ? { ...old, result } : old); }).catch(() => {}); }, 1800);
    return () => { alive = false; clearInterval(timer); };
  }, [busy, active?.result.operationId]);
  async function execute(input: Input, existing?: Result, check = false) {
    if (executing.current) return;
    executing.current = true; executionScope.current++;
    const retained = activeRef.current;
    if (!existing && retained?.humanOwned && ["pending", "review"].includes(retained.result.state) && stable(retained.input) === stable(input)) existing = retained.result;
    const id = existing?.operationId ?? crypto.randomUUID().replaceAll("-", "");
    const initial: Result = existing ?? { operationId: id, recordId: null, summary: `Preparing your ${input.kind === "emode" ? "E-mode change" : input.kind === "collateral" ? "collateral change" : input.kind === "rewards" ? "reward claim" : input.kind.replace("_atokens", "")}`, state: "pending", phase: "preparing", transactionHash: null, steps: [], message: "Checking your Aave position and saving the transaction steps…" };
    setBusy(true); setError(""); setActive({ input, result: initial, humanOwned: true });
    try {
      const result = await invoke<Result>(check ? "aave_reconcile_v1" : existing?.recordId ? "aave_continue_v1" : "aave_execute_v1", check || existing?.recordId ? { operationId: id } : { ...input, operationId: id });
      setActive({ input, result, humanOwned: true });
    } catch (reason) {
      setError(message(reason));
      try { const saved = await invoke<{ result: Result | null }>("aave_status_v1", { operationId: id }); if (saved.result) setActive({ input, result: saved.result, humanOwned: true }); } catch { /* Keep the original intent available after an ambiguous reply. */ }
    } finally { executing.current = false; executionScope.current++; setBusy(false); setRefresh((value) => value + 1); }
  }
  const visible = history.filter((row) => row.input.chainId === chainId), pending = visible.filter((row) => !["complete", "stopped"].includes(row.result.state));
  function show(selection: Selection) { setSelection(selection); setError(""); }
  return <main className="nt-app av-app"><div className="av-shell">
    <header className="nt-app-header">
      <div className="nt-app-header-main">
        <img className="nt-app-header-icon" src="static/icon.svg" alt="" />
        <div className="nt-app-header-copy"><h1 className="nt-app-header-title">via Aave</h1><p className="nt-app-header-subtitle">Supply & borrow</p></div>
      </div>
      <div className="nt-app-header-actions"><select className="nt-select nt-app-header-control" aria-label="Network" value={chainId} disabled={busy} onChange={(event) => { setChainId(event.target.value as ChainId); setSelection(null); setActive(null); setError(""); }}>{Object.entries(CHAINS).map(([id, chain]) => <option key={id} value={id}>{chain.marketName}</option>)}</select></div>
    </header>
    <div className="av-wallet"><span className={`av-wallet-dot ${account ? "" : "av-disconnected"}`} /><span>{account ? <a href={`${explorer(chainId)}/address/${account.address}`} target="_blank" rel="noreferrer" title={account.address}>{short(account.address)} ↗</a> : accountRead.loading ? "Connecting to EVM Wallet…" : "EVM Wallet unavailable"}</span><span className="av-right">{balances.data ? `${display(balances.data.nativeBalanceWei, 18, 5)} ETH` : "—"}</span><button type="button" className="av-text" aria-label="Refresh wallet and markets" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>↻</button></div>
    <ErrorNote error={accountRead.error || balances.error} />{!account && !accountRead.loading && <div className="av-empty"><h3>Connect your EVM Wallet</h3><p>Install and open EVM Wallet to use your Ethereum account with Aave, then refresh this view.</p><button type="button" className="av-secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh connection</button></div>}
    <nav className="av-tabs" aria-label="Aave sections">{(["position", "markets", "activity"] as const).map((value) => <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{value === "position" ? "Your position" : value === "markets" ? "Markets" : `Activity${pending.length ? ` · ${pending.length}` : ""}`}</button>)}</nav>
    {tab !== "activity" && <><ErrorNote error={marketRead.error} />{marketRead.error && <div className="av-row"><p className="av-muted">{market ? "Showing the last successful read. Refresh before relying on balances or rates." : "Balances and rates could not be read from this market."}</p><button type="button" className="av-quiet" onClick={() => setRefresh((value) => value + 1)}>Retry</button></div>}{marketRead.loading && !market && <Spinner label="Reading Aave markets and your position…" />}{market?.errors.length ? <details className="av-details"><summary>Some market data is unavailable</summary>{market.errors.map((notice, index) => <p className="av-muted" key={index}>{notice}</p>)}</details> : null}
      {market && tab === "position" && <Overview market={market} busy={busy} select={show} markets={() => setTab("markets")} />}{market && tab === "markets" && <Markets key={chainId} market={market} busy={busy} select={show} />}</>}
    <ErrorNote error={error} />{active && tab !== "activity" && <Progress execution={active} busy={busy} resume={() => { void execute(active.input, active.result); }} check={() => { void execute(active.input, active.result, true); }} />}{!active && tab !== "activity" && pending.length > 0 && <button type="button" className="av-resume-banner" onClick={() => setTab("activity")}>{pending.length} saved {pending.length === 1 ? "operation needs" : "operations need"} attention<span>View activity →</span></button>}
    {tab === "activity" && <section className="av-stack" aria-label="Activity"><header className="av-section-heading"><div><h2>Your activity</h2><p className="av-muted">Saved lending transactions on {CHAINS[chainId].marketName}.</p></div><button type="button" className="av-quiet" onClick={() => { void loadHistory(); }} disabled={historyLoading}>Refresh</button></header><ErrorNote error={historyError} />{active && active.input.chainId === chainId && !visible.some((row) => row.id === active.result.operationId) && <Progress execution={active} busy={busy} resume={() => { void execute(active.input, active.result); }} check={() => { void execute(active.input, active.result, true); }} />}{visible.map((row) => <Progress key={row.id} execution={active?.result.operationId === row.id ? active : row} busy={busy} resume={() => { void execute(row.input, row.result); }} check={() => { void execute(row.input, row.result, true); }} />)}{historyLoading && <Spinner label="Reading saved activity…" />}{!historyLoading && !visible.length && !(active && active.input.chainId === chainId) && <div className="av-empty"><span className="av-empty-icon" aria-hidden="true">↗</span><h3>Your lending activity, in one place</h3><p>Supplies, loans, repayments and collateral changes appear here. Transaction progress is saved so you can continue after closing the app.</p><button type="button" className="av-secondary" onClick={() => setTab("markets")}>Explore markets</button></div>}{nextCursor && <button type="button" className="av-quiet" disabled={historyLoading} onClick={() => { void loadHistory(nextCursor); }}>Load older activity</button>}</section>}
    {currentSelection && market && (["supply", "withdraw", "borrow", "repay"].includes(currentSelection.kind) ? <ActionDialog key={`${currentSelection.kind}:${currentSelection.reserve?.address}`} selection={currentSelection as Selection & { kind: ActionKind }} market={market} nativeBalance={balances.data?.nativeBalanceWei ?? null} busy={busy} execute={(input) => { void execute(input); }} close={() => setSelection(null)} refresh={refresh} /> : <ControlDialog selection={currentSelection} market={market} busy={busy} execute={(input) => { void execute(input); }} close={() => setSelection(null)} />)}
    <footer><span>Aave V3 · Signed with your EVM Wallet</span>{market && <span>{marketRead.loading ? "Refreshing market…" : `Block ${market.blockNumber}`} · <a href={`${explorer(chainId)}/address/${market.pool}`} target="_blank" rel="noreferrer">Pool contract ↗</a></span>}</footer>
  </div></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
