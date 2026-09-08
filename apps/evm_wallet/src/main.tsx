import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  callTool,
  copyToClipboard,
  describeApp,
  exposeTool,
  loadTileContext,
  onAppStateChange,
  querySelf,
  updateSelf,
  type JsonObject,
} from "neutron-tools/app";
import {
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
  createEvmWalletClient,
  evmReplaceTransactionInputSchema,
  evmSendTransactionInputSchema,
  evmSignMessageInputSchema,
  evmSignTypedDataInputSchema,
  evmOperationOutputSchema,
  parseEvmOperationResult,
  parseEvmOperationStatusResult,
  type EvmSendTransactionRequest,
} from "neutron-tools/evm_wallet";
import { encodeFunctionData, erc20Abi, hexToString } from "viem";
import {
  METHODS,
  amount,
  atomicAmount,
  address,
  decodeKnownCall,
  errorMessage,
  hex,
  identityArgs,
  maxFee,
  parseOperation,
  parseSnapshot,
  requestId,
  shortAddress,
  unwrap,
  when,
  type Balance,
  type Network,
  type Operation,
  type Snapshot,
} from "./data.ts";
import { effectIntent, parseEffect, OWNER_REVIEW_TOOLS, PRESENT_TOOLS } from "./provider.ts";
import {
  acceptPrompt,
  checkPrompt,
  closeUncertainPrompt,
  declinePrompt,
  getPrompts,
  getPreparations,
  presentEffect,
  presentOwnEffect,
  refreshPromptEvidence,
  subscribePrompts,
  type PreparingReview,
} from "./prompts.ts";
import {
  assertLocalAccount,
  localTransferRequest,
  type LocalIntent,
} from "./local_intent.ts";
import { SignForm } from "./sign_form.tsx";
import { ReplacementForm } from "./replacement.tsx";
import { knownApprovals, parseAllowanceResult } from "./known_approvals.ts";
import { TokenReview } from "./token_review.tsx";
import { onFormActionKeyDown, runFormAction } from "./form_actions.ts";
import { queryHistoryWindow } from "./history.ts";
import { executeBrowserOperation, prepareBrowserOperation, reconcileBrowserOperation, refreshBrowserEvidence } from "./browser_operations.ts";
import { operationStatusLabel, operationStatusMessage, presentTypedData, type OperationPresentation } from "./presentation.ts";
import { useOperationPresentation } from "./decoders/use_presentation.ts";
import { DecoderSettings } from "./decoders/DecoderSettings.tsx";
import { clearTokenMetadataCache } from "./decoders/metadata.ts";
import { invalidateDecoderPacks } from "./decoders/store.ts";
import { useWalletRefresh } from "./use_wallet_refresh.ts";
import { evmTokenIcon, evmTokenInitials } from "neutron-tools/src/evm_token_icons.js";
import { curatedEvmTokens } from "neutron-tools/src/evm_assets.js";
import { formatUsd, usdPriceTitle, usdValue, type EvmUsdPrice } from "neutron-tools/src/evm_prices.js";
import { useEvmPrices } from "./use_usd_prices.ts";
import "./style.scss";

function tileRuntime(): boolean {
  try {
    const c = loadTileContext();
    return c.app === "evm_wallet" && c.tile === "evm_wallet";
  } catch {
    return false;
  }
}
if (tileRuntime())
  for (const [kind, schema] of [
    ["replacement", evmReplaceTransactionInputSchema],
    ["transaction", evmSendTransactionInputSchema],
    ["message", evmSignMessageInputSchema],
    ["typed_data", evmSignTypedDataInputSchema],
  ] as const) {
    exposeTool(
      PRESENT_TOOLS[kind],
      {
        title: "Review EVM Wallet request",
        description:
          "Review the exact backend-prepared request in the Wallet's foreground tile.",
        inputSchema: schema,
        outputSchema: evmOperationOutputSchema,
        annotations: {
          "neutron:audit": "metadata_only",
          "neutron:audience": "foreground_tile",
          "neutron:visibility": "same_app",
          "neutron:effects": ["write", "network", "user_visible_ui"],
        },
      },
      (args, context) => presentEffect(kind, args, context),
    );
    exposeTool(
      OWNER_REVIEW_TOOLS[kind],
      {
        title: "Review own EVM Wallet request",
        description:
          "Review a request from this Wallet's resident service in the originating Wallet tile.",
        inputSchema: schema,
        outputSchema: evmOperationOutputSchema,
        annotations: {
          "neutron:audit": "metadata_only",
          "neutron:visibility": "same_app",
          "neutron:effects": ["write", "network", "user_visible_ui"],
        },
      },
      (args, context) => presentOwnEffect(kind, args, context),
    );
  }
