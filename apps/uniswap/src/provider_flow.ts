import { getAddress, keccak256, stringToHex } from "viem";
import type { EvmAccount, EvmWalletCaller, EvmWalletClient } from "neutron-tools/evm_wallet";
import {
  approvalConfirmed, checkAccount, effectiveOperation, executeProviderStep, receivedTokenAtoms,
  reconcileStep, savedIntent, type SavedIntent, type Store, type SwapRecord,
} from "./controller.ts";
import { customToken, defaultTokens, network, prepareSwap, quoteSwap, type QuoteProgress } from "./swap.ts";
import { walletReader } from "./controller.ts";

export type ProviderSwapInput = {
  swapId: string; chainId: string; accountId: "main"; tokenIn: string | null; tokenOut: string | null;
  amountIn: string; recipient: string | null; slippageBps: number; quoteValiditySeconds: string;
};
export type ProviderFlow = {
  version: 1; id: string; attempt: string; caller: EvmWalletCaller; agentMode: boolean; input: ProviderSwapInput;
};
export type ProviderSwapResult = {
  flowId: string; swapId: string | null; state: "complete" | "pending" | "review" | "stopped";
  phase: string; transactionHash: string | null; approvalTransactionHash: string | null;
  receivedAmountAtoms: string | null; message: string;
};
type Prepare = (wallet: EvmWalletClient, input: ProviderSwapInput, onProgress: QuoteProgress, now: () => number, previousAccount?: EvmAccount) => Promise<SavedIntent>;
type Options = {
  signal?: AbortSignal; onProgress?: (phase: string, record: SwapRecord | null) => void;
  onRecord?: (record: SwapRecord) => void; wait?: (signal?: AbortSignal) => Promise<void>;
  prepare?: Prepare; now?: () => number;
};

