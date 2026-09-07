import type { EvmWalletClient } from "neutron-tools/evm_wallet";
import { approvalConfirmed, effectiveOperation, executeStep, reconcileStep, savedIntent, type Store, type SwapRecord } from "./controller.ts";

export type SwapProgress = { stage: "approval" | "swap"; state: "checking" | "review" | "pending" | "confirmed"; message: string };
export type SwapOutcome = { record: SwapRecord; state: "complete" | "expired" | "stopped" | "review" };
type Options = {
  signal?: AbortSignal;
  onRecord?: (record: SwapRecord) => void;
  onProgress?: (progress: SwapProgress) => void;
  wait?: (signal?: AbortSignal) => Promise<void>;
  reconcile?: typeof reconcileStep;
  execute?: typeof executeStep;
};

function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }
function waitForReceipt(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    abort(signal);
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, 2500);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason ?? new DOMException("Tracking paused", "AbortError")); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** Continue one owner's Swap action using the durable request IDs throughout.
 * Mounting the app never calls this function. Pausing stops progression, not a
 * transaction already signed; the next Continue reconciles before requesting it.
 */
export async function continueSwap(wallet: EvmWalletClient, store: Store, initial: SwapRecord, options: Options = {}): Promise<SwapOutcome> {
  const reconcile = options.reconcile ?? reconcileStep, execute = options.execute ?? executeStep;
  const wait = options.wait ?? waitForReceipt;
  const callOptions = options.signal ? { signal: options.signal } : undefined;
  let record = await store.get(initial.id) ?? initial;
  if (savedIntent(record).executionMode !== "human") throw new Error("This swap is managed by the agent that created it.");
  const requested = new Set<"approval" | "swap">();
  const update = (next: SwapRecord) => { record = next; options.onRecord?.(next); };
  const progress = (stage: SwapProgress["stage"], state: SwapProgress["state"], message: string) => options.onProgress?.({ stage, state, message });
  abort(options.signal);
  // A swap may already have been submitted even when its last reply was lost.
  progress("swap", "checking", "Checking your saved swap…");
  update(await reconcile(wallet, store, record, "swap", callOptions));
  for (;;) {
    abort(options.signal);
    const swap = effectiveOperation(record, "swap");
    if (swap?.status === "confirmed" && swap.receipt?.status === "success") {
      progress("swap", "confirmed", "Swap complete");
      return { record, state: "complete" };
    }
    // Existing submitted swaps take precedence over approval state and expiry.
    const stage = swap && !["preparing", "prepared"].includes(swap.status) ? "swap" : approvalConfirmed(record) ? "swap" : "approval";
    progress(stage, "checking", stage === "approval" ? "Checking token approval…" : "Checking your swap…");
    update(await reconcile(wallet, store, record, stage, callOptions));
    abort(options.signal);
    const operation = effectiveOperation(record, stage);
    if (operation?.status === "confirmed" && operation.receipt?.status === "success") {
      if (stage === "approval") progress("approval", "confirmed", "Token approved. Opening swap confirmation…");
      continue;
    }
    if (operation && ["rejected", "reverted", "failed", "replaced"].includes(operation.status)) return { record, state: "stopped" };
    if (!operation || ["preparing", "prepared"].includes(operation.status)) {
      if (BigInt(savedIntent(record).quote.deadline) <= BigInt(Math.floor(Date.now() / 1000))) return { record, state: "expired" };
      // A changed prepared transaction needs another explicit continuation. Do
      // not repeatedly reopen Wallet if it returned without a signed request.
      if (requested.has(stage)) return { record, state: "review" };
      requested.add(stage);
      progress(stage, "review", stage === "approval" ? "Approve token access in EVM Wallet" : "Confirm your swap in EVM Wallet");
      update(await execute(wallet, store, record, stage, callOptions));
      continue;
    }
    progress(stage, "pending", stage === "approval" ? "Waiting for token approval. Swap confirmation opens next." : "Swap submitted. Waiting for confirmation…");
    await wait(options.signal);
  }
}
