import { expect, test } from "bun:test";
import type { EvmAccount } from "neutron-tools/evm_wallet";
import { readWalletAccounts } from "../src/read_connection.ts";

const account: EvmAccount = { accountId: "main", address: "0x1111111111111111111111111111111111111111", publicKey: `0x02${"22".repeat(32)}`, keyFingerprint: `0x${"33".repeat(32)}`, namespaceVersion: "1" };

test("opening Wallet reads available accounts without a runtime permission request", async () => {
  let reads = 0;
  const wallet = { accounts: async () => { reads++; return { accounts: [account] }; } };
  expect(await readWalletAccounts(wallet, "main")).toEqual({ accounts: [account], selected: account });
  expect(await readWalletAccounts(wallet, "removed-account")).toEqual({ accounts: [account], selected: account });
  expect(reads).toBe(2);
});

test("an empty Wallet and a temporary read error remain distinguishable for automatic recovery", async () => {
  expect(await readWalletAccounts({ accounts: async () => ({ accounts: [] }) }, "main")).toEqual({ accounts: [], selected: null });
  await expect(readWalletAccounts({ accounts: async () => { throw new Error("Wallet is starting"); } }, "main")).rejects.toThrow("Wallet is starting");
});
