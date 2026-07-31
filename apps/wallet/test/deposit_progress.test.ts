import { expect, test } from "bun:test";
import {
  confirmationPercent,
  confirmationsRemaining,
  parseNativeDepositProgress,
} from "../src/deposit_progress.ts";

test("Wallet keeps concurrent deposits at independent confirmation counts", () => {
  const progress = parseNativeDepositProgress({
    checked_at: "1783958400000000000",
    current_confirmations: null,
    required_confirmations: "4",
    pending: [
      {
        txid: "11".repeat(32),
        vout: "0",
        value: "10000000",
        confirmations: "1",
        required_confirmations: "4",
      },
      {
        txid: "22".repeat(32),
        vout: "3",
        value: "25000000",
        confirmations: "3",
        required_confirmations: "4",
      },
    ],
    processing: [],
    recent_minted: [],
    issues: [],
  });

  expect(progress?.pending).toHaveLength(2);
  expect(progress?.pending.map((deposit) => deposit.confirmations)).toEqual([
    "1",
    "3",
  ]);
  expect(
    progress?.pending.map((deposit) => `${deposit.txid}:${deposit.vout}`),
  ).toEqual([`${"11".repeat(32)}:0`, `${"22".repeat(32)}:3`]);
});

test("Wallet derives bounded confirmation progress without floating point", () => {
  expect(confirmationPercent("1", "4")).toBe(25);
  expect(confirmationPercent("8", "4")).toBe(100);
  expect(confirmationsRemaining("3", "4")).toBe("1");
  expect(confirmationsRemaining("5", "4")).toBe("0");
});
