import { describe, expect, test } from "bun:test";
import { buildActionReview } from "../src/action_review.ts";
import type { WalletTokenInfo } from "../src/wallet.ts";
import type { JsonObject } from "neutron-tools/app";

const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai", ID = "ab".repeat(16);
const info = (ledger: string, symbol: string, decimals: number): WalletTokenInfo => ({ ledger, symbol, decimals,
  account: "3rurp-vyaaa-aaaay-aacua-cai", name: null, feeAtoms: 10000n, balanceAtoms: 0n, observedAtNs: 1n });
const metadata = new Map([[ICP, info(ICP, "ICP", 8)], [USDC, info(USDC, "ckUSDC", 6)]]);
const swap: JsonObject = { pool: POOL, input_address: ICP, output_address: USDC, amount_in: "123456789",
  quoted_out: "5012345", expected_out: "5002345", amount_out_minimum: "4987283", token_in_fee: "10000",
  token_out_fee: "10000", funding_amount: "123456789", total_debit: "123476789", slippage: "500" };
const liquidity: JsonObject = { pool: POOL, token0: { address: ICP, standard: "ICRC2" }, token1: { address: USDC, standard: "ICRC1" },
  request: { kind: "mint", amount0: "123456789", amount1: "2500000", position_id: null, tick_lower: "-120", tick_upper: "240" },
  expected_amount0: "123450000", expected_amount1: "2499999", funding0: "100000000", funding1: "2000000",
  fee0: "10000", fee1: "10000", baseline_positions: Array.from({ length: 300 }, (_, id) => ({ id: String(id) })) };

