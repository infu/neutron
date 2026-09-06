import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { accruedPositionFees, browserPositionIds, listPositions, readPosition, type PositionListCursor } from "../src/positions.ts";
import type { Reader } from "../src/swap.ts";

// Independent interfaces from the deployed V3 NFT manager and V4 StateView.
const ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)", "function tickSpacing() view returns (int24)",
  "function feeGrowthGlobal0X128() view returns (uint256)", "function feeGrowthGlobal1X128() view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getPositionInfo(bytes32 poolId,address owner,int24 tickLower,int24 tickUpper,bytes32 salt) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)",
]);
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const POOL = getAddress("0x3333333333333333333333333333333333333333");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const WETH = getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
const V3 = getAddress("0xc36442b4a4522e871399cd717abdd847ab11fe88");
const V4 = getAddress("0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e");
const Q = 1n << 128n;
type FixtureOptions = { liquidity?: bigint; count?: bigint; transferred?: string[]; burned?: string[]; offline?: string[]; blockMismatch?: string; currentTick?: number; fee?: number; hooks?: Address };
function fixture(options: FixtureOptions = {}) {
  const calls: { name: string; target: Address; args: readonly unknown[]; block: string | undefined }[] = [];
  const liquidity = options.liquidity ?? 1_000_000n;
  const read: Reader = async (_chain, target, data, block) => {
    const decoded = decodeFunctionData({ abi: ABI, data });
    const args = decoded.args ?? [];
    calls.push({ name: decoded.functionName, target, args, block });
    let result: unknown;
    switch (decoded.functionName) {
      case "ownerOf":
        if (options.burned?.includes(String(args[0]))) throw new Error(`RPC eth_call on chain 1: execution reverted: ${target === V3 ? "ERC721: owner query for nonexistent token" : "NOT_MINTED"}`);
        if (options.offline?.includes(String(args[0]))) throw new Error("RPC provider unavailable");
        result = options.transferred?.includes(String(args[0])) ? OTHER : OWNER; break;
      case "balanceOf": result = options.count ?? 1n; break;
      case "tokenOfOwnerByIndex": result = 7n + BigInt(String(args[1])); break;
      case "positions": result = [0n, zeroAddress, USDC, WETH, 500, -10, 10, liquidity, Q, Q, 20n, 30n]; break;
      case "getPool": result = POOL; break;
      case "slot0": result = [1n << 96n, options.currentTick ?? 0, 0, 0, 0, 0, true]; break;
      case "liquidity": case "getLiquidity": result = 10_000_000n; break;
      case "tickSpacing": result = 10; break;
      case "feeGrowthGlobal0X128": result = 5n * Q; break;
      case "feeGrowthGlobal1X128": result = 7n * Q; break;
      case "ticks": result = [1_000_000n, 0n, Q, Q, 0n, 0n, 0, true]; break;
      case "getPoolAndPositionInfo": result = [{ currency0: zeroAddress, currency1: USDC, fee: options.fee ?? 500, tickSpacing: 10, hooks: options.hooks ?? zeroAddress }, ((1n << 24n) - 10n) << 8n | 10n << 32n | 1n]; break;
      case "getPositionLiquidity": result = liquidity; break;
      case "getSlot0": result = [1n << 96n, 0, 0, 500]; break;
      case "getPositionInfo": result = [liquidity, Q, Q]; break;
      case "getFeeGrowthInside": result = [3n * Q, 5n * Q]; break;
      default: throw new Error(`Unexpected fixture call`);
    }
    return { data: encodeFunctionResult({ abi: ABI, functionName: decoded.functionName, result } as never), blockNumber: options.blockMismatch === decoded.functionName ? "101" : "100", observedAtMs: 1000 };
  };
  return { read, calls };
}
const account = { accountId: "main", address: OWNER };
const indexItem = (id: string) => ({ id, token_type: "ERC-721", owner: { hash: OWNER }, token: { address_hash: V4 }, metadata: { image: "data:image/svg+xml;huge", description: "Untrusted pool info" } });
function pageFetch(items: unknown[], next: unknown = null): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ items, next_page_params: next }))) as unknown as typeof globalThis.fetch;
}

