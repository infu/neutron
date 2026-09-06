import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { defaultTokens, FACTORY, network, TOKEN_ABI, type Reader, type Token } from "./swap.ts";
import { liquidityAmounts } from "./liquidity_math.ts";
import { v4Deployment, v4PoolId, V4_STATE_VIEW_ABI } from "./v4_common.ts";

export type PositionProtocol = "v3" | "v4";
export type PositionReference = { protocol: PositionProtocol; tokenId: string };
export type PositionAccount = { accountId: string; address: Address };
export type PoolInput = {
  chainId: string; protocol: PositionProtocol; tokenA: string | null; tokenB: string | null;
  fee: number; tickSpacing?: number; hooks?: string;
};
export type PoolState = {
  protocol: PositionProtocol; chainId: string; currency0: Address | null; currency1: Address | null;
  token0: Token; token1: Token; fee: number; tickSpacing: number; hooks: Address;
  poolId?: Hex; address?: Address; sqrtPriceX96: string; tick: number; liquidity: string; blockNumber: string;
};
export type PositionRecord = PositionReference & {
  chainId: string; accountId: string; owner: Address; manager: Address; pool: PoolState;
  tickLower: number; tickUpper: number; liquidity: string; amount0: string; amount1: string;
  /** Fresh accrual only. V3 stored owed balances may include withdrawn principal. */
  fees0: string; fees1: string; owed0: string; owed1: string; claimable0: string; claimable1: string;
  inRange: boolean; hasSubscriber: boolean; blockNumber: string;
};
export type PositionInput = PositionReference & { chainId: string; accountId: string; owner: Address };
export class PositionNotOwnedError extends Error {}
export const V3_POSITION_MANAGER = getAddress("0xc36442b4a4522e871399cd717abdd847ab11fe88");
export const POSITION_MANAGER_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
]);
const FACTORY_ABI = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)", "function tickSpacing() view returns (int24)",
  "function feeGrowthGlobal0X128() view returns (uint256)", "function feeGrowthGlobal1X128() view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)",
]);
const V4_FEES_ABI = parseAbi([
  "function getPositionInfo(bytes32 poolId,address owner,int24 tickLower,int24 tickUpper,bytes32 salt) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)",
]);
const U256 = 1n << 256n, Q128 = 1n << 128n;
const mod256 = (value: bigint) => ((value % U256) + U256) % U256;
export function accruedPositionFees(inside: bigint, last: bigint, liquidity: bigint): bigint {
  return mod256(inside - last) * liquidity / Q128;
}
function checkedId(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= U256) throw new Error("Invalid position token ID.");
  return BigInt(value);
}
function checkedProtocol(protocol: PositionProtocol): void {
  if (protocol !== "v3" && protocol !== "v4") throw new Error("Select V3 or V4.");
}
export function positionManager(chainId: string, protocol: PositionProtocol): Address {
  network(chainId); checkedProtocol(protocol);
  return protocol === "v3" ? V3_POSITION_MANAGER : v4Deployment(chainId).positionManager;
}
function blockNumber(value: string | null): string {
  if (value === null || BigInt(value) < 0n) throw new Error("The RPC did not identify the block used for this position read.");
  return BigInt(value).toString();
}
function pinnedReader(read: Reader, chainId: string, requested?: string) {
  let block = requested === undefined ? undefined : blockNumber(requested);
  return {
    get block() { if (block === undefined) throw new Error("Position snapshot has no block."); return block; },
    read: async (address: Address, data: Hex) => {
      const result = await read(chainId, address, data, block === undefined ? undefined : toHex(BigInt(block)));
      const actual = blockNumber(result.blockNumber);
      if (block !== undefined && actual !== block) throw new Error("Position RPC returned a different block than requested.");
      block = actual;
      return result.data;
    },
  };
}
async function tokenMetadata(read: ReturnType<typeof pinnedReader>, chainId: string, address: Address): Promise<Token> {
  const native = address === zeroAddress;
  const known = defaultTokens(chainId).find((token) => native ? token.address === null : token.address?.toLowerCase() === address.toLowerCase());
  if (known) return known;
  const [decimals, symbol] = await Promise.all([
    read.read(address, encodeFunctionData({ abi: TOKEN_ABI, functionName: "decimals" })).then((data) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: "decimals", data })),
    read.read(address, encodeFunctionData({ abi: TOKEN_ABI, functionName: "symbol" })).then((data) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: "symbol", data })).catch(() => `${address.slice(0, 6)}…${address.slice(-4)}`),
  ]);
  return { chainId, address: native ? null : address, decimals, symbol };
}