describe("exact action reviews", () => {
  test("mixed token decimals and net/gross swap amounts remain distinct", () => {
    const input: JsonObject = { amount: "123456789" };
    const review = buildActionReview({ operationId: ID, kind: "swap", input, plan: swap, metadata });
    expect(review.pair).toBe("ICP → ckUSDC");
    expect(review.amount).toBe("1.23456789 ICP");
    expect(review.quotedOutputGross).toBe("5.012345 ckUSDC");
    expect(review.expectedOutputNet).toBe("5.002345 ckUSDC");
    expect(review.minimumOutputGross).toBe("4.987283 ckUSDC");
    expect(review.minimumOutputNetEstimate).toBe("4.977283 ckUSDC");
    expect(review.estimatedWalletDebit).toBe("1.23476789 ICP");
    expect(review.slippage).toBe("0.5%");
    expect(review.exactAction).toEqual({ operationId: ID, input, plan: swap });
  });

  test("gross quote can supply net estimate without inventing a missing fee", () => {
    const { expected_out: _unused, ...withoutNet } = swap;
    const review = (plan: JsonObject) => buildActionReview({ operationId: ID, kind: "swap", input: {}, plan, metadata });
    expect(review(withoutNet).expectedOutputNet).toBe("5.002345 ckUSDC");
    expect(review({ ...withoutNet, token_out_fee: null }).expectedOutputNet).toBe("Unavailable");
    expect(review({ ...withoutNet, token_out_fee: null }).minimumOutputNetEstimate).toBe("Unavailable");
    expect(review({ ...withoutNet, quoted_out: "9999" }).expectedOutputNet).toBe("0 ckUSDC");
  });

  test("amounts above Number.MAX_SAFE_INTEGER retain every atomic unit", () => {
    const review = buildActionReview({ operationId: ID, kind: "swap", input: {},
      plan: { ...swap, amount_in: "12345678901234567890123456789" }, metadata });
    expect(review.amount).toBe("123456789012345678901.23456789 ICP");
  });

  test("unknown metadata is explicit atoms, and unavailable evidence is not zero", () => {
    const review = buildActionReview({ operationId: ID, kind: "swap", input: {}, plan: { ...swap, total_debit: null }, metadata: new Map() });
    expect(review.amount).toBe(`123456789 atoms (${ICP})`);
    expect(review.expectedOutputNet).toBe(`5002345 atoms (${USDC})`);
    expect(review.estimatedWalletDebit).toBe("Unavailable");
    const wrongMetadata = new Map([[ICP, info(USDC, "ckUSDC", 6)]]);
    expect(buildActionReview({ operationId: ID, kind: "swap", input: {}, plan: swap, metadata: wrongMetadata }).amount).toBe(`123456789 atoms (${ICP})`);
  });

  test("position maximums differ from expected use and Wallet funding includes exact fees", () => {
    const review = buildActionReview({ operationId: ID, kind: "liquidity", input: { kind: "mint" }, plan: liquidity, metadata });
    expect(review.maximums).toEqual(["1.23456789 ICP", "2.5 ckUSDC"]);
    expect(review.expectedPositionAmounts).toEqual(["1.2345 ICP", "2.499999 ckUSDC"]);
    expect(String(review.range)).toContain("ckUSDC / ICP");
    expect(String(review.range)).toStartWith("≈ ");
    expect(review.position).toBe("New position");
    expect(review.funding).toEqual([
      { token: "ICP", poolFundingDeficit: "1 ICP", route: "Approve the pool", requestedWalletAmount: "1 ICP", estimatedWalletDebit: "1.0002 ICP" },
      { token: "ckUSDC", poolFundingDeficit: "2 ckUSDC", route: "Send to the pool deposit account", requestedWalletAmount: "2.01 ckUSDC", estimatedWalletDebit: "2.02 ckUSDC" },
    ]);
    expect(review.notes).toContain("ICPSwap liquidity methods have no protocol-enforced minimum amounts or deadline. Expected amounts can change before execution.");
    const { exactAction, ...summary } = review;
    expect(JSON.stringify(summary)).not.toContain("baseline_positions");
    expect((exactAction as JsonObject).plan).toBe(liquidity);
  });

  test("human range preserves integer price zeroes", () => {
    const plan = { ...liquidity, request: { ...(liquidity.request as JsonObject), tick_lower: "0" } };
    expect(String(buildActionReview({ operationId: ID, kind: "liquidity", input: {}, plan, metadata }).range)).toStartWith("≈ 100 to ");
  });

  test("close review uses effective retained liquidity and position range", () => {
    const plan = { ...liquidity, funding0: "0", funding1: "0", request: { kind: "close", position_id: "9007199254740993", liquidity: "12345678901234567890", tick_lower: "120", tick_upper: "240" } };
    const review = buildActionReview({ operationId: ID, kind: "liquidity", input: { kind: "close", liquidity: "0" }, plan, metadata });
    expect(review.title).toBe("Close an ICPSwap position");
    expect(review.position).toBe("#9007199254740993");
    expect(review.liquidityToRemove).toBe("12345678901234567890");
    expect(review.funding).toEqual([]);
    expect(review.expectedPoolAmountsGross).toEqual(["1.2345 ICP", "2.499999 ckUSDC"]);
    expect(review).not.toHaveProperty("maximums");
  });

  test("unused withdrawal identifies gross amount and net Wallet receipt", () => {
    const plan = { ...liquidity, funding0: "0", funding1: "0", request: { kind: "withdraw", withdraw_token: USDC, withdraw_amount: "1000000", position_id: null } };
    const review = buildActionReview({ operationId: ID, kind: "liquidity", input: {}, plan, metadata });
    expect(review.amount).toBe("1 ckUSDC");
    expect(review.expectedOutputNet).toBe("0.99 ckUSDC");
    expect(review.position).toBe("Pool unused balance");
    expect(review.range).toBeNull();
  });

  test.each(["claim", "decrease", "close"])("%s keeps sub-fee pool credit distinct from a Wallet payout", (kind) => {
    const plan = { ...liquidity, funding0: "0", funding1: "0", expected_amount0: "429", expected_amount1: "10001",
      request: { kind, position_id: "5090", liquidity: "186839601" } };
    const review = buildActionReview({ operationId: ID, kind: "liquidity", input: { kind }, plan, metadata });
    expect(review.expectedPoolAmountsGross).toEqual(["0.00000429 ICP", "0.010001 ckUSDC"]);
    expect(review.estimatedWalletAmountsNet).toEqual(["0 ICP", "0.000001 ckUSDC"]);
    expect((review.notes as string[]).some((note) => note.includes("0.00000429 ICP") && note.includes("stay in your pool balance"))).toBe(true);
  });

  test("missing transfer fee leaves the net estimate unavailable", () => {
    const plan = { ...liquidity, funding0: "0", funding1: "0", fee0: null, expected_amount0: "429", expected_amount1: "0", request: { kind: "claim" } };
    const review = buildActionReview({ operationId: ID, kind: "liquidity", input: {}, plan, metadata });
    expect(review.estimatedWalletAmountsNet).toEqual(["Unavailable", "0 ckUSDC"]);
    expect((review.notes as string[]).some((note) => note.includes("stay in your pool balance"))).toBe(false);
  });
});
