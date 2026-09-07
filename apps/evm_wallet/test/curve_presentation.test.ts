import { expect, test } from "bun:test";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import { presentCurve } from "../src/curve_presentation.ts";
import { presentOperation } from "../src/presentation.ts";
import type { Operation } from "../src/data.ts";
const router = "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e", native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", recipient = "0x4444444444444444444444444444444444444444", pool = "0x5555555555555555555555555555555555555555", zero = "0x0000000000000000000000000000000000000000";
const abi = parseAbi(["function exchange(address[11],uint256[5][5],uint256,uint256,address[5],address) payable returns (uint256)"]);
function swap(): Operation { return { chainId: "1", intent: {}, preparedTransaction: { to: router, value: "1000000000000000", data: encodeFunctionData({ abi, functionName: "exchange", args: [[native, weth, weth, pool, usdc, zero, zero, zero, zero, zero, zero], [[0n, 0n, 8n, 0n, 0n], [2n, 0n, 1n, 30n, 3n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]], 1000000000000000n, 995000n, [zero, zero, zero, zero, zero], recipient] }) } } as Operation; }
test("Curve router review derives native payment, minimum and receiver from calldata", () => {
  const shown = presentOperation(swap(), mergeEvmAssets([]));
  expect(shown.title).toBe("Swap through Curve"); expect(shown.amount).toBe("0.001 ETH"); expect(shown.parties).toEqual([{ label: "Minimum received", value: "0.995 USDC" }, { label: "Recipient", value: getAddress(recipient) }]); expect(shown.description).toContain("no onchain expiry"); expect(shown.advancedDetails?.find((field) => field.label === "Route")?.value).toContain(getAddress(pool));
});
test("wrong chain, router, payment or trailing calldata retain generic review", () => {
  for (const change of [(op: Operation) => { op.chainId = "42161"; }, (op: Operation) => { op.preparedTransaction!.to = recipient; }, (op: Operation) => { op.preparedTransaction!.value = "1"; }, (op: Operation) => { op.preparedTransaction!.data += "00"; }]) { const op = swap(); change(op); expect(presentCurve(op, [])).toBeNull(); }
});
test("pool liquidity review preserves coin budgets, receiver and minimum without asserting factory membership", () => {
  const poolAbi = parseAbi(["function add_liquidity(uint256[3],uint256,bool,address) payable"]);
  const op = { chainId: "1", address: recipient, intent: {}, preparedTransaction: { to: pool, value: "3000000000000000", data: encodeFunctionData({ abi: poolAbi, functionName: "add_liquidity", args: [[1000001n, 2000002n, 3000000000000000n], 999n, true, recipient] }) } } as Operation;
  const shown = presentOperation(op, []);
  expect(shown.title).toBe("Add pool liquidity"); expect(shown.description).toContain("does not verify Curve factory membership"); expect(shown.parties).toContainEqual({ label: "Minimum LP tokens (atomic units)", value: "999" }); expect(shown.parties).toContainEqual({ label: "Recipient", value: recipient }); expect(shown.nativeValue).toBe("0.003 ETH");
});