/** Public state only. The first read establishes a block; every dependent read is pinned to it. */
export async function readPool(read: Reader, input: PoolInput, blockTag?: string): Promise<PoolState> {
  network(input.chainId); checkedProtocol(input.protocol);
  const a = getAddress(input.tokenA ?? (input.protocol === "v4" ? zeroAddress : network(input.chainId).wrapped));
  const b = getAddress(input.tokenB ?? (input.protocol === "v4" ? zeroAddress : network(input.chainId).wrapped));
  if (a === b) throw new Error("Choose two different pool currencies.");
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const snapshot = pinnedReader(read, input.chainId, blockTag);
  let sqrtPriceX96: bigint, tick: number, liquidity: bigint, tickSpacing: number, address: Address | undefined, poolId: Hex | undefined;
  const hooks = getAddress(input.hooks ?? zeroAddress);
  if (input.protocol === "v3") {
    if (currency0 === zeroAddress) throw new Error("V3 positions use wrapped tokens.");
    if (hooks !== zeroAddress) throw new Error("V3 pools do not have hooks.");
    address = getAddress(decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: await snapshot.read(FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [currency0, currency1, input.fee] })) }));
    if (address === zeroAddress) throw new Error("This V3 pool does not exist.");
    const [slot, poolLiquidity, spacing] = await Promise.all([
      snapshot.read(address, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "slot0" })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "slot0", data })),
      snapshot.read(address, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "liquidity" })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "liquidity", data })),
      snapshot.read(address, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "tickSpacing" })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "tickSpacing", data })),
    ]);
    [sqrtPriceX96, tick] = slot; liquidity = poolLiquidity; tickSpacing = spacing;
  } else {
    if (input.tickSpacing === undefined) throw new Error("Specify the V4 pool tick spacing.");
    tickSpacing = input.tickSpacing;
    poolId = v4PoolId({ currency0, currency1, fee: input.fee, tickSpacing, hooks });
    const target = v4Deployment(input.chainId).stateView;
    [sqrtPriceX96, tick] = decodeFunctionResult({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", data: await snapshot.read(target, encodeFunctionData({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] })) });
    if (sqrtPriceX96 === 0n) throw new Error("This V4 pool is not initialized.");
    liquidity = decodeFunctionResult({ abi: V4_STATE_VIEW_ABI, functionName: "getLiquidity", data: await snapshot.read(target, encodeFunctionData({ abi: V4_STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] })) });
  }
  const [token0, token1] = await Promise.all([tokenMetadata(snapshot, input.chainId, currency0), tokenMetadata(snapshot, input.chainId, currency1)]);
  return { protocol: input.protocol, chainId: input.chainId, currency0: currency0 === zeroAddress ? null : currency0, currency1: currency1 === zeroAddress ? null : currency1,
    token0, token1, fee: input.fee, tickSpacing, hooks, ...(address ? { address } : {}), ...(poolId ? { poolId } : {}), sqrtPriceX96: sqrtPriceX96.toString(), tick, liquidity: liquidity.toString(), blockNumber: snapshot.block };
}

