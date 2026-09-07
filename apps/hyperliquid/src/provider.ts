import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { requireEvmWalletCaller } from "neutron-tools/evm_wallet";

/** The resident retains the exact prepared action. UI approval only answers the
 * review; it cannot replace the action or provide a signature. Agent approval
 * is bound by the Kernel to this provider invocation, as in EVM Wallet. */
export async function authorizeTrade(context: MsgBusToolContext, review: JsonObject): Promise<void> {
  context.signal?.throwIfAborted();
  const caller = requireEvmWalletCaller(context);
  if (context.agentMode) {
    if (!context.requestApproval) throw new Error("Update Neutron to use exact Agent trading review.");
    await context.requestApproval(review);
  } else {
    let result: { approved: boolean };
    const args = { reviewJson: JSON.stringify(review) };
    if (caller.appId === "hyperliquid") {
      const endpoint = context.caller!.endpoint;
      if (context.caller!.role !== "tile" || !/^app:hyperliquid:tile:hyperliquid:instance:[^:]+$/.test(endpoint)) {
        throw new Error("Human trade review requires the originating Hyperliquid tile.");
      }
      result = await context.kernel.callTool<{ approved: boolean }>({
        target: endpoint as `app:hyperliquid:tile:hyperliquid:instance:${string}`,
        name: "hl_owner_review_v1", arguments: args,
      }, context.signal ? { signal: context.signal } : undefined);
    } else {
      if (!context.presentUserInterface) throw new Error("Update Neutron to review this trade in Hyperliquid.");
      result = await context.presentUserInterface<{ approved: boolean }>({ tileId: "hyperliquid", tool: "hl_review_v1", arguments: args });
    }
    if (result?.approved !== true) throw new Error("Trade review declined. No new order was submitted.");
  }
  context.signal?.throwIfAborted();
}
