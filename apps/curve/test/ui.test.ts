import { expect, test } from "bun:test";
import type { EvmAccount, EvmBalancesResult } from "neutron-tools/evm_wallet";
import type { Token } from "../src/contracts.ts";
import { accountBalances, accountScope, balanceFor, liquidityDraftAmounts } from "../src/ui.tsx";

const coins = [{ decimals: 18 }, { decimals: 6 }];

test("deposit budgets ignore unfinished hidden LP drafts without rounding active amounts", () => {
  const amounts = ["0.000000000000000001", "12345678901234567890.123456"];
  expect(liquidityDraftAmounts("deposit", amounts, coins, ".", 18)).toEqual({
    amounts: ["1", "12345678901234567890123456"], lpAmount: "0",
  });
  expect(amounts).toEqual(["0.000000000000000001", "12345678901234567890.123456"]);
});

test.each(["withdraw", "withdraw_one"] as const)("%s budgets ignore unfinished hidden deposit drafts", (mode) => {
  const amounts = [".", "1.0000001"];
  expect(liquidityDraftAmounts(mode, amounts, coins, "0.000000000000000001", 18)).toEqual({ amounts: [], lpAmount: "1" });
  expect(amounts).toEqual([".", "1.0000001"]);
});

test("invalid active drafts still report errors, and empty or zero active budgets do not quote", () => {
  expect(() => liquidityDraftAmounts("deposit", [".", "1"], coins, "1", 18)).toThrow("decimal places");
  expect(() => liquidityDraftAmounts("deposit", ["1", "1.0000001"], coins, "", 18)).toThrow("decimal places");
  expect(() => liquidityDraftAmounts("withdraw", ["1", "1"], coins, ".", 18)).toThrow("decimal places");
  expect(liquidityDraftAmounts("deposit", ["", "0"], coins, ".", 18)).toBeNull();
  expect(liquidityDraftAmounts("withdraw_one", [".", "."], coins, "", 18)).toBeNull();
  expect(liquidityDraftAmounts("withdraw", [".", "."], coins, "0", 18)).toBeNull();
});

const account: EvmAccount = { accountId: "main", address: "0xAbCd000000000000000000000000000000000000", publicKey: "0x02" + "11".repeat(32), keyFingerprint: "0x" + "22".repeat(32), namespaceVersion: "1" };
const native: Token = { chainId: "1", address: null, symbol: "ETH", decimals: 18 };
const usdc: Token = { chainId: "1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };
const balances: EvmBalancesResult = {
  accountId: "main", address: account.address.toLowerCase(), chainId: "1", nativeBalanceWei: "123456789012345678901234567890",
  tokens: [{ address: usdc.address!.toLowerCase(), balanceAtoms: "12345678901234567890123456", decimals: "6", symbol: "USDC", error: null }],
  blockNumber: "25922607", observedAtNs: "1", completeness: "requested_only",
};

test("account scopes invalidate quotes when the signing namespace or fingerprint changes", () => {
  expect(accountScope(null)).toBeNull();
  expect(accountScope({ ...account, address: account.address.toLowerCase() })).toBe(accountScope(account));
  expect(accountScope({ ...account, keyFingerprint: "0x" + "33".repeat(32) })).not.toBe(accountScope(account));
  expect(accountScope({ ...account, namespaceVersion: "2" })).not.toBe(accountScope(account));
  expect(accountScope({ ...account, address: "0x" + "44".repeat(20) })).not.toBe(accountScope(account));
});

test("native and token balances preserve exact atoms only for the observed account and network", () => {
  expect(accountBalances(balances, account)).toBe(balances);
  expect(balanceFor(balances, native, account)).toBe("123456789012345678901234567890");
  expect(balanceFor(balances, usdc, account)).toBe("12345678901234567890123456");
  expect(balanceFor(balances, { ...usdc, chainId: "42161" }, account)).toBeNull();
  expect(balanceFor(balances, { ...usdc, address: "0x5555555555555555555555555555555555555555" }, account)).toBeNull();
  expect(balanceFor({ ...balances, tokens: [{ ...balances.tokens[0]!, balanceAtoms: null, error: "Read unavailable" }] }, usdc, account)).toBeNull();
});

test("a response from another wallet cannot supply displayed balances or Max amounts", () => {
  const mismatch = { ...balances, address: "0x" + "66".repeat(20) };
  expect(accountBalances(mismatch, account)).toBeNull();
  expect(balanceFor(mismatch, native, account)).toBeNull();
  expect(balanceFor(mismatch, usdc, account)).toBeNull();
  expect(accountBalances(balances, null)).toBeNull();
  expect(accountBalances(null, account)).toBeNull();
  expect(balanceFor(balances, native, null)).toBeNull();
  expect(balanceFor(balances, usdc, null)).toBeNull();
});
