import { expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import { presentUniswapSwap } from "../src/decoders/adapters/swap_presentation.ts";
import type { Operation } from "../src/data.ts";

const router = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const recipient = "0x4444444444444444444444444444444444444444";
const abi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);
function request(nativeInput: boolean, nativeOutput: boolean, extra: Hex[] = []): Operation {
  const input = nativeInput ? 10n ** 15n : 1_000_000n;
  const output = nativeOutput ? 10n ** 14n : 995_000n;
  const calls: Hex[] = [encodeFunctionData({ abi, functionName: "exactInputSingle", args: [{
    tokenIn: nativeInput ? weth : usdc, tokenOut: nativeOutput ? weth : usdc,
    fee: 3000, recipient: nativeOutput ? router : recipient,
    amountIn: input, amountOutMinimum: output, sqrtPriceLimitX96: 0n,
  }] })];
  if (nativeOutput) calls.push(encodeFunctionData({ abi, functionName: "unwrapWETH9", args: [output, recipient] }));
  if (nativeInput) calls.push(encodeFunctionData({ abi, functionName: "refundETH" }));
  calls.push(...extra);
  return { chainId: "1", address: recipient, preparedTransaction: {
    to: router, value: nativeInput ? input.toString() : "0",
    data: encodeFunctionData({ abi, functionName: "multicall", args: [2_000_000_000n, calls] }),
  } } as Operation;
}

test("wallet shows exact native input and token minimum for the router's swap/refund flow", () => {
  expect(presentUniswapSwap(request(true, false), mergeEvmAssets([]))).toMatchObject({
    title: "Swap tokens", amount: "0.001 ETH", tokenAddress: null,
    parties: [{ label: "Minimum received", value: "0.995 USDC" }, { label: "Recipient", value: recipient }],
  });
});

test("wallet shows ERC20 input and the actual native-output recipient after unwrap", () => {
  expect(presentUniswapSwap(request(false, true), mergeEvmAssets([]))).toMatchObject({
    amount: "1 USDC", tokenAddress: getAddress(usdc),
    parties: [{ label: "Minimum received", value: "0.0001 ETH" }, { label: "Recipient", value: recipient }],
  });
});

test("unknown extra calls or a mismatched native payment never receive a misleading swap-only summary", () => {
  const extra = encodeFunctionData({ abi, functionName: "refundETH" });
  expect(presentUniswapSwap(request(true, false, [extra]), mergeEvmAssets([]))).toBeNull();
  const operation = request(true, false);
  operation.preparedTransaction!.value = "2";
  expect(presentUniswapSwap(operation, mergeEvmAssets([]))).toBeNull();
  operation.preparedTransaction!.to = recipient;
  expect(presentUniswapSwap(operation, mergeEvmAssets([]))).toBeNull();
});

test("V3 swap interpretation consumes the exact outer call and every nested call", () => {
  const outerTrailing = request(true, false);
  outerTrailing.preparedTransaction!.data += "00";
  expect(presentUniswapSwap(outerTrailing, mergeEvmAssets([]))).toBeNull();

  for (const index of [0, 1]) {
    const nestedTrailing = request(true, false);
    const outer = decodeFunctionData({ abi, data: nestedTrailing.preparedTransaction!.data as Hex });
    if (outer.functionName !== "multicall") throw new Error("Expected multicall");
    const calls = [...outer.args[1]];
    calls[index] = `${calls[index]!}00`;
    nestedTrailing.preparedTransaction!.data = encodeFunctionData({ abi, functionName: "multicall", args: [outer.args[0], calls] });
    expect(presentUniswapSwap(nestedTrailing, mergeEvmAssets([]))).toBeNull();
  }
});

test("V3 recipient flags resolve to the actual sender or router custody", () => {
  function flagged(nativeOutput: boolean, flag: Hex): Operation {
    const op = request(false, nativeOutput);
    const outer = decodeFunctionData({ abi, data: op.preparedTransaction!.data as Hex });
    if (outer.functionName !== "multicall") throw new Error("Expected multicall");
    const calls = [...outer.args[1]];
    const swap = decodeFunctionData({ abi, data: calls[0]! });
    if (swap.functionName !== "exactInputSingle") throw new Error("Expected swap");
    calls[0] = encodeFunctionData({ abi, functionName: "exactInputSingle", args: [{ ...swap.args[0], recipient: flag }] });
    op.preparedTransaction!.data = encodeFunctionData({ abi, functionName: "multicall", args: [outer.args[0], calls] });
    return op;
  }
  expect(presentUniswapSwap(flagged(false, "0x0000000000000000000000000000000000000001"), mergeEvmAssets([]))?.parties).toContainEqual({ label: "Recipient", value: recipient });
  // A router-custody output is not delivered until the corresponding unwrap.
  expect(presentUniswapSwap(flagged(false, "0x0000000000000000000000000000000000000002"), mergeEvmAssets([]))).toBeNull();
  expect(presentUniswapSwap(flagged(true, "0x0000000000000000000000000000000000000002"), mergeEvmAssets([]))?.swap).toMatchObject({ recipient, outputNative: true });
});
