import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { isMsgBusInstallationUid } from "neutron-tools/protocol";

export class SnsReviewDeclinedError extends Error {
  constructor() {
    super("Review canceled. No new SNS action was sent by this review.");
    this.name = "SnsReviewDeclinedError";
  }
}

export function isOwnerTile(context: MsgBusToolContext): boolean {
  const caller = context.caller;
  return !context.agentMode && caller?.appId === "snsgov" && caller.role === "tile"
    && isMsgBusInstallationUid(caller.installationUid)
    && /^app:snsgov:tile:main:instance:[^:]+$/.test(caller.endpoint);
}

/** Review is invocation-bound: the foreground returns a decision only, never
 * replacement command bytes. Root uses the existing Kernel approval judge. */
export async function authorizeAction(
  context: MsgBusToolContext,
  review: JsonObject,
  options: { ownerVote?: boolean } = {},
): Promise<void> {
  context.signal?.throwIfAborted();
  const caller = context.caller;
  if (!caller?.appId || !isMsgBusInstallationUid(caller.installationUid)) {
    throw new Error("SNS actions require an authenticated Neutron app invocation.");
  }
  if (context.agentMode) {
    if (!context.requestApproval) throw new Error("Exact SNS action review is unavailable in this Neutron.");
    await context.requestApproval(review);
  } else if (options.ownerVote && isOwnerTile(context)) {
    // The owner's Yes/No control already displays the proposal and selected
    // neurons. This is never used for a proposal, payment or permission change.
    // The flag is supplied by our vote handler, not accepted from tool input.
  } else {
    const args = { reviewJson: JSON.stringify(review) };
    let decision: { approved: boolean };
    if (isOwnerTile(context)) {
      decision = await context.kernel.callTool<{ approved: boolean }>({
        target: caller.endpoint as `app:snsgov:tile:main:instance:${string}`,
        name: "sns_owner_review_v1", arguments: args,
      }, context.signal ? { signal: context.signal } : undefined);
    } else {
      if (caller.appId === "snsgov") throw new Error("SNS owner review requires the originating tile.");
      if (!context.presentUserInterface) throw new Error("SNS action review is unavailable in this Neutron.");
      decision = await context.presentUserInterface<{ approved: boolean }>({
        tileId: "main", tool: "sns_review_v1", arguments: args,
      });
    }
    if (decision?.approved === false) throw new SnsReviewDeclinedError();
    if (decision?.approved !== true) throw new Error("SNS review did not return an approval. No new action was sent.");
  }
  context.signal?.throwIfAborted();
}
