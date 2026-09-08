import { expect, test } from "bun:test";
import { calculatePerpFeeRates } from "../src/fees";

test("observed referral discount applies to taker and positive maker fees exactly", () => {
  const raw = { userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0.04" };
  expect(calculatePerpFeeRates(raw)).toEqual({ takerRate: "0.000432", makerRate: "0.000144", activeReferralDiscount: "0.04" });
  expect(raw).toEqual({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0.04" });
});

test("referral discounts do not reduce negative maker rebates or change zero fees", () => {
  expect(calculatePerpFeeRates({ userCrossRate: "0.00045", userAddRate: "-0.00002", activeReferralDiscount: "0.04" }))
    .toEqual({ takerRate: "0.000432", makerRate: "-0.00002", activeReferralDiscount: "0.04" });
  expect(calculatePerpFeeRates({ userCrossRate: "0", userAddRate: "0", activeReferralDiscount: "0.04" }))
    .toEqual({ takerRate: "0", makerRate: "0", activeReferralDiscount: "0.04" });
});

test("missing discount retains supplied rates without fabricating a zero-discount observation", () => {
  expect(calculatePerpFeeRates({ userCrossRate: "0.00045", userAddRate: "0.00015" }))
    .toEqual({ takerRate: "0.00045", makerRate: "0.00015" });
  expect(calculatePerpFeeRates({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0" }))
    .toEqual({ takerRate: "0.00045", makerRate: "0.00015", activeReferralDiscount: "0" });
});

test("unavailable or invalid fee observations cannot produce plausible estimates", () => {
  expect(calculatePerpFeeRates(null)).toBeNull();
  expect(calculatePerpFeeRates({ userCrossRate: "NaN", userAddRate: "0" })).toBeNull();
  for (const activeReferralDiscount of ["bad", "-0.01", "1.01"]) {
    expect(calculatePerpFeeRates({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount })).toBeNull();
  }
});
