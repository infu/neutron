import { useEffect, useMemo, useState } from "react";
import { createMsgBusClient } from "neutron-tools/app";
import { createEvmWalletClient, type EvmAccount, type EvmNetwork } from "neutron-tools/evm_wallet";
import { CapabilityFrame, EvidenceList, OperationResult, formatError, formatResult, useOperation } from "./lab_ui.tsx";
import {
  EVM_DEMO_KINDS,
  advanceEvmWalletDemo,
  createEvmDemoIntent,
  evmDemoRecordTerminal,
  evmDemoStepSucceeded,
  readEvmWalletSelection,
  type EvmDemoKind,
  type EvmDemoRecord,
} from "./evm_wallet_demo.ts";
import { createEvmDemoJournal } from "./evm_wallet_intent_storage.ts";
import { kitchenSinkPersonalMessage } from "./evm_wallet_signatures.ts";

const labels: Record<EvmDemoKind, string> = {
  native: "Native transfer",
  token: "ERC20 transfer",
  approval_call: "ERC20 approval + contract call",
  message: "Personal message signature",
  typed_data: "EIP-712 message signature",
};

export function EvmWalletPage() {
  const bus = useMemo(() => createMsgBusClient(), []);
  const wallet = useMemo(() => createEvmWalletClient(bus), [bus]);
  const journal = useMemo(() => createEvmDemoJournal(bus), [bus]);
  const operation = useOperation();
  const [accounts, setAccounts] = useState<EvmAccount[]>([]);
  const [networks, setNetworks] = useState<EvmNetwork[]>([]);
  const [chainId, setChainId] = useState("");
  const [accountId, setAccountId] = useState("main");
  const [kind, setKind] = useState<EvmDemoKind>("native");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("");
  const [calldata, setCalldata] = useState("");
  const [readTo, setReadTo] = useState("");
  const [readData, setReadData] = useState("");
  const [records, setRecords] = useState<EvmDemoRecord[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const account = accounts.find((entry) => entry.accountId === accountId);
  const selectedNetwork = networks.find((network) => network.chainId === chainId);
  const ready = !!account && !!selectedNetwork;
  const busy = !!operation.busy;

  const refreshRecords = async () => {
    try {
      const next = await journal.list();
      setRecords(next.reverse());
      setStorageError(null);
      setStorageReady(true);
    } catch (error) {
      setStorageReady(false);
      setStorageError(formatError(error));
    }
  };
  useEffect(() => { void refreshRecords(); }, [journal]);

  const discover = () => void operation.run("EVM Wallet accounts and networks", async () => {
    const { accountResult, networkResult } = await readEvmWalletSelection(wallet);
    setAccounts(accountResult.accounts);
    setNetworks(networkResult.networks);
    setAccountId((current) => accountResult.accounts.some((entry) => entry.accountId === current) ? current : accountResult.accounts[0]?.accountId ?? "main");
    setChainId((current) => networkResult.networks.some((entry) => entry.chainId === current) ? current : networkResult.networks[0]?.chainId ?? "");
    return { ...accountResult, ...networkResult };
  });

  const prepare = () => void operation.run("save complete EVM intent", async () => {
    if (!account || !selectedNetwork || !storageReady) throw new Error("Read the wallet account and network, and load saved intents first.");
    try {
      const intent = createEvmDemoIntent({ kind, account, chainId, destination, amountAtoms: amount, token, calldata });
      return await journal.prepare(intent);
    } finally {
      await refreshRecords();
    }
  });

  const advance = (record: EvmDemoRecord) => void operation.run("EVM Wallet review or status reconciliation", async () => {
    try {
      return await advanceEvmWalletDemo(wallet, journal, record.intent.id);
    } finally {
      await refreshRecords();
    }
  });

  return <CapabilityFrame
    status={ready ? "ready" : "setup"}
    statusLabel={ready ? "EVM Wallet account loaded" : "Separate EVM Wallet required"}
    purpose="Use the installed chain-key EVM Wallet from an ordinary app. Choose an explicit network and account for every request; EVM Wallet makes the signing decision in its own review."
    boundary="Kitchen Sink never receives EVM Wallet's custody capability or private keys. Its resident saves complete consumer intents under a Web Lock before a tile asks for an effect. The public wallet tools always use wallet-owned review. The root Agent must call the separate wallet root tools directly; a nested Kitchen Sink callback has no such authority."
    declaration={'// No additional signing or RPC capability is declared.\nimport { createEvmWalletClient } from "neutron-tools/evm_wallet";\nconst wallet = createEvmWalletClient(bus);'}
    evidence={<EvidenceList items={[
      { label: "Consumer endpoint", value: "app:evm_wallet:background" },
      { label: "Selected network", value: selectedNetwork ? `${selectedNetwork.name} · chain ${selectedNetwork.chainId}` : "Read accounts and networks first" },
      { label: "Selected account", value: account?.address ?? "Not loaded" },
      { label: "Amounts", value: "Atomic decimal units: native value in wei; ERC20 value in the token's smallest unit. Symbols alone never identify a token." },
      { label: "Saved state", value: "Complete requests, pinned account fingerprint, each operation ID/hash, and separate approval/call progress persist in the resident browser origin." },
      { label: "Freshness", value: "Reads show blockNumber and observedAtNs from EVM Wallet. Requested token balances are not a complete portfolio." },
    ]} />}
  >
    <div className="nt-command-bar">
      <button className="nt-button" data-tid="evm-wallet-discover" disabled={busy} onClick={discover} type="button">Read accounts and networks</button>
      <button className="nt-button nt-button--secondary" disabled={busy} onClick={() => void refreshRecords()} type="button">Reload saved intents</button>
    </div>
    <div className="ks-two-column">
      <label className="nt-field"><span className="nt-label">Network</span><select className="nt-select" data-tid="evm-wallet-chain" disabled={busy || networks.length === 0} value={chainId} onChange={(event) => setChainId(event.target.value)}>
        {!networks.length ? <option value="">Load networks</option> : null}
        {networks.map((network) => <option key={network.chainId} value={network.chainId}>{network.name} ({network.chainId})</option>)}
      </select></label>
      <label className="nt-field"><span className="nt-label">Account</span><select className="nt-select" disabled={busy || accounts.length === 0} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        {!accounts.length ? <option value="main">Load account</option> : null}
        {accounts.map((entry) => <option key={entry.accountId} value={entry.accountId}>{entry.accountId} · {entry.address}</option>)}
      </select></label>
    </div>

    <section className="ks-action-group">
      <h2>Balances and contract reads</h2>
      <label className="nt-field"><span className="nt-label">ERC20 token address (optional for balances)</span><input className="nt-input" data-tid="evm-wallet-token" placeholder="0x…" value={token} onChange={(event) => setToken(event.target.value)} /></label>
      <div className="nt-command-bar"><button className="nt-button nt-button--secondary" disabled={busy || !ready} onClick={() => void operation.run("live EVM balances", () => wallet.balances({ accountId: account!.accountId, chainId, tokens: token.trim() ? [token.trim()] : [] }))} type="button">Read native and selected token balances</button></div>
      <div className="ks-two-column">
        <label className="nt-field"><span className="nt-label">Read-only contract address</span><input className="nt-input" placeholder="0x…" value={readTo} onChange={(event) => setReadTo(event.target.value)} /></label>
        <label className="nt-field"><span className="nt-label">Read calldata (hex)</span><input className="nt-input" placeholder="0x18160ddd for ERC20 totalSupply()" value={readData} onChange={(event) => setReadData(event.target.value)} /></label>
      </div>
      <button className="nt-button nt-button--secondary" disabled={busy || !ready || !readTo || !readData} onClick={() => void operation.run("read EVM contract", () => wallet.readContract({ accountId: account!.accountId, chainId, to: readTo.trim(), data: readData.trim() }))} type="button">Read contract without signing</button>
    </section>

    <section className="ks-action-group">
      <h2>Prepare a wallet request</h2>
      <label className="nt-field"><span className="nt-label">Example</span><select className="nt-select" data-tid="evm-wallet-kind" disabled={busy} value={kind} onChange={(event) => setKind(event.target.value as EvmDemoKind)}>{EVM_DEMO_KINDS.map((entry) => <option key={entry} value={entry}>{labels[entry]}</option>)}</select></label>
      {kind === "message" || kind === "typed_data" ? <p className="nt-text">{kitchenSinkPersonalMessage} The EIP-712 example uses a KitchenSinkMessage type and the selected chain; it is not a permit.</p> : <>
        <div className="ks-two-column">
          <label className="nt-field"><span className="nt-label">{kind === "approval_call" ? "Spender and contract to call" : "Recipient address"}</span><input className="nt-input" data-tid="evm-wallet-destination" placeholder="0x…" value={destination} onChange={(event) => setDestination(event.target.value)} /></label>
          <label className="nt-field"><span className="nt-label">Amount ({kind === "native" ? "wei" : "token atomic units"})</span><input className="nt-input" data-tid="evm-wallet-amount" inputMode="numeric" placeholder="Positive integer" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
        </div>
        {kind !== "native" ? <p className="nt-text">Uses the ERC20 token contract entered above on chain {chainId || "(select a network)"}. For tokens with six decimals, 1000000 atomic units is one token.</p> : null}
        {kind === "approval_call" ? <>
          <label className="nt-field"><span className="nt-label">Contract call calldata</span><textarea className="nt-textarea" data-tid="evm-wallet-calldata" placeholder="Exact ABI-encoded call for your deployed test contract" value={calldata} onChange={(event) => setCalldata(event.target.value)} /></label>
          <p className="nt-text">Approval and call are two separate transactions and two wallet decisions. The call sends zero native value. Continue the call only after the approval receipt succeeds. A failed or declined call leaves the completed approval in place; revoke it in EVM Wallet if no longer needed.</p>
        </> : null}
      </>}
      <button className="nt-button" data-tid="evm-wallet-prepare" disabled={busy || !ready || !storageReady} onClick={prepare} type="button">Save intent for wallet review</button>
      <p className="nt-muted">Saving sends no transaction and requests no signature. The saved record below has the next action. Editing the form never changes a saved intent.</p>
    </section>

    {storageError ? <div className="nt-alert nt-alert--danger" role="alert">Saved EVM intents are unavailable: {storageError}</div> : null}
    <OperationResult {...operation} testId="evm-wallet-evidence" idle="No EVM effect runs when this page opens. Read or prepare an explicit request to see real wallet evidence." />

    <section className="ks-action-group" data-tid="evm-wallet-intents">
      <h2>Saved requests and recovery</h2>
      <p className="nt-text">A lost reply retains the same request ID. Resume checks the wallet's status first. Account replacement or a missing previously observed operation stops resubmission. A new effect can be prepared after this example returns a terminal result.</p>
      {records.length === 0 ? <p className="nt-muted">{storageReady ? "No saved EVM requests." : "Loading saved EVM requests…"}</p> : records.map((record) => <SavedEvmRequest key={record.intent.id} record={record} busy={busy || !storageReady} advance={() => advance(record)} />)}
    </section>
    <details className="ks-boundary">
      <summary>Direct-root Agent automation</summary>
      <p>Agent obtains or prepares an exact intent, then calls EVM Wallet's corresponding <code>evm_send_transaction_root_v1</code>, <code>evm_sign_message_root_v1</code>, or <code>evm_sign_typed_data_root_v1</code> tool directly. Kernel must attest the active root. Kitchen Sink's resident only stores intents and cannot forward root authority.</p>
      <pre className="nt-pre nt-pre--wrap"><code>{'// Executed by the authorized root Agent, with the saved request:\nawait context.kernel.callTool({\n  target: "app:evm_wallet:background",\n  name: "evm_send_transaction_root_v1",\n  arguments: savedTransactionRequest,\n});'}</code></pre>
    </details>
  </CapabilityFrame>;
}

function SavedEvmRequest({ record, busy, advance }: { record: EvmDemoRecord; busy: boolean; advance: () => void }) {
  const terminal = evmDemoRecordTerminal(record);
  const next = record.progress.findIndex((entry) => !evmDemoStepSucceeded(entry));
  return <article className="ks-evm-intent" data-tid={`evm-intent-${record.intent.id}`}>
    <h3>{labels[record.intent.kind]} · chain {record.intent.chainId}</h3>
    <p className="nt-muted">Request {record.intent.id} · {record.intent.account.address}</p>
    <ol>{record.intent.steps.map((step, index) => {
      const progress = record.progress[index]!;
      return <li key={step.request.requestId}><strong>{step.title}</strong>: {progress.operation?.status ?? (progress.attempted ? "reply unknown; reconcile saved request" : "saved; not submitted")}
        {progress.operation?.transactionHash ? <div className="ks-evm-hash">Transaction: <code>{progress.operation.transactionHash}</code></div> : null}
        {progress.operation?.replacementTransactionHash ? <div className="ks-evm-hash">Replacement: <code>{progress.operation.replacementTransactionHash}</code><p>The original transaction was replaced and this sequence has ended. Review the replacement in EVM Wallet. You can explicitly save a new intent above.</p></div> : null}
        {progress.operation ? <div>Operation {progress.operation.operationId}{progress.operation.receipt ? ` · receipt ${progress.operation.receipt.status} · ${progress.operation.receipt.finality}` : ""}</div> : null}
        {progress.signatureVerified ? <div>Signature independently verified against the saved account and message.</div> : null}
        {progress.operation?.message ? <div>{progress.operation.message}</div> : null}
        {progress.error ? <div role="alert">{progress.error}</div> : null}
      </li>;
    })}</ol>
    <button className="nt-button nt-button--secondary" disabled={busy || terminal} onClick={advance} type="button">{terminal ? "Recorded terminal outcome" : record.progress[next]?.attempted ? "Reconcile or resume saved request" : `Request wallet review: step ${next + 1}`}</button>
    <details><summary>Exact saved intent and wallet evidence</summary><pre className="nt-pre nt-pre--wrap">{formatResult(record)}</pre></details>
  </article>;
}
