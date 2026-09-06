import { expect, test } from "bun:test";
import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import { presentUniswapV4Swap } from "../src/v4_swap_presentation.ts";
import type { Operation } from "../src/data.ts";

const ROUTERS: Record<string, Address> = {
  "1": "0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca",
  "42161": "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
};
const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OWNER = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const HOOK = "0x5555555555555555555555555555555555555555";
const EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const ACTIONS = parseAbiParameters("bytes actions, bytes[] params");
const SINGLE = parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params");
const SETTLE = parseAbiParameters("address currency,uint256 amount");
const TAKE = parseAbiParameters("address currency,address recipient,uint256 amount");

type Options = {
  mode?: "nativeIn" | "nativeOut" | "tokens";
  chainId?: string;
  commands?: Hex;
  actions?: Hex;
  hooks?: Address;
  takeCurrency?: Address;
  takeAmount?: bigint;
  settleAmount?: bigint;
  settleCurrency?: Address;
  takeRecipient?: Address;
  refundRecipient?: Address;
  refundCurrency?: Address;
  refundMinimum?: bigint;
  extraInput?: boolean;
  extraAction?: boolean;
  trailingSwapBytes?: boolean;
  trailingActionBytes?: boolean;
};
function request(options: Options = {}): Operation {
  const mode = options.mode ?? "nativeIn";
  const nativeIn = mode === "nativeIn", nativeOut = mode === "nativeOut";
  const tokenIn = nativeIn ? ZERO : USDC;
  const tokenOut = nativeOut ? ZERO : nativeIn ? USDC : WETH;
  const amountIn = nativeIn ? 10n ** 15n : 1_000_000n;
  const minimumOut = nativeIn ? 995_000n : 10n ** 14n;
  const params: Hex[] = [
    encodeAbiParameters(SINGLE, [{
      poolKey: { currency0: nativeIn || nativeOut ? ZERO : USDC, currency1: nativeIn || nativeOut ? USDC : WETH, fee: 500, tickSpacing: 10, hooks: options.hooks ?? ZERO },
      zeroForOne: !nativeOut, amountIn, amountOutMinimum: minimumOut, minHopPriceX36: 0n, hookData: options.hooks ? "0x1234" : "0x",
    }]),
    encodeAbiParameters(SETTLE, [options.settleCurrency ?? tokenIn, options.settleAmount ?? amountIn]),
    encodeAbiParameters(TAKE, [options.takeCurrency ?? tokenOut, options.takeRecipient ?? RECIPIENT, options.takeAmount ?? 0n]),
  ];
  if (options.trailingSwapBytes) params[0] = `${params[0]!}00`;
  if (options.extraAction) params.push("0x");
  const inputs: Hex[] = [encodeAbiParameters(ACTIONS, [options.actions ?? "0x060c0e", params])];
  if (options.trailingActionBytes) inputs[0] = `${inputs[0]!}00`;
  if (nativeIn) inputs.push(encodeAbiParameters(TAKE, [options.refundCurrency ?? ZERO, options.refundRecipient ?? OWNER, options.refundMinimum ?? 0n]));
  if (options.extraInput) inputs.push("0x");
  const chainId = options.chainId ?? "1";
  return { address: OWNER, chainId, preparedTransaction: {
    to: ROUTERS[chainId], value: nativeIn ? amountIn.toString() : "0",
    data: encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [options.commands ?? (nativeIn ? "0x1004" : "0x10"), inputs, 2_000_000_000n] }),
  }, intent: {} } as Operation;
}

test("V4 native input shows its exact payment, minimum and custom recipient with owner refund", () => {
  expect(presentUniswapV4Swap(request(), mergeEvmAssets([]))).toMatchObject({
    title: "Swap tokens", amount: "0.001 ETH", tokenAddress: null,
    parties: [{ label: "Minimum received", value: "0.995 USDC" }, { label: "Recipient", value: RECIPIENT }],
    swap: { protocol: "v4", tokenIn: ZERO, tokenOut: getAddress(USDC), amountIn: "1000000000000000", amountOutMinimum: "995000", recipient: RECIPIENT, refundRecipient: OWNER, inputNative: true, outputNative: false, minHopPriceX36: "0", deadline: "2000000000" },
  });
});

