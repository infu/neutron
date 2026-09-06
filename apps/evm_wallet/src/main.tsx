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
  parseBalance,
  parseOperation,
  parseReviewEvidence,
  parseSnapshot,
  quantity,
  record,
  requestId,
  shortAddress,
  unwrap,
  when,
  type Balance,
  type Network,
  type Operation,
  type Snapshot,
} from "./data.ts";
import { OWNER_REVIEW_TOOLS, PRESENT_TOOLS } from "./provider.ts";
import {
  acceptPrompt,
  checkPrompt,
  closeUncertainPrompt,
  declinePrompt,
  getPrompts,
  presentEffect,
  presentOwnEffect,
  refreshPromptEvidence,
  subscribePrompts,
} from "./prompts.ts";
import {
  assertLocalAccount,
  localTransferRequest,
  type LocalIntent,
} from "./local_intent.ts";
import { SignForm } from "./sign_form.tsx";
import { ReplacementForm } from "./replacement.tsx";
import { knownApprovals } from "./known_approvals.ts";
import { TokenReview } from "./token_review.tsx";
import { onFormActionKeyDown, runFormAction } from "./form_actions.ts";
import { queryHistoryPage } from "./history.ts";
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
export function EvmWalletApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [balance, setBalance] = useState<Balance | null>(null),
    [history, setHistory] = useState<Operation[]>([]),
    [total, setTotal] = useState("0");
  const [chainId, setChainId] = useState("1"),
    [tab, setTab] = useState<Tab>("Assets"),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [balanceError, setBalanceError] = useState<string | null>(null);
  const [manualReview, setManualReview] = useState<Operation | null>(null),
    [reviewError, setReviewError] = useState<string | null>(null),
    [reviewBusy, setReviewBusy] = useState(false);
  const prompts = useSyncExternalStore(subscribePrompts, getPrompts),
    prompt = prompts[0];
  const account = snapshot?.accounts[0],
    network = snapshot?.networks.find((n) => n.chainId === chainId);
  const load = useCallback(async () => {
    let current = parseSnapshot(await querySelf(METHODS.snapshot, [null]));
    if (current.accounts.length === 0) {
      await updateSelf(METHODS.accounts, [null], 120);
      current = parseSnapshot(await querySelf(METHODS.snapshot, [null]));
    }
    setSnapshot(current);
    const activity = await queryHistoryPage("0");
    setHistory(activity.operations);
    setTotal(activity.total);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
    return onAppStateChange("evm_wallet", (event) => {
      if (event.topic === "evm_wallet")
        void load().catch((e) => setError(errorMessage(e)));
    });
  }, [load]);
  useEffect(() => {
    let active = true;
    setBalance(null);
    setBalanceError(null);
    if (!account) return;
    const tokens = (snapshot?.assets ?? [])
      .filter((t) => t.chainId === chainId)
      .map((t) => t.address);
    void updateSelf(
      METHODS.balances,
      [{ account_id: account.id, chain_id: chainId, tokens }],
      120,
    )
      .then(parseBalance)
      .then(
        (result) => {
          if (active) setBalance(result);
        },
        (e) => {
          if (active) setBalanceError(errorMessage(e));
        },
      );
    return () => {
      active = false;
    };
  }, [account?.address, chainId, snapshot]);
  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await load();
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
      await updateSelf(
        METHODS.status,
        [
          {
            identity: identityArgs(operation.caller, operation.requestId),
            refresh: true,
          },
        ],
        120,
      ).then(parseOperation);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function continueOperation(accept: boolean) {
    if (!manualReview || reviewBusy) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const next = parseOperation(
        await updateSelf(
          accept ? METHODS.execute : METHODS.reject,
          [
            {
              identity: identityArgs(
                manualReview.caller,
                manualReview.requestId,
              ),
              ...(accept
                ? { review_revision: manualReview.reviewRevision }
                : {}),
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
      const operation = parseReviewEvidence(await updateSelf(
        METHODS.reviewEvidence,
        [{
          identity: identityArgs(current.caller, current.requestId),
          review_revision: current.reviewRevision,
          refresh,
        }],
        120,
      ));
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
            <p className="evm-subtitle">
              Your chain-key account, across networks
            </p>
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
          <button
            className="nt-button nt-button--secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="evm-error">
          {error}
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
          {balance ? amount(balance.nativeBalance) : "—"}{" "}
          <span className="evm-muted">{network?.nativeSymbol ?? "ETH"}</span>
        </strong>
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
          <button
            className="nt-button nt-button--secondary"
            disabled={!account}
            onClick={() => {
              if (account)
                void copyToClipboard(account.address).catch((e) =>
                  setError(errorMessage(e)),
                );
            }}
          >
            Copy receive address
          </button>
        </div>
        {balance && (
          <p className="evm-muted">
            Block {balance.blockNumber} · {when(balance.observedAtNs)}
          </p>
        )}
        {balanceError && (
          <p className="evm-error">Balance unavailable: {balanceError}</p>
        )}
      </section>
      <nav className="evm-tabs" aria-label="Wallet pages">
        {tabs.map((t) => (
          <button
            key={t}
            className={`evm-tab ${t === tab ? "is-active" : ""}`}
            aria-current={t === tab ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "Assets" && (
        <section className="evm-card">
          <h2 className="evm-card-title">
            Assets on {network?.name ?? "this network"}
          </h2>
          <p className="evm-muted">
            Native currency and selected tokens. This is not an exhaustive
            portfolio.
          </p>
          <div className="evm-asset-list">
            <AssetRow
              symbol={network?.nativeSymbol ?? "ETH"}
              name="Native currency"
              value={balance ? amount(balance.nativeBalance) : "Unavailable"}
            />
            {balance?.tokens.map((token) => (
              <AssetRow
                key={token.address}
                symbol={token.symbol ?? "Token"}
                name={token.address}
                value={
                  token.balance === null || token.decimals === null
                    ? "Unavailable"
                    : amount(token.balance, token.decimals)
                }
                error={token.error}
              />
            ))}
          </div>
          <button
            className="nt-button nt-button--secondary"
            onClick={() => setTab("Settings")}
          >
            Add a token
          </button>
        </section>
      )}
      {tab === "Send" && account && (
        <SendForm
          accountAddress={account.address}
          chainId={chainId}
          snapshot={snapshot!}
          onResult={() => void refresh()}
        />
      )}
      {tab === "Activity" && (
        <section className="evm-card">
          <h2 className="evm-card-title">Wallet activity</h2>
          <p className="evm-muted">
            Requests saved by this Wallet, including signatures and unresolved
            operations. External history is not indexed.
          </p>
          <div className="evm-activity">
            {history.length === 0 ? (
              <p className="evm-empty">No saved requests yet.</p>
            ) : (
              history.map((operation) => (
                <OperationRow
                  key={operation.operationId}
                  operation={operation}
                  networks={snapshot?.networks ?? []}
                  busy={busy}
                  onRefresh={() => void refreshOperation(operation)}
                  onReview={() => {
                    setReviewError(null);
                    setManualReview(operation);
                    const tx = operation.preparedTransaction ?? operation.intent.transaction;
                    if (tx && decodeKnownCall(tx.data)) void refreshManualEvidence(false, operation);
                  }}
                />
              ))
            )}
          </div>
          {BigInt(total) > BigInt(history.length) && (
            <button
              className="nt-button nt-button--secondary"
              onClick={() => {
                void queryHistoryPage(String(history.length))
                  .then(
                    (page) => {
                      setHistory([...history, ...page.operations]);
                      setTotal(page.total);
                    },
                    (e) => setError(errorMessage(e)),
                  );
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
            <h2 className="evm-card-title">Add selected token</h2>
            <TokenForm chainId={chainId} onSaved={() => void refresh()} />
          </section>
          <section className="evm-card">
            <h2 className="evm-card-title">Account and network</h2>
            <p className="evm-muted">
              {snapshot?.lifecycle ??
                "Account lifecycle information is loading."}
            </p>
            <p className="evm-notice">
              Keep EVM Wallet installed while the address holds assets or
              permissions. Compatible upgrades preserve the key. Uninstalling
              and reinstalling rotates the installation namespace and address.
              There is no private-key or seed export.
            </p>
            <p className="evm-muted">{network?.finalityDescription}</p>
            <p className="evm-muted">
              Transactions need native gas on the selected EVM network.
              Chain-key signing and RPC calls also consume this Neutron's IC
              cycles.
            </p>
          </section>
        </section>
      )}
      {prompt && (
        <ReviewDialog
          operation={prompt.prepared.operation}
          networks={snapshot?.networks ?? []}
          error={prompt.error}
          queued={prompts.length - 1}
          busy={prompt.phase === "executing" || prompt.phase === "checking"}
          uncertain={prompt.phase === "uncertain"}
          onApprove={() => void acceptPrompt(prompt)}
          onDecline={() => void declinePrompt(prompt)}
          onCheck={() => void checkPrompt(prompt)}
          onRefreshEvidence={() => void refreshPromptEvidence(prompt)}
          onClose={() => closeUncertainPrompt(prompt)}
        />
      )}
      {!prompt && manualReview && (
        <ReviewDialog
          operation={manualReview}
          networks={snapshot?.networks ?? []}
          error={reviewError}
          busy={reviewBusy}
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
function AssetRow({
  symbol,
  name,
  value,
  error,
}: {
  symbol: string;
  name: string;
  value: string;
  error?: string | null;
}) {
  return (
    <div className="evm-asset">
      <span className="evm-asset-icon">{symbol.slice(0, 2)}</span>
      <div>
        <strong>{symbol}</strong>
        <p className="evm-muted evm-address">{name}</p>
        {error && <p className="evm-error">{error}</p>}
      </div>
      <strong className="evm-asset-value">{value}</strong>
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
      {status}
    </span>
  );
}
function SendForm({
  accountAddress,
  chainId,
  snapshot,
  onResult,
}: {
  accountAddress: string;
  chainId: string;
  snapshot: Snapshot;
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
    [saved, setSaved] = useState<LocalIntent | null>(null);
  const tokens = snapshot.assets.filter((t) => t.chainId === chainId);
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
      setNotice(
        `Operation ${result.operationId}: ${result.status}${result.transactionHash ? ` · ${result.transactionHash}` : ""}`,
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
        ].includes(result.status)
      ) {
        setSaved(null);
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
          ? "Request not yet found. Review the same current request to continue."
          : `Operation ${r.operationId}: ${r.status}`,
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
      <h2 className="evm-card-title">Send or call a contract</h2>
      {saved && (
        <div className="evm-notice">
          <strong>Current request awaiting resolution</strong>
          <p className="evm-address">
            {saved.request.requestId} · Chain {saved.request.chainId}
          </p>
          <p>
            {saved.request.to} · {saved.request.valueWei} wei
          </p>
          <div className="evm-actions">
            <button
              className="nt-button nt-button--secondary"
              disabled={busy}
              onClick={() => void check()}
            >
              Check current request
            </button>
            <button
              className="nt-button"
              disabled={busy}
              onClick={() => void send(true)}
            >
              Review saved request
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
          <select
            className="nt-select"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          >
            <option value="native">ETH</option>
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol} · {shortAddress(t.address)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Recipient or contract">
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
        </Field>
        {token === "native" && (
          <>
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
          </>
        )}
        {error && (
          <p role="alert" className="evm-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="evm-notice evm-address">
            {notice}
          </p>
        )}
        <button
          type="button"
          className="nt-button"
          data-testid="evm-send-review"
          disabled={busy || saved !== null}
          onClick={(e) => runFormAction(e.currentTarget.form, busy || saved !== null, () => void send())}
        >
          {busy ? "Working…" : "Review transaction"}
        </button>
        <p className="evm-muted">
          The backend saves this request and prepares gas, nonce and fee
          evidence before your final approval. After a reload, resume saved
          requests in Activity.
        </p>
      </form>
    </section>
  );
}
function OperationRow({
  operation,
  networks,
  busy,
  onRefresh,
  onReview,
}: {
  operation: Operation;
  networks: Network[];
  busy: boolean;
  onRefresh: () => void;
  onReview: () => void;
}) {
  const network = networks.find((n) => n.chainId === operation.chainId),
    tx = operation.preparedTransaction ?? operation.intent.transaction,
    decoded = tx ? decodeKnownCall(tx.data) : null;
  return (
    <article
      className="evm-operation"
      data-testid={`evm-operation-${operation.operationId}`}
    >
      <div className="evm-row">
        <strong>
          {decoded?.name ??
            (operation.kind === "transaction"
              ? "Transaction"
              : operation.kind === "message"
                ? "Personal message"
                : "Typed data")}
        </strong>
        <Status status={operation.status} />
      </div>
      <p className="evm-muted">
        {network?.name ?? `Chain ${operation.chainId}`} ·{" "}
        {operation.caller.appId} · {when(operation.createdAtNs)}
      </p>
      <p className="evm-address">
        {tx
          ? `${amount(tx.value)} ETH → ${tx.to}`
          : `Account ${operation.address}`}
      </p>
      <p className="evm-muted">
        Operation {operation.operationId} · Request {operation.requestId}
      </p>
      {operation.message && <p className="evm-notice">{operation.message}</p>}
      {operation.finality && (
        <p className="evm-muted">Finality: {operation.finality}</p>
      )}
      {operation.transactionHash && (
        <p className="evm-address">
          {network ? (
            <a
              href={`${network.explorerUrl}/tx/${operation.transactionHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {operation.transactionHash}
            </a>
          ) : (
            operation.transactionHash
          )}
        </p>
      )}
      {operation.replacementTransactionHash && (
        <p className="evm-notice evm-address">
          Replaced by{" "}
          {network ? (
            <a
              href={`${network.explorerUrl}/tx/${operation.replacementTransactionHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {operation.replacementTransactionHash}
            </a>
          ) : (
            operation.replacementTransactionHash
          )}
          . The original requested transaction did not complete.
        </p>
      )}
      {operation.signature && (
        <details>
          <summary>Returned signature</summary>
          <pre className="evm-code">{operation.signature}</pre>
        </details>
      )}
      <div className="evm-actions">
        <button
          className="nt-button nt-button--secondary"
          disabled={busy}
          onClick={onRefresh}
        >
          Check status
        </button>
        {operation.status === "prepared" && (
          <button className="nt-button" onClick={onReview}>
            Review saved request
          </button>
        )}
      </div>
      {operation.kind === "transaction" &&
        ["signed", "submitted", "unknown"].includes(operation.status) && (
          <ReplacementForm operation={operation} onResult={onRefresh} />
        )}
    </article>
  );
}
function ReviewDialog({
  operation,
  networks,
  error,
  busy,
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
  error: string | null;
  busy: boolean;
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
  let messageText: string | null = null;
  if (operation.intent.messageHex)
    try {
      messageText = hexToString(hex(operation.intent.messageHex));
    } catch {}
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
        <h2 id="evm-review-title">
          {decoded?.name ??
            (operation.kind === "transaction"
              ? "Review transaction"
              : operation.kind === "message"
                ? "Sign personal message"
                : "Sign typed data")}
        </h2>
        <p className="evm-muted">
          Requested by {operation.caller.appId} · Installation{" "}
          {operation.caller.installationUid}
        </p>
        <dl className="evm-review-details">
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
                {amount(tx.value)} ETH ({tx.value} wei)
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
                {amount(fee.balance)} ETH ({fee.balance} wei)
              </dd>
              <dt>Nonce</dt>
              <dd>{fee.nonce}</dd>
              <dt>Gas limit</dt>
              <dd>{fee.gasLimit}</dd>
              <dt>Maximum network fee</dt>
              <dd>{amount(maxFee(fee))} ETH</dd>
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
            busy={busy}
            onRefresh={onRefreshEvidence}
          />
        )}
        {tx && tx.data !== "0x" && (
          <details open={!decoded}>
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
        {operation.intent.messageHex !== undefined && (
          <>
            <p className="evm-notice">
              A message signature can authorize actions outside this Wallet.
              Review the complete message and requesting app.
            </p>
            {messageText !== null && (
              <pre className="evm-code">{messageText}</pre>
            )}
            <details>
              <summary>Exact message bytes</summary>
              <pre className="evm-code">{operation.intent.messageHex}</pre>
            </details>
          </>
        )}
        {operation.intent.typedDataJson !== undefined && (
          <>
            <p className="evm-notice">
              Typed signatures may grant token spending rights. Review the
              verifying contract, spender, amount, nonce and expiry below. These
              exact JSON bytes are used by the backend.
            </p>
            <pre className="evm-code">{operation.intent.typedDataJson}</pre>
          </>
        )}
        {operation.intent.replacement && (
          <p className="evm-notice">
            {operation.intent.replacement.cancel ? "Cancel" : "Speed up"}{" "}
            operation {operation.intent.replacement.operationId} using the same
            nonce. The original can still win the race.
          </p>
        )}
        {operation.message && (
          <p className="evm-notice" role="note">
            {operation.message}
          </p>
        )}
        {error && (
          <p className="evm-error" role="alert">
            {error}
          </p>
        )}
        <footer className="evm-review-footer">
          {uncertain ? (
            <>
              <button
                className="nt-button nt-button--secondary"
                disabled={busy}
                onClick={onClose}
              >
                Close and keep saved
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
                Decline
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
                    ? "Approve and send"
                    : "Approve signature"}
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
  async function check(key: string, token: string, spender: string) {
    setBusy(key);
    setError(null);
    try {
      const r = record(
        unwrap(
          await updateSelf(
            METHODS.readContract,
            [
              {
                chain_id: chainId,
                to: token,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "allowance",
                  args: [
                    address(accountAddress) as `0x${string}`,
                    address(spender) as `0x${string}`,
                  ],
                }),
                block: "latest",
              },
            ],
            120,
          ),
        ),
        "allowance read",
      );
      setResults((previous) => ({ ...previous, [key]: {
        value: BigInt(hex(r.result)).toString(),
        blockNumber: quantity(r.block_number, "allowance block"),
        observedAtNs: quantity(r.observed_at, "allowance observation time"),
      } }));
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
      const result = parseEvmOperationResult(
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
        ].includes(result.status)
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