describe("authoritative liquidity positions", () => {
  test("V3 uses NFT fee snapshots, preserves stored principal separately and pins every read", async () => {
    const { read, calls } = fixture();
    const position = await readPosition(read, { chainId: "1", accountId: "main", owner: OWNER, protocol: "v3", tokenId: "7" });
    expect(position.manager).toBe(V3);
    expect(position.fees0).toBe("2000000"); expect(position.fees1).toBe("4000000");
    expect(position.owed0).toBe("20"); expect(position.claimable0).toBe("2000020");
    expect(BigInt(position.amount0)).toBeGreaterThan(0n); expect(BigInt(position.amount1)).toBeGreaterThan(0n);
    expect(position.inRange).toBe(true); expect(position.blockNumber).toBe("100");
    expect(calls[0]!.block).toBeUndefined(); expect(calls.slice(1).every((call) => call.block === "0x64")).toBe(true);
  });
  test("V4 decodes negative packed ticks and uses manager ownership plus NFT ID salt for fee reads", async () => {
    const { read, calls } = fixture();
    const position = await readPosition(read, { chainId: "1", accountId: "main", owner: OWNER, protocol: "v4", tokenId: "7" });
    expect(position.tickLower).toBe(-10); expect(position.tickUpper).toBe(10); expect(position.hasSubscriber).toBe(true);
    expect(position.pool.currency0).toBeNull(); expect(position.pool.token0.symbol).toBe("ETH");
    expect(position.fees0).toBe("2000000"); expect(position.claimable1).toBe("4000000"); expect(position.owed0).toBe("0");
    const feeRead = calls.find((call) => call.name === "getPositionInfo")!;
    expect(feeRead.args.slice(1)).toEqual([V4, -10, 10, toHex(7n, { size: 32 })]);
    expect(calls.slice(1).every((call) => call.block === "0x64")).toBe(true);
  });
  test("zero-liquidity V3 retains collectible tokens; V4 does not invent accrued fees", async () => {
    for (const protocol of ["v3", "v4"] as const) {
      const { read, calls } = fixture({ liquidity: 0n });
      const position = await readPosition(read, { chainId: "1", accountId: "main", owner: OWNER, protocol, tokenId: "7" });
      expect(position.fees0).toBe("0"); expect(position.claimable0).toBe(protocol === "v3" ? "20" : "0");
      expect(calls.some((call) => /FeeGrowth|feeGrowth/.test(call.name))).toBe(false);
    }
  });
  test("V4 preserves the dynamic PoolKey fee instead of replacing it with the current LP fee", async () => {
    const position = await readPosition(fixture({ fee: 0x800000, hooks: OTHER }).read, { chainId: "1", accountId: "main", owner: OWNER, protocol: "v4", tokenId: "7" });
    expect(position.pool.fee).toBe(0x800000); expect(position.pool.tickSpacing).toBe(10);
  });
  test("rejects a foreign owner before reading pool data and rejects mixed block observations", async () => {
    const foreign = fixture({ transferred: ["7"] });
    await expect(readPosition(foreign.read, { chainId: "1", accountId: "main", owner: OWNER, protocol: "v4", tokenId: "7" })).rejects.toThrow("not owned");
    expect(foreign.calls.map((call) => call.name)).toEqual(["ownerOf"]);
    await expect(readPosition(fixture({ blockMismatch: "getPositionLiquidity" }).read, { chainId: "1", accountId: "main", owner: OWNER, protocol: "v4", tokenId: "7" })).rejects.toThrow("different block");
  });
  test("fee growth wraps at uint256 rather than clamping negative differences", () => {
    expect(accruedPositionFees(Q, (1n << 256n) - Q, 9n)).toBe(18n);
    expect(accruedPositionFees(3n, 2n, 1n)).toBe(0n);
  });
});