/** Import and refresh share this path; index metadata never authorizes ownership or a pool. */
export async function readPosition(read: Reader, input: PositionInput, blockTag?: string): Promise<PositionRecord> {
  const manager = positionManager(input.chainId, input.protocol), tokenId = checkedId(input.tokenId), owner = getAddress(input.owner);
  const snapshot = pinnedReader(read, input.chainId, blockTag);
  let actualOwner: Address;
  try {
    actualOwner = getAddress(decodeFunctionResult({ abi: POSITION_MANAGER_ABI, functionName: "ownerOf", data: await snapshot.read(manager, encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "ownerOf", args: [tokenId] })) }));
  } catch (error) {
    // Both official managers retain no owner after burn. Only their definite
    // ownerOf revert removes a stale saved reference; outages are still errors.
    const reason = error instanceof Error ? error.message : String(error);
    const missing = input.protocol === "v3" ? /execution reverted:\s*ERC721: owner query for nonexistent token(?:$|["\r\n])/ : /execution reverted:\s*NOT_MINTED(?:$|["\r\n])/;
    if (missing.test(reason)) throw new PositionNotOwnedError(`Position #${input.tokenId} no longer exists.`);
    throw error;
  }
  if (actualOwner !== owner) throw new PositionNotOwnedError(`Position #${input.tokenId} is not owned by this wallet.`);
  let pool: PoolState, tickLower: number, tickUpper: number, liquidity: bigint, last0: bigint, last1: bigint;
  let fees0 = 0n, fees1 = 0n, owed0 = 0n, owed1 = 0n, hasSubscriber = false;
  if (input.protocol === "v3") {
    const position = decodeFunctionResult({ abi: POSITION_MANAGER_ABI, functionName: "positions", data: await snapshot.read(manager, encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "positions", args: [tokenId] })) });
    [, , , , , tickLower, tickUpper, liquidity, last0, last1, owed0, owed1] = position;
    pool = await readPool(read, { chainId: input.chainId, protocol: "v3", tokenA: position[2], tokenB: position[3], fee: position[4] }, snapshot.block);
    if (liquidity > 0n) {
      const target = pool.address!;
      const [global0, global1, lower, upper] = await Promise.all([
        snapshot.read(target, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "feeGrowthGlobal0X128" })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "feeGrowthGlobal0X128", data })),
        snapshot.read(target, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "feeGrowthGlobal1X128" })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "feeGrowthGlobal1X128", data })),
        snapshot.read(target, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "ticks", args: [tickLower] })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "ticks", data })),
        snapshot.read(target, encodeFunctionData({ abi: V3_POOL_ABI, functionName: "ticks", args: [tickUpper] })).then((data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "ticks", data })),
      ]);
      const inside = (global: bigint, low: bigint, high: bigint) => mod256(global - (pool.tick >= tickLower ? low : mod256(global - low)) - (pool.tick < tickUpper ? high : mod256(global - high)));
      fees0 = accruedPositionFees(inside(global0, lower[2], upper[2]), last0, liquidity);
      fees1 = accruedPositionFees(inside(global1, lower[3], upper[3]), last1, liquidity);
    }
  } else {
    const [key, info] = decodeFunctionResult({ abi: POSITION_MANAGER_ABI, functionName: "getPoolAndPositionInfo", data: await snapshot.read(manager, encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "getPoolAndPositionInfo", args: [tokenId] })) });
    const signedTick = (value: bigint) => Number(value >= 0x800000n ? value - 0x1000000n : value);
    tickLower = signedTick((info >> 8n) & 0xffffffn); tickUpper = signedTick((info >> 32n) & 0xffffffn); hasSubscriber = (info & 0xffn) !== 0n;
    [pool, liquidity] = await Promise.all([
      readPool(read, { chainId: input.chainId, protocol: "v4", tokenA: key.currency0, tokenB: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, snapshot.block),
      snapshot.read(manager, encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "getPositionLiquidity", args: [tokenId] })).then((data) => decodeFunctionResult({ abi: POSITION_MANAGER_ABI, functionName: "getPositionLiquidity", data })),
    ]);
    if (liquidity > 0n) {
      const target = v4Deployment(input.chainId).stateView;
      const [[coreLiquidity, growth0, growth1], [inside0, inside1]] = await Promise.all([
        snapshot.read(target, encodeFunctionData({ abi: V4_FEES_ABI, functionName: "getPositionInfo", args: [pool.poolId!, manager, tickLower, tickUpper, toHex(tokenId, { size: 32 })] })).then((data) => decodeFunctionResult({ abi: V4_FEES_ABI, functionName: "getPositionInfo", data })),
        snapshot.read(target, encodeFunctionData({ abi: V4_FEES_ABI, functionName: "getFeeGrowthInside", args: [pool.poolId!, tickLower, tickUpper] })).then((data) => decodeFunctionResult({ abi: V4_FEES_ABI, functionName: "getFeeGrowthInside", data })),
      ]);
      if (coreLiquidity !== liquidity) throw new Error("PositionManager and pool liquidity disagree at this block.");
      fees0 = accruedPositionFees(inside0, growth0, liquidity); fees1 = accruedPositionFees(inside1, growth1, liquidity);
    }
  }
  return { ...input, owner, manager, pool, tickLower, tickUpper, liquidity: liquidity.toString(), ...liquidityAmounts(pool, tickLower, tickUpper, liquidity.toString()),
    fees0: fees0.toString(), fees1: fees1.toString(), owed0: owed0.toString(), owed1: owed1.toString(), claimable0: (owed0 + fees0).toString(), claimable1: (owed1 + fees1).toString(),
    inRange: pool.tick >= tickLower && pool.tick < tickUpper, hasSubscriber, blockNumber: snapshot.block };
}