test("native output uses V4's zero currency instead of pretending it is a WETH unwrap", () => {
  expect(presentUniswapV4Swap(request({ mode: "nativeOut" }), mergeEvmAssets([]))).toMatchObject({
    amount: "1 USDC", tokenAddress: getAddress(USDC),
    parties: [{ label: "Minimum received", value: "0.0001 ETH" }, { label: "Recipient", value: RECIPIENT }],
    swap: { tokenIn: getAddress(USDC), tokenOut: ZERO, inputNative: false, outputNative: true },
  });
});

test("ERC20 swaps retain hook and pool details in the review and support both deployed routers", () => {
  for (const chainId of ["1", "42161"]) {
    expect(presentUniswapV4Swap(request({ mode: "tokens", hooks: HOOK, chainId }), mergeEvmAssets([]))).toMatchObject({
      contract: ROUTERS[chainId],
      parties: [expect.anything(), { label: "Recipient", value: RECIPIENT }, { label: "Pool hook", value: HOOK }],
      swap: { protocol: "v4", poolKey: { currency0: getAddress(USDC), currency1: getAddress(WETH), fee: "500", tickSpacing: "10", hooks: HOOK }, hookData: "0x1234", inputNative: false, outputNative: false },
    });
  }
});

test("mismatched settlement, output, refunds and unexpected commands remain ordinary contract interactions", () => {
  const malformed: Options[] = [
    { settleCurrency: USDC }, { settleAmount: 1n }, { takeCurrency: ZERO }, { takeAmount: 1n },
    { refundRecipient: RECIPIENT }, { refundCurrency: USDC }, { refundMinimum: 1n },
    { commands: "0x9004" }, { commands: "0x100404" }, { commands: "0x10" },
    { actions: "0x060c0f" }, { extraAction: true }, { extraInput: true },
    { takeRecipient: ROUTERS["1"]! }, { takeRecipient: "0x0000000000000000000000000000000000000002" },
  ];
  for (const options of malformed) expect(presentUniswapV4Swap(request(options), mergeEvmAssets([]))).toBeNull();
  for (const mode of ["nativeIn", "nativeOut", "tokens"] as const) {
    const operation = request({ mode });
    operation.preparedTransaction!.value = "1";
    expect(presentUniswapV4Swap(operation, mergeEvmAssets([]))).toBeNull();
  }
});

test("sentinel recipients resolve to the authenticated wallet rather than a misleading literal address", () => {
  expect(presentUniswapV4Swap(request({ takeRecipient: "0x0000000000000000000000000000000000000001", refundRecipient: "0x0000000000000000000000000000000000000001" }), [])).toMatchObject({ swap: { recipient: OWNER, refundRecipient: OWNER } });
});

test("unknown destinations, old UR versions and malformed calldata cannot borrow a V4 swap label", () => {
  const operation = request();
  operation.preparedTransaction!.to = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
  expect(presentUniswapV4Swap(operation, [])).toBeNull();
  operation.preparedTransaction!.to = ROUTERS["1"]!;
  operation.preparedTransaction!.data = "0x3593564c00";
  expect(presentUniswapV4Swap(operation, [])).toBeNull();
});

test("unconsumed ABI bytes at every nested level retain the generic calldata review", () => {
  expect(presentUniswapV4Swap(request({ trailingSwapBytes: true }), [])).toBeNull();
  expect(presentUniswapV4Swap(request({ trailingActionBytes: true }), [])).toBeNull();
  const operation = request();
  operation.preparedTransaction!.data += "00";
  expect(presentUniswapV4Swap(operation, [])).toBeNull();
});
