import type { MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletInvocationClient, EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";

// These exact reads are declared in neutron.json and need no Agent decision on
// Kernel 344+. Keep unlisted calls in the queue: a read without an install grant
// can still ask the judge for routing permission.
const installedReads = new Set<string>([
  EVM_WALLET_TOOLS.accounts,
  EVM_WALLET_TOOLS.balances,
  EVM_WALLET_TOOLS.prices,
  EVM_WALLET_TOOLS.callContract,
  EVM_WALLET_TOOLS.estimateTransaction,
  EVM_WALLET_TOOLS.transaction,
  EVM_WALLET_TOOLS.replacementTransaction,
  EVM_WALLET_TOOLS.operationStatus,
]);

/** Pool, position, metadata and fee reads share the Kernel's existing child-call
 * capacity. Excess reads wait; effects still receive serial provider reviews.
 * The shared client retains this invocation's authority and cancellation.
 */
export function createServiceWallet(context: MsgBusToolContext) {
  return createEvmWalletInvocationClient(context, { parallelReadTools: [...installedReads] });
}
