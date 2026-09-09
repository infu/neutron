import { expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi } from "viem";
import { CHAINS, encode, liquiditySignatures, minimum, NATIVE, poolRef, uint, ZERO, type Reader, type VerifiedPool } from "../src/contracts.ts";
import { approvalSteps, parseInput, swapRoute } from "../src/plans.ts";
import { catalogTokens, fetchPools, parsePoolCatalog, readToken, verifyPool } from "../src/pools.ts";
import { atoms } from "../src/ui.tsx";
const address = getAddress("0x1111111111111111111111111111111111111111"), receiver = getAddress("0x2222222222222222222222222222222222222222");
test("decimal entry never rounds an atomic budget, including >2^53 amounts", () => {
  expect(atoms("12345678901234567890.123456", 6)).toBe("12345678901234567890123456");
  expect(() => atoms("1.0000001", 6)).toThrow(); expect(() => atoms("1e6", 18)).toThrow(); expect(() => uint("-1", "amount")).toThrow(); expect(() => uint((1n << 256n).toString(), "amount")).toThrow();
  expect(minimum(999999999999999999999n, 50)).toBe(994999999999999999999n);
});
test("native wrapping hops and pool routing preserve direction and chain", () => {
  for (const chainId of ["1", "42161"] as const) {
    const pool = { address, family: "tricrypto-ng" as const, coins: [{ address: receiver }, { address: CHAINS[chainId].weth }, { address }] } as VerifiedPool;
    const incoming = swapRoute(chainId, null, receiver, pool), outgoing = swapRoute(chainId, receiver, null, pool);
    expect(incoming.route.slice(0, 5)).toEqual([NATIVE, CHAINS[chainId].weth, CHAINS[chainId].weth, address, receiver]);
    expect(incoming.params.slice(0, 2)).toEqual([[0n, 0n, 8n, 0n, 0n], [1n, 0n, 1n, 30n, 3n]]);
    expect(outgoing.route.slice(0, 5)).toEqual([receiver, address, CHAINS[chainId].weth, CHAINS[chainId].weth, NATIVE]);
    expect(incoming.route).toHaveLength(11); expect(outgoing.params).toHaveLength(5);
  }
  expect(() => parseInput({ kind: "swap", chainId: "10", tokenIn: null, tokenOut: address, amountIn: "1" })).toThrow();
  expect(() => parseInput({ kind: "deposit", chainId: "1", pool: { chainId: "42161", address, family: "stable-ng" } })).toThrow("another network");
});
test("WETH routes unwrap into native ETH pools and wrap their output on both networks", () => {
  for (const chainId of ["1", "42161"] as const) {
    const weth = CHAINS[chainId].weth;
    const pool = { address, family: "legacy-2" as const, coins: [{ address: null }, { address: receiver }] } as VerifiedPool;
    const incoming = swapRoute(chainId, weth, receiver, pool), outgoing = swapRoute(chainId, receiver, weth, pool);
    expect(incoming.route.slice(0, 5)).toEqual([weth, weth, NATIVE, address, receiver]);
    expect(incoming.params.slice(0, 2)).toEqual([[0n, 0n, 8n, 0n, 0n], [0n, 1n, 1n, 1n, 2n]]);
    expect(outgoing.route.slice(0, 5)).toEqual([receiver, address, NATIVE, weth, weth]);
    expect(outgoing.params.slice(0, 2)).toEqual([[1n, 0n, 1n, 1n, 2n], [0n, 0n, 8n, 0n, 0n]]);
    expect(swapRoute(chainId, null, receiver, pool).route.slice(0, 3)).toEqual([NATIVE, address, receiver]);
    expect(swapRoute(chainId, receiver, null, pool).route.slice(0, 3)).toEqual([receiver, address, NATIVE]);
  }
});
test.each(["stable-ng", "stable-meta-ng", "twocrypto-ng", "tricrypto-ng", "legacy-2", "legacy-3"] as const)("%s liquidity encodes exact arrays, receiver and minima against independent ABI", (family) => {
  const ref = { chainId: "1" as const, address, family }, sig = liquiditySignatures(ref);
  const dimension = family === "stable-ng" ? "[]" : ["tricrypto-ng", "legacy-3"].includes(family) ? "[3]" : "[2]";
  const budgets = dimension === "[3]" ? [1000001n, 2000002n, 3000003n] : [1000001n, 2000002n];
  const suffix = family.startsWith("legacy") ? "" : family === "tricrypto-ng" ? ",bool,address" : ",address";
  const tail = family.startsWith("legacy") ? [] : family === "tricrypto-ng" ? [true, receiver] : [receiver];
  const independent = parseAbi([`function add_liquidity(uint256${dimension},uint256${suffix}) payable`, `function remove_liquidity(uint256,uint256${dimension}${suffix})`]);
  const deposit = decodeFunctionData({ abi: independent, data: encode(sig.deposit, [budgets, 900000n, ...tail]) });
  expect(deposit.args as readonly unknown[]).toEqual([budgets, 900000n, ...tail]);
  expect(decodeFunctionData({ abi: independent, data: encode(sig.withdraw, [123456n, budgets, ...tail]) }).args as readonly unknown[]).toEqual([123456n, budgets, ...tail]);
});
test("exact approvals reuse sufficient allowances and reset mainnet USDT when required", async () => {
  const token = { chainId: "1" as const, address: getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7"), decimals: 6, symbol: "USDT" };
  const abi = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
  const reader = (value: bigint): Reader => async () => ({ data: encodeFunctionResult({ abi, functionName: "allowance", result: value }), blockNumber: "123" });
  expect(await approvalSteps(reader(100n), "1", address, token, receiver, "100")).toEqual([]);
  const steps = await approvalSteps(reader(1n), "1", address, token, receiver, "100");
  expect(steps.map((step) => decodeFunctionData({ abi, data: step.transaction.data }).args)).toEqual([[receiver, 0n], [receiver, 100n]]);
  expect((await approvalSteps(reader(0n), "1", address, token, receiver, "100"))).toHaveLength(1);
});
test("discovery failures stay incomplete; full token address and native identities remain unambiguous", async () => {
  const result = await fetchPools("42161", { refresh: true, fetch: (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch });
  expect(result.complete).toBe(false); expect(result.errors).toHaveLength(4);
  const tokens = catalogTokens("42161"); expect(tokens.find((token) => token.symbol === "crvUSD")?.address).toBe(getAddress("0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5"));
  expect(() => parsePoolCatalog({ success: false }, "1", "factory-stable-ng")).toThrow();
  expect(() => poolRef({ chainId: "1", address: ZERO, family: "stable-ng" })).toThrow();
});
test("unregistered pools and incorrect metapool ABI selection fail before any effect", async () => {
  const abi = parseAbi(["function get_coins(address) view returns (address[])", "function is_meta(address) view returns (bool)"]);
  const read: Reader = async (_chain, _to, data) => {
    const decoded = decodeFunctionData({ abi, data });
    return { data: decoded.functionName === "get_coins" ? encodeFunctionResult({ abi, functionName: "get_coins", result: [address, receiver] }) : encodeFunctionResult({ abi, functionName: "is_meta", result: true }), blockNumber: "123" };
  };
  await expect(verifyPool(read, { chainId: "1", address, family: "stable-ng" })).rejects.toThrow("Pool type differs");
  await expect(verifyPool(async () => ({ data: encodeFunctionResult({ abi, functionName: "get_coins", result: [] }), blockNumber: "123" }), { chainId: "1", address, family: "stable-ng" })).rejects.toThrow("not registered");
});

test("pool discovery uses exact-address labels for native and bridged Arbitrum USDC", () => {
  const bridged = getAddress("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8");
  const native = getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
  const [pool] = parsePoolCatalog({ success: true, data: { poolData: [{ address, coins: [
    { address: bridged, symbol: "USDC", decimals: 6 },
    { address: native, symbol: "USDC.e", decimals: 6 },
    { address: receiver, symbol: "USDC", decimals: 7 },
  ] }] } }, "42161", "factory-stable-ng");
  expect(pool!.coins).toEqual([
    { chainId: "42161", address: bridged, symbol: "USDC.e", decimals: 6 },
    { chainId: "42161", address: native, symbol: "USDC", decimals: 6 },
    { chainId: "42161", address: receiver, symbol: "USDC", decimals: 7 },
  ]);
});

test("verified Arbitrum 2pool keeps bridged USDC identity when its contract symbol says USDC", async () => {
  const poolAddress = getAddress("0x7f90122bf0700f9e7e1f688fe926940e8839f353");
  const bridged = getAddress("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8");
  const native = getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
  const usdt0 = getAddress("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
  const abi = parseAbi([
    "function coins(uint256) view returns (address)", "function balances(uint256) view returns (uint256)",
    "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ]);
  const read: Reader = async (_chain, to, data, block) => {
    expect(block === undefined || block === "123").toBe(true);
    const { functionName, args } = decodeFunctionData({ abi, data });
    const result = functionName === "coins" ? [bridged, usdt0][Number(args![0])] :
      functionName === "balances" ? [123456n, 654321n][Number(args![0])] :
      functionName === "totalSupply" ? 1000000000000000000n :
      functionName === "decimals" ? to === poolAddress ? 18 : to === receiver ? 7 : 6 :
      to === usdt0 ? "USDT" : "USDC";
    return { data: encodeFunctionResult({ abi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]), blockNumber: "123" };
  };
  const pool = await verifyPool(read, { chainId: "42161", address: poolAddress, family: "legacy-2" });
  expect(pool.coins).toEqual([
    { chainId: "42161", address: bridged, symbol: "USDC.e", decimals: 6 },
    { chainId: "42161", address: usdt0, symbol: "USDT0", decimals: 6 },
  ]);
  expect(pool).toMatchObject({ blockNumber: "123", balances: ["123456", "654321"], lpDecimals: 18 });
  expect(await readToken(read, "42161", native, "123")).toMatchObject({ address: native, symbol: "USDC", decimals: 6 });
  expect(await readToken(read, "1", bridged, "123")).toMatchObject({ address: bridged, symbol: "USDC", decimals: 6 });
  expect(await readToken(read, "42161", receiver, "123")).toMatchObject({ address: receiver, symbol: "USDC", decimals: 7 });
});
