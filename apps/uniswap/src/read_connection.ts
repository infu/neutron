import { callTool } from "neutron-tools/app";
import { EVM_WALLET_TARGET, EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";

/** Exact read access for this connection. */
export const WALLET_READ_TOOLS = [
  EVM_WALLET_TOOLS.accounts,
  EVM_WALLET_TOOLS.balances,
  EVM_WALLET_TOOLS.callContract,
  EVM_WALLET_TOOLS.estimateTransaction,
  EVM_WALLET_TOOLS.transaction,
  EVM_WALLET_TOOLS.replacementTransaction,
] as const;

// Following a swap also reconciles its saved wallet request. This can resend
// only bytes that were already signed; it cannot approve or sign a new action.
// Include it in Connect so waiting for a receipt does not prompt on each poll.
export const WALLET_CONNECTION_TOOLS = [
  ...WALLET_READ_TOOLS,
  EVM_WALLET_TOOLS.operationStatus,
] as const;

export async function connectWalletReads(kernel: { callTool: typeof callTool } = { callTool }): Promise<void> {
  // Rechecking an existing session grant is silent. Reconnecting a provider
  // invalidates its old grant, so re-establish access before concurrent reads.
  await kernel.callTool({
    target: "kernel", name: "permissions.request",
    arguments: { target: EVM_WALLET_TARGET, tools: [...WALLET_CONNECTION_TOOLS] },
  });
}