export const POSITION_INDEXERS = { "1": "https://eth.blockscout.com", "42161": "https://arbitrum.blockscout.com" } as const;
export type PositionIndexPage = { tokenIds: string[]; next: string | null };
/** Blockscout is a replaceable ID index. Ignore metadata, media URLs, balances and pool descriptions. */
export async function browserPositionIds(chainId: string, owner: Address, after: string | null = null, options: { signal?: AbortSignal | undefined; fetch?: typeof globalThis.fetch } = {}): Promise<PositionIndexPage> {
  network(chainId);
  const manager = positionManager(chainId, "v4"), url = new URL(`/api/v2/tokens/${manager}/instances`, POSITION_INDEXERS[chainId as keyof typeof POSITION_INDEXERS]);
  url.searchParams.set("holder_address_hash", getAddress(owner));
  if (after !== null) { checkedId(after); url.searchParams.set("unique_token", after); }
  const response = await (options.fetch ?? globalThis.fetch)(url, { mode: "cors", credentials: "omit", ...(options.signal ? { signal: options.signal } : {}) });
  if (!response.ok) throw new Error(`Position discovery is unavailable (HTTP ${response.status}). Saved and imported positions can still be managed.`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) throw new Error("Position discovery returned an invalid page.");
  const value = body as { items: unknown[]; next_page_params?: unknown }, ids = new Set<string>();
  for (const item of value.items) {
    if (!item || typeof item !== "object") throw new Error("Position discovery returned an invalid item.");
    const record = item as { id?: unknown; owner?: { hash?: unknown } | null; token?: { address_hash?: unknown }; token_type?: unknown };
    if (typeof record.id !== "string" || typeof record.token?.address_hash !== "string" || getAddress(record.token.address_hash) !== manager || record.token_type !== "ERC-721") throw new Error("Position discovery returned a different NFT collection.");
    checkedId(record.id);
    if (record.owner?.hash !== undefined && (typeof record.owner.hash !== "string" || getAddress(record.owner.hash) !== getAddress(owner))) throw new Error("Position discovery returned a different owner.");
    if (after !== null && BigInt(record.id) >= BigInt(after)) throw new Error("Position discovery did not advance its page.");
    ids.add(record.id);
  }
  let next: string | null = null;
  if (value.next_page_params != null) {
    if (typeof value.next_page_params !== "object") throw new Error("Position discovery returned an invalid cursor.");
    const cursor = value.next_page_params as { unique_token?: unknown; holder_address_hash?: unknown };
    if (typeof cursor.holder_address_hash !== "string" || getAddress(cursor.holder_address_hash) !== getAddress(owner)) throw new Error("Position discovery changed the requested holder.");
    if (typeof cursor.unique_token !== "string" && (typeof cursor.unique_token !== "number" || !Number.isSafeInteger(cursor.unique_token))) throw new Error("Position discovery returned an inexact cursor.");
    next = String(cursor.unique_token); checkedId(next);
    if ((after !== null && BigInt(next) >= BigInt(after)) || !ids.size || !ids.has(next) || [...ids].some((id) => BigInt(id) < BigInt(next!))) throw new Error("Position discovery did not advance its cursor.");
  }
  return { tokenIds: [...ids], next };
}

