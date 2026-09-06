import type { EvmWalletClient } from "neutron-tools/evm_wallet";

/** Access is declared at installation; opening the app only reads Wallet state. */
export async function readWalletAccounts(wallet: Pick<EvmWalletClient, "accounts">, preferredAccountId: string) {
  const result = await wallet.accounts();
  return {
    accounts: result.accounts,
    selected: result.accounts.find((account) => account.accountId === preferredAccountId) ?? result.accounts[0] ?? null,
  };
}
