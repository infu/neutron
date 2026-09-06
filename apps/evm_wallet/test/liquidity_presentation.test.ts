import { expect, test } from "bun:test";
import { CurrencyAmount, Ether, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool as V3Pool, Position as V3Position } from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position, V4PositionManager } from "@uniswap/v4-sdk";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import type { Operation } from "../src/data.ts";
import { presentPermit2Approval, presentUniswapLiquidity } from "../src/liquidity_presentation.ts";
import { presentOperation } from "../src/presentation.ts";

const owner = "0x4444444444444444444444444444444444444444";
const receiver = "0x5555555555555555555555555555555555555555";
const v3Manager = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
const v4Manager = "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e";
const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const zero = "0x0000000000000000000000000000000000000000";
const usdc = new Token(1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6, "USDC");
const weth = Ether.onChain(1).wrapped;
const native = Ether.onChain(1);
const assets = mergeEvmAssets([]);
const common = { slippageTolerance: new Percent(50, 10_000), deadline: "2000000000" };
const v3Pool = new V3Pool(usdc, weth, 3000, (2n ** 96n).toString(), "1000000000000", 0);
const v3Position = new V3Position({ pool: v3Pool, liquidity: "1000000000", tickLower: -120, tickUpper: 120 });
const v4Pool = new V4Pool(usdc, weth, 3000, 60, zero, (2n ** 96n).toString(), "1000000000000", 0);
const v4Position = new V4Position({ pool: v4Pool, liquidity: "1000000000", tickLower: -120, tickUpper: 120 });
const v4NativePool = new V4Pool(native, usdc, 3000, 60, zero, (2n ** 96n).toString(), "1000000000000", 0);
const v4NativePosition = new V4Position({ pool: v4NativePool, liquidity: "1000000000", tickLower: -120, tickUpper: 120 });
function operation(manager: string, parameters: { calldata: string; value: string }): Operation {
  return { chainId: "1", address: owner, kind: "transaction", intent: {}, preparedTransaction: { to: manager, data: parameters.calldata, value: BigInt(parameters.value).toString() } } as Operation;
}
const V3_ABI = parseAbi([
  "function multicall(bytes[] data) payable returns(bytes[])",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable",
  "function burn(uint256 tokenId) payable",
  "function refundETH() payable",
]);
const V4_ABI = parseAbi(["function modifyLiquidities(bytes unlockData,uint256 deadline) payable"]);
const UNLOCK = parseAbiParameters("bytes actions,bytes[] params");

test("official V3 and V4 SDK mints show maximum deposits, exact pair and NFT owner", () => {
  for (const [protocol, manager, sdk, position] of [
    ["v3", v3Manager, NonfungiblePositionManager, v3Position],
    ["v4", v4Manager, V4PositionManager, v4Position],
  ] as const) {
    const encoded = sdk.addCallParameters(position as never, { ...common, recipient: receiver });
    const summary = presentUniswapLiquidity(operation(manager, encoded), assets)!;
    expect(summary.title).toBe("Create liquidity position");
    expect(summary.amount).toContain("USDC");
    expect(summary.amount).toContain("WETH");
    expect(summary.liquidity).toMatchObject({ protocol, action: "mint", token0: usdc.address, token1: weth.address, recipient: receiver, deadline: common.deadline, tickLower: "-120", tickUpper: "120" });
    expect(BigInt(summary.liquidity!.amount0Max!)).toBeGreaterThan(0n);
    expect(summary.parties).toContainEqual({ label: "Position owner", value: receiver });
  }
});

test("native mints include ETH in the deposit and require the matching refund flow", () => {
  const v3 = operation(v3Manager, NonfungiblePositionManager.addCallParameters(v3Position, { ...common, recipient: owner, useNative: native }));
  const v4 = operation(v4Manager, V4PositionManager.addCallParameters(v4NativePosition, { ...common, recipient: owner, useNative: native }));
  for (const op of [v3, v4]) {
    const summary = presentUniswapLiquidity(op, assets)!;
    expect(summary.amount).toContain("ETH");
    expect(summary.amount).not.toContain("WETH");
    expect(summary.nativeValue).toBeNull();
    expect(summary.liquidity!.refundRecipient).toBe(owner);
    op.preparedTransaction!.value = (BigInt(op.preparedTransaction!.value) + 1n).toString();
    expect(presentUniswapLiquidity(op, assets)).toBeNull();
  }
});

test("existing-position SDK increases retain NFT identity and explicitly atomic token-order limits", () => {
  const v3 = operation(v3Manager, NonfungiblePositionManager.addCallParameters(v3Position, { ...common, tokenId: "42" }));
  const v4 = operation(v4Manager, V4PositionManager.addCallParameters(v4Position, { ...common, tokenId: "42" }));
  for (const op of [v3, v4]) {
    const summary = presentUniswapLiquidity(op, assets)!;
    expect(summary.title).toBe("Add liquidity");
    expect(summary.amount).toContain("atomic units");
    expect(summary.liquidity).toMatchObject({ action: "increase", tokenId: "42", deadline: common.deadline });
    expect(summary.liquidity!.token0).toBeUndefined();
  }
  const [unlock] = decodeFunctionData({ abi: V4_ABI, data: v4.preparedTransaction!.data as Hex }).args;
  expect(decodeAbiParameters(UNLOCK, unlock)[0]).toBe("0x001212");
});

