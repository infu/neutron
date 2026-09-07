import { expect, test } from "bun:test";
import { liquidityDraftAmounts } from "../src/ui.tsx";

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
