import type { JsonValue, MsgBusCallOptions, MsgBusToolCall, MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, EVM_WALLET_TARGET, EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";

// These exact reads are declared in neutron.json and need no Agent decision on
// Kernel 344+. Keep unlisted calls in the queue: a read without an install grant
// can still ask the judge for routing permission.
const installedReads = new Set<string>([
  EVM_WALLET_TOOLS.accounts,
  EVM_WALLET_TOOLS.balances,
  EVM_WALLET_TOOLS.callContract,
  EVM_WALLET_TOOLS.estimateTransaction,
  EVM_WALLET_TOOLS.transaction,
  EVM_WALLET_TOOLS.replacementTransaction,
  EVM_WALLET_TOOLS.operationStatus,
]);

/** Pool, position, metadata and fee reads can run concurrently through their
 * install grants. Effects still require fresh provider reviews, so serialize
 * those within this tool invocation while retaining the scoped Kernel client
 * and every request's cancellation/transport options.
 */
export function createServiceWallet(context: MsgBusToolContext) {
  const options = context.signal ? { callOptions: { signal: context.signal } } : {};
  if (!context.agentMode) return createEvmWalletClient(context.kernel, options);
  let tail: Promise<unknown> = Promise.resolve();
  const callTool = <T extends JsonValue = JsonValue>(call: MsgBusToolCall, options?: number | MsgBusCallOptions): Promise<T> => {
    const dispatch = async () => {
      context.signal?.throwIfAborted();
      if (typeof options === "object") options.signal?.throwIfAborted();
      return context.kernel.callTool<T>(call, options);
    };
    if (call.target === EVM_WALLET_TARGET && installedReads.has(call.name)) return dispatch();
    const pending = tail.then(dispatch);
    // A failed request must not poison the remaining invocation queue.
    tail = pending.catch(() => undefined);
    return pending;
  };
  return createEvmWalletClient({ callTool }, options);
}
