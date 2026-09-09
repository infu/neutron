import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { isMsgBusInstallationUid } from "neutron-tools/protocol";

/** A local explicit owner decision, distinct from an interrupted or malformed
 * review reply. Callers still inspect the durable journal before claiming that
 * the operation itself has no previously requested effects. */
export class ActionReviewDeclinedError extends Error {
  constructor() {
    super("ICPSwap action review declined. No funding or protocol action was sent by this review. Retain the operation ID if you choose to try again.");
    this.name = "ActionReviewDeclinedError";
  }
}

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
    context.signal?.throwIfAborted();
    if (result?.approved === false) throw new ActionReviewDeclinedError();
    if (result?.approved !== true) throw new Error("ICPSwap action review returned an invalid decision. No funding or protocol action was sent by this review.");
  }
  context.signal?.throwIfAborted();
}