test("official SDK withdrawal/close sequences show enforced minima, matching NFT and payout recipient", () => {
  for (const close of [false, true]) {
    const fraction = new Percent(close ? 100 : 50, 100);
    const v3 = operation(v3Manager, NonfungiblePositionManager.removeCallParameters(v3Position, {
      ...common, tokenId: "42", liquidityPercentage: fraction, burnToken: close,
      collectOptions: { recipient: receiver, expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(usdc, 0), expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(weth, 0) },
    }));
    const v4 = operation(v4Manager, V4PositionManager.removeCallParameters(v4Position, { ...common, tokenId: "42", liquidityPercentage: fraction, burnToken: close }));
    for (const op of [v3, v4]) {
      const summary = presentUniswapLiquidity(op, assets)!;
      expect(summary.liquidity).toMatchObject({ action: close ? "close" : "decrease", tokenId: "42", recipient: op === v3 ? receiver : owner });
      expect(BigInt(summary.liquidity!.amount0Min!)).toBeGreaterThan(0n);
      expect(summary.parties.some(party => party.label === "Minimum token 0")).toBe(true);
      expect(summary.amount).toBeNull();
    }
  }
});

test("fee collection and empty V3 closure never claim an invented withdrawal or NFT burn", () => {
  const v3 = operation(v3Manager, NonfungiblePositionManager.collectCallParameters({ tokenId: "42", recipient: receiver, expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(usdc, 0), expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(weth, 0) }));
  const v4 = operation(v4Manager, V4PositionManager.collectCallParameters(v4Position, { ...common, tokenId: "42", recipient: receiver, hookData: "0x" }));
  for (const op of [v3, v4]) {
    const summary = presentUniswapLiquidity(op, assets)!;
    expect(summary.title).toBe("Collect position fees");
    expect(summary.liquidity).toMatchObject({ action: "collect", tokenId: "42", recipient: receiver });
    expect(summary.parties.some(party => party.label.startsWith("Minimum"))).toBe(false);
  }
  const closed = operation(v3Manager, { value: "0", calldata: encodeFunctionData({ abi: V3_ABI, functionName: "multicall", args: [[v3.preparedTransaction!.data as Hex, encodeFunctionData({ abi: V3_ABI, functionName: "burn", args: [42n] })]] }) });
  const summary = presentUniswapLiquidity(closed, assets)!;
  expect(summary.liquidity!.action).toBe("close");
  expect(summary.description).toContain("empty position");
  expect(summary.liquidity!.amount0Min).toBeUndefined();
});

test("extra commands, altered settlement, wrong NFT and noncanonical calldata fall back to full contract review", () => {
  const mint = operation(v4Manager, V4PositionManager.addCallParameters(v4Position, { ...common, recipient: owner }));
  const [unlock, deadline] = decodeFunctionData({ abi: V4_ABI, data: mint.preparedTransaction!.data as Hex }).args;
  const [actions, params] = decodeAbiParameters(UNLOCK, unlock);
  const variants = [
    encodeAbiParameters(UNLOCK, [`${actions}12`, [...params, encodeAbiParameters(parseAbiParameters("address"), [getAddress(usdc.address)])]]),
    encodeAbiParameters(UNLOCK, [actions, [params[0]!, encodeAbiParameters(parseAbiParameters("address,address"), [getAddress(usdc.address), receiver])]]),
  ];
  for (const changed of variants) {
    const op = operation(v4Manager, { value: "0", calldata: encodeFunctionData({ abi: V4_ABI, functionName: "modifyLiquidities", args: [changed, deadline] }) });
    expect(presentUniswapLiquidity(op, assets)).toBeNull();
    expect(presentOperation(op, assets).title).toBe("Contract interaction");
  }
  const collect = encodeFunctionData({ abi: V3_ABI, functionName: "collect", args: [{ tokenId: 42n, recipient: owner, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }] });
  const wrongBurn = encodeFunctionData({ abi: V3_ABI, functionName: "burn", args: [43n] });
  const bad = operation(v3Manager, { value: "0", calldata: encodeFunctionData({ abi: V3_ABI, functionName: "multicall", args: [[collect, wrongBurn]] }) });
  expect(presentUniswapLiquidity(bad, assets)).toBeNull();
  mint.preparedTransaction!.data += "00";
  expect(presentUniswapLiquidity(mint, assets)).toBeNull();
});

test("Permit2 approval shows the actual token, amount, spender and expiry without claiming an LP or swap completion", () => {
  const abi = parseAbi(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
  const op = operation(permit2, { value: "0", calldata: encodeFunctionData({ abi, functionName: "approve", args: [getAddress(usdc.address), v4Manager, 3_000_000n, 2_000_000_000] }) });
  const summary = presentOperation(op, assets);
  expect(summary.amount).toBe("3 USDC");
  expect(summary.description).toContain("does not perform a swap or deposit liquidity");
  expect(summary.permit2Approval).toMatchObject({ token: usdc.address, spender: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e", amount: "3000000", expiration: "2000000000" });
  expect(summary.parties).toContainEqual({ label: "Expires", value: "2033-05-18T03:33:20 UTC" });
  const expired = operation(permit2, { value: "0", calldata: encodeFunctionData({ abi, functionName: "approve", args: [getAddress(usdc.address), v4Manager, 0n, 0] }) });
  expect(presentPermit2Approval(expired, assets)?.parties).toContainEqual({ label: "Expires", value: "Immediately expired" });
  op.preparedTransaction!.value = "1";
  expect(presentPermit2Approval(op, assets)).toBeNull();
});
