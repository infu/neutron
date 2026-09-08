import { describe, expect, test } from "bun:test";
// SDK contract helpers are a development oracle only; production imports math.
import { Ether, Percent, Token as SdkToken } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool as V3Pool, Position as V3Position, TickMath } from "@uniswap/v3-sdk";
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import type { EvmAccount } from "neutron-tools/evm_wallet";
import { buildLiquidity, type LiquidityInput } from "../src/liquidity.ts";
import { fullRangeTicks, liquidityAmounts, positionWithinBudgets } from "../src/liquidity_math.ts";
import { network, type Token } from "../src/swap.ts";
import type { PoolState, PositionRecord } from "../src/positions.ts";

const NOW = 1_800_000_000_000;
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const A = getAddress("0x0000000000000000000000000000000000000010"), B = getAddress("0x0000000000000000000000000000000000000020");
const ACCOUNT: EvmAccount = { accountId: "main", address: OWNER, publicKey: "unused", keyFingerprint: "test", namespaceVersion: "1" };
const V4_ABI = parseAbi(["function modifyLiquidities(bytes unlockData,uint256 deadline) payable"]);
const V3_ABI = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) p) payable returns(uint256,uint128,uint256,uint256)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) p) payable returns(uint128,uint256,uint256)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) p) payable returns(uint256,uint256)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) p) payable returns(uint256,uint256)",
  "function burn(uint256 tokenId) payable", "function multicall(bytes[] calls) payable returns(bytes[] results)",
  "function refundETH() payable", "function unwrapWETH9(uint256 minimum,address recipient) payable", "function sweepToken(address token,uint256 minimum,address recipient) payable",
]);
function pool(protocol: "v3" | "v4" = "v4", native = false, chainId = "1"): PoolState {
  const token = (address: Address | null, symbol: string): Token => ({ chainId, address, symbol, decimals: 18 });
  let tokens = [token(native ? protocol === "v4" ? null : network(chainId).wrapped : A, native ? protocol === "v4" ? "ETH" : "WETH" : "AAA"), token(B, "BBB")];
  tokens.sort((a, b) => BigInt(a.address ?? zeroAddress) < BigInt(b.address ?? zeroAddress) ? -1 : 1);
  return { protocol, chainId, token0: tokens[0]!, token1: tokens[1]!, currency0: tokens[0]!.address, currency1: tokens[1]!.address, fee: 3000, tickSpacing: 60, hooks: zeroAddress, sqrtPriceX96: (1n << 96n).toString(), tick: 0, liquidity: "1000000000000000000", blockNumber: "100" };
}
function position(p: PoolState, liquidity = "100000000"): PositionRecord {
  return { protocol: p.protocol, chainId: p.chainId, accountId: "main", owner: OWNER, manager: A, tokenId: "42", pool: p, tickLower: -120, tickUpper: 120, liquidity, ...liquidityAmounts(p, -120, 120, liquidity), fees0: "7", fees1: "11", owed0: "3", owed1: "5", claimable0: "10", claimable1: "16", inRange: true, hasSubscriber: false, blockNumber: "100" };
}
function input(p: PoolState, operation: LiquidityInput["operation"] = "mint"): LiquidityInput {
  return { operation, protocol: p.protocol, chainId: p.chainId, accountId: "main", ...(operation === "mint" ? { tokenA: p.currency0, tokenB: p.currency1, tickLower: -120, tickUpper: 120 } : { tokenId: "42" }),
    ...(operation === "mint" || operation === "increase" ? { maxAmountA: "1000000", maxAmountB: "2000000" } : {}), slippageBps: 50, quoteValiditySeconds: 600 };
}
function v4Actions(data: Hex) {
  const call = decodeFunctionData({ abi: V4_ABI, data });
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), call.args[0]);
  return { actions, params, deadline: call.args[1] };
}
function v3Calls(data: Hex) {
  const call = decodeFunctionData({ abi: V3_ABI, data });
  return call.functionName === "multicall" ? call.args[0].map(data => decodeFunctionData({ abi: V3_ABI, data })) : [call];
}

