import { exposeTool, publishAppStateChange, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { bridgeComplete, bridgeLabel, createBridgeClient, executeBridgeDeposit, type BridgeIntent } from "./bridge.ts";
import { assertBridgeProviderOwner, prepareBridgeProvider, readBridgeProviderBinding } from "./bridge_provider.ts";
import { connectEvmBridge } from "./evm_bridge.ts";
import { parsePrincipal } from "./icrc_account.ts";
import { transferIdBytes } from "./transfers.ts";
import { WALLET_PROJECTION_TOPIC } from "./wallet_projection.ts";

const text: JsonObject = { type: "string" };
const id: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const closed = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
export const walletWrapInputSchema = closed({ requestId: id, ledger: text, amountAtoms: { type: "string", pattern: "^[1-9][0-9]*$" } });
export const walletWrapOutputSchema = closed({
  requestId: id, ledger: text, amountAtoms: nat, chainId: { const: "1" },
  status: { enum: ["completed", "pending", "failed"] },
  phase: { enum: ["ready", "approval", "deposit", "ethereum_confirmation", "ck_token_mint", "completed", "failed"] },
  message: text, nextAction: { enum: ["continue_same_request", "refresh_mint", "none"] },
  ethereumTransactionHash: nullable(text), icLedgerBlockIndex: nullable(nat),
  steps: { type: "array", items: closed({ kind: { enum: ["reset_approval", "approval", "deposit"] }, state: { enum: ["ready", "unknown", "submitted", "confirmed", "failed"] }, transactionHash: nullable(text) }) },
});
export function registerDepositTools(): void {
  exposeTool("wallet_wrap_root_v1", {
    title: "Wrap Ethereum assets into ck tokens",
    description: "Complete Ethereum Mainnet → Internet Computer wrapping from EVM Wallet into this Wallet: reuse allowance, approve if required, submit the official minter deposit, then verify the exact ck-token mint. Use a supported ckETH/ckERC20 ledger and atomic amount from Wallet's route/token information, for example ETH→ckETH, USDC→ckUSDC or USDT→ckUSDT. This does not convert fiat USD or bridge from Arbitrum. Keep one stable 32-hex requestId and identical original ledger/amount. The tool automatically continues past approval using the current root Agent's Wallet permission decisions. If pending, call this same tool again with the same arguments; never start a second request after a timeout and never call a separate EVM send for this flow. Only status completed means ck tokens arrived; Ethereum confirmation can precede minting by several minutes. Serialize value-moving Wallet flows within the Agent run.",
    inputSchema: walletWrapInputSchema, outputSchema: walletWrapOutputSchema,
    annotations: { "neutron:audience": "agent_root", "neutron:visibility": "same_app", "neutron:audit": "metadata_only", "neutron:longRunning": true, "neutron:effects": ["read", "write", "network"] },
  }, handleWalletWrap);
  exposeTool("wallet_wrap_status_v1", {
    title: "Read an Agent wrapping request",
    description: "Read a saved automatic Ethereum→ck-token wrapping request without sending anything. An approval or Ethereum deposit alone is not a completed wrap. For a pending request, continue wallet_wrap_root_v1 with its original requestId, ledger and amountAtoms; it safely refreshes the mint after Ethereum confirmation.",
    inputSchema: closed({ requestId: id }), outputSchema: walletWrapOutputSchema,
    annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const requestId = requestIdArg(args);
    if (!await readBridgeProviderBinding(context, requestId)) throw new Error("This request is not an automatic Agent wrap. Use wallet_bridge_status_v1 for earlier deposits.");
    return summarizeWalletWrap(await scopedBridge(context).status(requestId));
  });
  exposeTool("wallet_wrap_pending_v1", {
    title: "Find saved automatic ck-token wrapping requests",
    description: "List one page of saved automatic Agent wrapping requests and their exact IDs, ledger and amounts. Read nextAfter until null. Completed historical requests are omitted; scanning a page may return no pending requests while nextAfter is still present. This never signs or resubmits a transaction.",
    inputSchema: closed({ after: nullable(id) }, []),
    outputSchema: closed({ requests: { type: "array", items: walletWrapOutputSchema }, nextAfter: nullable(id) }),
    annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const after = args.after == null ? null : requestIdArg({ requestId: args.after });
    const page = await context.kernel.querySelf("wallet_bridge_list_v1", [{ ...(after === null ? {} : { after: transferIdBytes(after) }), limit: "40" }]);
    if (!page || typeof page !== "object" || Array.isArray(page)) throw new Error("Invalid saved wrapping page");
    const record = page as Record<string, unknown>;
    if (!Array.isArray(record.records)) throw new Error("Invalid saved wrapping records");
    const { parseBridgeIntent } = await import("./bridge.ts");
    const requests: JsonObject[] = [];
    for (const raw of record.records) {
      const intent = parseBridgeIntent(raw);
      if (!bridgeComplete(intent) && !intent.steps.some((step) => step.state === "failed") && await readBridgeProviderBinding(context, intent.id)) requests.push(summarizeWalletWrap(intent));
    }
    const next = record.next;
    if (next != null && (!(next instanceof Uint8Array) || next.length !== 16)) throw new Error("Invalid saved wrapping cursor");
    return { requests, nextAfter: next == null ? null : [...next as Uint8Array].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  });
}

export async function handleWalletWrap(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const caller = requireEvmWalletCaller(context, true);
  context.signal?.throwIfAborted();
  const requestId = requestIdArg(args);
  if (typeof args.ledger !== "string") throw new Error("Select the ck token ledger");
  const ledger = parsePrincipal(args.ledger, "ck token ledger").toText();
  if (typeof args.amountAtoms !== "string" || !/^[1-9][0-9]*$/.test(args.amountAtoms) || BigInt(args.amountAtoms) >= 2n ** 256n) throw new Error("Wrap amount must be a positive Ethereum uint256 atomic amount");
  const amount = args.amountAtoms;
  const bridge = scopedBridge(context);
  let current: BridgeIntent | null = null;
  let binding = await readBridgeProviderBinding(context, requestId);
  if (binding) {
    assertBridgeProviderOwner(binding, caller, context);
    try { current = await bridge.status(requestId); }
    catch (error) { if (!errorMessage(error).includes("Bridge intent not found")) throw error; }
    if (current) {
      assertIntent(current, ledger, amount);
      assertBridgeProviderOwner(binding, current.source, context);
      if (bridgeComplete(current) || current.steps.some((step) => step.state === "failed")) return summarizeWalletWrap(current);
      if (current.steps.some((step) => step.kind === "deposit" && step.state === "confirmed")) {
        try { current = await bridge.refresh(requestId); }
        catch (error) { return summarizeWalletWrap(current, errorMessage(error)); }
        return summarizeWalletWrap(current);
      }
    }
  }
  const wallet = createEvmWalletClient(context.kernel, context.signal ? { callOptions: { signal: context.signal } } : {});
  const account = (await wallet.accounts()).accounts.find((candidate) => candidate.accountId === "main");
  if (!account) throw new Error("EVM Wallet's main account is unavailable");
  if (binding) assertBridgeProviderOwner(binding, caller, context, account);
  try { current = await prepareBridgeProvider(context, requestId, ledger, amount, account); }
  catch (error) {
    // Preparation may have saved the binding or intent before its reply was
    // lost. Return the same caller-supplied ID even when cancellation prevents
    // reading it back; do not claim a transaction was dispatched.
    return {
      requestId, ledger, amountAtoms: amount, chainId: "1", status: "pending", phase: "ready",
      message: `Preparation did not finish: ${errorMessage(error)}. Retry this exact request to recover its saved preparation; no transaction was requested by this call.`,
      nextAction: "continue_same_request", ethereumTransactionHash: null, icLedgerBlockIndex: null, steps: [],
    };
  }
  assertIntent(current, ledger, amount);
  binding = await readBridgeProviderBinding(context, requestId);
  if (!binding) throw new Error("The saved deposit has no provider execution identity");
  assertBridgeProviderOwner(binding, current.source, context, account);
  try {
    context.reportProgress({ requestId, phase: "preparing", message: "Preparing the official Ethereum deposit" });
    const cancellation = context.signal ? { signal: context.signal } : {};
    const connected = await connectEvmBridge(wallet, current.quote.helperAddress, current.quote.tokenAddress, current.account, { ...cancellation, confirmationTimeoutMs: 45_000 });
    current = await executeBridgeDeposit({
      intent: current, client: bridge, provider: connected.provider, evm: connected.evm,
      providerAgent: caller, ...cancellation,
      onChange: (intent) => { current = intent; },
      onProgress: (phase) => context.reportProgress({ requestId, phase }),
    });
    current = await bridge.refresh(requestId);
    return summarizeWalletWrap(current);
  } catch (error) {
    // The request and every claimed step are already durable. Cancellation may
    // also stop the scoped read; retain our latest receipt in that case.
    try { current = await bridge.status(requestId); } catch { /* Saved ID remains authoritative. */ }
    return summarizeWalletWrap(current, errorMessage(error));
  } finally {
    try { await publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now()); } catch { /* Best-effort UI refresh. */ }
  }
}

export function summarizeWalletWrap(intent: BridgeIntent, error?: string): JsonObject {
  const complete = bridgeComplete(intent);
  const failed = intent.steps.some((step) => step.state === "failed");
  const deposit = intent.steps.find((step) => step.kind === "deposit")!;
  const pending = intent.steps.find((step) => step.state === "unknown" || step.state === "submitted");
  const mintPending = deposit.state === "confirmed";
  const phase = complete ? "completed" : failed ? "failed" : mintPending ? "ck_token_mint" : pending?.kind === "deposit" ? pending.transactionHash ? "ethereum_confirmation" : "deposit" : pending ? "approval" : "ready";
  return {
    requestId: intent.id, ledger: intent.quote.ledger, amountAtoms: intent.amount, chainId: "1",
    status: complete ? "completed" : failed ? "failed" : "pending", phase,
    message: complete ? "Your ck tokens arrived in IC Wallet." : error ?? bridgeLabel(intent),
    nextAction: complete || failed ? "none" : mintPending ? "refresh_mint" : "continue_same_request",
    ethereumTransactionHash: deposit.transactionHash, icLedgerBlockIndex: intent.mint?.ledgerBlockIndex ?? null,
    steps: intent.steps.map((step) => ({ kind: step.kind, state: step.state, transactionHash: step.transactionHash })),
  };
}
function assertIntent(intent: BridgeIntent, ledger: string, amount: string): void {
  if (intent.quote.ledger !== ledger || intent.amount !== amount) throw new Error("This request ID belongs to a different wrapping amount or token. Continue with its original arguments.");
}
function requestIdArg(args: JsonObject): string {
  if (typeof args.requestId !== "string" || !/^[0-9a-f]{32}$/.test(args.requestId)) throw new Error("Use a stable 32-hex wrapping request ID");
  return args.requestId;
}
function scopedBridge(context: MsgBusToolContext) {
  return createBridgeClient({ query: (method, args) => context.kernel.querySelf(method, args), update: (method, args) => context.kernel.updateSelf(method, args, 120) });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