export function parseProviderSwapInput(raw: Partial<ProviderSwapInput>): ProviderSwapInput {
  if (typeof raw.swapId !== "string" || !/^[0-9a-f]{32}$/.test(raw.swapId)) throw new Error("swapId must be 32 lowercase hexadecimal characters; reuse it for every retry of this swap.");
  const chainId = String(raw.chainId); network(chainId);
  if (raw.accountId !== undefined && raw.accountId !== "main") throw new Error("Choose the main EVM Wallet account.");
  const token = (value: string | null | undefined) => value === null ? null : getAddress(String(value));
  const positive = (value: unknown, label: string) => { if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive decimal string.`); return value; };
  const slippageBps = raw.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) throw new Error("Slippage must be between 0 and 99.99%.");
  return {
    swapId: raw.swapId, chainId, accountId: "main", tokenIn: token(raw.tokenIn), tokenOut: token(raw.tokenOut),
    amountIn: positive(raw.amountIn, "amountIn"), recipient: raw.recipient == null ? null : getAddress(raw.recipient),
    slippageBps, quoteValiditySeconds: positive(raw.quoteValiditySeconds ?? "1200", "quoteValiditySeconds"),
  };
}

// A renewed quote remains a different immutable intent. Deterministic successor
// IDs make a lost begin reply discoverable without regenerating wallet IDs.
export function providerAttemptId(flowId: string, attempt: string): string {
  return attempt === "0" ? flowId : keccak256(stringToHex(`neutron:uniswap-provider:v1:${flowId}:${attempt}`)).slice(2, 34);
}
function assertFlow(record: SwapRecord, input: ProviderSwapInput, caller: EvmWalletCaller, agentMode: boolean): ProviderFlow {
  const intent = savedIntent(record), flow = intent.providerFlow;
  if (intent.executionMode !== "provider" || !flow || flow.version !== 1) throw new Error("This saved swap uses an earlier workflow. Continue its original tool and Wallet request IDs; do not recreate it.");
  if (flow.id !== input.swapId || flow.caller.appId !== caller.appId || flow.caller.installationUid !== caller.installationUid || flow.agentMode !== agentMode || JSON.stringify(flow.input) !== JSON.stringify(input)) throw new Error("This swapId belongs to different inputs or a different caller. Retry the original request unchanged.");
  if (!/^(0|[1-9][0-9]*)$/.test(flow.attempt) || providerAttemptId(flow.id, flow.attempt) !== record.id) throw new Error("The saved swap continuation identity does not match its flow.");
  return flow;
}
async function prepareProviderIntent(wallet: EvmWalletClient, input: ProviderSwapInput, onProgress: QuoteProgress, now: () => number, previousAccount?: EvmAccount): Promise<SavedIntent> {
  onProgress("Checking EVM Wallet account…");
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === input.accountId);
  if (!account) throw new Error("EVM Wallet account is unavailable.");
  if (previousAccount && (account.address.toLowerCase() !== previousAccount.address.toLowerCase() || account.keyFingerprint !== previousAccount.keyFingerprint || account.namespaceVersion !== previousAccount.namespaceVersion)) throw new Error("The EVM Wallet signing identity changed. Do not continue the saved swap with a replacement account.");
  const read = walletReader(wallet, account.accountId), defaults = defaultTokens(input.chainId);
  const token = async (address: string | null) => defaults.find((entry) => address === null ? entry.address === null : entry.address?.toLowerCase() === address.toLowerCase()) ?? customToken(read, input.chainId, String(address));
  const [tokenIn, tokenOut] = await Promise.all([token(input.tokenIn), token(input.tokenOut)]);
  const quote = await quoteSwap(read, {
    chainId: input.chainId, accountId: input.accountId, accountAddress: getAddress(account.address), tokenIn, tokenOut,
    amountIn: input.amountIn, slippageBps: input.slippageBps, recipient: getAddress(input.recipient ?? account.address),
    deadline: String(BigInt(Math.floor(now() / 1000)) + BigInt(input.quoteValiditySeconds)),
  }, now(), onProgress);
  onProgress("Checking existing token allowance…");
  return { ...await prepareSwap(read, quote, now()), account, executionMode: "provider", walletCaller: null };
}
function waitForReceipt(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, 2500);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason ?? new Error("Swap tracking paused")); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
export function providerSwapResult(input: ProviderSwapInput, record: SwapRecord | null, state: ProviderSwapResult["state"], message: string): ProviderSwapResult {
  return {
    flowId: input.swapId, swapId: record?.id ?? null, state, phase: record?.phase ?? "quoting",
    transactionHash: record ? effectiveOperation(record, "swap")?.transactionHash ?? null : null,
    approvalTransactionHash: record ? effectiveOperation(record, "approval")?.transactionHash ?? null : null,
    receivedAmountAtoms: record ? receivedTokenAtoms(record) : null, message,
  };
}

/** Drives one explicitly requested provider flow. Every wallet signature uses
 * the public provider tool's fresh exact review; this app never impersonates a
 * root Agent. The UI has no authority to resume these provider-owned records.
 */
export async function runProviderSwap(wallet: EvmWalletClient, store: Store, input: ProviderSwapInput, caller: EvmWalletCaller, agentMode: boolean, options: Options = {}): Promise<ProviderSwapResult> {
  const now = options.now ?? Date.now, prepare = options.prepare ?? prepareProviderIntent, wait = options.wait ?? waitForReceipt;
  const callOptions = options.signal ? { signal: options.signal } : undefined;
  const abort = () => options.signal?.throwIfAborted();
  let record: SwapRecord | null = await store.get(input.swapId), attempt = "0";
  const update = (next: SwapRecord) => { record = next; options.onRecord?.(next); };
  const missingDispatch = (saved: SwapRecord | null): "approval" | "swap" | null => saved?.phase === "swap_requested" ? "swap" : saved?.phase === "approval_requested" ? "approval" : null;
  const journal: Store = { ...store, async update(saved, stage, phase, operation = null) {
    // Reading the other stage must not erase the only durable marker of a
    // dispatch whose Wallet result is still absent. Its exact observation clears it.
    const unresolved = missingDispatch(saved);
    const next = await store.update(saved, stage, unresolved && unresolved !== stage ? `${unresolved}_requested` : phase, operation);
    update(next); return next;
  } };
  const progress = (phase: string) => options.onProgress?.(phase, record);
  const requested = new Set<string>();
  const create = async (previousAccount?: EvmAccount): Promise<SwapRecord> => {
    const id = providerAttemptId(input.swapId, attempt), existing = await store.get(id);
    if (existing) { assertFlow(existing, input, caller, agentMode); return existing; }
    let intent: SavedIntent;
    for (;;) {
      abort();
      try { intent = await prepare(wallet, input, progress, now, previousAccount); break; }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "Swap deadline has expired. Request a new quote.") throw error;
        progress("The quote expired while loading. Getting a fresh price…");
      }
    }
    abort();
    const flow: ProviderFlow = { version: 1, id: input.swapId, attempt, caller, agentMode, input };
    return store.begin({ ...intent, executionMode: "provider", walletCaller: null, providerFlow: flow }, id);
  };
  abort();
  if (record) {
    // Follow retained successors before touching any predecessor Wallet request.
    // They can only be created after the predecessor was known unsigned.
    for (;;) {
      const flow = assertFlow(record, input, caller, agentMode); attempt = flow.attempt;
      const next = await store.get(providerAttemptId(input.swapId, String(BigInt(attempt) + 1n)));
      if (!next) break;
      record = next;
    }
    update(record);
  } else update(await create());
  for (;;) {
    abort();
    const current = record!;
    assertFlow(current, input, caller, agentMode);
    if (current.phase === "swap_superseded") {
      // A lost successor preparation/begin reply must resume the same retained
      // attempt without reopening the predecessor's Wallet requests.
      attempt = String(BigInt(attempt) + 1n);
      update(await create(savedIntent(current).account));
      continue;
    }
    // Swap status has priority over approval and deadline: its reply may have
    // been lost after signing or submitting the actual token swap.
    progress("Checking saved swap…");
    update(await reconcileStep(wallet, journal, current, "swap", callOptions));
    abort();
    const swap = effectiveOperation(record!, "swap");
    if (swap?.status === "confirmed" && swap.receipt?.status === "success") return providerSwapResult(input, record, "complete", "Swap complete: its successful receipt is recorded. Receipt inclusion is separate from final settlement.");
    if (swap && ["rejected", "reverted", "failed", "replaced"].includes(swap.status)) return providerSwapResult(input, record, "stopped", swap.message ?? `Swap ${swap.status}. Keep this saved flow; do not report approval alone as a swap.`);
    if (swap?.status === "preparing" && BigInt(savedIntent(record!).quote.deadline) <= BigInt(Math.floor(now() / 1000))) return providerSwapResult(input, record, "pending", "The original Wallet swap preparation is unresolved and its quote has expired. Reconcile the same request; no successor was created.");
    if (swap && !["preparing", "prepared"].includes(swap.status)) {
      progress("Swap is pending. Waiting for its receipt…"); await wait(options.signal); continue;
    }
    if (record!.approval_request_id) {
      progress("Checking token approval…");
      update(await reconcileStep(wallet, journal, record!, "approval", callOptions));
      abort();
      const approval = effectiveOperation(record!, "approval");
      if (approval && ["rejected", "reverted", "failed", "replaced"].includes(approval.status)) return providerSwapResult(input, record, "stopped", approval.message ?? `Token approval ${approval.status}; the swap did not run.`);
      if (approval?.status === "preparing" && BigInt(savedIntent(record!).quote.deadline) <= BigInt(Math.floor(now() / 1000))) return providerSwapResult(input, record, "pending", "The original Wallet approval preparation is unresolved and its quote has expired. Reconcile the same request; no successor was created.");
      if (approval && !["preparing", "prepared", "confirmed"].includes(approval.status)) {
        progress("Waiting for token approval. The swap follows automatically…"); await wait(options.signal); continue;
      }
    }
    if (BigInt(savedIntent(record!).quote.deadline) <= BigInt(Math.floor(now() / 1000))) {
      if (missingDispatch(record)) return providerSwapResult(input, record, "pending", "The expired flow retains a dispatched request whose Wallet result is not yet visible. Retry this same flow to reconcile its original request; do not create another intent from an absent or lost reply.");
      await checkAccount(wallet, savedIntent(record!), callOptions);
      abort();
      progress("Approval is resolved and the old swap is unsigned. Updating the price and checking its existing allowance…");
      const previousAccount = savedIntent(record!).account;
      // Freeze the predecessor before allocating new Wallet request IDs. A
      // concurrent dispatch advances its revision and makes this CAS fail.
      update(await journal.update(record!, "swap", "swap_superseded"));
      attempt = String(BigInt(attempt) + 1n);
      update(await create(previousAccount));
      continue;
    }
    const stage = approvalConfirmed(record!) ? "swap" : "approval";
    const requestId = stage === "approval" ? record!.approval_request_id! : record!.swap_request_id;
    if (requested.has(requestId)) return providerSwapResult(input, record, "review", "Wallet refreshed the exact transaction after review. Call uniswap_swap_v1 again with the same original arguments and swapId for a fresh review; do not create another flow.");
    requested.add(requestId);
    progress(stage === "approval" ? "Reviewing exact token approval in EVM Wallet…" : "Reviewing the swap in EVM Wallet…");
    try { update(await executeProviderStep(wallet, journal, record!, stage, callOptions)); }
    catch (error) {
      abort();
      if (error instanceof Error && error.message === "Swap deadline has expired. Request a new quote.") continue;
      // A recorded dispatch can have lost its reply after signing. Leave the
      // consumer one recoverable flow, even when the transport returned an error.
      if (record!.phase === `${stage}_requested`) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (code === "AGENT_CONSENT_DENIED" || code === "AGENT_MODE_REVOKED") return providerSwapResult(input, record, "stopped", `Wallet authorization was declined or revoked. The saved request remains intact. ${error instanceof Error ? error.message : String(error)}`);
        return providerSwapResult(input, record, "pending", `The Wallet call did not return a complete result. Retry uniswap_swap_v1 with the same swapId and original arguments to reconcile its exact saved request before any further action. ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    if (["preparing", "prepared"].includes(effectiveOperation(record!, stage)?.status ?? "")) return providerSwapResult(input, record, "review", "Wallet refreshed the exact transaction after review. Call uniswap_swap_v1 again with the same original arguments and swapId for a fresh review; do not create another flow.");
  }
}