export type PositionListCursor = {
  chainId: string; owner: Address; protocol: PositionProtocol | null; blockNumber: string;
  phase: "known" | "v3" | "v4" | "done"; knownIds: PositionReference[]; knownIndex: number; v3Index: string; v4After: string | null;
  v4Pending: string[]; v4End: boolean; verified: { v3: string; v4: string }; hadError: boolean;
};
export type PositionListOptions = {
  protocol?: PositionProtocol; knownIds?: PositionReference[]; signal?: AbortSignal | undefined; pageSize?: number;
  cursor?: PositionListCursor; drain?: boolean; fetch?: typeof globalThis.fetch;
};
export type PositionListResult = {
  positions: PositionRecord[]; totalOwned: { v3: string | null; v4: string | null }; complete: boolean;
  errors: string[]; nextCursor: PositionListCursor | null; blockNumber: string;
};

/** Pages are a presentation choice, not a total position limit. Callers can drain or continue the cursor. */
export async function listPositions(read: Reader, account: PositionAccount, chainId: string, options: PositionListOptions = {}): Promise<PositionListResult> {
  network(chainId); if (options.protocol) checkedProtocol(options.protocol);
  const owner = getAddress(account.address), pageSize = options.pageSize ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("Position page size must be a positive integer.");
  const check = () => options.signal?.throwIfAborted();
  const guardedRead: Reader = async (...args) => { check(); return read(...args); };
  const snapshot = pinnedReader(guardedRead, chainId, options.cursor?.blockNumber);
  const totalOwned: PositionListResult["totalOwned"] = { v3: null, v4: null };
  for (const protocol of ["v3", "v4"] as const) if (!options.protocol || options.protocol === protocol) {
    totalOwned[protocol] = decodeFunctionResult({ abi: POSITION_MANAGER_ABI, functionName: "balanceOf", data: await snapshot.read(positionManager(chainId, protocol), encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "balanceOf", args: [owner] })) }).toString();
  }
  const cursor: PositionListCursor = options.cursor ? structuredClone(options.cursor) : {
    chainId, owner, protocol: options.protocol ?? null, blockNumber: snapshot.block, phase: "known", knownIds: options.knownIds ?? [], knownIndex: 0,
    v3Index: "0", v4After: null, v4Pending: [], v4End: false, verified: { v3: "0", v4: "0" }, hadError: false,
  };
  if (cursor.chainId !== chainId || getAddress(cursor.owner) !== owner || cursor.protocol !== (options.protocol ?? null)) throw new Error("Position cursor belongs to a different account, network or protocol.");
  if (!["known", "v3", "v4", "done"].includes(cursor.phase) || !Number.isSafeInteger(cursor.knownIndex) || cursor.knownIndex < 0 || !Array.isArray(cursor.v4Pending) || !Array.isArray(cursor.knownIds)) throw new Error("Invalid position cursor.");
  checkedId(cursor.v3Index); checkedId(cursor.verified.v3); checkedId(cursor.verified.v4); cursor.v4Pending.forEach(checkedId); if (cursor.v4After !== null) checkedId(cursor.v4After);
  // A tool call may reload the durable reference list between pages. Keep the
  // original sequence with the snapshot so imports cannot shift knownIndex.
  const known = [...new Map(cursor.knownIds.filter((item) => !options.protocol || item.protocol === options.protocol).map((item) => {
    checkedProtocol(item.protocol); checkedId(item.tokenId); return [`${item.protocol}:${item.tokenId}`, item] as const;
  })).values()];
  cursor.knownIds = known;
  const knownKeys = new Set(known.map((item) => `${item.protocol}:${item.tokenId}`)), positions: PositionRecord[] = [], errors: string[] = [];
  let examined = 0;
  const normalizePhase = () => {
    if (cursor.phase === "known" && cursor.knownIndex >= known.length) cursor.phase = "v3";
    if (cursor.phase === "v3" && (totalOwned.v3 === null || BigInt(cursor.v3Index) >= BigInt(totalOwned.v3))) cursor.phase = "v4";
    if (cursor.phase === "v4" && (totalOwned.v4 === null || totalOwned.v4 === "0" || (cursor.v4End && !cursor.v4Pending.length))) cursor.phase = "done";
  };
  while (options.drain || examined < pageSize) {
    check(); normalizePhase(); if (cursor.phase === "done") break;
    let reference: PositionReference;
    if (cursor.phase === "known") {
      reference = known[cursor.knownIndex++]!;
      if (totalOwned[reference.protocol] === "0") { examined++; continue; }
    }
    else if (cursor.phase === "v3") {
      const index = BigInt(cursor.v3Index); cursor.v3Index = (index + 1n).toString(); examined++;
      try {
        const id = decodeFunctionResult({ abi: POSITION_MANAGER_ABI, functionName: "tokenOfOwnerByIndex", data: await snapshot.read(V3_POSITION_MANAGER, encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "tokenOfOwnerByIndex", args: [owner, index] })) }).toString();
        reference = { protocol: "v3", tokenId: id };
      } catch (error) { check(); errors.push(`V3 position discovery: ${String(error)}`); cursor.hadError = true; continue; }
      if (knownKeys.has(`v3:${reference.tokenId}`)) continue;
      examined--;
    } else {
      if (!cursor.v4Pending.length) {
        try {
          const page = await browserPositionIds(chainId, owner, cursor.v4After, options);
          cursor.v4Pending = page.tokenIds; cursor.v4After = page.next; cursor.v4End = page.next === null;
          if (!cursor.v4Pending.length) { normalizePhase(); continue; }
        } catch (error) {
          // The index cursor has not advanced. Retrying this same page can
          // recover fully, so this outage is not a permanent verification gap.
          check(); errors.push(String(error));
          return { positions, totalOwned, complete: false, errors, nextCursor: cursor, blockNumber: snapshot.block };
        }
      }
      reference = { protocol: "v4", tokenId: cursor.v4Pending.shift()! };
      if (knownKeys.has(`v4:${reference.tokenId}`)) { examined++; continue; }
    }
    examined++;
    try {
      positions.push(await readPosition(guardedRead, { ...reference, chainId, accountId: account.accountId, owner }, snapshot.block));
      cursor.verified[reference.protocol] = (BigInt(cursor.verified[reference.protocol]) + 1n).toString();
    } catch (error) {
      check();
      // Saved references remain durable history after an NFT transfer. Current
      // ownership removes them from the portfolio without making discovery fail.
      if (error instanceof PositionNotOwnedError && knownKeys.has(`${reference.protocol}:${reference.tokenId}`)) continue;
      errors.push(`${reference.protocol.toUpperCase()} #${reference.tokenId}: ${String(error)}`); cursor.hadError = true;
    }
  }
  normalizePhase();
  const ended = cursor.phase === "done";
  const matchesCounts = (["v3", "v4"] as const).every((protocol) => totalOwned[protocol] === null || totalOwned[protocol] === cursor.verified[protocol]);
  if (ended && !matchesCounts) errors.push("Some positions have not been discovered or verified yet. You can import a missing position by its token ID.");
  return { positions, totalOwned, complete: ended && matchesCounts && !cursor.hadError, errors, nextCursor: ended ? null : cursor, blockNumber: snapshot.block };
}
