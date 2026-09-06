import { useCallback, useEffect, useMemo, useState } from "react";
import { connectEthereumProvider, createMsgBusClient } from "neutron-tools/app";
import { createEvmWalletClient, createEvmRequestId } from "neutron-tools/evm_wallet";
import { IoOpenOutline, IoRefresh, IoWalletOutline } from "react-icons/io5";
import { bridgeComplete, bridgeLabel, createBridgeClient, executeBridgeDeposit, type BridgeIntent } from "./bridge.ts";
import { attachExternalBridgeTransaction, connectEvmBridge } from "./evm_bridge.ts";
import { parseTokenAmount } from "./format.ts";

export function WalletBridgeDeposit({ ledger, symbol, decimals, onRefresh, tray, openInTile }: {
  ledger: string; symbol: string; decimals: number | null; onRefresh: () => void;
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
  const [effectiveHashes, setEffectiveHashes] = useState<Record<string, string>>({});
  const current = records.find((record) => record.id === selectedId) ?? null;
  useEffect(() => {
    let active = true;
    setEffectiveHashes({});
    if (current) void Promise.all(current.steps.filter((step) => step.transactionHash).map(async (step) => [step.kind, await bridge.effectiveHash(current.id, step.kind)] as const)).then((entries) => {
      if (active) { const hashes: Record<string, string> = {}; for (const [kind, hash] of entries) if (hash !== null) hashes[kind] = hash; setEffectiveHashes(hashes); }
    }).catch((reason) => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [bridge, current?.id, current?.revision]);
  const remember = useCallback((intent: BridgeIntent) => {
    setRecords((old) => [intent, ...old.filter((record) => record.id !== intent.id)]);
    setSelectedId(intent.id);
  }, []);
  const reload = useCallback(async () => {
    const saved = await bridge.list(ledger);
    saved.sort((a, b) => BigInt(a.createdAt) > BigInt(b.createdAt) ? -1 : 1);
    setRecords(saved);
    return saved;
  }, [bridge, ledger]);
  useEffect(() => {
    let active = true;
    setLoading(true); setLoaded(false); setError(null); setSelectedId(null);
    void reload().then((saved) => { if (active) { setLoaded(true); setSelectedId(saved.find((record) => !bridgeComplete(record))?.id ?? null); } }).catch((reason) => { if (active) setError(message(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);
  const refresh = useCallback(async (record: BridgeIntent) => {
    const next = await bridge.refresh(record.id);
    remember(next);
    if (bridgeComplete(next)) onRefresh();
    return next;
  }, [bridge, onRefresh, remember]);
  useEffect(() => {
    if (!current || bridgeComplete(current) || busy || !current.steps.some((step) => step.kind === "deposit" && step.transactionHash)) return;
    let running = false;
    const run = async () => { if (running) return; running = true; try { await refresh(current); } catch (reason) { setError(message(reason)); } finally { running = false; } };
    const timer = globalThis.setInterval(() => void run(), 60_000);
    return () => globalThis.clearInterval(timer);
  }, [current, busy, refresh]);
  const submit = async () => {
    if (busy || loading || !loaded) return;
    setBusy(true); setError(null); setPhase(null);
    let external: Awaited<ReturnType<typeof connectEthereumProvider>> | null = null;
    try {
      if (tray) { await openInTile(); return; }
      if (current && (bridgeComplete(current) || current.steps.find((step) => step.kind === "deposit")?.state === "confirmed" || typeof current.source !== "string")) { await refresh(current); return; }
      let intent = current;
      const selectedSource = intent?.source ?? source;
      const quote = intent?.quote ?? await bridge.quote(ledger);
      let connection: Awaited<ReturnType<typeof connectEvmBridge>> | null = null;
      let account: string;
      if (selectedSource === "evm") {
        connection = await connectEvmBridge(evm, quote.helperAddress, quote.tokenAddress, intent?.account);
        account = connection.account.address;
      } else {
        external = await connectEthereumProvider();
        const accounts = await external.provider.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("The browser wallet returned no Ethereum account");
        account = accounts[0];
      }
      if (!intent) {
        if (decimals === null) throw new Error("Token decimals are unavailable");
        const units = parseTokenAmount(amount, decimals);
        if (BigInt(units) <= 0n) throw new Error("Deposit amount must be greater than zero");
        intent = await bridge.prepare({ id: createEvmRequestId(), ledger, source: selectedSource, account, amount: units });
        remember(intent);
      }
      const provider = connection?.provider ?? external?.provider;
      if (!provider) throw new Error("The deposit source is unavailable");
      const completed = await executeBridgeDeposit({ intent, client: bridge, provider, ...(connection ? { evm: connection.evm } : {}), onChange: remember, onProgress: (value) => setPhase(value.replaceAll("-", " ")) });
      remember(completed);
      await refresh(completed);
      onRefresh();
    } catch (reason) {
      setError(message(reason));
      // Reload authoritative pending state even if a write response was lost.
      await reload().catch(() => undefined);
    } finally {
      await external?.close().catch(() => undefined);
      setBusy(false); setPhase(null);
    }
  };
  const unresolvedBrowserStep = current?.source === "external" ? current.steps.find((step) => step.state === "unknown" && !step.transactionHash) : null;
  const recoverBrowserHash = async () => {
    if (!current || !unresolvedBrowserStep || busy) return;
    setBusy(true); setError(null);
    try {
      const recovered = await attachExternalBridgeTransaction(evm, bridge, current, unresolvedBrowserStep.kind, recoveryHash.trim());
      remember(recovered); setRecoveryHash("");
      if (unresolvedBrowserStep.kind === "deposit") await refresh(recovered);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };

  return <div className="wallet-ethereum-deposit">
    {tray ? <button type="button" className="nt-button nt-button--secondary nt-button--sm" onClick={() => void openInTile()}><IoOpenOutline /> Continue deposit in Wallet</button> : <>
      {records.length > 0 ? <label className="wallet-bridge-selector">Saved deposits<select className="nt-input" disabled={busy} value={selectedId ?? ""} onChange={(event) => { setSelectedId(event.target.value || null); setError(null); }}><option value="">New deposit</option>{records.map((record) => <option key={record.id} value={record.id}>{new Date(Number(BigInt(record.createdAt) / 1_000_000n)).toLocaleString()} · {bridgeLabel(record)}</option>)}</select></label> : null}
      {!current ? <>
        <label className="wallet-bridge-selector">Deposit source<select className="nt-input" disabled={busy || loading} value={source} onChange={(event) => setSource(event.target.value as "evm" | "external")}><option value="evm">EVM Wallet</option><option value="external">External browser wallet</option></select></label>
        <div className="wallet-ethereum-form"><label className="wallet-ethereum-amount"><input aria-label={`Amount of ${symbol} to deposit`} autoComplete="off" disabled={busy || loading} inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} /><strong>{symbol}</strong></label></div>
      </> : <p className="wallet-bridge-description">{current.source === "external" ? "Browser wallet" : typeof current.source === "string" ? "EVM Wallet" : "Root Agent"} · Ethereum Mainnet<br /><code>{current.account}</code><br />{displayAmount(current.amount, decimals)} {symbol}</p>}
      <button className="nt-button nt-button--sm wallet-metamask-button" type="button" disabled={busy || loading || !loaded || (!current && !amount.trim())} onClick={() => void submit()}>{busy ? <span className="wallet-spinner" /> : current ? <IoRefresh /> : <IoWalletOutline />}{current ? current.steps.find((step) => step.kind === "deposit")?.state === "confirmed" || typeof current.source !== "string" ? "Check deposit and mint" : "Resume saved deposit" : `Deposit with ${source === "evm" ? "EVM Wallet" : "browser wallet"}`}</button>
    </>}
    {unresolvedBrowserStep && !tray ? <label className="wallet-bridge-selector">Recover the existing browser transaction<small>Find the hash in the source wallet. Wallet checks its actual Ethereum fields before attaching it; this does not send a transaction.</small><input className="nt-input" aria-label="Existing browser transaction hash" placeholder="0x…" value={recoveryHash} disabled={busy} onChange={(event) => setRecoveryHash(event.target.value)} /><button className="nt-button nt-button--secondary nt-button--sm" type="button" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={() => void recoverBrowserHash()}>Verify and attach transaction</button></label> : null}
    {!loaded && !loading ? <button className="nt-button nt-button--secondary nt-button--sm" type="button" onClick={() => { setLoading(true); void reload().then((saved) => { setLoaded(true); setSelectedId(saved.find((record) => !bridgeComplete(record))?.id ?? null); setError(null); }).catch((reason) => setError(message(reason))).finally(() => setLoading(false)); }}>Retry loading saved deposits</button> : null}
    <small>Ethereum Mainnet only. Arbitrum assets must be bridged to Ethereum before wrapping into ck-tokens.</small>
    {current || error || phase ? <div className={`wallet-ethereum-status wallet-bridge-status${error ? " is-error" : current && bridgeComplete(current) ? " is-complete" : ""}`} role={error ? "alert" : "status"}><span><strong>{error ?? phase ?? (current ? bridgeLabel(current) : "Preparing deposit")}</strong>{current?.error && !error ? <small>{current.error}</small> : null}{current?.steps.filter((step) => step.transactionHash).map((step) => <span key={step.kind}><small>{step.kind.replaceAll("_", " ")} original transaction</small><code title={step.transactionHash!}>{step.transactionHash}</code>{effectiveHashes[step.kind] && effectiveHashes[step.kind] !== step.transactionHash ? <><small>Verified replacement execution</small><code title={effectiveHashes[step.kind]}>{effectiveHashes[step.kind]}</code></> : null}</span>)}</span></div> : null}
  </div>;
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function displayAmount(units: string, decimals: number | null): string { if (decimals === null) return `${units} atomic`; if (decimals === 0) return units; const value = units.padStart(decimals + 1, "0"); return `${value.slice(0, -decimals)}.${value.slice(-decimals)}`.replace(/\.?0+$/, ""); }