describe("liquidity contract plans", () => {
  test("V4 mint fits explicit budgets including slippage, sorted orientation and custom recipient", () => {
    const p = pool(), i = { ...input(p), tokenA: B, tokenB: A, maxAmountA: "2000000", maxAmountB: "1000000", recipient: RECIPIENT };
    const built = buildLiquidity(p, null, ACCOUNT, i, NOW), decoded = v4Actions(built.transaction.data);
    expect(decoded.actions).toBe("0x020d"); expect(decoded.deadline).toBe(1_800_000_600n);
    const [key, lower, upper, liquidity, max0, max1, recipient, hookData] = decodeAbiParameters(parseAbiParameters("(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes"), decoded.params[0]!);
    expect(key).toEqual({ currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: zeroAddress });
    expect([lower, upper, recipient, hookData]).toEqual([-120, 120, RECIPIENT, "0x"]);
    expect(liquidity).toBeGreaterThan(0n); expect(max0).toBeLessThanOrEqual(1_000_000n); expect(max1).toBeLessThanOrEqual(2_000_000n);
    expect(built.approvalTokens.map(t => t.amount)).toEqual([max0.toString(), max1.toString()]);
    expect(BigInt(built.preview.amount0)).toBeLessThanOrEqual(max0); expect(BigInt(built.preview.amount1)).toBeLessThanOrEqual(max1);
  });
  test("native V4 mint funds the exact maximum and refunds to Wallet", () => {
    const p = pool("v4", true), built = buildLiquidity(p, null, ACCOUNT, input(p), NOW), decoded = v4Actions(built.transaction.data);
    expect(decoded.actions).toBe("0x020d14"); expect(built.transaction.value).toBe(built.preview.amount0Max);
    expect(built.approvalTokens.map(t => t.address)).toEqual([B]);
    expect(decodeAbiParameters(parseAbiParameters("address,address"), decoded.params[2]!)).toEqual([zeroAddress, OWNER]);
  });
  test("V4 increase handles accrued-fee credits in either currency with CLOSE_CURRENCY", () => {
    const p = pool("v4", true), built = buildLiquidity(p, position(p), ACCOUNT, input(p, "increase"), NOW), decoded = v4Actions(built.transaction.data);
    expect(decoded.actions).toBe("0x00121214");
    expect(decodeAbiParameters(parseAbiParameters("address"), decoded.params[1]!)).toEqual([zeroAddress]);
    expect(decodeAbiParameters(parseAbiParameters("address"), decoded.params[2]!)).toEqual([B]);
    const args = decodeAbiParameters(parseAbiParameters("uint256,uint256,uint128,uint128,bytes"), decoded.params[0]!);
    expect(args[0]).toBe(42n); expect(args[1]).toBe(BigInt(built.preview.liquidity));
  });
  test("V4 partial removal binds exact units, minimum outputs, currencies and recipient", () => {
    const p = pool(), built = buildLiquidity(p, position(p, "100000001"), ACCOUNT, { ...input(p, "decrease"), liquidityBps: 2500, recipient: RECIPIENT }, NOW), decoded = v4Actions(built.transaction.data);
    expect(decoded.actions).toBe("0x0111");
    const args = decodeAbiParameters(parseAbiParameters("uint256,uint256,uint128,uint128,bytes"), decoded.params[0]!);
    expect(args[0]).toBe(42n); expect(args[1]).toBe(25_000_000n); expect(args[2]).toBeGreaterThan(0n); expect(args[3]).toBeGreaterThan(0n);
    expect(decodeAbiParameters(parseAbiParameters("address,address,address"), decoded.params[1]!)).toEqual([A, B, RECIPIENT]);
    expect(built.approvalTokens).toEqual([]); expect(built.transaction.value).toBe("0");
  });
  test("V4 protocol recipient aliases cannot silently redirect minted positions or withdrawals", () => {
    // BaseActionsRouter maps address(1) to msgSender() and address(2) to itself.
    // Neither calldata value would deliver to the literal recipient in preview.
    const p = pool();
    for (const recipient of ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"]) {
      for (const operation of ["mint", "decrease", "collect", "close"] as const) {
        expect(() => buildLiquidity(p, operation === "mint" ? null : position(p), ACCOUNT, { ...input(p, operation), recipient }, NOW)).toThrow("router alias");
      }
    }
    // V3's NFT manager does not apply those aliases to its recipient fields.
    const v3 = pool("v3"), recipient = getAddress("0x0000000000000000000000000000000000000001");
    const mint = v3Calls(buildLiquidity(v3, null, ACCOUNT, { ...input(v3), recipient }, NOW).transaction.data)[0]!;
    if (mint.functionName !== "mint") throw new Error("Expected mint");
    expect(mint.args[0].recipient).toBe(recipient);
  });
  test("V4 collect leaves liquidity intact; empty close burns NFT", () => {
    const p = pool(), collect = buildLiquidity(p, position(p), ACCOUNT, input(p, "collect"), NOW);
    const decoded = v4Actions(collect.transaction.data);
    expect(decoded.actions).toBe("0x0111");
    expect(decodeAbiParameters(parseAbiParameters("uint256,uint256,uint128,uint128,bytes"), decoded.params[0]!)).toEqual([42n, 0n, 0n, 0n, "0x"]);
    expect([collect.preview.amount0, collect.preview.amount1]).toEqual(["10", "16"]);
    expect(() => buildLiquidity(p, position(p, "0"), ACCOUNT, input(p, "collect"), NOW)).toThrow("empty V4 position");
    const close = v4Actions(buildLiquidity(p, position(p, "0"), ACCOUNT, input(p, "close"), NOW).transaction.data);
    expect(close.actions).toBe("0x0311"); expect(decodeAbiParameters(parseAbiParameters("uint256,uint128,uint128,bytes"), close.params[0]!)).toEqual([42n, 0n, 0n, "0x"]);
  });
  test("V4 hook address and hook data survive mint/increase/remove", () => {
    const p = { ...pool(), hooks: getAddress("0x0000000000000000000000000000000000000080") };
    for (const operation of ["mint", "increase", "decrease"] as const) {
      const i = { ...input(p, operation), hooks: p.hooks, hookData: "0x1234" };
      const b = buildLiquidity(p, operation === "mint" ? null : position(p), ACCOUNT, i, NOW), d = v4Actions(b.transaction.data);
      const args = decodeAbiParameters(operation === "mint" ? parseAbiParameters("(address,address,uint24,int24,address),int24,int24,uint256,uint128,uint128,address,bytes") : parseAbiParameters("uint256,uint256,uint128,uint128,bytes"), d.params[0]!);
      expect(args.at(-1)).toBe("0x1234"); expect(b.preview.pool.hooks).toBe(p.hooks); expect(b.preview.warnings[0]).toContain("hook");
    }
  });
  test("V3 native add uses wrapped pool currency, exact ETH value and refund", () => {
    const p = pool("v3", true), i = { ...input(p), tokenA: B, tokenB: null };
    const b = buildLiquidity(p, null, ACCOUNT, i, NOW), calls = v3Calls(b.transaction.data);
    expect(calls.map(c => c.functionName)).toEqual(["mint", "refundETH"]);
    const mint = calls[0]!; if (mint.functionName !== "mint") throw new Error("Expected mint");
    expect(mint.args[0].token1).toBe(network("1").wrapped); expect(b.transaction.value).toBe(mint.args[0].amount1Desired.toString());
    expect(b.approvalTokens.map(t => t.address)).toEqual([B]);
    expect(mint.args[0].amount0Desired).toBeLessThanOrEqual(1_000_000n); expect(mint.args[0].amount1Desired).toBeLessThanOrEqual(2_000_000n);
  });
  test("V3 authored encoding matches the SDK oracle for mint, increase and native refunds", () => {
    for (const chainId of ["1", "42161"]) for (const native of [false, true]) for (const operation of ["mint", "increase"] as const) {
      const p = pool("v3", native, chainId), i = { ...input(p, operation), ...(native ? { tokenA: B, tokenB: null } : {}) };
      const built = buildLiquidity(p, operation === "mint" ? null : position(p), ACCOUNT, i, NOW);
      const sdk = positionWithinBudgets(p, -120, 120, 1_000_000n, 2_000_000n, 50);
      if (!(sdk instanceof V3Position)) throw new Error("Expected V3 position");
      const expected = NonfungiblePositionManager.addCallParameters(sdk, { slippageTolerance: new Percent(50, 10000), deadline: built.preview.deadline,
        ...(operation === "mint" ? { recipient: OWNER } : { tokenId: "42" }), ...(native ? { useNative: Ether.onChain(Number(chainId)) } : {}) });
      expect(built.transaction.data).toBe(expected.calldata as Hex); expect(built.transaction.value).toBe(BigInt(expected.value).toString());
    }
    const p = pool("v3", true), built = buildLiquidity(p, null, ACCOUNT, { ...input(p), tokenA: B, tokenB: null, tickLower: 600, tickUpper: 1200, maxAmountB: "0" }, NOW);
    expect(built.transaction.value).toBe("0"); expect(v3Calls(built.transaction.data).map(c => c.functionName)).toEqual(["mint"]);
  });
  test("V3 mixed-decimal narrow ranges match independent SDK amounts, approvals and native encoding", () => {
    const usdc = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), weth = network("1").wrapped;
    // Batch-1 ranges and budgets. Sample the observed ticks without claiming
    // these approximations reconstruct the later historical transaction state.
    for (const [tick, tickLower, tickUpper, maxAmountA, maxAmountB, native] of [
      [198127, 198030, 198230, "2000000", "800000000000000", true],
      [198146, 198040, 198240, "700000", "300000000000000", false],
    ] as const) {
      const low = BigInt(TickMath.getSqrtRatioAtTick(tick).toString()), high = BigInt(TickMath.getSqrtRatioAtTick(tick + 1).toString());
      for (const ratio of [low, (low + high) / 2n, high - 1n]) {
        const p: PoolState = { ...pool("v3"), token0: { chainId: "1", address: usdc, symbol: "USDC", decimals: 6 }, token1: { chainId: "1", address: weth, symbol: "WETH", decimals: 18 },
          currency0: usdc, currency1: weth, tick, sqrtPriceX96: ratio.toString(), fee: 500, tickSpacing: 10 };
        const built = buildLiquidity(p, null, ACCOUNT, { ...input(p), tokenA: usdc, tokenB: native ? null : weth, tickLower, tickUpper, maxAmountA, maxAmountB }, NOW);
        const sdkPool = new V3Pool(new SdkToken(1, usdc, 6), new SdkToken(1, weth, 18), 500, ratio.toString(), p.liquidity, tick);
        const sdk = V3Position.fromAmounts({ pool: sdkPool, tickLower, tickUpper, amount0: maxAmountA, amount1: maxAmountB, useFullPrecision: false });
        const expected = NonfungiblePositionManager.addCallParameters(sdk, { slippageTolerance: new Percent(50, 10000), deadline: built.preview.deadline, recipient: OWNER, ...(native ? { useNative: Ether.onChain(1) } : {}) });
        expect(built.transaction.data).toBe(expected.calldata as Hex);
        expect(built.transaction.value).toBe(BigInt(expected.value).toString());
        expect(built.approvalTokens.map(({ address, amount }) => [address, amount])).toEqual(native
          ? [[usdc, sdk.mintAmounts.amount0.toString()]] : [[usdc, sdk.mintAmounts.amount0.toString()], [weth, sdk.mintAmounts.amount1.toString()]]);
        // The position manager derives liquidity from the encoded desired
        // amounts; account for that second round of integer precision too.
        const actual = V3Position.fromAmounts({ pool: sdkPool, tickLower, tickUpper, amount0: built.preview.amount0, amount1: built.preview.amount1, useFullPrecision: false });
        for (const [amount, minimum, maximum] of [[actual.mintAmounts.amount0, built.preview.amount0Min, built.preview.amount0Max], [actual.mintAmounts.amount1, built.preview.amount1Min, built.preview.amount1Max]] as const) {
          expect(BigInt(amount.toString())).toBeGreaterThanOrEqual(BigInt(minimum));
          expect(BigInt(amount.toString())).toBeLessThanOrEqual(BigInt(maximum));
        }
      }
    }
  });
  test("V3 removal pays principal and fees in one transaction; full close burns after collect", () => {
    const p = pool("v3"), b = buildLiquidity(p, position(p), ACCOUNT, { ...input(p, "decrease"), liquidity: "1234567", recipient: RECIPIENT }, NOW), calls = v3Calls(b.transaction.data);
    expect(calls.map(c => c.functionName)).toEqual(["decreaseLiquidity", "collect"]);
    const decrease = calls[0]!, collect = calls[1]!;
    if (decrease.functionName !== "decreaseLiquidity" || collect.functionName !== "collect") throw new Error("Unexpected calls");
    expect(decrease.args[0].liquidity).toBe(1_234_567n); expect(collect.args[0].recipient).toBe(RECIPIENT); expect(collect.args[0].amount0Max).toBe((1n << 128n) - 1n);
    expect(v3Calls(buildLiquidity(p, position(p), ACCOUNT, input(p, "close"), NOW).transaction.data).map(c => c.functionName)).toEqual(["decreaseLiquidity", "collect", "burn"]);
    expect(v3Calls(buildLiquidity(p, position(p, "0"), ACCOUNT, input(p, "close"), NOW).transaction.data).map(c => c.functionName)).toEqual(["collect", "burn"]);
  });
  test("V3 empty position collection previews stored owed funds when fresh fees are zero", () => {
    const p = pool("v3"), existing = { ...position(p, "0"), fees0: "0", fees1: "0", owed0: "1200000", owed1: "3400000", claimable0: "1200000", claimable1: "3400000" };
    const built = buildLiquidity(p, existing, ACCOUNT, input(p, "collect"), NOW);
    expect([built.preview.amount0, built.preview.amount1]).toEqual(["1200000", "3400000"]);
    expect(built.preview.liquidity).toBe("0"); expect(built.approvalTokens).toEqual([]);
    const calls = v3Calls(built.transaction.data);
    expect(calls.map(c => c.functionName)).toEqual(["collect"]);
    if (calls[0]!.functionName !== "collect") throw new Error("Expected collect");
    expect(calls[0]!.args[0].recipient).toBe(OWNER);
    expect(calls[0]!.args[0].amount0Max).toBeGreaterThan(BigInt(existing.claimable0));
  });
  test("V3 optional native removal unwraps and sweeps to the same recipient", () => {
    const p = pool("v3", true), b = buildLiquidity(p, position(p), ACCOUNT, { ...input(p, "decrease"), tokenA: B, tokenB: null, recipient: RECIPIENT }, NOW), calls = v3Calls(b.transaction.data);
    expect(calls.map(c => c.functionName)).toEqual(["decreaseLiquidity", "collect", "unwrapWETH9", "sweepToken"]);
    const unwrap = calls[2]!, sweep = calls[3]!;
    if (unwrap.functionName !== "unwrapWETH9" || sweep.functionName !== "sweepToken") throw new Error("Unexpected calls");
    expect(unwrap.args).toEqual([BigInt(b.preview.amount1Min), RECIPIENT]); expect(sweep.args).toEqual([B, BigInt(b.preview.amount0Min), RECIPIENT]);
  });
  test("both networks use their actual PositionManager", () => {
    for (const [chainId, expected] of [["1", "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e"], ["42161", "0xd88f38f930b7952f2db2432cb002e7abbf3dd869"]]) {
      const p = pool("v4", false, chainId); expect(buildLiquidity(p, null, ACCOUNT, input(p), NOW).transaction.to.toLowerCase()).toBe(expected!);
    }
  });
  test("rejects changed owner/pool/range, mismatched currencies and oversized removal", () => {
    const p = pool(), existing = position(p), i = input(p, "increase");
    expect(() => buildLiquidity(p, { ...existing, owner: RECIPIENT }, ACCOUNT, i, NOW)).toThrow("not owned");
    expect(() => buildLiquidity(p, existing, ACCOUNT, { ...i, fee: 500 }, NOW)).toThrow("pool settings");
    expect(() => buildLiquidity(p, existing, ACCOUNT, { ...i, tickLower: -180 }, NOW)).toThrow("price range");
    expect(() => buildLiquidity(p, existing, ACCOUNT, { ...i, tokenA: B }, NOW)).toThrow("currencies");
    expect(() => buildLiquidity(p, existing, ACCOUNT, { ...input(p, "decrease"), liquidity: "100000001" }, NOW)).toThrow("currently");
    expect(() => buildLiquidity(p, existing, ACCOUNT, { ...input(p, "decrease"), liquidity: "1", liquidityBps: 100 }, NOW)).toThrow("not both");
    expect(() => buildLiquidity(p, null, ACCOUNT, { ...input(p), maxAmountA: (1n << 128n).toString() }, NOW)).toThrow("uint128");
  });
});

