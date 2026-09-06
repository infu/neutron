import type { JsonValue, MsgBusCallOptions, MsgBusToolCall, MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient } from "neutron-tools/evm_wallet";

/** Agent permission decisions belong to the whole invocation. Pool, metadata,
 * and fee reads may be parallel in the UI, but must not ask the Agent's judge
 * concurrently. Keep this queue local to one tool call, retaining the scoped
 * Kernel client and each request's cancellation/transport options.
 */
export function createServiceWallet(context: MsgBusToolContext) {
  const options = context.signal ? { callOptions: { signal: context.signal } } : {};
  if (!context.agentMode) return createEvmWalletClient(context.kernel, options);
  let tail: Promise<unknown> = Promise.resolve();
  const callTool = <T extends JsonValue = JsonValue>(call: MsgBusToolCall, options?: number | MsgBusCallOptions): Promise<T> => {
    const pending = tail.then(() => {
      context.signal?.throwIfAborted();
      if (typeof options === "object") options.signal?.throwIfAborted();
      return context.kernel.callTool<T>(call, options);
    });
    // One unavailable pool must not prevent other pools from being checked.
    tail = pending.catch(() => undefined);
    return pending;
  };
  return createEvmWalletClient({ callTool }, options);
}
