import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import { PERMIT2, permit2ApprovalSteps, planErc20Approval, planPermit2Approval } from "../src/approval_plan.ts";
import type { Reader } from "../src/swap.ts";

// Contract-facing interfaces are independent of the planner's private ABI.
const erc20 = parseAbi([
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const permit2 = parseAbi([
  "function allowance(address,address,address) view returns (uint160,uint48,uint48)",
  "function approve(address,address,uint160,uint48)",
]);
const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7");
const spender = getAddress("0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e");
const input = { chainId: "1", accountId: "primary", owner, token, spender, amount: "3000000", symbol: "USDT" };
const nowSeconds = "1800000000", expiration = "1800000600";
function reader(options: { erc20Allowance?: bigint; permitAllowance?: bigint; permitExpiration?: number } = {}) {
  const calls: Array<{ chainId: string; to: Address; data: Hex }> = [];
  const read: Reader = async (chainId, to, data) => {
    calls.push({ chainId, to, data });
    const result = to === PERMIT2
      ? encodeFunctionResult({ abi: permit2, functionName: "allowance", result: [options.permitAllowance ?? 0n, options.permitExpiration ?? 0, 7] })
      : encodeFunctionResult({ abi: erc20, functionName: "allowance", result: options.erc20Allowance ?? 0n });
    return { data: result, blockNumber: "21000000", observedAtMs: 1800000000000 };
  };
  return { read, calls };
}

describe("exact ERC20 approvals", () => {
  test.each([3000000n, 2n ** 256n - 1n])("reuses adequate allowance %s", async (allowance) => {
    const { read, calls } = reader({ erc20Allowance: allowance });
    expect(await planErc20Approval(read, input)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: erc20, data: calls[0]!.data })).toMatchObject({ functionName: "allowance", args: [owner, spender] });
  });

  test.each([0n, 2999999n])("preserves USDT reset order for allowance %s", async (allowance) => {
    const { read } = reader({ erc20Allowance: allowance });
    const steps = await planErc20Approval(read, input);
    expect(steps.map((step) => decodeFunctionData({ abi: erc20, data: step.transaction.data }).args))
      .toEqual(allowance ? [[spender, 0n], [spender, 3000000n]] : [[spender, 3000000n]]);
    expect(steps.every((step) => step.kind === "approval" && step.transaction.value === "0" && step.transaction.to === token)).toBe(true);
    expect(steps.at(-1)!.transaction).toMatchObject({ chainId: "1", accountId: "primary" });
  });

  test.each([
    { chainId: "1", token: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), symbol: "USDC" },
    { chainId: "1", token: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), symbol: "WETH" },
    { chainId: "42161", token: getAddress("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"), symbol: "USDT0" },
    { chainId: "1", token: owner, symbol: "USDT" },
    { chainId: "42161", token, symbol: "USDT" },
  ])("ordinary tokens replace a deficient allowance directly (%o)", async (asset) => {
    const { read } = reader({ erc20Allowance: 1n });
    const steps = await planErc20Approval(read, { ...input, ...asset });
    expect(steps).toHaveLength(1);
    expect(decodeFunctionData({ abi: erc20, data: steps[0]!.transaction.data }).args).toEqual([spender, 3000000n]);
  });

  test("a zero amount needs no RPC read", async () => {
    const { read, calls } = reader();
    expect(await planErc20Approval(read, { ...input, amount: "0" })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test.each(["-1", "1.5", "1e6", "01", "3\n", (2n ** 256n).toString()])("rejects invalid uint256 %s before reading", async (amount) => {
    const { read, calls } = reader();
    await expect(planErc20Approval(read, { ...input, amount })).rejects.toThrow("uint256");
    expect(calls).toHaveLength(0);
  });
});

describe("Permit2 allowance planning", () => {
  test("queries the exact owner, token and downstream spender and reuses valid approval", async () => {
    const { read, calls } = reader({ permitAllowance: 3000000n, permitExpiration: Number(expiration) });
    expect(await planPermit2Approval(read, { ...input, expiration, nowSeconds })).toEqual([]);
    expect(calls[0]!.to).toBe(getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3"));
    expect(decodeFunctionData({ abi: permit2, data: calls[0]!.data })).toMatchObject({ functionName: "allowance", args: [owner, token, spender] });
  });

  test.each([
    { permitAllowance: 2999999n, permitExpiration: Number(expiration) },
    { permitAllowance: 3000000n, permitExpiration: Number(expiration) - 1 },
    { permitAllowance: 2n ** 160n - 1n, permitExpiration: Number(nowSeconds) - 1 },
  ])("insufficient or expiring allowance produces one exact authorization", async (options) => {
    const { read } = reader(options);
    const steps = await planPermit2Approval(read, { ...input, expiration, nowSeconds });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "approval", transaction: { chainId: "1", accountId: "primary", to: PERMIT2, value: "0" } });
    expect(decodeFunctionData({ abi: permit2, data: steps[0]!.transaction.data })).toMatchObject({ functionName: "approve", args: [token, spender, 3000000n, Number(expiration)] });
  });

  test("preserves maximum uint160 amount and uint48 expiration without truncation", async () => {
    const { read } = reader();
    const amount = 2n ** 160n - 1n, expires = 2n ** 48n - 1n;
    const steps = await planPermit2Approval(read, { ...input, amount: amount.toString(), expiration: expires.toString(), nowSeconds });
    expect(decodeFunctionData({ abi: permit2, data: steps[0]!.transaction.data }).args).toEqual([token, spender, amount, Number(expires)]);
  });

  test.each([
    { amount: (2n ** 160n).toString() },
    { expiration: (2n ** 48n).toString() },
    { expiration: "-1" },
    { expiration: "1800000600.5" },
    { expiration: nowSeconds },
  ])("rejects unusable authorization before RPC (%o)", async (override) => {
    const { read, calls } = reader();
    await expect(planPermit2Approval(read, { ...input, expiration, nowSeconds, ...override })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("a zero amount needs no RPC read", async () => {
    const { read, calls } = reader();
    expect(await planPermit2Approval(read, { ...input, amount: "0", expiration, nowSeconds })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("shared V4 plan sets ERC20→Permit2 then Permit2→manager, omitting zero amounts", async () => {
    const { read, calls } = reader({ erc20Allowance: 1n });
    // A historical test clock proves the convenience does not silently use the
    // current wall clock when callers prepare an operation with an explicit time.
    const clock = "1700000000", deadline = "1700000600";
    const steps = await permit2ApprovalSteps(read, { chainId: "1", accountId: "primary", accountAddress: owner, spender, deadline, nowSeconds: clock,
      tokens: [{ address: token, amount: "3000000", symbol: "USDT" }, { address: owner, amount: "0" }] });
    expect(steps).toHaveLength(3);
    expect(steps.every((step) => step.transaction.chainId === "1")).toBe(true);
    expect(decodeFunctionData({ abi: erc20, data: steps[0]!.transaction.data }).args).toEqual([PERMIT2, 0n]);
    expect(decodeFunctionData({ abi: erc20, data: steps[1]!.transaction.data }).args).toEqual([PERMIT2, 3000000n]);
    expect(decodeFunctionData({ abi: permit2, data: steps[2]!.transaction.data }).args).toEqual([token, spender, 3000000n, Number(deadline)]);
    expect(calls).toHaveLength(2);
  });
});
