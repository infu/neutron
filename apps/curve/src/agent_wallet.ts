import type { MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletInvocationClient, EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";

// These reads have exact install grants in neutron.json. Wallet effects still
// retain their provider review and the caller's invocation-scoped authority.
const parallelReadTools = [
  EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.balances, EVM_WALLET_TOOLS.prices,
  EVM_WALLET_TOOLS.callContract, EVM_WALLET_TOOLS.estimateTransaction,
  EVM_WALLET_TOOLS.transaction, EVM_WALLET_TOOLS.replacementTransaction,
  EVM_WALLET_TOOLS.operationStatus,
];

export function createServiceWallet(context: MsgBusToolContext) {
  return createEvmWalletInvocationClient(context, { parallelReadTools });
}