describe("exact liquidity math", () => {
  test("full-range ticks align correctly for positive and negative extremes", () => {
    expect(fullRangeTicks(60)).toEqual({ tickLower: -887220, tickUpper: 887220 });
    expect(fullRangeTicks(1)).toEqual({ tickLower: -887272, tickUpper: 887272 });
    expect(() => fullRangeTicks(0)).toThrow("spacing");
  });
  test("V4 fitted liquidity stays within both budgets across slippage and asymmetric inputs", () => {
    const p = pool();
    for (const bps of [0, 1, 50, 500]) for (const [b0, b1] of [[12345n, 999999n], [999999n, 12345n], [1000000n, 1000000n]]) {
      const fitted = positionWithinBudgets(p, -600, 600, b0!, b1!, bps);
      const build = buildLiquidity(p, null, ACCOUNT, { ...input(p), tickLower: -600, tickUpper: 600, maxAmountA: b0!.toString(), maxAmountB: b1!.toString(), slippageBps: bps }, NOW);
      expect(build.preview.liquidity).toBe(fitted.liquidity.toString()); expect(BigInt(build.preview.amount0Max)).toBeLessThanOrEqual(b0!); expect(BigInt(build.preview.amount1Max)).toBeLessThanOrEqual(b1!);
    }
  });
  test("single-sided out-of-range mint does not require the unused token", () => {
    const p = pool(), b = buildLiquidity(p, null, ACCOUNT, { ...input(p), tickLower: 600, tickUpper: 1200, maxAmountA: "1000000", maxAmountB: "0" }, NOW);
    expect(b.preview.amount1Max).toBe("0"); expect(b.approvalTokens.map(t => t.address)).toEqual([A]); expect(b.preview.inRange).toBe(false);
  });
});
