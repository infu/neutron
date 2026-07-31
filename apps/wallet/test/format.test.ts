import { expect, test } from "bun:test";
import {
  maxTransferAmount,
  parseTransferAmount,
} from "../src/format.ts";

test("transfer amounts require ledger decimals before consent", () => {
  const token = { balance: "1000000", decimals: null, fee: "100" };

  expect(() => parseTransferAmount("1", token)).toThrow(
    "Token decimals are not available",
  );
  expect(maxTransferAmount(token)).toBeNull();
});

test("transfer amounts account for the ledger fee", () => {
  const token = { balance: "1000000", decimals: 4, fee: "100" };

  expect(parseTransferAmount("99.99", token)).toBe("999900");
  expect(maxTransferAmount(token)).toBe("99.99");
  expect(() => parseTransferAmount("100", token)).toThrow(
    "Amount and fee exceed the available balance",
  );
});
