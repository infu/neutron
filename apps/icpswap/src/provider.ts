import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { isMsgBusInstallationUid } from "neutron-tools/protocol";

/** Consent belongs to this invocation and its exact retained plan. The tile
 * returns only a decision; it cannot substitute another protocol action. */
export async function authorizeAction(context: MsgBusToolContext, review: JsonObject): Promise<void> {
  context.signal?.throwIfAborted();
  const caller = context.caller;
  if (!caller?.appId || !isMsgBusInstallationUid(caller.installationUid)) {
    throw new Error("ICPSwap actions require an authenticated caller installation.");
  }
  if (context.agentMode) {
    if (!context.requestApproval) throw new Error("Exact Root Agent review is unavailable in this Neutron.");
    await context.requestApproval(review);
  } else {
    const args = { reviewJson: JSON.stringify(review) };
    let result: { approved: boolean };
    if (caller.appId === "icpswap") {
      if (caller.role !== "tile" || !/^app:icpswap:tile:main:instance:[^:]+$/u.test(caller.endpoint)) {
        throw new Error("Owner review requires the originating ICPSwap tile.");
      }
      result = await context.kernel.callTool<{ approved: boolean }>({
        target: caller.endpoint as `app:icpswap:tile:main:instance:${string}`,
        name: "icpswap_owner_review_v1", arguments: args,
      }, context.signal ? { signal: context.signal } : undefined);
    } else {
      if (!context.presentUserInterface) throw new Error("ICPSwap action review is unavailable in this Neutron.");
      result = await context.presentUserInterface<{ approved: boolean }>({
        tileId: "main", tool: "icpswap_review_v1", arguments: args,
      });
    }
    if (result?.approved !== true) throw new Error("ICPSwap action review declined. No funding or protocol action was sent by this review. Retain the operation ID if you choose to try again.");
  }
  context.signal?.throwIfAborted();
}