const tabs = [
  "Assets",
  "Send",
  "Activity",
  "Approvals",
  "Sign",
  "Settings",
] as const;
type Tab = (typeof tabs)[number];
type CustodyStatus = "checking" | "durable" | "legacy" | "reset-required" | "unknown";
export function EvmWalletApp() {
  const [custodyKernelVersion, setCustodyKernelVersion] = useState<number | null | undefined>(undefined);
  const custodyCheckRevision = useRef(0);
  const refreshCustody = useCallback(async () => {
    const revision = ++custodyCheckRevision.current;
    let version: number | null = null;
    try {
      const kernel = await describeApp("kernel");
      if (kernel && typeof kernel === "object" && !Array.isArray(kernel) &&
          kernel.id === "kernel" && typeof kernel.version === "number" &&
          Number.isSafeInteger(kernel.version) && kernel.version > 0) {
        version = kernel.version;
      }
    } catch { /* Version discovery failure must not promise account recovery. */ }
    if (custodyCheckRevision.current === revision) setCustodyKernelVersion(version);
  }, []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [balance, setBalance] = useState<Balance | null>(null),
    [history, setHistory] = useState<Operation[]>([]),
    [total, setTotal] = useState("0");
  const [chainId, setChainId] = useState("1"),
    [tab, setTab] = useState<Tab>("Assets"),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [balanceError, setBalanceError] = useState<string | null>(null),
    [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [manualReview, setManualReview] = useState<Operation | null>(null),
    [reviewError, setReviewError] = useState<string | null>(null),
    [reviewBusy, setReviewBusy] = useState(false);
  const prompts = useSyncExternalStore(subscribePrompts, getPrompts),
    prompt = prompts[0];
  const preparations = useSyncExternalStore(subscribePrompts, getPreparations);
  const reviewActive = !!prompt || !!manualReview || preparations.length > 0;
  const reviewActiveRef = useRef(reviewActive);
  reviewActiveRef.current = reviewActive;
  const account = snapshot?.accounts[0],
    network = snapshot?.networks.find((n) => n.chainId === chainId);
  const custodyStatus: CustodyStatus = custodyKernelVersion === undefined ? "checking"
    : custodyKernelVersion === null ? "unknown"
    : custodyKernelVersion < 346 ? "legacy"
    : !account ? "checking"
    : account.namespaceVersion === "2" ? "durable"
    : account.namespaceVersion !== "1" ? "unknown"
    : "reset-required";
  const custodyLifecycle = custodyStatus === "durable"
    ? "Your account belongs to EVM Wallet in this Neutron. Reinstalling the same app ID (evm_wallet) and account slot (main) restores the same address after you grant custody access. Compatible upgrades preserve your account."
    : custodyStatus === "legacy"
      ? "This account uses the older custody system. To start with the new stable account, fully uninstall EVM Wallet before installing Kernel 0.3.46, then reinstall EVM Wallet. This deliberately abandons the legacy account; it does not transfer its assets or permissions."
      : custodyStatus === "reset-required"
        ? "This Wallet still has an old account saved. Kernel 0.3.46 uses a different account and cannot sign for this saved address. Fully uninstall and reinstall EVM Wallet to start with the new stable account. The old account's assets and permissions do not move."
        : custodyStatus === "unknown"
          ? "Could not verify this account's custody lifecycle. Check the installed Kernel version and account before uninstalling or upgrading; recovery of this saved address has not been verified."
          : "Checking the account and this Neutron's Kernel version before showing account recovery advice.";
  const { priceFor } = useEvmPrices([
    { chainId, address: null },
    ...(snapshot?.assets ?? []).filter((asset) => asset.chainId === chainId),
  ]);
  // A network/account change renders before the balance refresh effect runs.
  const shownBalance = balance?.chainId === chainId && balance.address.toLowerCase() === account?.address.toLowerCase() ? balance : null;
  const nativePrice = priceFor({ chainId, address: null });
  const holdings = shownBalance ? [
    { atoms: shownBalance.nativeBalance, decimals: 18, price: nativePrice },
    ...(snapshot?.assets ?? []).filter((asset) => asset.chainId === chainId).map((asset) => {
      const token = shownBalance.tokens.find((entry) => entry.address.toLowerCase() === asset.address.toLowerCase());
      return { atoms: token?.balance ?? null, decimals: token?.decimals ?? null, price: priceFor(asset) };
    }),
  ] : [];
  const values = holdings.map((holding) => holding.atoms !== null && BigInt(holding.atoms) === 0n ? 0
    : holding.atoms === null || holding.decimals === null ? null : usdValue(holding.atoms, holding.decimals, holding.price));
  const pricedValues = values.filter((value): value is number => value !== null);
  const trackedUsd = pricedValues.length ? pricedValues.reduce((sum, value) => sum + value, 0) : null;
  const partialUsd = values.some((value) => value === null);
  const trackedUsdTitle = `Estimated value of the tokens tracked on this network.${partialUsd ? " Some balances or prices are unavailable; only priced balances are included." : ""}\n${[...new Set(holdings.filter((holding) => holding.atoms !== null && BigInt(holding.atoms) !== 0n).map((holding) => usdPriceTitle(holding.price)))].join("\n")}`;
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadedHistoryCount = useRef(0);
  const requestedHistoryCount = useRef(0);
  const loadQueued = useRef(false);
  const load = useCallback((minimumCount = 0) => {
    requestedHistoryCount.current = Math.max(requestedHistoryCount.current, loadedHistoryCount.current, minimumCount);
    if (loadInFlight.current) {
      loadQueued.current = true;
      return loadInFlight.current;
    }
    const work = (async () => {
      do {
        loadQueued.current = false;
        let current = parseSnapshot(await querySelf(METHODS.snapshot, [null]));
        if (current.accounts.length === 0) {
          await updateSelf(METHODS.accounts, [null], 120);
          current = parseSnapshot(await querySelf(METHODS.snapshot, [null]));
        }
        setSnapshot(current);
        const activity = await queryHistoryWindow(requestedHistoryCount.current);
        loadedHistoryCount.current = activity.operations.length;
        setHistory(activity.operations);
        setTotal(activity.total);
      } while (loadQueued.current);
    })().finally(() => { if (loadInFlight.current === work) loadInFlight.current = null; });
    loadInFlight.current = work;
    return work;
  }, []);
  const balanceTokenKey = JSON.stringify((snapshot?.assets ?? []).filter((asset) => asset.chainId === chainId).map((asset) => asset.address));
  const balanceKey = `${account?.address ?? ""}:${chainId}:${balanceTokenKey}`;
  const activeBalanceKey = useRef(balanceKey);
  activeBalanceKey.current = balanceKey;
  const balanceInFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const refreshBalance = useCallback((): Promise<void> => {
    if (!account) return Promise.resolve();
    if (balanceInFlight.current?.key === balanceKey) return balanceInFlight.current.promise;
    const work = createEvmWalletClient({ callTool }).balances({ accountId: "main", chainId, tokens: JSON.parse(balanceTokenKey) as string[] })
      .then((result) => {
        if (activeBalanceKey.current !== balanceKey) return;
        setBalanceError(null);
        setBalance({
          accountId: result.accountId, chainId: result.chainId, address: result.address,
          nativeBalance: result.nativeBalanceWei, blockNumber: result.blockNumber,
          observedAtNs: result.observedAtNs, completeness: result.completeness,
          tokens: result.tokens.map((token) => ({ address: token.address, balance: token.balanceAtoms,
            decimals: token.decimals === null ? null : Number(token.decimals), symbol: token.symbol, error: token.error })),
        });
      }, (reason) => { if (activeBalanceKey.current === balanceKey) setBalanceError(errorMessage(reason)); })
      .finally(() => { if (balanceInFlight.current?.promise === work) balanceInFlight.current = null; });
    balanceInFlight.current = { key: balanceKey, promise: work };
    return work;
  }, [account?.address, balanceKey, chainId, balanceTokenKey]);
  useEffect(() => {
    void refreshCustody();
  }, [tab, refreshCustody]);
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
    return onAppStateChange("evm_wallet", (event) => {
      if (event.topic === "evm_wallet") {
        void refreshCustody();
        void load().catch((e) => setError(errorMessage(e)));
        if (document.visibilityState !== "hidden" && !reviewActiveRef.current) void refreshBalance();
      }
    });
  }, [load, refreshBalance, refreshCustody]);
  useEffect(() => {
    setBalance(null);
    setBalanceError(null);
    void refreshBalance();
  }, [balanceKey, refreshBalance]);
  useWalletRefresh({
    enabled: !!account,
    load,
    refreshBalance,
    reconcile: (operation) => reconcileBrowserOperation({ querySelf, updateSelf }, operation),
    pending: history.filter((operation) => operation.kind === "transaction" && operation.chainId === chainId && ["signing", "signed", "submitted", "unknown"].includes(operation.status)),
    paused: reviewActive,
    onError: (reason) => setBackgroundError(errorMessage(reason)),
  });
  async function refresh() {
    clearTokenMetadataCache();
    invalidateDecoderPacks();
    setBusy(true);
    setError(null);
    setBackgroundError(null);
    try {
      await Promise.all([load(), refreshBalance(), refreshCustody()]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function refreshOperation(operation: Operation) {
    setBusy(true);
    setError(null);
    try {
      await reconcileBrowserOperation({ querySelf, updateSelf }, operation);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function openManualReview(operation: Operation) {
    if (reviewBusy) return;
    setManualReview(operation);
    setReviewBusy(true);
    setReviewError(null);
    try {
      let current = operation;
      if (current.status === "preparing") {
        // Activity restores the original journaled request, including its caller.
        // Resume only unsigned preparation; signing still needs Confirm below.
        const common = { requestId: current.requestId, accountId: current.accountId, chainId: current.chainId };
        const replacement = current.intent.replacement;
        const tx = current.intent.transaction;
        if (!replacement && !tx) throw new Error("The saved operation has no transaction intent to prepare");
        const intent = replacement ? effectIntent("replacement", parseEffect("replacement", {
          ...common, operationId: replacement.operationId, cancel: replacement.cancel,
          maxFeePerGasWei: replacement.maxFeePerGas, maxPriorityFeePerGasWei: replacement.maxPriorityFeePerGas,
        })) : effectIntent("transaction", parseEffect("transaction", {
          ...common, to: tx!.to, valueWei: tx!.value, data: tx!.data, accessList: tx!.accessList,
          ...(tx!.transactionType === null ? {} : { transactionType: tx!.transactionType }),
          ...(tx!.gasLimit === null ? {} : { gasLimit: tx!.gasLimit }),
          ...(tx!.maxFeePerGas === null ? {} : { maxFeePerGasWei: tx!.maxFeePerGas }),
          ...(tx!.maxPriorityFeePerGas === null ? {} : { maxPriorityFeePerGasWei: tx!.maxPriorityFeePerGas }),
          ...(tx!.gasPrice === null ? {} : { gasPriceWei: tx!.gasPrice }),
        }));
        current = await prepareBrowserOperation({ querySelf, updateSelf }, identityArgs(current.caller, current.requestId), intent);
      }
      setManualReview(current.status === "prepared" ? current : null);
      const tx = current.preparedTransaction ?? current.intent.transaction;
      if (current.status === "prepared" && tx && decodeKnownCall(tx.data)) await refreshManualEvidence(false, current, true);
      if (operation.status === "preparing") await load();
    } catch (e) {
      setManualReview(null);
      setError(`The saved request could not be prepared. Continue it in Activity to retry. ${errorMessage(e)}`);
    } finally {
      setReviewBusy(false);
    }
  }
  async function continueOperation(accept: boolean) {
    if (!manualReview || reviewBusy) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const next = accept ? await executeBrowserOperation({ querySelf, updateSelf }, manualReview) : parseOperation(
        await updateSelf(
          METHODS.reject,
          [
            {
              identity: identityArgs(
                manualReview.caller,
                manualReview.requestId,
              ),
            },
          ],
          120,
        ),
      );
      if (next.status === "prepared") {
        setManualReview(next);
        setReviewError(next.message);
        const tx = next.preparedTransaction ?? next.intent.transaction;
        if (tx && decodeKnownCall(tx.data)) {
          await refreshManualEvidence(false, next, true);
        }
      } else setManualReview(null);
      await load();
    } catch (e) {
      setReviewError(
        `Outcome unresolved. Check operation ${manualReview.operationId} in Activity before submitting again. ${errorMessage(e)}`,
      );
    } finally {
      setReviewBusy(false);
    }
  }
  async function refreshManualEvidence(refresh = true, current = manualReview, alreadyBusy = false) {
    if (!current || (reviewBusy && !alreadyBusy)) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const operation = await refreshBrowserEvidence({ querySelf, updateSelf }, current, refresh);
      setManualReview((previous) => previous?.operationId === current.operationId
        ? operation.status === "prepared" ? operation : null
        : previous);
      if (refresh) await load();
    } catch (e) {
      setReviewError(`Token observations could not be refreshed. ${errorMessage(e)}`);
    } finally {
      setReviewBusy(false);
    }
  }
  return (
    <main className="nt-app evm-app">
      <header className="evm-header">
        <div className="evm-brand">
          <img className="evm-brand-icon" src="static/icon.svg" alt="" />
          <div>
            <h1 className="evm-title">EVM Wallet</h1>

          </div>
        </div>
        <div className="evm-actions">
          <select
            aria-label="Network"
            data-testid="evm-network-select"
            className="nt-select evm-network-select"
            value={chainId}
            onChange={(e) => setChainId(e.target.value)}
          >
            {(snapshot?.networks ?? [{ chainId: "1", name: "Ethereum" }]).map(
              (n) => (
                <option key={n.chainId} value={n.chainId}>
                  {n.name}
                </option>
              ),
            )}
          </select>
          <IconButton icon="refresh" label={busy ? "Refreshing wallet…" : backgroundError ? `Some activity could not be refreshed: ${backgroundError}. Refresh wallet` : "Refresh wallet"} disabled={busy} onClick={() => void refresh()} />
        </div>
      </header>
      {error && (
        <p role="alert" className="evm-error">
          {error}
        </p>
      )}
      {custodyStatus === "reset-required" && (
        <p role="alert" className="evm-error" data-testid="evm-custody-reset-required">
          {custodyLifecycle}
        </p>
      )}
      <section className="evm-account">
        <div className="evm-row">
          <span className="evm-tag">Main account</span>
          <span className="evm-muted">
            {network?.name ?? "Ethereum"}
            {network?.testnet ? " · Test network" : ""}
          </span>
        </div>
        <strong className="evm-account-balance">
          {shownBalance ? amount(shownBalance.nativeBalance) : "—"}{" "}
          <span className="evm-muted">{network?.nativeSymbol ?? "ETH"}</span>
        </strong>
        <UsdEstimate atoms={shownBalance?.nativeBalance ?? null} decimals={18} price={nativePrice} testId="evm-native-usd" />
        <div className="evm-account-address" data-testid="evm-account-address">
          {account?.address ?? "Loading chain-key account…"}
        </div>
        <div className="evm-account-actions">
          <button
            className="nt-button"
            disabled={!account}
            onClick={() => setTab("Send")}
          >
            Send
          </button>
          <IconButton icon="copy" label="Copy receive address" disabled={!account} onClick={() => { if (account) void copyToClipboard(account.address).catch((e) => setError(errorMessage(e))); }} />
        </div>

        {balanceError && (
          <p className="evm-error">Balance unavailable: {balanceError}</p>
        )}
      </section>
      <nav className="evm-tabs" aria-label="Wallet pages">
        {tabs.filter((t) => !["Approvals", "Sign"].includes(t)).map((t) => (
          <button
            key={t}
            className={`evm-tab ${t === tab ? "is-active" : ""}`}
            aria-current={t === tab ? "page" : undefined}
            aria-label={t}
            title={t}
            onClick={() => setTab(t)}
          >
            {t === "Settings" ? <WalletIcon name="settings" /> : t}
          </button>
        ))}
      </nav>
      {tab === "Assets" && (
        <section className="evm-card">
          <div className="evm-row evm-section-heading"><h2 className="evm-card-title">Tokens</h2><IconButton icon="plus" label="Add a token" onClick={() => setTab("Settings")} /></div>
          <p className="evm-tracked-usd evm-muted" title={trackedUsdTitle} data-testid="evm-tracked-usd">
            {partialUsd ? "Priced token total" : "Tracked token total"} <strong>{trackedUsd !== null && Number.isFinite(trackedUsd) ? `≈ ${formatUsd(trackedUsd)}` : "—"}</strong>
          </p>
          <div className="evm-asset-list">
            <AssetRow
              chainId={chainId}
              tokenAddress={null}
              symbol={network?.nativeSymbol ?? "ETH"}
              name={network?.name ?? "Ethereum"}
              value={shownBalance ? amount(shownBalance.nativeBalance) : "Unavailable"}
              atoms={shownBalance?.nativeBalance ?? null}
              decimals={18}
              price={nativePrice}
            />
            {shownBalance?.tokens.map((token) => (
              <AssetRow
                key={token.address}
                chainId={chainId}
                tokenAddress={token.address}
                symbol={token.symbol ?? "Token"}
                name={curatedEvmTokens(chainId).find((entry) => entry.address?.toLowerCase() === token.address.toLowerCase())?.name ?? shortAddress(token.address)}
                value={
                  token.balance === null || token.decimals === null
                    ? "Unavailable"
                    : amount(token.balance, token.decimals)
                }
                atoms={token.balance}
                decimals={token.decimals}
                price={priceFor({ chainId, address: token.address })}
                error={token.error}
              />
            ))}
          </div>

        </section>
      )}
      {tab === "Send" && account && (
        <SendForm
          accountAddress={account.address}
          chainId={chainId}
          snapshot={snapshot!}
          history={history}
          priceFor={priceFor}
          onResult={() => void refresh()}
        />
      )}
      {tab === "Activity" && (
        <section className="evm-card">
          <h2 className="evm-card-title">Wallet activity</h2>
          <p className="evm-muted">Your sends, approvals and app requests. Amounts and limits come from each saved request.</p>
          <div className="evm-activity">
            {history.length === 0 ? (
              <p className="evm-empty">No saved requests yet.</p>
            ) : (
              history.map((operation) => (
                <OperationRow
                  key={operation.operationId}
                  operation={operation}
                  networks={snapshot?.networks ?? []}
                  assets={snapshot?.assets ?? []}
                  busy={busy}
                  onRefresh={() => void refreshOperation(operation)}
                  onReview={() => void openManualReview(operation)}
                />
              ))
            )}
          </div>
          {BigInt(total) > BigInt(history.length) && (
            <button
              className="nt-button nt-button--secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void load(loadedHistoryCount.current + 40)
                  .catch((e) => setError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
            >
              Load more
            </button>
          )}
        </section>
      )}
      {tab === "Approvals" && account && (
        <Approvals
          chainId={chainId}
          accountAddress={account.address}
          history={history}
          onResult={() => void refresh()}
        />
      )}
      {tab === "Sign" && account && (
        <SignForm
          chainId={chainId}
          accountAddress={account.address}
          onResult={() => void refresh()}
        />
      )}
      {tab === "Settings" && (
        <section className="evm-grid">
          <section className="evm-card">
            <h2 className="evm-card-title">Wallet tools</h2>
            <div className="evm-actions">
              <button className="nt-button nt-button--secondary" onClick={() => setTab("Approvals")}>Manage token approvals</button>
              <button className="nt-button nt-button--secondary" onClick={() => setTab("Sign")}>Sign a message</button>
            </div>
          </section>
          <section className="evm-card">
            <h2 className="evm-card-title">Add a token</h2>
            <TokenForm chainId={chainId} onSaved={() => void refresh()} />
          </section>
          <DecoderSettings />
          <section className="evm-card">
            <h2 className="evm-card-title">Account and network</h2>
            <p className={custodyStatus === "durable" ? "evm-muted" : "evm-notice"} data-testid="evm-custody-lifecycle">
              {custodyLifecycle}
            </p>
            <p className="evm-notice">
              Uninstalling removes wallet history, settings and pending
              transaction records. Account access depends on keeping this
              Neutron's state intact. There is no private-key or seed export.
            </p>
            <p className="evm-muted">{network?.finalityDescription}</p>
            <p className="evm-muted">
              Transactions need native gas on the selected EVM network.
              Chain-key signing consumes this Neutron's IC cycles. Network
              reads and transaction broadcasts connect directly from your browser.
            </p>
          </section>
        </section>
      )}
      {prompt && (
        <ReviewDialog
          operation={prompt.prepared.operation}
          networks={snapshot?.networks ?? []}
          assets={snapshot?.assets ?? []}
          error={prompt.error}
          queued={prompts.length - 1}
          busy={prompt.phase === "executing" || prompt.phase === "checking" || prompt.phase === "loading_evidence"}
          progress={prompt.phase === "loading_evidence" ? "Checking token balance and allowance…" : prompt.phase === "checking" ? "Checking transaction status…" : prompt.phase === "executing" ? "Confirming your request. Keep this window open…" : null}
          uncertain={prompt.phase === "uncertain"}
          onApprove={() => void acceptPrompt(prompt)}
          onDecline={() => void declinePrompt(prompt)}
          onCheck={() => void checkPrompt(prompt)}
          onRefreshEvidence={() => void refreshPromptEvidence(prompt)}
          onClose={() => closeUncertainPrompt(prompt)}
        />
      )}
      {!prompt && !manualReview && preparations[0] && (
        <PreparationStatus preparation={preparations[0]} snapshot={snapshot} />
      )}
      {!prompt && manualReview && (
        <ReviewDialog
          operation={manualReview}
          networks={snapshot?.networks ?? []}
          assets={snapshot?.assets ?? []}
          error={reviewError}
          busy={reviewBusy}
          progress={manualReview.status === "preparing" ? "Checking the saved transaction and network fee…" : null}
          uncertain={reviewError?.startsWith("Outcome unresolved") ?? false}
          onApprove={() => void continueOperation(true)}
          onRefreshEvidence={() => void refreshManualEvidence()}
          onDecline={() => void continueOperation(false)}
          onCheck={() => {
            void refreshOperation(manualReview).then(() =>
              setManualReview(null),
            );
          }}
          onClose={() => setManualReview(null)}
        />
      )}
    </main>
  );
}
type WalletIconName = "refresh" | "copy" | "external" | "plus" | "settings";
function WalletIcon({ name }: { name: WalletIconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "refresh" ? <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M18 17a7 7 0 0 1-12 1l-2-3" /></> : name === "copy" ? <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" /></> : name === "external" ? <><path d="M14 3h7v7M21 3l-11 11" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></> : name === "settings" ? <><path d="m9 3-.7 2.2-2 .9L4 5.6 2 9l1.6 1.8v2.4L2 15l2 3.4 2.3-.5 2 .9L9 21h6l.7-2.2 2-.9 2.3.5 2-3.4-1.6-1.8v-2.4L22 9l-2-3.4-2.3.5-2-.9L15 3Z" /><circle cx="12" cy="12" r="3" /></> : <path d="M12 5v14M5 12h14" />}
  </svg>;
}
function IconButton({ icon, label, disabled, onClick }: { icon: WalletIconName; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="nt-button nt-button--secondary evm-icon-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}><WalletIcon name={icon} /></button>;
}
function TokenIcon({ chainId, address, symbol }: { chainId: string; address: string | null; symbol: string }) {
  const src = evmTokenIcon(chainId, address);
  return <span className="evm-asset-icon" aria-hidden="true">{src ? <img src={src} alt="" /> : evmTokenInitials(symbol)}</span>;
}
function UsdEstimate({ atoms, decimals, price, testId }: {
  atoms: string | null;
  decimals: number | null;
  price: EvmUsdPrice | undefined;
  testId?: string;
}) {
  const value = atoms === null || decimals === null ? null : usdValue(atoms, decimals, price);
  return <span className="evm-usd" data-testid={testId} title={usdPriceTitle(price)} aria-label={value === null ? "USD value unavailable" : undefined}>
    {value === null ? "—" : `≈ ${formatUsd(value)}${price?.status === "stale" ? " · outdated" : ""}`}
  </span>;
}
function AssetRow({
  chainId,
  tokenAddress,
  symbol,
  name,
  value,
  atoms,
  decimals,
  price,
  error,
}: {
  chainId: string;
  tokenAddress: string | null;
  symbol: string;
  name: string;
  value: string;
  atoms: string | null;
  decimals: number | null;
  price: EvmUsdPrice | undefined;
  error?: string | null;
}) {
  return (
    <div className="evm-asset">
      <TokenIcon chainId={chainId} address={tokenAddress} symbol={symbol} />
      <div>
        <strong>{symbol}</strong>
        <p className="evm-muted evm-address">{name}</p>
        {error && <p className="evm-error">{error}</p>}
      </div>
      <div className="evm-asset-value"><strong>{value}</strong><UsdEstimate atoms={atoms} decimals={decimals} price={price} /></div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="evm-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className="evm-status" data-status={status}>
      {operationStatusLabel(status)}
    </span>
  );
}
function SendForm({
  accountAddress,
  chainId,
  snapshot,
  history,
  priceFor,
  onResult,
}: {
  accountAddress: string;
  chainId: string;
  snapshot: Snapshot;
  history: Operation[];
  priceFor: ReturnType<typeof useEvmPrices>["priceFor"];
  onResult: () => void;
}) {
  const [to, setTo] = useState(""),
    [value, setValue] = useState(""),
    [token, setToken] = useState("native"),
    [data, setData] = useState("0x"),
    [advanced, setAdvanced] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [saved, setSaved] = useState<LocalIntent | null>(null),
    [lastOperationId, setLastOperationId] = useState<string | null>(null);
  const tokens = snapshot.assets.filter((t) => t.chainId === chainId);
  const nativeSymbol = snapshot.networks.find((network) => network.chainId === chainId)?.nativeSymbol ?? "ETH";
  const selectedToken = tokens.find((entry) => entry.address.toLowerCase() === token.toLowerCase());
  const sendDecimals = token === "native" ? 18 : selectedToken?.decimals ?? null;
  let sendAtoms: string | null = null;
  if (sendDecimals !== null && value.trim()) {
    try { sendAtoms = atomicAmount(value, sendDecimals); } catch { /* Incomplete input has no USD estimate. */ }
  }
  const sending = useRef(false);
  useEffect(() => {
    setToken("native");
    setValue("");
    setData("0x");
    setAdvanced(false);
  }, [chainId]);
  async function send(resume = false) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      let intent: LocalIntent;
      if (resume) {
        const current = saved;
        if (!current) throw new Error("No saved request");
        intent = current;
        assertLocalAccount(intent, accountAddress);
      } else {
        if (saved)
          throw new Error(
            "Resolve the saved request before submitting these fields again",
          );
        const request = localTransferRequest({
          requestId: requestId(),
          chainId,
          token,
          assets: snapshot.assets,
          to,
          amount: value,
          ...(advanced ? { data } : {}),
        });
        intent = { request, expectedAddress: accountAddress };
        setSaved(intent);
      }
      const result = parseEvmOperationResult(
        await callTool({
          target: EVM_WALLET_TARGET,
          name: EVM_WALLET_TOOLS.sendTransaction,
          arguments: intent.request as unknown as JsonObject,
        }),
        intent.request,
        "transaction",
      );
      setLastOperationId(result.operationId);
      setNotice(operationStatusMessage(result.status));
      if (
        [
          "signed",
          "submitted",
          "confirmed",
          "reverted",
          "rejected",
          "failed",
          "replaced",
        ].includes(result.status)
      ) {
        setSaved(null);
        if (["signed", "submitted", "confirmed"].includes(result.status)) { setValue(""); setTo(""); }
      }
      onResult();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      assertLocalAccount(saved, accountAddress);
      const r = parseEvmOperationStatusResult(
        await callTool({
          target: EVM_WALLET_TARGET,
          name: EVM_WALLET_TOOLS.operationStatus,
          arguments: {
            accountId: saved.request.accountId,
            chainId: saved.request.chainId,
            requestId: saved.request.requestId,
          },
        }),
        saved.request,
      );
      setNotice(
        r.status === "not_found"
          ? "This transfer is saved. Continue to review it."
          : operationStatusMessage(r.status),
      );
      if (
        [
          "signed",
          "submitted",
          "confirmed",
          "reverted",
          "rejected",
          "failed",
          "replaced",
        ].includes(r.status)
      ) {
        setSaved(null);
      }
      onResult();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="evm-card">
      <h2 className="evm-card-title">Send</h2>
      {saved && (
        <div className="evm-notice" aria-live="polite">
          <strong>{busy ? "Preparing your transfer…" : "Continue your transfer"}</strong>
          <TransactionIntentDetails request={saved.request} snapshot={snapshot} />
          {busy && <p>Your confirmation will appear here shortly.</p>}
          <div className="evm-actions">
            <button
              className="nt-button nt-button--secondary"
              disabled={busy}
              onClick={() => void check()}
            >
              Check status
            </button>
            <button
              className="nt-button"
              disabled={busy}
              onClick={() => void send(true)}
            >
              Continue
            </button>
          </div>
        </div>
      )}
      <form
        className="evm-form"
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => onFormActionKeyDown(e, busy || saved !== null, () => void send())}
      >
        <Field label="Asset">
          <div className="evm-token-select"><TokenIcon chainId={chainId} address={token === "native" ? null : token} symbol={token === "native" ? nativeSymbol : tokens.find((entry) => entry.address === token)?.symbol ?? "Token"} />
          <select
            className="nt-select"
            data-testid="evm-send-asset"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          >
            <option value="native">{nativeSymbol}</option>
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select></div>
        </Field>
        <Field label={advanced ? "Recipient or contract" : "Recipient"}>
          <input
            className="nt-input"
            data-testid="evm-send-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x…"
            required
            spellCheck={false}
          />
        </Field>
        <Field label="Amount">
          <input
            className="nt-input"
            data-testid="evm-send-amount"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.0"
            required
          />
          <UsdEstimate atoms={sendAtoms} decimals={sendDecimals} price={priceFor({ chainId, address: token === "native" ? null : token })} testId="evm-send-usd" />
        </Field>
        {token === "native" && (
          <details className="evm-pro-details">
            <summary>Advanced</summary>
            <label>
              <input
                type="checkbox"
                checked={advanced}
                onChange={(e) => setAdvanced(e.target.checked)}
              />{" "}
              Include contract calldata
            </label>
            {advanced && (
              <Field label="Exact calldata">
                <textarea
                  className="nt-input evm-code"
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                  spellCheck={false}
                />
              </Field>
            )}
          </details>
        )}
        {error && (
          <p role="alert" className="evm-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="evm-notice evm-address">
            {history.find((operation) => operation.operationId === lastOperationId) ? operationStatusMessage(history.find((operation) => operation.operationId === lastOperationId)!.status) : notice}
          </p>
        )}
        <button
          type="button"
          className="nt-button"
          data-testid="evm-send-review"
          disabled={busy || saved !== null}
          onClick={(e) => runFormAction(e.currentTarget.form, busy || saved !== null, () => void send())}
        >
          {busy ? "Preparing…" : "Continue"}
        </button>
        <p className="evm-muted">Review the amount and network fee before you confirm.</p>
      </form>
    </section>
  );
}
function OperationRow({ operation, networks, assets, busy, onRefresh, onReview }: {
  operation: Operation;
  networks: Network[];
  assets: Snapshot["assets"];
  busy: boolean;
  onRefresh: () => void;
  onReview: () => void;
}) {
  const network = networks.find((n) => n.chainId === operation.chainId);
  const presentation = useOperationPresentation(operation, assets, network);
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const typedData = operation.intent.typedDataJson ? presentTypedData(operation.intent.typedDataJson) : null;
  const messageText = readableMessage(operation.intent.messageHex);
  const pending = ["preparing", "prepared", "signing", "signed", "submitted", "unknown"].includes(operation.status);
  return (
    <article className="evm-operation" data-testid={`evm-operation-${operation.operationId}`}>
      <div className="evm-row">
        <strong>{presentation.title}</strong>
        <Status status={operation.status} />
      </div>
      {presentation.amount && <div className="evm-operation-amount" data-testid="evm-activity-amount">
        <span>{presentation.amountLabel}</span>
        <strong>{presentation.amount}</strong>
      </div>}
      <p className="evm-muted">
        {network?.name ?? `Chain ${operation.chainId}`} · {operation.caller.appId === "evm_wallet" ? "You" : operation.caller.appId} · {when(operation.createdAtNs)}
      </p>
      {presentation.decoder?.kind === "imported" && <p className="evm-muted" data-testid="evm-decoder-caption">Decoded by {presentation.decoder.name} · v{presentation.decoder.version}</p>}
      {presentation.description && <p className={presentation.unlimitedApproval ? "evm-notice" : "evm-muted"}>{presentation.description}</p>}
      {presentation.decoderWarning && <p className="evm-notice" data-testid="evm-decoder-warning">{presentation.decoderWarning}</p>}
      {(presentation.parties.length > 0 || presentation.nativeValue || typedData) && <dl className="evm-activity-fields">
        {presentation.parties.map((party, index) => <div key={`${party.label}:${index}`}><dt>{party.label}</dt><dd><PresentationValue value={party.value} /></dd></div>)}
        {presentation.nativeValue && <div><dt>Native value</dt><dd>{presentation.nativeValue}</dd></div>}
        {typedData?.domainName && <div><dt>Signing domain</dt><dd>{typedData.domainName}</dd></div>}
        {typedData?.primaryType && <div><dt>Signature type</dt><dd>{typedData.primaryType}</dd></div>}
      </dl>}
      {messageText && <p className="evm-operation-message" data-testid="evm-activity-message">{messageText}</p>}
      {!["confirmed", "finalized"].includes(operation.status) && <p className={operation.status === "failed" || operation.status === "reverted" ? "evm-error" : "evm-muted"}>{operationStatusMessage(operation.status, operation.kind)}</p>}
      <div className="evm-actions">
        {["preparing", "prepared"].includes(operation.status) && <button className="nt-button" disabled={busy} onClick={onReview}>Continue</button>}
        {pending && <IconButton icon="refresh" label={busy ? "Checking transaction…" : "Refresh transaction status"} disabled={busy} onClick={onRefresh} />}
        {operation.transactionHash && network && <a className="evm-icon-button evm-text-link" title="View on explorer" aria-label="View on explorer" href={`${network.explorerUrl}/tx/${operation.transactionHash}`} target="_blank" rel="noreferrer"><WalletIcon name="external" /></a>}
      </div>
      <details className="evm-pro-details">
        <summary>Details</summary>
        <dl className="evm-review-details">
          {presentation.advancedDetails?.map((field, index) => <div className="evm-review-detail-pair" key={`${field.label}:${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          <DecoderDetails presentation={presentation} />
          <dt>Account</dt><dd>{operation.address}</dd>
          <dt>Operation</dt><dd>{operation.operationId}</dd>
          <dt>Request</dt><dd>{operation.requestId}</dd>
          {presentation.contract && <><dt>Contract</dt><dd>{presentation.contract}</dd></>}
          {tx && <><dt>Native value (wei)</dt><dd>{tx.value}</dd><dt>Calldata</dt><dd className="evm-activity-calldata">{tx.data}</dd></>}
          {operation.transactionHash && <><dt>Transaction</dt><dd>{operation.transactionHash}</dd></>}
          {operation.finality && <><dt>Finality</dt><dd>{operation.finality}</dd></>}
          {operation.replacementTransactionHash && <><dt>Replacement</dt><dd>{operation.replacementTransactionHash}</dd></>}
          {typedData?.verifyingContract && <><dt>Verifying contract</dt><dd>{typedData.verifyingContract}</dd></>}
          {typedData?.chainId && <><dt>Signing chain</dt><dd>{typedData.chainId}</dd></>}
          {typedData?.fields.map((field, index) => <div className="evm-review-detail-pair" key={`typed:${field.label}:${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
        </dl>
        {operation.message && <p className="evm-notice">{operation.message}</p>}
        {operation.intent.messageHex !== undefined && <><p className="evm-muted">Message</p><pre className="evm-code">{messageText ?? operation.intent.messageHex}</pre><p className="evm-muted">Exact message bytes</p><pre className="evm-code">{operation.intent.messageHex}</pre></>}
        {operation.intent.typedDataJson !== undefined && <><p className="evm-muted">Exact signed data</p><pre className="evm-code">{operation.intent.typedDataJson}</pre></>}
        {operation.signature && <><p className="evm-muted">Signature</p><pre className="evm-code">{operation.signature}</pre></>}
      </details>
      {operation.kind === "transaction" && ["signed", "submitted", "unknown"].includes(operation.status) && <ReplacementForm operation={operation} onResult={onRefresh} />}
    </article>
  );
}
function readableMessage(messageHex: string | undefined): string | null {
  if (messageHex === undefined) return null;
  try { return hexToString(hex(messageHex)); } catch { return null; }
}
function PresentationValue({ value }: { value: string }) {
  return /^0x[0-9a-f]{40}$/i.test(value)
    ? <span className="evm-address" title={value}>{shortAddress(value)}</span>
    : <span>{value}</span>;
}
function DecoderDetails({ presentation }: { presentation: OperationPresentation }) {
  const decoder = presentation.decoder;
  return decoder ? <>
    <dt>Decoder</dt><dd>{decoder.name} · v{decoder.version}</dd>
    <dt>Decoder origin</dt><dd>{decoder.kind === "imported" ? "Imported decoder pack" : "Included with EVM Wallet"}</dd>
    <dt>Decoder ID</dt><dd>{decoder.id}</dd>
    {decoder.source && <><dt>Decoder source</dt><dd>{decoder.source}</dd></>}
    {decoder.sha256 && <><dt>Decoder SHA-256</dt><dd>{decoder.sha256}</dd></>}
  </> : null;
}
function TransactionIntentDetails({ request, snapshot }: {
  request: EvmSendTransactionRequest;
  snapshot: Snapshot | null;
}) {
  const decoded = decodeKnownCall(request.data);
  const network = snapshot?.networks.find((entry) => entry.chainId === request.chainId);
  const asset = snapshot?.assets.find((entry) => entry.chainId === request.chainId && entry.address.toLowerCase() === request.to.toLowerCase());
  const transferred = decoded?.details.find(([label]) => label === "Amount (atomic units)")?.[1];
  const allowance = decoded?.details.find(([label]) => label === "Allowance (atomic units)")?.[1];
  const recipient = decoded?.details.find(([label]) => label === "Recipient")?.[1];
  const spender = decoded?.details.find(([label]) => label === "Spender")?.[1];
  return (
    <div className="evm-address" data-testid="evm-intent-details">
      {transferred && recipient ? <>
        <p>{asset ? `${amount(transferred, asset.decimals)} ${asset.symbol}` : decoded?.name === "ERC-20 transfer from" ? `${transferred} (amount or token ID)` : `${transferred} token atomic units`} to {recipient}</p>

        {request.valueWei !== "0" && <p>Native value: {amount(request.valueWei)} {network?.nativeSymbol ?? "ETH"}</p>}
      </> : allowance && spender ? <>
        <p>{asset && allowance === "0" ? "Revoke" : "Approve"} {asset ? `${amount(allowance, asset.decimals)} ${asset.symbol}` : `${allowance} (allowance or token ID)`}</p>
        <p className="evm-muted">Spender: {spender}</p>
        {request.valueWei !== "0" && <p>Native value: {amount(request.valueWei)} {network?.nativeSymbol ?? "ETH"}</p>}
      </> : <p>{request.data === "0x" || request.valueWei !== "0" ? `${amount(request.valueWei)} ${network?.nativeSymbol ?? "ETH"} · ` : "Contract interaction · "}{request.to}</p>}
    </div>
  );
}
function PreparationStatus({ preparation, snapshot }: { preparation: PreparingReview; snapshot: Snapshot | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - preparation.startedAt) / 1000));
  const network = snapshot?.networks.find((entry) => entry.chainId === preparation.request.chainId);
  return (
    <div className="evm-review-overlay">
      <section className="evm-review" role="status" aria-live="polite" data-testid="evm-preparing-review">
        <span className="evm-tag">EVM Wallet</span>
        <h2>Preparing your {preparation.kind === "transaction" || preparation.kind === "replacement" ? "transaction" : "signature"}</h2>
        <p>{network?.name ?? `Chain ${preparation.request.chainId}`} · {elapsed}s elapsed</p>
        {preparation.kind === "transaction" && <TransactionIntentDetails request={preparation.request as EvmSendTransactionRequest} snapshot={snapshot} />}
        <p>{preparation.kind === "transaction" || preparation.kind === "replacement" ? "Checking your balance and network fee…" : "Loading the message for your review…"}</p>
        <p className="evm-muted">Your approval is required before signing.</p>
      </section>
    </div>
  );
}
function ReviewDialog({
  operation,
  networks,
  assets,
  error,
  busy,
  progress = null,
  uncertain = false,
  queued = 0,
  onApprove,
  onDecline,
  onCheck,
  onRefreshEvidence,
  onClose,
}: {
  operation: Operation;
  networks: Network[];
  assets: Snapshot["assets"];
  error: string | null;
  busy: boolean;
  progress?: string | null;
  uncertain?: boolean;
  queued?: number;
  onApprove: () => void;
  onDecline: () => void;
  onCheck: () => void;
  onRefreshEvidence: () => void;
  onClose: () => void;
}) {
  const network = networks.find((n) => n.chainId === operation.chainId),
    tx = operation.preparedTransaction ?? operation.intent.transaction,
    decoded = tx ? decodeKnownCall(tx.data) : null;
  const presentation = useOperationPresentation(operation, assets, network);
  const typedData = operation.intent.typedDataJson ? presentTypedData(operation.intent.typedDataJson) : null;
  const { priceFor } = useEvmPrices([
    { chainId: operation.chainId, address: null },
    ...assets.filter((asset) => asset.chainId === operation.chainId),
    ...(presentation.tokenAddress ? [{ chainId: operation.chainId, address: presentation.tokenAddress }] : []),
  ]);
  const reviewAsset = presentation.tokenAddress ? assets.find((asset) => asset.chainId === operation.chainId && asset.address.toLowerCase() === presentation.tokenAddress?.toLowerCase()) : null;
  const reviewDecimals = presentation.amountDecimals ?? (presentation.tokenAddress ? reviewAsset?.decimals ?? null : 18);
  const reviewAtoms = presentation.amountAtoms ?? presentation.swap?.amountIn ?? presentation.permit2Approval?.amount
    ?? decoded?.details.find(([label]) => label === "Allowance (atomic units)" || label === "Amount (atomic units)")?.[1]
    ?? (!presentation.decoder && presentation.tokenAddress == null ? tx?.value ?? null : null);
  const reviewPrice = priceFor({ chainId: operation.chainId, address: presentation.tokenAddress ?? null });
  const nativePrice = priceFor({ chainId: operation.chainId, address: null });
  const messageText = readableMessage(operation.intent.messageHex);
  const fee = operation.review;
  return (
    <div className="evm-review-overlay">
      <section
        className="evm-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evm-review-title"
        data-testid="evm-review"
      >
        <div className="evm-row">
          <span className="evm-tag">EVM Wallet</span>
          {queued > 0 && (
            <span className="evm-muted">{queued} more awaiting review</span>
          )}
        </div>
        <div className="evm-review-heading">
          <h2 id="evm-review-title">{presentation.title}</h2>
          <p className="evm-muted">{operation.caller.appId === "evm_wallet" ? "Your wallet" : `Requested by ${operation.caller.appId}`}</p>
          {presentation.decoder?.kind === "imported" && <p className="evm-muted" data-testid="evm-decoder-caption">Decoded by {presentation.decoder.name} · v{presentation.decoder.version}</p>}
        </div>
        {presentation.amount && <div className="evm-review-amount"><span>{presentation.amountLabel}</span><div>{presentation.tokenAddress !== undefined && <TokenIcon chainId={operation.chainId} address={presentation.tokenAddress} symbol={presentation.tokenSymbol ?? network?.nativeSymbol ?? "ETH"} />}<strong>{presentation.amount}</strong></div></div>}
        {presentation.amount && reviewAtoms !== null && (tx || presentation.tokenAddress !== undefined) && !presentation.unlimitedApproval && !presentation.liquidity && <UsdEstimate atoms={reviewAtoms} decimals={reviewDecimals} price={reviewPrice} testId="evm-review-usd" />}
        {presentation.description && <p className={presentation.unlimitedApproval ? "evm-notice" : "evm-muted"}>{presentation.description}</p>}
        {presentation.decoderWarning && <p className="evm-notice" data-testid="evm-decoder-warning">{presentation.decoderWarning}</p>}
        <dl className="evm-review-details evm-review-overview">
          {presentation.parties.map((party, index) => <div className="evm-review-detail-pair" key={`${party.label}:${index}`}><dt>{party.label}</dt><dd><PresentationValue value={party.value} /></dd></div>)}
          <dt>{operation.kind === "typed_data" ? "Signing network" : "Network"}</dt><dd>{network?.name ?? `Chain ${operation.chainId}`}</dd>
          {fee && <><dt>Maximum network fee</dt><dd>{amount(maxFee(fee))} {network?.nativeSymbol ?? "ETH"}<UsdEstimate atoms={maxFee(fee)} decimals={18} price={nativePrice} testId="evm-review-fee-usd" /></dd></>}
          {presentation.nativeValue && <><dt>Also sending</dt><dd>{presentation.nativeValue}<UsdEstimate atoms={tx?.value ?? null} decimals={18} price={nativePrice} /></dd></>}
        </dl>
        {operation.intent.messageHex !== undefined && <>
          <p className="evm-notice">Only sign if you recognize this app and understand the message.</p>
          <pre className="evm-code">{messageText ?? operation.intent.messageHex}</pre>
        </>}
        {operation.intent.typedDataJson !== undefined && <>
          <p className="evm-notice">This signature can authorize actions, including spending tokens. Review what the app is asking you to sign.</p>
          {typedData && <dl className="evm-review-details">
            {typedData.domainName && <><dt>App</dt><dd>{typedData.domainName}</dd></>}
            {typedData.verifyingContract && <><dt>Verifying contract</dt><dd>{typedData.verifyingContract}</dd></>}
            {typedData.chainId && <><dt>Signing chain</dt><dd>{typedData.chainId}</dd></>}
            {typedData.fields.map((field) => <div className="evm-review-detail-pair" key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>}
          {!typedData && <pre className="evm-code">{operation.intent.typedDataJson}</pre>}
        </>}
        {operation.intent.replacement && <p className="evm-notice">{operation.intent.replacement.cancel ? "This will try to cancel your pending transaction." : "This will try to speed up your pending transaction."} The original can still confirm first.</p>}
        {fee?.simulation && /revert|failed|error/i.test(fee.simulation) && <p className="evm-notice">Simulation result: {fee.simulation}</p>}
        {decoded && operation.status === "prepared" && operation.tokenEvidence && [operation.tokenEvidence.balance, operation.tokenEvidence.allowance].some((entry) => entry?.error) && <p className="evm-notice">Some token information is unavailable. Open details to review what could be checked.</p>}
        <details className="evm-pro-details" data-testid="evm-review-pro-details">
          <summary>Advanced details</summary>
        <dl className="evm-review-details">
          <DecoderDetails presentation={presentation} />
          {presentation.advancedDetails?.map((field) => <div className="evm-review-detail-pair" key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          <dt>Network</dt>
          <dd>
            {network?.name ?? `Chain ${operation.chainId}`} ·{" "}
            {operation.chainId}
          </dd>
          <dt>Signing account</dt>
          <dd>{operation.address}</dd>
          <dt>Request</dt>
          <dd data-testid="evm-review-request-id">{operation.requestId}</dd>
          {tx && (
            <>
              <dt>{tx.data === "0x" ? "Recipient" : "Contract"}</dt>
              <dd>{tx.to}</dd>
              <dt>Native value</dt>
              <dd>
                {amount(tx.value)} {network?.nativeSymbol ?? "ETH"} ({tx.value} wei)
              </dd>
              {decoded?.details.map(([label, value]) => (
                <div className="evm-review-detail-pair" key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </>
          )}
          {fee && (
            <>
              <dt>Observed native balance</dt>
              <dd>
                {amount(fee.balance)} {network?.nativeSymbol ?? "ETH"} ({fee.balance} wei)
              </dd>
              <dt>Nonce</dt>
              <dd>{fee.nonce}</dd>
              <dt>Gas limit</dt>
              <dd>{fee.gasLimit}</dd>
              <dt>Maximum network fee</dt>
              <dd>{amount(maxFee(fee))} {network?.nativeSymbol ?? "ETH"}</dd>
              {fee.maxFeePerGas && (
                <>
                  <dt>Max fee per gas</dt>
                  <dd>{fee.maxFeePerGas} wei</dd>
                </>
              )}
              {fee.maxPriorityFeePerGas && (
                <>
                  <dt>Priority fee per gas</dt>
                  <dd>{fee.maxPriorityFeePerGas} wei</dd>
                </>
              )}
              {fee.gasPrice && (
                <>
                  <dt>Gas price</dt>
                  <dd>{fee.gasPrice} wei</dd>
                </>
              )}
              <dt>Simulation</dt>
              <dd>{fee.simulation}</dd>
              <dt>Prepared at</dt>
              <dd>{when(fee.observedAtNs)}</dd>
            </>
          )}
        </dl>
        {decoded && (
          <p className="evm-muted">
            Method labels are inferred from calldata. They do not verify the
            contract’s behavior.
          </p>
        )}
        {decoded && operation.status === "prepared" && !uncertain && (
          <TokenReview
            evidence={operation.tokenEvidence}
            fungible={presentation.tokenSymbol !== null || decoded.name === "ERC-20 transfer"}
            busy={busy}
            onRefresh={onRefreshEvidence}
          />
        )}
        {tx && tx.data !== "0x" && (
          <details>
            <summary>Exact calldata</summary>
            <pre className="evm-code">{tx.data}</pre>
          </details>
        )}
        {tx && tx.accessList.length > 0 && (
          <details>
            <summary>Access list</summary>
            <pre className="evm-code">
              {JSON.stringify(tx.accessList, null, 2)}
            </pre>
          </details>
        )}
        {operation.intent.messageHex !== undefined && <details><summary>Exact message bytes</summary><pre className="evm-code">{operation.intent.messageHex}</pre></details>}
        {operation.intent.typedDataJson !== undefined && typedData && <details><summary>Exact signed data</summary><pre className="evm-code">{operation.intent.typedDataJson}</pre></details>}
        <dl className="evm-review-details"><dt>Requesting app installation</dt><dd>{operation.caller.installationUid}</dd><dt>Review revision</dt><dd>{operation.reviewRevision}</dd></dl>
        {operation.message && (
          <p className="evm-notice" role="note">
            {operation.message}
          </p>
        )}
        </details>
        {error && (
          <p className="evm-error" role="alert">
            {error}
          </p>
        )}
        {progress && <p className="evm-notice" role="status">{progress}</p>}
        <footer className="evm-review-footer">
          {uncertain ? (
            <>
              <button
                className="nt-button nt-button--secondary"
                disabled={busy}
                onClick={onClose}
              >
                Close
              </button>
              <button
                className="nt-button"
                data-testid="evm-review-check"
                disabled={busy}
                onClick={onCheck}
              >
                {busy ? "Checking…" : "Check status"}
              </button>
            </>
          ) : (
            <>
              <button
                className="nt-button nt-button--secondary"
                data-testid="evm-review-decline"
                disabled={busy}
                onClick={onDecline}
              >
                Cancel
              </button>
              <button
                className="nt-button"
                data-testid="evm-review-approve"
                disabled={busy}
                onClick={onApprove}
              >
                {busy
                  ? "Working…"
                  : operation.kind === "transaction"
                    ? "Confirm"
                    : "Sign"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
function TokenForm({
  chainId,
  onSaved,
}: {
  chainId: string;
  onSaved: () => void;
}) {
  const [contract, setContract] = useState(""),
    [symbol, setSymbol] = useState(""),
    [decimals, setDecimals] = useState("18"),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (
        !/^(0|[1-9][0-9]{0,2})$/.test(decimals) ||
        Number(decimals) > 255
      )
        throw new Error("Decimals must be an integer from 0 to 255");
      unwrap(
        await updateSelf(
          METHODS.assetSet,
          [{ chain_id: chainId, address: address(contract), symbol, decimals }],
          60,
        ),
      );
      setContract("");
      setSymbol("");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="evm-form"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => onFormActionKeyDown(e, busy, () => void save())}
    >
      <Field label="Token contract">
        <input
          className="nt-input"
          required
          value={contract}
          onChange={(e) => setContract(e.target.value)}
          placeholder="0x…"
        />
      </Field>
      <Field label="Display symbol">
        <input
          className="nt-input"
          required
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        />
      </Field>
      <Field label="Decimals">
        <input
          className="nt-input"
          required
          value={decimals}
          onChange={(e) => setDecimals(e.target.value)}
          inputMode="numeric"
        />
      </Field>
      <p className="evm-muted">
        Tokens are identified by chain and contract. A display symbol is not
        proof of token identity. Verify display details against the token
        contract before saving.
      </p>
      {error && <p className="evm-error">{error}</p>}
      <button
        type="button"
        className="nt-button"
        disabled={busy}
        onClick={(e) => runFormAction(e.currentTarget.form, busy, () => void save())}
      >
        {busy ? "Saving…" : "Save selected token"}
      </button>
    </form>
  );
}
function Approvals({
  chainId,
  accountAddress,
  history,
  onResult,
}: {
  chainId: string;
  accountAddress: string;
  history: Operation[];
  onResult: () => void;
}) {
  const [error, setError] = useState<string | null>(null),
    [results, setResults] = useState<Record<string, {
      value: string;
      blockNumber: string;
      observedAtNs: string;
    }>>({}),
    [busy, setBusy] = useState<string | null>(null);
  const known = knownApprovals(history, chainId);
  async function readAllowance(token: string, spender: string) {
    const r = await createEvmWalletClient({ callTool }).callContract({
      accountId: "main", chainId, to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance",
        args: [address(accountAddress) as `0x${string}`, address(spender) as `0x${string}`] }),
    });
    return { value: parseAllowanceResult(r.result), blockNumber: r.blockNumber, observedAtNs: r.observedAtNs };
  }
  async function check(key: string, token: string, spender: string) {
    setBusy(key);
    setError(null);
    try {
      const result = await readAllowance(token, spender);
      setResults((previous) => ({ ...previous, [key]: result }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function revoke(key: string, token: string, spender: string) {
    setBusy(key);
    setError(null);
    try {
      // approve(spender, 0) can approve NFT token ID 0. Confirm this pair exposes
      // an ERC20 allowance before presenting it as a zero-allowance request.
      const result = await readAllowance(token, spender);
      setResults((previous) => ({ ...previous, [key]: result }));
      const request: EvmSendTransactionRequest = {
        requestId: requestId(),
        accountId: "main",
        chainId,
        to: token,
        valueWei: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [address(spender) as `0x${string}`, 0n],
        }),
      };
      const operation = parseEvmOperationResult(
        await callTool({
          target: EVM_WALLET_TARGET,
          name: EVM_WALLET_TOOLS.sendTransaction,
          arguments: request as unknown as JsonObject,
        }),
        request,
        "transaction",
      );
      if (
        [
          "submitted",
          "confirmed",
          "reverted",
          "rejected",
          "failed",
          "replaced",
        ].includes(operation.status)
      )
        onResult();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="evm-card">
      <h2 className="evm-card-title">Known token approvals</h2>
      <p className="evm-muted">
        Spenders from successful confirmed transactions in the loaded Wallet
        activity. Pending requests, older pages, external approvals and signed
        permits are not exhaustively indexed. Check the live allowance before
        revoking.
      </p>
      {error && <p className="evm-error">{error}</p>}
      {known.length === 0 ? (
        <p className="evm-empty">
          No approval transactions in the loaded activity.
        </p>
      ) : (
        known.map(({ key, ...a }) => (
          <article className="evm-operation" key={key}>
            <p className="evm-address">Token {a.token}</p>
            <p className="evm-address">Spender {a.spender}</p>
            <p>
              Observed allowance: {results[key]?.value ?? "Not checked"}
              {results[key] ? " atomic units" : ""}
            </p>
            {results[key] && (
              <p className="evm-muted">
                Block {results[key].blockNumber} · {when(results[key].observedAtNs)}.
                {" "}The allowance may have changed since this observation.
              </p>
            )}
            <div className="evm-actions">
              <button
                className="nt-button nt-button--secondary"
                disabled={busy !== null}
                onClick={() => void check(key, a.token, a.spender)}
              >
                Check allowance
              </button>
              <button
                className="nt-button"
                disabled={busy !== null}
                onClick={() => void revoke(key, a.token, a.spender)}
              >
                Review revocation
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
const container = document.getElementById("root");
if (container) createRoot(container).render(<EvmWalletApp />);