describe("keyless position discovery", () => {
  test("queries exact manager/owner, follows scalar cursor and strips all index metadata", async () => {
    let request: URL | undefined, init: RequestInit | undefined;
    const fetch: typeof globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      request = new URL(String(url)); init = options;
      return new Response(JSON.stringify({ items: [indexItem("9"), indexItem("8")], next_page_params: { holder_address_hash: OWNER, unique_token: 8 } }));
    }) as unknown as typeof globalThis.fetch;
    expect(await browserPositionIds("1", OWNER, "10", { fetch })).toEqual({ tokenIds: ["9", "8"], next: "8" });
    expect(request!.origin).toBe("https://eth.blockscout.com"); expect(request!.pathname).toBe(`/api/v2/tokens/${V4}/instances`);
    expect(request!.searchParams.get("holder_address_hash")).toBe(OWNER); expect(request!.searchParams.get("unique_token")).toBe("10");
    expect(init?.credentials).toBe("omit"); expect(init?.mode).toBe("cors");
  });
  test("rejects wrong collection, owner, unsafe integer cursor and repeated pages", async () => {
    await expect(browserPositionIds("1", OWNER, null, { fetch: pageFetch([{ ...indexItem("7"), token: { address_hash: V3 } }]) })).rejects.toThrow("different NFT");
    await expect(browserPositionIds("1", OWNER, null, { fetch: pageFetch([{ ...indexItem("7"), owner: { hash: OTHER } }]) })).rejects.toThrow("different owner");
    await expect(browserPositionIds("1", OWNER, null, { fetch: pageFetch([indexItem("7")], { holder_address_hash: OWNER, unique_token: Number.MAX_SAFE_INTEGER + 1 }) })).rejects.toThrow("inexact cursor");
    await expect(browserPositionIds("1", OWNER, "7", { fetch: pageFetch([indexItem("7")]) })).rejects.toThrow("did not advance");
    await expect(browserPositionIds("1", OWNER, "10", { fetch: pageFetch([indexItem("9"), indexItem("7"), indexItem("8")], { holder_address_hash: OWNER, unique_token: "8" }) })).rejects.toThrow("did not advance");
  });
  test("V3 enumeration pages quickly and skips durable references transferred away", async () => {
    const { read } = fixture({ count: 2n, transferred: ["99"] });
    const knownIds = [{ protocol: "v3" as const, tokenId: "99" }];
    const first = await listPositions(read, account, "1", { protocol: "v3", knownIds, pageSize: 2 });
    expect(first.positions.map((position) => position.tokenId)).toEqual(["7"]); expect(first.complete).toBe(false); expect(first.errors).toEqual([]);
    const second = await listPositions(read, account, "1", { protocol: "v3", knownIds, pageSize: 2, cursor: first.nextCursor! });
    expect(second.positions.map((position) => position.tokenId)).toEqual(["8"]); expect(second.complete).toBe(true); expect(second.nextCursor).toBeNull();
  });
  test("burned saved references do not poison discovery of remaining positions, while RPC failures stay visible", async () => {
    for (const protocol of ["v3", "v4"] as const) {
      const knownIds = [{ protocol, tokenId: "99" }];
      const options = { protocol, knownIds, fetch: pageFetch([indexItem("7")]) };
      const closed = await listPositions(fixture({ burned: ["99"] }).read, account, "1", options);
      expect(closed.positions.map((position) => position.tokenId)).toEqual(["7"]); expect(closed.complete).toBe(true); expect(closed.errors).toEqual([]);
      const unavailable = await listPositions(fixture({ offline: ["99"] }).read, account, "1", options);
      expect(unavailable.complete).toBe(false); expect(unavailable.errors.join()).toContain("RPC provider unavailable");
    }
  });
  test("imports between pages cannot shift the saved-reference cursor or falsely satisfy the owner count", async () => {
    const { read } = fixture({ count: 3n });
    const knownIds = ["8", "9"].map((tokenId) => ({ protocol: "v3" as const, tokenId }));
    const first = await listPositions(read, account, "1", { protocol: "v3", knownIds, pageSize: 1 });
    const next = await listPositions(read, account, "1", { protocol: "v3", knownIds: [{ protocol: "v3", tokenId: "7" }, ...knownIds], cursor: first.nextCursor!, drain: true });
    expect([...first.positions, ...next.positions].map((position) => position.tokenId).sort()).toEqual(["7", "8", "9"]);
    expect(next.complete).toBe(true); expect(next.errors).toEqual([]);
  });
  test("V4 pages retain unprocessed index IDs, merge known IDs and verify count without truncation", async () => {
    const { read, calls } = fixture({ count: 3n }); let requests = 0;
    const fetch: typeof globalThis.fetch = (async (url: RequestInfo | URL) => {
      requests++;
      return new URL(String(url)).searchParams.has("unique_token")
        ? new Response(JSON.stringify({ items: [indexItem("6")], next_page_params: null }))
        : new Response(JSON.stringify({ items: [indexItem("8"), indexItem("7")], next_page_params: { holder_address_hash: OWNER, unique_token: 7 } }));
    }) as unknown as typeof globalThis.fetch;
    const ids: string[] = [], knownIds = [{ protocol: "v4" as const, tokenId: "8" }]; let cursor: PositionListCursor | undefined;
    let complete = false;
    do {
      const result = await listPositions(read, account, "1", { protocol: "v4", knownIds, pageSize: 1, fetch, ...(cursor ? { cursor } : {}) });
      ids.push(...result.positions.map((position) => position.tokenId)); complete = result.complete; cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(["8", "7", "6"]); expect(complete).toBe(true); expect(requests).toBe(2);
    expect(calls.filter((call) => call.name === "ownerOf" && call.args[0] === 8n)).toHaveLength(1);
  });
  test("index failure preserves known positions and reports incomplete; zero balance never contacts index", async () => {
    const failing: typeof globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof globalThis.fetch;
    const result = await listPositions(fixture({ count: 2n }).read, account, "1", { protocol: "v4", knownIds: [{ protocol: "v4", tokenId: "7" }], fetch: failing });
    expect(result.positions.map((position) => position.tokenId)).toEqual(["7"]); expect(result.complete).toBe(false); expect(result.errors.join()).toContain("503");
    const recovered = await listPositions(fixture({ count: 2n }).read, account, "1", { protocol: "v4", knownIds: [{ protocol: "v4", tokenId: "7" }], fetch: pageFetch([indexItem("7"), indexItem("6")]), cursor: result.nextCursor! });
    expect(recovered.positions.map((position) => position.tokenId)).toEqual(["6"]); expect(recovered.complete).toBe(true); expect(recovered.errors).toEqual([]);
    const empty = await listPositions(fixture({ count: 0n }).read, account, "1", { protocol: "v4", fetch: (async () => { throw new Error("unexpected fetch"); }) as unknown as typeof globalThis.fetch });
    expect(empty.complete).toBe(true); expect(empty.errors).toEqual([]); expect(empty.positions).toEqual([]);
  });
  test("cursor is account bound and cancellation propagates rather than looking like discovery failure", async () => {
    const first = await listPositions(fixture({ count: 2n }).read, account, "1", { protocol: "v3", pageSize: 1 });
    await expect(listPositions(fixture().read, { accountId: "main", address: OTHER }, "1", { protocol: "v3", cursor: first.nextCursor! })).rejects.toThrow("different account");
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(listPositions(fixture().read, account, "1", { signal: controller.signal })).rejects.toThrow("cancelled");
  });
});
