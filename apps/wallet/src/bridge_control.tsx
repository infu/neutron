import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectEthereumProvider, createMsgBusClient } from "neutron-tools/app";
import { createEvmWalletClient, createEvmRequestId } from "neutron-tools/evm_wallet";
import { IoArrowBack, IoArrowForward, IoCheckmark, IoChevronForward, IoClose, IoOpenOutline, IoRefresh, IoTimeOutline, IoWalletOutline } from "react-icons/io5";
import { bridgeComplete, bridgeLabel, createBridgeClient, executeBridgeDeposit, type BridgeIntent } from "./bridge.ts";
import { attachExternalBridgeTransaction, connectEvmBridge, connectEvmBridgeReads } from "./evm_bridge.ts";
import { TokenMark } from "./token_mark.tsx";
import { formatTokenAmount, parseTokenAmount } from "./format.ts";

export function WalletBridgeDeposit({ ledger, symbol, decimals, onRefresh, tray, openInTile, logo = null }: {
  ledger: string; symbol: string; decimals: number | null; onRefresh: () => void; logo?: string | null;
  tray: boolean; openInTile: () => Promise<unknown>;
}) {
  const bridge = useMemo(() => createBridgeClient(), []);
  const evm = useMemo(() => createEvmWalletClient(createMsgBusClient()), []);
  const [records, setRecords] = useState<BridgeIntent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<"evm" | "external">("evm");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const [phase, setPhase] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const busyRef = useRef(false);
  const refreshRef = useRef<Promise<void> | null>(null);
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  const [effectiveHashes, setEffectiveHashes] = useState<Record<string, string>>({});
  const current = records.find((record) => record.id === selectedId) ?? null;
  const nativeSymbol = symbol.startsWith("ck") ? symbol.slice(2) : symbol;
  const mergeRecord = useCallback((intent: BridgeIntent) => {
    if (intent.quote.ledger !== ledgerRef.current) return;
    setRecords((old) => [intent, ...old.filter((record) => record.id !== intent.id)]
      .sort((a, b) => BigInt(a.createdAt) > BigInt(b.createdAt) ? -1 : 1));
  }, []);
  useEffect(() => {
    let active = true;
    setEffectiveHashes({});
    if (current && detailsOpen) void Promise.all(current.steps.filter((step) => step.transactionHash).map(async (step) => [step.kind, await bridge.effectiveHash(current.id, step.kind)] as const)).then((entries) => {
      if (active) { const hashes: Record<string, string> = {}; for (const [kind, hash] of entries) if (hash !== null) hashes[kind] = hash; setEffectiveHashes(hashes); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [bridge, current?.id, current?.revision, detailsOpen]);
  const remember = useCallback((intent: BridgeIntent) => {
    mergeRecord(intent);
    if (intent.quote.ledger === ledgerRef.current) setSelectedId(intent.id);
  }, [mergeRecord]);
  const reload = useCallback(async () => {
    const saved = await bridge.list(ledger);
    saved.sort((a, b) => BigInt(a.createdAt) > BigInt(b.createdAt) ? -1 : 1);
    if (ledger === ledgerRef.current) setRecords(saved);
    return saved;
  }, [bridge, ledger]);
  useEffect(() => {
    let active = true;
    setLoading(true); setLoaded(false); setError(null); setSelectedId(null); setRecords([]); setAmount(""); setActivityOpen(false); setDetailsOpen(false);
    void reload().then(() => { if (active) setLoaded(true); }).catch((reason) => { if (active) setError(message(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);
  const refresh = useCallback(async (record: BridgeIntent) => {
    const next = await bridge.refresh(record.id);
    remember(next);
    if (bridgeComplete(next)) onRefresh();
    return next;
  }, [bridge, onRefresh, remember]);
  const refreshState = useRef({ records, mergeRecord, onRefresh });
  refreshState.current = { records, mergeRecord, onRefresh };
  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active || document.visibilityState === "hidden" || busyRef.current || refreshRef.current) return;
      const pending = refreshState.current.records.filter((record) => !bridgeComplete(record)
        && !record.steps.some((step) => step.state === "failed")
        && record.steps.some((step) => step.kind === "deposit" && step.transactionHash));
      const work = (async () => {
        for (const record of pending) {
          if (!active || busyRef.current) break;
          try {
            const next = await bridge.refresh(record.id);
            if (!active) break;
            refreshState.current.mergeRecord(next);
            if (bridgeComplete(next)) refreshState.current.onRefresh();
          } catch { /* Keep the saved progress; foreground Continue exposes any persistent error. */ }
        }
      })();
      refreshRef.current = work;
      try { await work; } finally { if (refreshRef.current === work) refreshRef.current = null; }
    };
    void run();
    const timer = globalThis.setInterval(() => void run(), 15_000);
    const visible = () => { if (document.visibilityState !== "hidden") void run(); };
    globalThis.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; globalThis.clearInterval(timer); globalThis.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [bridge, ledger, loaded]);
  const submit = async () => {
    if (busyRef.current || loading || !loaded) return;
    busyRef.current = true;
    setBusy(true); setError(null); setPhase("connecting");
    let external: Awaited<ReturnType<typeof connectEthereumProvider>> | null = null;
    try {
      await refreshRef.current;
      if (tray) { await openInTile(); return; }
      if (current && (bridgeComplete(current) || current.steps.find((step) => step.kind === "deposit")?.state === "confirmed" || typeof current.source !== "string")) { await refresh(current); return; }
      let intent = current;
      if (!intent && decimals === null) throw new Error("Token decimals are unavailable");
      const units = intent?.amount ?? parseTokenAmount(amount, decimals!);
      const selectedSource = intent?.source ?? source;
      const quote = intent?.quote ?? await bridge.quote(ledger);
      let connection: Awaited<ReturnType<typeof connectEvmBridge>> | null = null;
      let account: string;
      if (selectedSource === "evm") {
        await connectEvmBridgeReads();
        connection = await connectEvmBridge(evm, quote.helperAddress, quote.tokenAddress, intent?.account);
        account = connection.account.address;
      } else {
        external = await connectEthereumProvider();
        const accounts = await external.provider.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("The browser wallet returned no Ethereum account");
        account = accounts[0];
      }
      if (!intent) {
        intent = await bridge.prepare({ id: createEvmRequestId(), ledger, source: selectedSource, account, amount: units });
        remember(intent);
      }
      const provider = connection?.provider ?? external?.provider;
      if (!provider) throw new Error("The deposit source is unavailable");
      const completed = await executeBridgeDeposit({ intent, client: bridge, provider, ...(connection ? { evm: connection.evm } : {}), onChange: remember, onProgress: setPhase });
      remember(completed);
      await refresh(completed);
      onRefresh();
    } catch (reason) {
      setError(message(reason));
      // Reload authoritative pending state even if a write response was lost.
      await reload().catch(() => undefined);
    } finally {
      await external?.close().catch(() => undefined);
      busyRef.current = false;
      setBusy(false); setPhase(null);
    }
  };
  const unresolvedBrowserStep = current?.source === "external" ? current.steps.find((step) => step.state === "unknown" && !step.transactionHash) : null;
  const recoverBrowserHash = async () => {
    if (!current || !unresolvedBrowserStep || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      await refreshRef.current;
      await connectEvmBridgeReads();
      const recovered = await attachExternalBridgeTransaction(evm, bridge, current, unresolvedBrowserStep.kind, recoveryHash.trim());
      remember(recovered); setRecoveryHash("");
      if (unresolvedBrowserStep.kind === "deposit") await refresh(recovered);
    } catch (reason) { setError(message(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const choose = (id: string | null) => { setDetailsOpen(false); setSelectedId(id); setError(null); setPhase(null); setRecoveryHash(""); };
  const complete = current !== null && bridgeComplete(current);
  const failed = current?.steps.some((step) => step.state === "failed") ?? false;
  const deposit = current?.steps.find((step) => step.kind === "deposit");
  const deposited = deposit?.state === "confirmed" || Boolean(current?.acceptedDeposit) || complete;
  const agentOwned = current !== null && typeof current.source !== "string";
  const problem = complete ? null : error ?? (!busy ? current?.error : null);
  const waiting = current !== null && !failed && !complete && (deposited || Boolean(deposit?.transactionHash));
  const attention = records.filter((record) => !bridgeComplete(record) && !record.steps.some((step) => step.state === "failed")
    && !record.steps.some((step) => step.kind === "deposit" && step.transactionHash));
  const inProgress = records.filter((record) => !bridgeComplete(record) && !record.steps.some((step) => step.state === "failed")
    && record.steps.some((step) => step.kind === "deposit" && step.transactionHash));
  const activeSource = current?.source ?? source;
  const sourceName = typeof activeSource !== "string" ? "Agent" : activeSource === "evm" ? "EVM Wallet" : "browser wallet";
  const resetForm = () => { choose(null); setAmount(""); };
  const steps = current ? depositSteps(current, nativeSymbol, symbol, busy, phase) : [];
  const primaryText = complete ? "Done" : failed ? "New deposit" : busy ? busyLabel(current, sourceName, phase)
    : agentOwned || deposited ? "Check progress" : current ? "Continue deposit" : `Wrap ${nativeSymbol}`;

  return <div className="wallet-ethereum-deposit wallet-bridge">
    {tray ? <button type="button" className="nt-button nt-button--secondary nt-button--sm" onClick={() => void openInTile()}><IoOpenOutline /> Continue in Wallet</button> : <>
      <div className="wallet-bridge-heading">
        <span><strong>{current ? complete ? "Deposit complete" : "Your deposit" : `Wrap ${nativeSymbol}`}</strong><small>Ethereum <IoArrowForward aria-hidden="true" /> Internet Computer</small></span>
        {current ? <button type="button" className="nt-icon-button" title="Back to deposit" aria-label="Back to deposit" disabled={busy} onClick={resetForm}><IoArrowBack /></button> : <span className="wallet-bridge-network">Mainnet</span>}
      </div>
      {!current ? <>
        <div className="wallet-bridge-amount-card">
          <span className="wallet-bridge-field-label">You deposit</span>
          <label className="wallet-ethereum-amount"><input aria-label={`Amount of ${nativeSymbol} to deposit`} autoComplete="off" disabled={busy || loading} inputMode="decimal" placeholder="0" value={amount} onChange={(event) => { setAmount(event.target.value); setError(null); }} /><strong><TokenMark logo={logo} symbol={nativeSymbol} />{nativeSymbol}</strong></label>
          <span className="wallet-bridge-receive">Receive <strong>{amount.trim() || "0"} {symbol}</strong> in your IC Wallet</span>
        </div>
        <label className="wallet-bridge-source"><span><IoWalletOutline aria-hidden="true" /> From</span><select aria-label="Deposit source" disabled={busy || loading} value={source} onChange={(event) => setSource(event.target.value as "evm" | "external")}><option value="evm">EVM Wallet</option><option value="external">Browser wallet</option></select></label>
        <p className="wallet-bridge-hint">Use {nativeSymbol} on Ethereum. You’ll also need ETH for network fees.</p>
      </> : <>
        <div className={`wallet-bridge-summary${complete ? " is-complete" : ""}`}>
          <span>{complete ? <IoCheckmark aria-hidden="true" /> : <TokenMark logo={logo} symbol={nativeSymbol} />}</span>
          <div><strong>{displayAmount(current.amount, decimals)} {complete ? symbol : nativeSymbol}</strong><small>{complete ? "Received in your IC Wallet" : `${sourceName} → ${symbol} in your IC Wallet`}</small></div>
        </div>
        <ol className="wallet-bridge-steps" aria-label="Deposit progress">{steps.map((step, index) => <li key={step.title} className={`is-${step.state}`} aria-current={step.state === "current" ? "step" : undefined}><span className="wallet-bridge-step-mark">{step.state === "done" ? <IoCheckmark /> : step.state === "failed" ? <IoClose /> : step.state === "current" && busy ? <span className="wallet-spinner" /> : index + 1}</span><span><strong>{step.title}</strong><small>{step.description}</small></span></li>)}</ol>
        {agentOwned && !complete ? <p className="wallet-bridge-hint">Your Agent started this deposit. Ask it to continue; progress updates here automatically.</p> : null}
        {waiting && !busy && !problem && !complete ? <p className="wallet-bridge-hint" role="status">{deposited ? `Your ${nativeSymbol} deposit is confirmed. Receiving ${symbol} can take a few minutes.` : "Waiting for Ethereum confirmation."} We’ll keep checking while Wallet is open.</p> : null}
      </>}
      {problem ? <p className="wallet-bridge-problem" role="alert">{friendlyError(problem, current)}</p> : null}
      {failed && !problem ? <p className="wallet-bridge-problem" role="alert">{current?.steps.some((step) => step.error?.includes("declined")) ? "The wallet request was declined. You can start a new deposit when you’re ready." : "This deposit could not complete. See Details for the transaction result."}</p> : null}
      <button className="nt-button wallet-bridge-primary" type="button" disabled={busy || loading || !loaded || (!current && !amount.trim()) || Boolean(unresolvedBrowserStep)} onClick={() => complete || failed ? resetForm() : void submit()}>{busy ? <span className="wallet-spinner" /> : complete ? <IoCheckmark /> : current && (agentOwned || deposited) ? <IoRefresh /> : null}{primaryText}</button>
      {busy ? <p className="wallet-bridge-hint" role="status">{current ? "Approve each request in your wallet. The next step opens automatically." : "Connecting your wallet and preparing the deposit…"}</p> : null}
      {unresolvedBrowserStep ? <div className="wallet-bridge-recovery"><strong>Find your transaction</strong><p>The browser wallet did not return its result. Paste its transaction hash to check what happened and continue the same deposit.</p><input className="nt-input" aria-label="Existing browser transaction hash" placeholder="Transaction hash · 0x…" value={recoveryHash} disabled={busy} onChange={(event) => setRecoveryHash(event.target.value)} /><button className="nt-button nt-button--secondary nt-button--sm" type="button" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={() => void recoverBrowserHash()}>Check transaction</button></div> : null}
      {!loaded && !loading ? <button className="nt-button nt-button--secondary nt-button--sm" type="button" onClick={() => { setLoading(true); void reload().then(() => { setLoaded(true); setError(null); }).catch((reason) => setError(message(reason))).finally(() => setLoading(false)); }}><IoRefresh /> Try again</button> : null}
      {current || error ? <details className="wallet-bridge-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}><summary>Details</summary><div>{current ? <><dl><div><dt>Source account</dt><dd><code>{current.account}</code></dd></div><div><dt>Network</dt><dd>Ethereum Mainnet</dd></div><div><dt>Deposit contract</dt><dd><code>{current.quote.helperAddress}</code></dd></div>{current.quote.tokenAddress ? <div><dt>Token contract</dt><dd><code>{current.quote.tokenAddress}</code></dd></div> : null}<div><dt>IC recipient</dt><dd><code>{current.quote.recipient}</code></dd></div><div><dt>Deposit ID</dt><dd><code>{current.id}</code></dd></div><div><dt>Status</dt><dd>{bridgeLabel(current)}</dd></div></dl>{current.steps.filter((step) => step.transactionHash).map((step) => <div className="wallet-bridge-transaction" key={step.kind}><small>{step.kind === "reset_approval" ? "Allowance reset" : step.kind === "approval" ? "Token approval" : "Ethereum deposit"}</small><a href={`https://etherscan.io/tx/${step.transactionHash}`} target="_blank" rel="noopener noreferrer" title="View transaction on Etherscan"><code>{step.transactionHash}</code><IoOpenOutline aria-hidden="true" /></a>{effectiveHashes[step.kind] && effectiveHashes[step.kind] !== step.transactionHash ? <><small>Replacement transaction</small><a href={`https://etherscan.io/tx/${effectiveHashes[step.kind]}`} target="_blank" rel="noopener noreferrer"><code>{effectiveHashes[step.kind]}</code><IoOpenOutline aria-hidden="true" /></a></> : null}</div>)}</> : null}{problem ? <p className="wallet-bridge-technical-error">{problem}</p> : null}<p>Arbitrum assets must be bridged to Ethereum before wrapping into ck-tokens.</p></div></details> : null}
      {!current && attention.length > 0 ? <button className="wallet-bridge-attention" type="button" disabled={busy} onClick={() => choose(attention[0]!.id)}><IoTimeOutline aria-hidden="true" /><span>{attention.length === 1 ? "1 deposit to continue" : `${attention.length} deposits to continue`}</span><IoChevronForward aria-hidden="true" /></button> : null}
      {!current && attention.length === 0 && inProgress.length > 0 ? <button className="wallet-bridge-attention" type="button" disabled={busy} onClick={() => choose(inProgress[0]!.id)}><IoTimeOutline aria-hidden="true" /><span>{inProgress.length === 1 ? "1 deposit in progress" : `${inProgress.length} deposits in progress`}</span><IoChevronForward aria-hidden="true" /></button> : null}
      {records.length > 0 ? <details className="wallet-bridge-activity" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}><summary>Activity <span>{records.length}</span></summary><div>{records.map((record) => <button key={record.id} type="button" className={`wallet-bridge-history-row${record.id === current?.id ? " is-selected" : ""}`} disabled={busy} onClick={() => { choose(record.id); setActivityOpen(false); }}><span className={`wallet-bridge-history-mark${bridgeComplete(record) ? " is-complete" : ""}`}>{bridgeComplete(record) ? <IoCheckmark /> : record.steps.some((step) => step.state === "failed") ? <IoClose /> : <IoTimeOutline />}</span><span><strong>{displayAmount(record.amount, decimals)} {symbol}</strong><small>{historyStatus(record)} · {depositDate(record.createdAt)}</small></span><IoChevronForward aria-hidden="true" /></button>)}</div></details> : null}
    </>}
  </div>;
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function displayAmount(units: string, decimals: number | null): string { return decimals === null ? units : formatTokenAmount(units, decimals); }
function depositDate(value: string): string { return new Date(Number(BigInt(value) / 1_000_000n)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function historyStatus(intent: BridgeIntent): string {
  if (bridgeComplete(intent)) return "Received";
  if (intent.steps.some((step) => step.state === "failed")) return "Stopped";
  if (intent.acceptedDeposit || intent.steps.some((step) => step.kind === "deposit" && step.state === "confirmed")) return "Receiving tokens";
  if (intent.steps.some((step) => step.kind === "deposit" && step.transactionHash)) return "Confirming";
  return "Ready to continue";
}
function friendlyError(error: string, intent: BridgeIntent | null): string {
  if (/header not found|RPC|network|fetch|timeout|timed out/i.test(error)) {
    if (intent?.steps.some((step) => step.kind === "deposit" && step.state === "confirmed")) return "Your Ethereum deposit is confirmed. We couldn’t check the received tokens yet; progress will update automatically.";
    if (intent?.steps.some((step) => step.kind === "approval" && step.state === "confirmed")) return "Could not check Ethereum. Your token approval is saved; continue to check this deposit and pick up where it stopped.";
    return intent ? "Could not check Ethereum. Your deposit progress is saved. Continue to try again." : "Could not connect to Ethereum. Please try again.";
  }
  if (/declined|reject|denied/i.test(error)) return "The wallet request was declined. Your progress is saved.";
  if (/amount|decimal/i.test(error) && !intent) return error;
  if (/source account/i.test(error)) return "Connect the same wallet account you used to start this deposit.";
  if (/browser wallet.*lost|unresolved.*browser|browser.*unresolved/i.test(error)) return "Check the transaction in your browser wallet to continue this deposit.";
  return intent ? "The deposit paused. Your progress is saved; check Details or continue to try again." : "Could not prepare the deposit. Check Details and try again.";
}
function busyLabel(intent: BridgeIntent | null, sourceName: string, phase: string | null): string {
  if (!intent) return "Connecting…";
  const pending = intent.steps.find((step) => step.state === "unknown" || step.state === "submitted");
  if (pending?.transactionHash) return "Waiting for Ethereum…";
  if (pending) return `Confirm in ${sourceName}`;
  if (intent.steps.some((step) => step.kind === "deposit" && step.state === "confirmed")) return "Checking deposit…";
  return phase === "checking-allowance" ? "Checking token approval…" : "Preparing next step…";
}
type DepositStepPresentation = { title: string; description: string; state: "done" | "current" | "future" | "failed" };
function depositSteps(intent: BridgeIntent, nativeSymbol: string, symbol: string, busy: boolean, phase: string | null): DepositStepPresentation[] {
  const approval = intent.steps.find((step) => step.kind === "approval")!;
  const reset = intent.steps.find((step) => step.kind === "reset_approval")!;
  const deposit = intent.steps.find((step) => step.kind === "deposit")!;
  const complete = bridgeComplete(intent);
  const received = complete || Boolean(intent.acceptedDeposit) || deposit.state === "confirmed";
  const depositStarted = deposit.state !== "ready" || phase === "submitting" || phase === "confirming";
  const approved = approval.state === "confirmed" || depositStarted || received;
  const approvalFailed = approval.state === "failed" || reset.state === "failed";
  const steps: DepositStepPresentation[] = [];
  if (intent.quote.tokenAddress) steps.push({ title: `Approve ${nativeSymbol}`, state: approvalFailed ? "failed" : approved ? "done" : "current", description: approvalFailed ? "Wallet request stopped" : approved ? "Token spending approved" : approval.transactionHash || reset.transactionHash && reset.state !== "confirmed" ? "Waiting for Ethereum confirmation" : reset.state === "unknown" ? "Confirm the token allowance reset in your wallet" : busy ? "Confirm token spending in your wallet" : "Permission to deposit your tokens" });
  steps.push({ title: "Deposit on Ethereum", state: deposit.state === "failed" ? "failed" : received ? "done" : approved || !intent.quote.tokenAddress ? "current" : "future", description: received ? "Deposit confirmed" : deposit.state === "failed" ? "Ethereum transaction stopped" : deposit.transactionHash ? "Waiting for Ethereum confirmation" : depositStarted && busy ? "Confirm the deposit in your wallet" : "Send tokens to the ck-token deposit contract" });
  steps.push({ title: `Receive ${symbol}`, state: complete ? "done" : received ? "current" : "future", description: complete ? "Available in your IC Wallet" : received ? `Waiting for ${symbol} to arrive · a few minutes` : "Automatically added to your IC Wallet" });
  return steps;
}
