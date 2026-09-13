import type { MsgBusToolContext } from "neutron-tools/app";
import { operationStatus } from "./actions.ts";
import { protocolClient } from "./client.ts";
import { ethereumSavedStatus } from "./ethereum_actions.ts";
import { canDismissNotification } from "./notification-state.ts";
import { deleteOperationDrafts, operationDrafts } from "./store.ts";

/** Delete checkout recovery data, not entitlement or ledger accounting.
 * The backend compares all four roots atomically, then removes their histories
 * too. A payment starting during the status check makes deletion fail. */
export async function dismissOperation(context: MsgBusToolContext, id: string): Promise<void> {
  const snapshot = await operationDrafts(context.kernel, id);
  const root = snapshot.find(draft => draft.id === `operation:${id}` || draft.id === `ethereum:operation:${id}`);
  if (root) {
    const saved = JSON.parse(new TextDecoder().decode(root.value));
    const client = await protocolClient(context);
    if (saved.scope.canister !== client.state.canisterId || saved.scope.owner !== client.state.owner) throw new Error("This checkout belongs to another marketplace or Neutron.");
    const status = root.id.startsWith("ethereum:") ? await ethereumSavedStatus(context, id) : await operationStatus(context, id);
    if (!status || !canDismissNotification(status)) throw new Error("This payment is still unresolved. Check its status and finish recovering the committed funds before dismissing it.");
  } else if (snapshot.length) {
    throw new Error("This payment still has a saved transaction without its checkout. Recover its original transaction before dismissing it.");
  }
  await deleteOperationDrafts(context.kernel, id, snapshot);
}
