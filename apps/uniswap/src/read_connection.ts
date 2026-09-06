import { callTool } from "neutron-tools/app";
import { EVM_WALLET_TARGET, EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";

/** Exact read access for this connection; transactions and signatures stay separate. */
export const WALLET_READ_TOOLS = [
  EVM_WALLET_TOOLS.accounts,
  EVM_WALLET_TOOLS.balances,
  EVM_WALLET_TOOLS.callContract,
  EVM_WALLET_TOOLS.estimateTransaction,
  EVM_WALLET_TOOLS.transaction,
  EVM_WALLET_TOOLS.replacementTransaction,
] as const;

export async function connectWalletReads(kernel: { callTool: typeof callTool } = { callTool }): Promise<void> {
  // Rechecking an existing session grant is silent. Reconnecting a provider
  // invalidates its old grant, so re-establish access before concurrent reads.
  await kernel.callTool({
    target: "kernel", name: "permissions.request",
    arguments: { target: EVM_WALLET_TARGET, tools: [...WALLET_READ_TOOLS] },
  });
}
